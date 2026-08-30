/**
 * offlineSimulation.ts — Offline Klan Evrimi Simülasyonu (FAZ 3.1)
 *
 * Oyuncu oyunu kapattığında, backend gerçek tick yapmak yerine
 * oyuncu geri giriş yaptığında istatistiksel klan evrimi simülasyonu çalıştırır.
 *
 * Rust wipe döngüsü gibi: klanlar büyür, savaşır, yıkılır, yenileri spawn olur.
 *
 * Tüm dengeleme değerleri docs/offline-evolution-plan.md'de.
 */

import { WorldState, WorldEventRecord } from "../types/worldState";
import { EnemyClan, EnemyBot, ClanTendency, InventorySlot, ItemDefinition, Position } from "../types/gameModels";
import { createInitialWorldState } from "../world/worldFactory";

// ─── Sabitler ──────────────────────────────────────────────────────────────────
const MIN_SIM_MS = 30 * 60 * 1000;
const WIPE_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_SIM_HOURS = 72;
const MIN_CLANS = 3;
const MAX_CLANS = 7;
const WEAPON_CAP_PER_CLAN = 8;

const TIER_CLOCK: Record<ClanTendency, number[]> = {
  builder:  [0.4, 2, 6, 18],
  farmer:   [0.75, 4.5, 12, 24],
  balanced: [0.6, 3, 9, 21],
};

const FARM_RATE: Record<ClanTendency, number> = {
  builder: 1.5, farmer: 3, balanced: 2.2,
};

const UPGRADE_COST: Record<number, number> = { 2: 30, 3: 80, 4: 150, 5: 250 };
const TIER_BASE_HP: Record<number, number> = { 1: 500, 2: 800, 3: 1200, 4: 1800, 5: 2500 };

export interface OfflineSimResult {
  newState: WorldState;
  events: WorldEventRecord[];
  wiped: boolean;
  offlineHours: number;
}

function rand(min: number, max: number): number { return min + Math.random() * (max - min); }
function randInt(min: number, max: number): number { return Math.floor(rand(min, max + 1)); }
function chance(pct: number): boolean { return Math.random() * 100 < pct; }

// ─── Loot tablosu ──────────────────────────────────────────────────────────────
const LOOT_RESOURCES = [
  { id: "odun", name: "Odun", cat: "resource" },
  { id: "tas", name: "Taş", cat: "resource" },
  { id: "metal_parca", name: "Metal Parça", cat: "metal" },
];
const LOOT_COMPONENTS = [
  { id: "disle", name: "Dişli", cat: "component" },
  { id: "boru", name: "Boru", cat: "component" },
];
const LOOT_ARMOR_T1 = [
  { id: "bez_gomlek", name: "Bez Gömlek", equipSlot: "body" },
  { id: "deri_kask", name: "Deri Kask", equipSlot: "head" },
];
const LOOT_WEAPONS_T1 = [
  { id: "tas_spear", name: "Taş Mızrak", equipSlot: "weapon" },
  { id: "tabanca", name: "Tabanca", equipSlot: "weapon" },
];
const LOOT_WEAPONS_T3 = [
  { id: "saldiri_tufegi", name: "Saldırı Tüfeği", equipSlot: "weapon" },
];

function makeItem(id: string, name: string, cat: string, stackable: boolean, maxStack: number, equipSlot?: string): ItemDefinition {
  return { id, name, category: cat, stackable, maxStack, equipSlot: equipSlot ?? null, weaponStats: null, armorStats: null };
}

