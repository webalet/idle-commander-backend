/**
 * botEngine.server.ts — Sunucu tarafı bot tick motoru.
 *
 * Client'taki botEngine.ts'in Zustand bağımlılığından arındırılmış versiyonu.
 * Hiçbir React/Zustand import'u yok.
 * Input: WorldState (mevcut durum)
 * Output: BotUpdate[] (ne değişti)
 *
 * tickAllBots() → her bot için tickBot() çağırır → değişiklikleri toplar → döndürür
 */

import {
  EnemyBot,
  EnemyClan,
  GameMap,
  MapRegion,
  Position,
  InventorySlot,
  ItemDefinition,
} from "../types/gameModels";
import { WorldState, ServerDroppedLoot } from "../types/worldState";

// ─── Sabitler ─────────────────────────────────────────────────────────────────
const GRID_SIZE = 150;
const LOOT_TICK_MS = 8000;
const PATROL_DURATION_MS = 15000;
const FLEE_RANGE = GRID_SIZE * 3;
const CHASE_RANGE = GRID_SIZE * 2;
const COMBAT_GRID_RANGE = GRID_SIZE * 1.5;
const BOT_STEP = 4; // px per tick

// ─── Çıktı tipleri ────────────────────────────────────────────────────────────
export interface BotUpdate {
  botId: string;
  changes: Partial<EnemyBot>;
}

export interface EngineResult {
  botUpdates: BotUpdate[];
  newLoots: ServerDroppedLoot[];
  removedLootIds: string[];
}

// ─── Yardımcı: iki nokta arası mesafe ────────────────────────────────────────
function dist(a: Position, b: Position): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// ─── Yardımcı: adım at ───────────────────────────────────────────────────────
function stepToward(
  from: Position,
  to: Position,
): { pos: Position; direction: number; arrived: boolean } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= BOT_STEP) {
    return { pos: { ...to }, direction: Math.atan2(dy, dx), arrived: true };
  }
  return {
    pos: { x: from.x + (dx / d) * BOT_STEP, y: from.y + (dy / d) * BOT_STEP },
    direction: Math.atan2(dy, dx),
    arrived: false,
  };
}

// ─── Yardımcı: kaçış adımı ───────────────────────────────────────────────────
function stepAwayFrom(from: Position, threat: Position): { pos: Position; direction: number } {
  const dx = from.x - threat.x;
  const dy = from.y - threat.y;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  const dir = Math.atan2(dy, dx);
  return {
    pos: { x: from.x + (dx / d) * BOT_STEP, y: from.y + (dy / d) * BOT_STEP },
    direction: dir,
  };
}

