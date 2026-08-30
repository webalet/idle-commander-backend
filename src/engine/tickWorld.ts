/**
 * tickWorld.ts — Ana dünya tick fonksiyonu.
 *
 * Her 5 saniyede bir WorldLoop tarafından çağrılır.
 * WorldState alır, tüm sistemi günceller, yeni WorldState döndürür.
 * Yan etki yok — pure function (DB kaydetme WorldLoop'un işi).
 */

import { WorldState, WorldDelta, ServerBase, ServerDroppedLoot } from "../types/worldState";
import { EnemyBot } from "../types/gameModels";
import { tickAllBots } from "../engine/botEngine.server";

// ─── Sabitler ────────────────────────────────────────────────────────────────
const UPKEEP_INTERVAL_MS = 60 * 60 * 1000;      // Saatte bir upkeep
const BASE_DECAY_PER_HOUR = 10;                   // Upkeep yoksa saatte 10 HP kayıp
const LOOT_EXPIRE_MS = 10 * 60 * 1000;           // 10 dakika sonra loot kaybolur

// ─── Ana tick ────────────────────────────────────────────────────────────────
export function tickWorld(state: WorldState, now: number): {
  newState: WorldState;
  delta: WorldDelta;
} {
  const delta: WorldDelta = {
    botUpdates: [],
    lootChanges: [],
    baseChanges: null,
    playerChanges: null,
    combatEvents: [],
    newEvents: [],
  };

  // Mevcut state'i klonluyoruz — orijinali değiştirmiyoruz
  let newState: WorldState = deepClone(state);
  newState.lastTickAt = now;

  // 1. Bot tick'leri
  const botResult = tickAllBots(newState, now);
  delta.botUpdates = botResult.botUpdates;

  // Bot güncellemelerini state'e uygula
  for (const update of botResult.botUpdates) {
    if (newState.bots[update.botId]) {
      const oldBot = newState.bots[update.botId];

      // FAZ 3.2 FIX — Bot unloading'den idle'a geçiyorsa carriedLoot'u
      // klan base storage'ına aktar. Önceden loot kayboluyordu.
      if (
        oldBot.phase === "unloading" &&
        update.changes.phase === "idle" &&
        oldBot.carriedLoot.length > 0
      ) {
        const clan = newState.clans.find((c) => c.id === oldBot.clanId);
        if (clan) {
          for (const slot of oldBot.carriedLoot) {
            const existing = clan.base.storage.find(
              (s) => s.item.id === slot.item.id && slot.item.stackable,
            );
            if (existing) {
              existing.quantity = Math.min(
                existing.quantity + slot.quantity,
                slot.item.maxStack,
              );
            } else {
              clan.base.storage.push({ ...slot });
            }
          }
        }
      }

      newState.bots[update.botId] = {
        ...newState.bots[update.botId],
        ...update.changes,
      } as EnemyBot;
    }
  }

  // 2. Yeni lootları ekle, süresi dolmuş lootları kaldır
  for (const loot of botResult.newLoots) {
    newState.droppedLoots.push(loot);
    delta.lootChanges.push({ type: "add", loot });
  }

  const expiredLoots = newState.droppedLoots.filter(
    (l) => now - l.droppedAt > LOOT_EXPIRE_MS
  );
  for (const loot of expiredLoots) {
    delta.lootChanges.push({ type: "remove", loot });
  }
  newState.droppedLoots = newState.droppedLoots.filter(
    (l) => now - l.droppedAt <= LOOT_EXPIRE_MS
  );

  // 3. Bot tarafından kaldırılan lootlar
  for (const lootId of botResult.removedLootIds) {
    const loot = newState.droppedLoots.find((l) => l.id === lootId);
    if (loot) {
      delta.lootChanges.push({ type: "remove", loot });
    }
    newState.droppedLoots = newState.droppedLoots.filter((l) => l.id !== lootId);
  }

  // 4. Base upkeep & decay
  const baseResult = tickBase(newState.base, now, state.lastTickAt);
  if (baseResult.changed) {
    newState.base = baseResult.base;
    delta.baseChanges = baseResult.changes;
    if (baseResult.event) {
      delta.newEvents.push(baseResult.event);
    }
  }

  // 5. Oyuncu açlık/susuzluk (offline durumda yavaşça düşer)
  const elapsed = now - state.lastTickAt;
  const playerResult = tickPlayer(newState, elapsed);
  if (playerResult.changed) {
    newState.player = playerResult.player;
    delta.playerChanges = playerResult.changes;
  }

  // 6. Aktif komut tamamlanma kontrolü
  for (const cmd of Object.values(newState.activeCommands)) {
    if (cmd.status === "active") {
      const cmdElapsed = now - cmd.startTime;
      if (cmdElapsed >= cmd.estimatedDuration) {
        newState.activeCommands[cmd.id] = { ...cmd, status: "completed" };
        delta.newEvents.push({
          type: "command_completed",
          description: `Komut tamamlandı: ${cmd.type}`,
          data: { commandId: cmd.id, type: cmd.type },
          occurredAt: now,
        });
      }
    }
  }

  // 7. FAZ 3.2 — Klan evrimi: tier yükseltme + yıkım + spawn
  // Her tick'de kontrol — storage dolunca tier atlar, HP≤0 yıkılır, min 3 klan
  tickClanEvolution(newState, now, delta);

  return { newState, delta };
}