function rollFarmLoot(clan: EnemyClan): InventorySlot | null {
  const weaponCount = clan.base.storage
    .filter(s => s.item.category === "weapon")
    .reduce((sum, s) => sum + s.quantity, 0);
  const weaponCapReached = weaponCount >= WEAPON_CAP_PER_CLAN;

  const roll = Math.random() * 100;
  if (roll < 60) {
    const def = LOOT_RESOURCES[randInt(0, LOOT_RESOURCES.length - 1)];
    return { item: makeItem(def.id, def.name, def.cat, true, 1000), quantity: randInt(5, 15) };
  }
  if (roll < 85) {
    const def = LOOT_COMPONENTS[randInt(0, LOOT_COMPONENTS.length - 1)];
    return { item: makeItem(def.id, def.name, def.cat, true, 100), quantity: randInt(1, 3) };
  }
  if (roll < 95) {
    const def = LOOT_ARMOR_T1[randInt(0, LOOT_ARMOR_T1.length - 1)];
    return { item: makeItem(def.id, def.name, "armor", false, 1, def.equipSlot), quantity: 1 };
  }
  if (roll < 99 && !weaponCapReached) {
    const def = LOOT_WEAPONS_T1[randInt(0, LOOT_WEAPONS_T1.length - 1)];
    return { item: makeItem(def.id, def.name, "weapon", false, 1, def.equipSlot), quantity: 1 };
  }
  if (!weaponCapReached) {
    const def = LOOT_WEAPONS_T3[randInt(0, LOOT_WEAPONS_T3.length - 1)];
    return { item: makeItem(def.id, def.name, "weapon", false, 1, def.equipSlot), quantity: 1 };
  }
  return null;
}

function addToStorage(storage: InventorySlot[], slot: InventorySlot): InventorySlot[] {
  const result = storage.map(s => ({ ...s }));
  if (slot.item.stackable) {
    const idx = result.findIndex(s => s.item.id === slot.item.id);
    if (idx >= 0) {
      result[idx] = { ...result[idx], quantity: Math.min(slot.item.maxStack, result[idx].quantity + slot.quantity) };
      return result;
    }
  }
  result.push({ ...slot });
  return result;
}

function storageItemCount(storage: InventorySlot[]): number {
  return storage.reduce((sum, s) => sum + s.quantity, 0);
}

function spendStorage(storage: InventorySlot[], amount: number): InventorySlot[] {
  let remaining = amount;
  const result = storage.map(s => ({ ...s }));
  for (let i = 0; i < result.length && remaining > 0; i++) {
    const take = Math.min(remaining, result[i].quantity);
    result[i] = { ...result[i], quantity: result[i].quantity - take };
    remaining -= take;
  }
  return result.filter(s => s.quantity > 0);
}

// ─── Klan gücü ─────────────────────────────────────────────────────────────────
function clanPower(clan: EnemyClan, bots: Record<string, EnemyBot>): number {
  const liveBots = clan.botIds.filter(id => bots[id]?.isAlive).length;
  const equipScore = clan.botIds.reduce((sum, id) => {
    const b = bots[id];
    if (!b || !b.isAlive) return sum;
    return sum + (b.equipment.weapon ? 10 : 0) + (b.equipment.body ? 5 : 0);
  }, 0);
  return liveBots * 10 + equipScore + clan.base.tier * 20 + clan.base.hp / 10;
}

// ─── Tier gelişimi ─────────────────────────────────────────────────────────────
function evolveClanTier(clan: EnemyClan, simHours: number, events: WorldEventRecord[], now: number): void {
  if (clan.base.destroyed) return;
  const tendency = clan.tendency ?? "balanced";
  let tier = clan.base.tier;
  let hoursLeft = simHours;

  while (tier < 5 && hoursLeft > 0) {
    const baseSüre = TIER_CLOCK[tendency][tier - 1];
    const geçişSüresi = baseSüre * (0.7 + Math.random() * 0.6);
    if (hoursLeft < geçişSüresi) break;

    const cost = UPGRADE_COST[tier + 1] ?? 0;
    if (storageItemCount(clan.base.storage) < cost) break;

    clan.base.storage = spendStorage(clan.base.storage, cost);
    tier += 1;
    hoursLeft -= geçişSüresi;

    events.push({
      type: "clan_tier",
      description: `${clan.name} base tier ${tier}'e ulaştı`,
      data: { clanId: clan.id, clanName: clan.name, tier },
      occurredAt: now,
    });
  }

  clan.base.tier = tier as 1 | 2 | 3 | 4 | 5;
  clan.base.maxHp = TIER_BASE_HP[tier];
  clan.base.hp = Math.min(clan.base.hp, clan.base.maxHp);
}