// ─── Yardımcı: bölge seç ─────────────────────────────────────────────────────
function pickRegion(regions: MapRegion[], botPos: Position, visited: string[]): MapRegion {
  const unvisited = regions.filter((r) => !visited.includes(r.id));
  const pool = unvisited.length > 0 ? unvisited : regions;
  // En yakın 3'ünden rastgele birini seç
  const sorted = [...pool].sort((a, b) => dist(botPos, a.position) - dist(botPos, b.position));
  const candidates = sorted.slice(0, 3);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ─── Yardımcı: farm süresi ───────────────────────────────────────────────────
function farmDuration(type: string): number {
  const durations: Record<string, number> = {
    forest: 20000,
    industrial: 25000,
    urban: 30000,
    special: 40000,
  };
  return durations[type] ?? 20000;
}

// ─── Yardımcı: patrol noktası ────────────────────────────────────────────────
function pickPatrolPoint(basePos: Position): Position {
  const angle = Math.random() * Math.PI * 2;
  const radius = 100 + Math.random() * 200;
  return {
    x: basePos.x + Math.cos(angle) * radius,
    y: basePos.y + Math.sin(angle) * radius,
  };
}

// ─── Yardımcı: basit loot roll ───────────────────────────────────────────────
function rollLoot(regionType: string): InventorySlot | null {
  // %40 ihtimalle loot düşür
  if (Math.random() > 0.4) return null;

  const lootTables: Record<string, Array<{ id: string; name: string }>> = {
    forest: [
      { id: "odun", name: "Odun" },
      { id: "tas", name: "Taş" },
    ],
    industrial: [
      { id: "metal_parca", name: "Metal Parça" },
      { id: "metal_cevheri", name: "Metal Cevheri" },
    ],
    urban: [
      { id: "metal_parca", name: "Metal Parça" },
      { id: "hqm_cevheri", name: "HQM Cevheri" },
    ],
    special: [
      { id: "yuksek_kalite_metal", name: "Yüksek Kalite Metal" },
      { id: "elektrik_devresi", name: "Elektrik Devresi" },
    ],
  };

  const table = lootTables[regionType] ?? lootTables["forest"];
  const picked = table[Math.floor(Math.random() * table.length)];
  const qty = 1 + Math.floor(Math.random() * 5);

  const item: ItemDefinition = {
    id: picked.id,
    name: picked.name,
    category: "resource",
    stackable: true,
    maxStack: 1000,
  };

  return { item, quantity: qty };
}

// ─── Bot öncelik sistemi — düşük MS = daha sık tick ──────────────────────────
function getBotTickInterval(bot: EnemyBot): number {
  if (bot.phase === "chasing_player" || bot.phase === "fleeing") return 200;   // 200ms
  if (bot.phase === "farming" || bot.phase === "patrol") return 2000;          // 2s
  if (bot.phase === "idle" || bot.phase === "unloading") return 5000;          // 5s
  return 1000; // diğer fazlar 1s
}

// ─── Tek bot tick ─────────────────────────────────────────────────────────────
export function tickBot(
  bot: EnemyBot,
  state: WorldState,
  now: number,
): { update: BotUpdate | null; newLoot: ServerDroppedLoot | null; removeLootId: string | null } {
  if (!bot.isAlive || bot.phase === "dead") {
    return { update: null, newLoot: null, removeLootId: null };
  }

  // Öncelik kontrolü — bu bot'un tick zamanı gelmedi mi?
  const interval = getBotTickInterval(bot);
  if (now - (bot.lastTickedAt ?? 0) < interval) {
    return { update: null, newLoot: null, removeLootId: null };
  }

  const clan = state.clans.find((c) => c.id === bot.clanId);
  if (!clan || !state.map) {
    return { update: null, newLoot: null, removeLootId: null };
  }

  const basePos = clan.base.position;
  let changes: Partial<EnemyBot> = { lastTickedAt: now };
  let newLoot: ServerDroppedLoot | null = null;
  let removeLootId: string | null = null;

  switch (bot.phase) {
    case "idle": {
      const regions = state.map.regions;
      if (!regions || regions.length === 0) break;

      // %60 patrol, %40 bölgeye git
      if (Math.random() < 0.6) {
        changes = {
          ...changes,
          phase: "patrol",
          patrolTarget: pickPatrolPoint(basePos),
          patrolStarted: now,
        };
        break;
      }

      const target = pickRegion(regions, bot.position, bot.visitedRegions ?? []);
      changes = {
        ...changes,
        phase: "moving_to_region",
        targetRegionId: target.id,
        targetRegionPosition: target.position,
        arrivedAt: null,
        farmDuration: farmDuration(target.type),
        lastLootTick: 0,
        carriedLoot: [],
        visitedRegions: [...(bot.visitedRegions ?? []).slice(-2), target.id],
      };
      break;
    }

    case "patrol": {
      if (!bot.patrolTarget || !bot.patrolStarted) {
        changes = { ...changes, phase: "idle" };
        break;
      }
      if (now - bot.patrolStarted >= PATROL_DURATION_MS) {
        changes = { ...changes, phase: "idle", patrolTarget: null, patrolStarted: null };
        break;
      }
      const { pos, direction, arrived } = stepToward(bot.position, bot.patrolTarget);
      changes = { ...changes, position: pos, direction };
      if (arrived) {
        if (Math.random() < 0.4) {
          changes = { ...changes, phase: "idle", patrolTarget: null, patrolStarted: null };
        } else {
          changes = { ...changes, patrolTarget: pickPatrolPoint(basePos) };
        }
      }
      break;
    }

    case "moving_to_region": {
      if (!bot.targetRegionPosition) {
        changes = { ...changes, phase: "idle" };
        break;
      }
      const { pos, direction, arrived } = stepToward(bot.position, bot.targetRegionPosition);
      changes = { ...changes, position: pos, direction };
      if (arrived) {
        changes = { ...changes, phase: "farming", arrivedAt: now, lastLootTick: now };
      }
      break;
    }

    case "farming": {
      if (!bot.arrivedAt) {
        changes = { ...changes, phase: "idle" };
        break;
      }
      if (now - (bot.lastLootTick ?? 0) >= LOOT_TICK_MS) {
        const regionType =
          state.map.regions.find((r) => r.id === bot.targetRegionId)?.type ?? "forest";
        const loot = rollLoot(regionType);
        if (loot) {
          const existing = bot.carriedLoot.find(
            (s) => s.item.id === loot.item.id && loot.item.stackable,
          );
          const newCarried = existing
            ? bot.carriedLoot.map((s) =>
                s.item.id === loot.item.id
                  ? { ...s, quantity: Math.min(s.quantity + loot.quantity, loot.item.maxStack) }
                  : s,
              )
            : [...bot.carriedLoot, loot];
          changes = { ...changes, carriedLoot: newCarried, lastLootTick: now };
        } else {
          changes = { ...changes, lastLootTick: now };
        }
      }
      if (now - bot.arrivedAt >= bot.farmDuration) {
        changes = { ...changes, phase: "moving_home", targetRegionId: null, targetRegionPosition: null };
      }
      break;
    }

    case "moving_home": {
      const { pos, direction, arrived } = stepToward(bot.position, basePos);
      changes = { ...changes, position: pos, direction };
      if (arrived) {
        changes = { ...changes, phase: "unloading", position: basePos, unloadStarted: now };
      }
      break;
    }

    case "unloading": {
      if (!bot.unloadStarted) {
        changes = { ...changes, unloadStarted: now };
        break;
      }
      if (now - bot.unloadStarted >= 1500) {
        // Taşınan lootları klan base deposuna aktar (klan state değişikliği ayrıca işlenir)
        changes = {
          ...changes,
          phase: "idle",
          arrivedAt: null,
          unloadStarted: null,
          lastLootTick: 0,
          targetRegionId: null,
          targetRegionPosition: null,
          carriedLoot: [],
        };
      }
      break;
    }

    case "fleeing": {
      const playerPos = state.player.position;
      const fleeD = dist(bot.position, playerPos);
      if (fleeD > FLEE_RANGE * 2) {
        changes = { ...changes, phase: "moving_home" };
        break;
      }
      const { pos, direction } = stepAwayFrom(bot.position, playerPos);
      changes = { ...changes, position: pos, direction };
      break;
    }

    case "searching": {
      if (!bot.searchStarted) {
        changes = { ...changes, phase: "moving_home" };
        break;
      }
      if (now - bot.searchStarted >= 10000) {
        changes = { ...changes, phase: "idle", searchStarted: null };
        break;
      }
      // Küçük rastgele hareket
      const wobble: Position = {
        x: bot.position.x + (Math.random() - 0.5) * 30,
        y: bot.position.y + (Math.random() - 0.5) * 30,
      };
      const sw = stepToward(bot.position, wobble);
      changes = { ...changes, position: sw.pos, direction: sw.direction };
      break;
    }

    // Diğer fazlar için temel davranış
    default: {
      changes = { ...changes, phase: "idle" };
      break;
    }
  }

  return {
    update: { botId: bot.id, changes },
    newLoot,
    removeLootId,
  };
}

// ─── Tüm botları tick et ──────────────────────────────────────────────────────
export function tickAllBots(state: WorldState, now: number): EngineResult {
  const botUpdates: BotUpdate[] = [];
  const newLoots: ServerDroppedLoot[] = [];
  const removedLootIds: string[] = [];

  for (const bot of Object.values(state.bots)) {
    const result = tickBot(bot, state, now);
    if (result.update) botUpdates.push(result.update);
    if (result.newLoot) newLoots.push(result.newLoot);
    if (result.removeLootId) removedLootIds.push(result.removeLootId);
  }

  return { botUpdates, newLoots, removedLootIds };
}