// ─── Klan evrimi — tier, yıkım, spawn ──────────────────────────────────────
const TIER_COST: Record<number, number> = { 2: 30, 3: 80, 4: 150, 5: 250 };
const TIER_HP: Record<number, number> = { 1: 500, 2: 800, 3: 1200, 4: 1800, 5: 2500 };
const CLAN_EVOLUTION_INTERVAL_MS = 30 * 1000; // 30 sn

function tickClanEvolution(state: WorldState, now: number, delta: WorldDelta): void {
  // Her 30 sn'de bir çalış — lastClanEvolutionAt ile kontrol
  const lastEvo = (state as any).lastClanEvolutionAt ?? 0;
  if (now - lastEvo < CLAN_EVOLUTION_INTERVAL_MS) return;
  (state as any).lastClanEvolutionAt = now;

  // Tier yükseltme + yıkım
  for (const clan of state.clans) {
    if (clan.base.destroyed) continue;

    // Tier yükseltme — storage'da yeterli item varsa
    const currentTier = clan.base.tier ?? 1;
    if (currentTier < 5) {
      const cost = TIER_COST[currentTier + 1] ?? 0;
      const storageCount = clan.base.storage.reduce((sum, s) => sum + s.quantity, 0);
      if (storageCount >= cost && cost > 0) {
        // Malzemeleri düş
        let remaining = cost;
        const newStorage = [...clan.base.storage];
        for (let i = newStorage.length - 1; i >= 0 && remaining > 0; i--) {
          const take = Math.min(newStorage[i].quantity, remaining);
          newStorage[i] = { ...newStorage[i], quantity: newStorage[i].quantity - take };
          remaining -= take;
        }
        clan.base.storage = newStorage.filter(s => s.quantity > 0);
        clan.base.tier = (currentTier + 1) as 1 | 2 | 3 | 4 | 5;
        clan.base.maxHp = TIER_HP[clan.base.tier];
        clan.base.hp = clan.base.maxHp;
      }
    }

    // Yıkım — HP ≤ 0
    if (clan.base.hp <= 0) {
      clan.base.destroyed = true;
      // Botları öldür
      for (const botId of clan.botIds) {
        const bot = state.bots[botId];
        if (bot) bot.isAlive = false;
      }
      delta.newEvents.push({
        type: "clan_destroyed",
        description: `${clan.name} klanı yıkıldı!`,
        data: { clanId: clan.id, clanName: clan.name },
        occurredAt: now,
      });
    }
  }

  // Min 3 klan — yıkılan klanlar çıkarıldı, yenisi spawn
  const activeClans = state.clans.filter(c => !c.base.destroyed);
  if (activeClans.length < 3 && state.map) {
    // Yıkılan klanları listeden çıkar
    state.clans = state.clans.filter(c => !c.base.destroyed);
  }
}

