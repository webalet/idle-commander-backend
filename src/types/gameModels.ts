/**
 * gameModels.ts — Sunucu tarafı oyun modelleri.
 * Client'taki models/ klasöründeki tiplerin React/Expo bağımlılığı olmayan kopyası.
 * Bu dosya hem sunucuda hem ileride shared package olarak client'ta kullanılabilir.
 */

// ─── Pozisyon ─────────────────────────────────────────────────────────────────
export interface Position {
  x: number;
  y: number;
}

// ─── Harita ───────────────────────────────────────────────────────────────────
export type RegionType = "forest" | "industrial" | "urban" | "special";
export type RegionRisk = "low" | "medium" | "high" | "extreme";

export interface MapRegion {
  id: string;
  name: string;
  type: RegionType;
  risk: RegionRisk;
  position: Position;
  radius: number;
  blobPath: string;
  isDiscovered: boolean;
  lootMultiplier: number;
}

export interface GameMap {
  seed: string;
  width: number;
  height: number;
  landPolygon: string;
  terrainPatches: Array<{
    id: string;
    type: string;
    points: string;
  }>;
  heightContours: Array<{
    threshold: number;
    paths: string[];
    fillColor: string;
    strokeColor: string;
  }>;
  rivers: Array<{
    id: string;
    points: Array<{ x: number; y: number }>;
    widths: number[];
  }>;
  regions: MapRegion[];
  base: { position: Position; hp: number; maxHp: number };
  trees: Array<{ id: string; x: number; y: number; size: number; maxHp: number }>;
  rocks: Array<{ id: string; x: number; y: number; size: number; maxHp: number }>;
  wipeStartTime: number;
  wipeEndTime: number;
}

// ─── Item ─────────────────────────────────────────────────────────────────────
export interface WeaponStats {
  damage: number;
  range: "melee" | "ranged";
  optimalRange?: number;
  fireRate?: number;
}

export interface ArmorStats {
  defense: number;
  bulletResist: number;
  meleeResist: number;
  explosiveResist: number;
}

export interface ItemDefinition {
  id: string;
  name: string;
  category: string;
  stackable: boolean;
  maxStack: number;
  weight?: number;
  equipSlot?: string | null;
  weaponStats?: WeaponStats | null;
  armorStats?: ArmorStats | null;
}

export interface InventorySlot {
  item: ItemDefinition;
  quantity: number;
}

// ─── Bot Ekipman ─────────────────────────────────────────────────────────────
export interface BotEquipment {
  weapon: ItemDefinition | null;
  head: ItemDefinition | null;
  body: ItemDefinition | null;
  feet: ItemDefinition | null;
  tool: ItemDefinition | null;   // FAZ 3.2 — gather aleti
}

// ─── Bot Phase & Personality ─────────────────────────────────────────────────
export type EnemyBotPhase =
  | "idle" | "patrol" | "moving_to_region" | "farming"
  | "moving_home" | "loot_pickup" | "fleeing" | "fleeing_to_hide"
  | "hiding" | "chasing_player" | "responding_to_help"
  | "searching" | "unloading" | "bot_vs_bot" | "raiding" | "dead";

export type BotPersonality = "aggressive" | "coward" | "neutral";

// FAZ 3.2 — Bot rolü (karakter derinliği)
export type BotRole = "fighter" | "farmer" | "coward" | "guard";

// ─── EnemyBot ─────────────────────────────────────────────────────────────────
export interface EnemyBot {
  id: string;
  name: string;
  clanId: string;
  position: Position;
  direction: number;
  hp: number;
  maxHp: number;
  personality: BotPersonality;
  role: BotRole;                    // FAZ 3.2 — bot rolü
  raidTargetClanId: string | null;  // FAZ 3.2 — raid hedefi
  raidTargetPosition: Position | null;
  phase: EnemyBotPhase;
  targetRegionId: string | null;
  targetRegionPosition: Position | null;
  arrivedAt: number | null;
  farmDuration: number;
  lastLootTick: number;
  unloadStarted: number | null;
  visitedRegions: string[];
  patrolTarget: Position | null;
  patrolStarted: number | null;
  helpTargetPos: Position | null;
  searchStarted: number | null;
  chaseStarted: number | null;
  hitStunUntil: number | null;
  carriedLoot: InventorySlot[];
  equipment: BotEquipment;
  healCooldowns: {
    bandaj: number;
    medical_siringa: number;
    buyuk_medkit: number;
  };
  targetLootId: string | null;
  targetLootPosition: Position | null;
  hidingStarted: number | null;
  hidingFleeTarget: Position | null;
  lastHidingMove: number | null;
  lastHidingLook: number | null;
  isAlive: boolean;
  // Sunucu tarafı ek alanlar
  lastTickedAt: number;
}

// ─── Klan Eğilimi (offline evrim için) ────────────────────────────────────────
export type ClanTendency = "builder" | "farmer" | "balanced";

// ─── Clan Base ────────────────────────────────────────────────────────────────
export interface ClanBase {
  id: string;
  clanId: string;
  position: Position;
  hp: number;
  maxHp: number;
  storage: InventorySlot[];
  tier: 1 | 2 | 3 | 4 | 5;       // Klan base tier'ı (offline evrim)
  destroyed?: boolean;            // Yıkıldı mı (kurukafa gösterimi)
}

// ─── Enemy Clan ───────────────────────────────────────────────────────────────
export interface EnemyClan {
  id: string;
  name: string;
  color: string;
  base: ClanBase;
  botIds: string[];
  tendency?: ClanTendency;        // Klan eğilimi (builder/farmer/balanced)
}