// ─── Klan farming ──────────────────────────────────────────────────────────────
function farmClan(clan: EnemyClan, simHours: number): void {
  if (clan.base.destroyed) return;
  const tendency = clan.tendency ?? "balanced";
  const liveBots = clan.botIds.length;
  const farmPerHour = liveBots * FARM_RATE[tendency];
  const totalFarm = Math.floor(farmPerHour * simHours);
  const ticks = Math.min(totalFarm, simHours * 2);
  for (let i = 0; i < ticks; i++) {
    const loot = rollFarmLoot(clan);
    if (loot) clan.base.storage = addToStorage(clan.base.storage, loot);
  }
}

// ─── Klan savaşları ────────────────────────────────────────────────────────────
function simulateClanWars(state: WorldState, simHours: number, scenario: string, events: WorldEventRecord[], now: number): void {
  const liveClans = state.clans.filter(c => !c.base.destroyed);
  const warChanceMult = scenario === "iki_guç" ? 2 : (scenario === "dengeli_kaos" ? 1.5 : 1);

  for (let i = 0; i < liveClans.length; i++) {
    for (let j = i + 1; j < liveClans.length; j++) {
      const a = liveClans[i];
      const b = liveClans[j];
      const dx = a.base.position.x - b.base.position.x;
      const dy = a.base.position.y - b.base.position.y;
      if (Math.sqrt(dx * dx + dy * dy) > 1000) continue;

      const warChance = 0.05 * (simHours / 24) * warChanceMult;
      if (!chance(warChance * 100)) continue;

      const winner = clanPower(a, state.bots) >= clanPower(b, state.bots) ? a : b;
      const loser = winner === a ? b : a;

      const tierRatio = winner.base.tier / Math.max(1, loser.base.tier);
      const damage = Math.floor(rand(50, 150) * tierRatio);
      loser.base.hp = Math.max(0, loser.base.hp - damage);

      const botLoss = randInt(0, 2);
      for (let k = 0; k < botLoss && loser.botIds.length > 0; k++) {
        const botId = loser.botIds[randInt(0, loser.botIds.length - 1)];
        if (state.bots[botId]) {
          state.bots[botId].isAlive = false;
          state.bots[botId].phase = "dead";
        }
        loser.botIds = loser.botIds.filter(id => id !== botId);
      }

      const lootAmount = Math.floor(storageItemCount(loser.base.storage) * 0.3);
      if (lootAmount > 0) {
        loser.base.storage = spendStorage(loser.base.storage, lootAmount);
        winner.base.storage = addToStorage(winner.base.storage, {
          item: makeItem("metal_parca", "Metal Parça", "metal", true, 1000),
          quantity: lootAmount,
        });
      }

      events.push({
        type: "war",
        description: `${a.name} vs ${b.name} — ${winner.name} kazandı (${damage} hasar)`,
        data: { winner: winner.name, loser: loser.name, damage },
        occurredAt: now,
      });
    }
  }
}

// ─── Yeni klan/bot spawn ────────────────────────────────────────────────────────
let _spawnCounter = 0;
function spawnUid(prefix: string): string {
  return `${prefix}_spawn_${Date.now()}_${++_spawnCounter}`;
}

function randomTendencySpawn(): ClanTendency {
  const r = Math.random();
  if (r < 0.30) return "builder";
  if (r < 0.70) return "farmer";
  return "balanced";
}

const SPAWN_CLAN_NAMES = ["Yeni Şafak", "Bozkır Timi", "Çelik Pençe", "Kızıl Bölük", "Gece Avcıları", "Demir Sürü"];