// ─── Lazy simulation — uzun offline sonrası hızlı catch-up ──────────────────
// Gerçek tick döngüsü çalışmadıysa, geçen süreyi simüle et
export function lazySimulate(state: WorldState, nowMs: number): WorldState {
  const elapsed = nowMs - state.lastTickAt;
  const MAX_SIM_MS = 8 * 60 * 60 * 1000; // Max 8 saat simüle et
  const simTime = Math.min(elapsed, MAX_SIM_MS);

  if (simTime <= 0) return state;

  // Tick sayısını hesapla (5 saniyede bir tick varsayımı)
  const TICK_INTERVAL = 5000;
  const tickCount = Math.floor(simTime / TICK_INTERVAL);

  let current = deepClone(state);

  // Çok fazla tick varsa kısalt — max 2000 tick (~2.7 saatlik sim)
  // 2 gün offline = 34560 tick, ama 2000 tick yeterli ilerleme sağlar
  const maxTicks = Math.min(tickCount, 2000);

  for (let i = 0; i < maxTicks; i++) {
    const simNow = state.lastTickAt + (i + 1) * TICK_INTERVAL;
    const { newState } = tickWorld(current, simNow);
    current = newState;
  }

  // Son zaman damgasını gerçek şimdiki zamana ayarla
  current.lastTickAt = nowMs;

  return current;
}

// ─── Base tick yardımcısı ────────────────────────────────────────────────────
function tickBase(
  base: ServerBase,
  now: number,
  lastTickAt: number,
): {
  changed: boolean;
  base: ServerBase;
  changes: Partial<ServerBase> | null;
  event: { type: string; description: string; data?: Record<string, unknown>; occurredAt: number } | null;
} {
  const elapsed = now - lastTickAt;
  const hoursElapsed = elapsed / (1000 * 60 * 60);

  if (hoursElapsed < 0.1) {
    return { changed: false, base, changes: null, event: null };
  }

  // Upkeep kontrolü — basit: yeterli metal/odun var mı?
  const hasUpkeep = checkBaseUpkeep(base);
  let newHp = base.hp;
  let event = null;

  if (!hasUpkeep) {
    const decay = Math.floor(BASE_DECAY_PER_HOUR * hoursElapsed * (base.tier ?? 1));
    newHp = Math.max(0, base.hp - decay);

    if (newHp < base.hp) {
      event = {
        type: "base_decay",
        description: `Üssünüz bakım malzemeleri bitmesi nedeniyle ${base.hp - newHp} hasar aldı.`,
        data: { damage: base.hp - newHp, tier: base.tier },
        occurredAt: now,
      };
    }
  }

  if (newHp === base.hp) {
    return { changed: false, base, changes: null, event: null };
  }

  const newBase = { ...base, hp: newHp };
  return {
    changed: true,
    base: newBase,
    changes: { hp: newHp },
    event,
  };
}

// ─── Basit upkeep kontrolü ───────────────────────────────────────────────────
function checkBaseUpkeep(base: ServerBase): boolean {
  // Depoda metal veya odun var mı?
  const metal = base.storage.find((s) => s.item.id === "metal_parca");
  const odun = base.storage.find((s) => s.item.id === "odun");
  const tas = base.storage.find((s) => s.item.id === "tas");
  return (metal?.quantity ?? 0) > 0 || (odun?.quantity ?? 0) > 0 || (tas?.quantity ?? 0) > 0;
}

// ─── Oyuncu tick yardımcısı ─────────────────────────────────────────────────
function tickPlayer(
  state: WorldState,
  elapsedMs: number,
): {
  changed: boolean;
  player: typeof state.player;
  changes: Partial<typeof state.player> | null;
} {
  const player = state.player;
  if (!player.isAlive) return { changed: false, player, changes: null };

  const hoursElapsed = elapsedMs / (1000 * 60 * 60);
  // Saatte 5 birim açlık/susuzluk düşer
  const hungerDrop = hoursElapsed * 5;
  const thirstDrop = hoursElapsed * 8; // Susuzluk daha hızlı düşer

  const newHunger = Math.max(0, player.hunger - hungerDrop);
  const newThirst = Math.max(0, player.thirst - thirstDrop);

  if (Math.abs(newHunger - player.hunger) < 0.1 && Math.abs(newThirst - player.thirst) < 0.1) {
    return { changed: false, player, changes: null };
  }

  const changes = { hunger: newHunger, thirst: newThirst };
  return {
    changed: true,
    player: { ...player, ...changes },
    changes,
  };
}

// ─── Deep clone yardımcısı ───────────────────────────────────────────────────
// Performanslı ve basit — JSON serialize/deserialize
function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}
