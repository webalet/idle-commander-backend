/**
 * WorldState — Sunucudaki tek bir kullanıcı dünyasının tüm state'i.
 * Bu tip hem DB'ye JSON olarak yazılır hem de tickWorld() tarafından kullanılır.
 * Zustand store'larının sunucu karşılığı.
 */

import { EnemyBot, EnemyClan, GameMap, InventorySlot, ItemDefinition } from "./gameModels";

// Re-export — dışarıdan tek yerden import edilebilsin
export type { InventorySlot, ItemDefinition };

// ─── Oyuncu State ────────────────────────────────────────────────────────────
export interface ServerPlayer {
  id: string;
  name: string;
  position: { x: number; y: number };
  direction: number;
  hp: number;
  maxHp: number;
  bodyZoneHp: { head: number; body: number; arms: number; legs: number };
  hunger: number;
  thirst: number;
  isAlive: boolean;
  skills: {
    combat: number;
    building: number;
    navigation: number;
    survival: number;
    carrying: number;
    awareness: number;
  };
  inventory: { slots: InventorySlot[]; maxSlots: number };
  equipment: {
    weapon: ItemDefinition | null;
    head: ItemDefinition | null;
    body: ItemDefinition | null;
    feet: ItemDefinition | null;
  };
  status: string;
  bedPosition: { x: number; y: number } | null;
}

// ─── Oyuncu Base ─────────────────────────────────────────────────────────────
export interface BaseModule {
  id: string;
  type: string;
  furnaceQueue?: Array<{
    inputItemId: string;
    quantity: number;
    startedAt: number;
  }>;
}

export interface ServerBase {
  hp: number;
  maxHp: number;
  tier: 1 | 2 | 3 | 4 | 5;
  position: { x: number; y: number };
  storage: InventorySlot[];
  modules: BaseModule[];
  lastRepairAt: number | null;
  lastAttackedAt: number | null;
}

// ─── Dropped Loot ────────────────────────────────────────────────────────────
export interface ServerDroppedLoot {
  id: string;
  position: { x: number; y: number };
  items: InventorySlot[];
  droppedAt: number;
}

// ─── Savaş State ─────────────────────────────────────────────────────────────
export interface ServerCombatState {
  inCombat: boolean;
  enemies: Array<{
    id: string;
    hp: number;
    maxHp: number;
    isDead: boolean;
    position: { x: number; y: number };
  }>;
  round: number;
  startedAt: number | null;
}

// ─── Aktif Komutlar ──────────────────────────────────────────────────────────
export interface ServerActiveCommand {
  id: string;
  characterId: string;
  type: string;
  status: "active" | "completed" | "failed";
  startTime: number;
  estimatedDuration: number;
  targetRegionId?: string | null;
}

// ─── Ana WorldState ──────────────────────────────────────────────────────────
export interface WorldState {
  // Harita — wipe başında bir kez üretilir, tick'te değişmez
  map: GameMap;

  // Oyuncu
  player: ServerPlayer;

  // Oyuncunun base'i
  base: ServerBase;

  // Düşman botlar (id → bot)
  bots: Record<string, EnemyBot>;

  // Düşman klanları
  clans: EnemyClan[];

  // Haritada düşen lootlar
  droppedLoots: ServerDroppedLoot[];

  // Aktif savaş durumu
  combat: ServerCombatState;

  // Aktif komutlar (oyuncu karakterlerinin görevleri)
  activeCommands: Record<string, ServerActiveCommand>;

  // Wipe bilgisi
  wipeStartTime: number;
  wipeEndTime: number;

  // Son tick zamanı — lazy sim için kullanılır
  lastTickAt: number;
}

// ─── Tick sonucu — ne değişti ────────────────────────────────────────────────
export interface WorldDelta {
  botUpdates: Array<{ botId: string; changes: Partial<EnemyBot> }>;
  lootChanges: Array<{ type: "add" | "remove"; loot: ServerDroppedLoot }>;
  baseChanges: Partial<ServerBase> | null;
  playerChanges: Partial<ServerPlayer> | null;
  combatEvents: CombatEvent[];
  newEvents: WorldEventRecord[];
}

export interface CombatEvent {
  type: "damage" | "kill" | "flee";
  targetId: string;
  amount?: number;
  at: number;
}

export interface WorldEventRecord {
  type: string;
  description: string;
  data?: Record<string, unknown>;
  occurredAt: number;
}