function createNewClan(state: WorldState, nameIndex: number): EnemyClan {
  const region = state.map.regions[randInt(0, state.map.regions.length - 1)];
  const offset = rand(150, 300);
  const angle = Math.random() * Math.PI * 2;
  const pos: Position = {
    x: region.position.x + Math.cos(angle) * offset,
    y: region.position.y + Math.sin(angle) * offset,
  };
  const clanId = spawnUid("clan");
  const botCount = randInt(2, 3);
  const botIds: string[] = [];
  for (let i = 0; i < botCount; i++) botIds.push(spawnUid("bot"));

  return {
    id: clanId,
    name: SPAWN_CLAN_NAMES[nameIndex % SPAWN_CLAN_NAMES.length],
    color: `hsl(${randInt(0, 360)}, 70%, 50%)`,
    tendency: randomTendencySpawn(),
    base: {
      id: spawnUid("clanbase"), clanId, position: pos,
      hp: 500, maxHp: 500, storage: [], tier: 1, destroyed: false,
    },
    botIds,
  };
}

function createNewBot(clanId: string, basePos: Position, index: number): EnemyBot {
  const angle = (index / 4) * Math.PI * 2;
  const pos: Position = {
    x: basePos.x + Math.cos(angle) * 50,
    y: basePos.y + Math.sin(angle) * 50,
  };
  const personalities: Array<"aggressive" | "coward" | "neutral"> = ["aggressive", "coward", "neutral"];
  // FAZ 3.2 — rastgele rol
  const rRoll = Math.random();
  const botRole: "fighter" | "farmer" | "coward" | "guard" =
    rRoll < 0.35 ? "fighter" : rRoll < 0.60 ? "farmer" : rRoll < 0.85 ? "coward" : "guard";
  return {
    id: spawnUid("bot"), name: ["Savaşçı", "Akıncı", "Muhafız"][index % 3], clanId,
    position: pos, direction: Math.random() * Math.PI * 2,
    hp: 100, maxHp: 100,
    personality: personalities[randInt(0, 2)],
    role: botRole, raidTargetClanId: null, raidTargetPosition: null,
    phase: "idle",
    targetRegionId: null, targetRegionPosition: null, arrivedAt: null,
    farmDuration: 20000, lastLootTick: 0, unloadStarted: null, visitedRegions: [],
    patrolTarget: null, patrolStarted: null, helpTargetPos: null,
    searchStarted: null, chaseStarted: null, hitStunUntil: null,
    carriedLoot: [], equipment: { weapon: null, head: null, body: null, feet: null, tool: null },
    healCooldowns: { bandaj: 0, medical_siringa: 0, buyuk_medkit: 0 },
    targetLootId: null, targetLootPosition: null,
    hidingStarted: null, hidingFleeTarget: null, lastHidingMove: null, lastHidingLook: null,
    isAlive: true, lastTickedAt: Date.now(),
  };
}

// ─── Yıkılma + spawn ───────────────────────────────────────────────────────────
function processDestructionAndSpawn(state: WorldState, events: WorldEventRecord[], now: number): void {
  for (const clan of state.clans) {
    if (clan.base.destroyed) continue;
    const liveBots = clan.botIds.filter(id => state.bots[id]?.isAlive).length;
    if (clan.base.hp <= 0 || liveBots === 0) {
      clan.base.destroyed = true;
      clan.base.hp = 0;
      events.push({
        type: "clan_destroyed",
        description: `${clan.name} yıkıldı`,
        data: { clanName: clan.name },
        occurredAt: now,
      });
    }
  }

  const activeClans = state.clans.filter(c => !c.base.destroyed);
  const destroyedCount = state.clans.length - activeClans.length;

  for (let i = 0; i < destroyedCount; i++) {
    if (activeClans.length + i >= MAX_CLANS) break;
    if (!chance(50)) continue;
    const newClan = createNewClan(state, activeClans.length + i);
    state.clans.push(newClan);
    for (const botId of newClan.botIds) {
      state.bots[botId] = createNewBot(newClan.id, newClan.base.position, i);
    }
    events.push({
      type: "clan_spawned",
      description: `Yeni klan: ${newClan.name}`,
      data: { clanName: newClan.name },
      occurredAt: now,
    });
  }

  // Min klan kontrolü
  let finalActive = state.clans.filter(c => !c.base.destroyed);
  while (finalActive.length < MIN_CLANS) {
    const newClan = createNewClan(state, finalActive.length);
    state.clans.push(newClan);
    for (const botId of newClan.botIds) {
      state.bots[botId] = createNewBot(newClan.id, newClan.base.position, 0);
    }
    finalActive = state.clans.filter(c => !c.base.destroyed);
    events.push({
      type: "clan_spawned",
      description: `Yeni klan: ${newClan.name} (denge)`,
      data: { clanName: newClan.name },
      occurredAt: now,
    });
  }
}

// ─── Senaryo seçimi ────────────────────────────────────────────────────────────
function pickScenario(): string {
  const r = Math.random();
  if (r < 0.25) return "tek_guç";
  if (r < 0.50) return "iki_guç";
  if (r < 0.70) return "dengeli_kaos";
  if (r < 0.85) return "yıkım_dalgası";
  return "tükenme";
}

// ─── Oyuncu base (offline) ──────────────────────────────────────────────────────
function simulatePlayerBase(state: WorldState, simHours: number, events: WorldEventRecord[], now: number): void {
  const hasUpkeep = (state.base.storage.find(s => s.item.id === "metal_parca")?.quantity ?? 0) > 0
    || (state.base.storage.find(s => s.item.id === "odun")?.quantity ?? 0) > 0;
  if (!hasUpkeep && simHours > 0.5) {
    const decay = Math.floor(10 * simHours * (state.base.tier ?? 1));
    state.base.hp = Math.max(0, state.base.hp - decay);
    if (decay > 0) {
      events.push({
        type: "base_decay",
        description: `Üssünüz bakımsızlık nedeniyle ${decay} hasar aldı`,
        data: { damage: decay },
        occurredAt: now,
      });
    }
  }

  let raidChance = 0;
  if (simHours > 2) raidChance = 20;
  if (simHours > 8) raidChance = 40;
  if (simHours > 24) raidChance = 60;
  if (chance(raidChance)) {
    const damage = randInt(50, 200);
    state.base.hp = Math.max(0, state.base.hp - damage);
    events.push({
      type: "base_raid",
      description: `Üssünüz baskına uğradı (-${damage} HP)`,
      data: { damage },
      occurredAt: now,
    });
  }
}

// ─── Ana fonksiyon ──────────────────────────────────────────────────────────────
export function simulateOfflineEvolution(state: WorldState, nowMs: number): OfflineSimResult {
  const elapsed = nowMs - state.lastTickAt;
  const events: WorldEventRecord[] = [];

  // 30dk altı — hiçbir şey
  if (elapsed < MIN_SIM_MS) {
    return { newState: state, events, wiped: false, offlineHours: 0 };
  }

  // 3 gün üstü — wipe
  if (elapsed > WIPE_THRESHOLD_MS) {
    const freshState = createInitialWorldState("wipe_user");
    freshState.lastTickAt = nowMs;
    events.push({
      type: "wipe",
      description: "3 gün doldu — dünya yenilendi (wipe)",
      data: { elapsedHours: elapsed / 3600000 },
      occurredAt: nowMs,
    });
    return { newState: freshState, events, wiped: true, offlineHours: elapsed / 3600000 };
  }

  // Normal sim
  const simHours = Math.min(elapsed / 3600000, MAX_SIM_HOURS);
  const newState: WorldState = JSON.parse(JSON.stringify(state));
  const scenario = pickScenario();

  simulatePlayerBase(newState, simHours, events, nowMs);

  for (const clan of newState.clans) {
    if (!clan.tendency) {
      const r = Math.random();
      clan.tendency = r < 0.30 ? "builder" : r < 0.70 ? "farmer" : "balanced";
    }
    if (clan.base.destroyed) continue;
    farmClan(clan, simHours);
    evolveClanTier(clan, simHours, events, nowMs);
  }

  simulateClanWars(newState, simHours, scenario, events, nowMs);
  processDestructionAndSpawn(newState, events, nowMs);
  newState.lastTickAt = nowMs;

  return { newState, events, wiped: false, offlineHours: simHours };
}
