/**
 * worldFactory.ts — Yeni kullanıcı için başlangıç dünya state'i oluşturur.
 *
 * Harita: Sunucuda basit/deterministik üretim.
 * Client, ilk bağlandığında haritayı daha zengin şekilde üretebilir ve
 * sunucuya gönderebilir — bu geçici bir başlangıç haritasıdır.
 */

import { WorldState, ServerPlayer, ServerBase } from "../types/worldState";
import {
  EnemyBot,
  EnemyClan,
  GameMap,
  MapRegion,
  Position,
  BotPersonality,
  BotRole,
} from "../types/gameModels";

const MAP_WIDTH = 3000;
const MAP_HEIGHT = 3000;
const WIPE_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 gün

// ─── Klan isimleri havuzu ─────────────────────────────────────────────────────
const CLAN_NAMES = [
  "Demir Yumruk", "Çelik Klan", "Kuzey Ordusu",
  "Karanlık Bölük", "Ateş Taburu", "Gölge Timi",
];

const BOT_NAMES = [
  "Savaşçı", "Akıncı", "Muhafız", "Avcı", "Keskin Nişancı",
  "Komando", "Raider", "Süvari", "Piyade", "Fedai",
];

const PERSONALITIES: BotPersonality[] = ["aggressive", "coward", "neutral", "neutral"];

// ─── Basit ID üretici ─────────────────────────────────────────────────────────
let _idCounter = 0;
function uid(prefix = "id"): string {
  return `${prefix}_${Date.now()}_${++_idCounter}`;
}

// ─── Rastgele pozisyon (harita içinde) ───────────────────────────────────────
function randPos(margin = 300): Position {
  return {
    x: margin + Math.random() * (MAP_WIDTH - margin * 2),
    y: margin + Math.random() * (MAP_HEIGHT - margin * 2),
  };
}

// ─── Başlangıç haritası ───────────────────────────────────────────────────────
function createInitialMap(seed: string): GameMap {
  const basePos: Position = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 };

  const regions: MapRegion[] = [
    {
      id: "region_forest_1",
      name: "Kuzey Ormanı",
      type: "forest",
      risk: "low",
      position: { x: 600, y: 600 },
      radius: 250,
      blobPath: "",
      isDiscovered: false,
      lootMultiplier: 1,
    },
    {
      id: "region_forest_2",
      name: "Güney Ormanı",
      type: "forest",
      risk: "low",
      position: { x: 2400, y: 2400 },
      radius: 250,
      blobPath: "",
      isDiscovered: false,
      lootMultiplier: 1,
    },
    {
      id: "region_industrial_1",
      name: "Fabrika Bölgesi",
      type: "industrial",
      risk: "medium",
      position: { x: 2200, y: 700 },
      radius: 300,
      blobPath: "",
      isDiscovered: false,
      lootMultiplier: 1.5,
    },
    {
      id: "region_industrial_2",
      name: "Maden Ocağı",
      type: "industrial",
      risk: "medium",
      position: { x: 800, y: 2200 },
      radius: 280,
      blobPath: "",
      isDiscovered: false,
      lootMultiplier: 1.5,
    },
    {
      id: "region_urban_1",
      name: "Şehir Harabeleri",
      type: "urban",
      risk: "high",
      position: { x: 1500, y: 800 },
      radius: 350,
      blobPath: "",
      isDiscovered: false,
      lootMultiplier: 2,
    },
    {
      id: "region_urban_2",
      name: "Eski Kasaba",
      type: "urban",
      risk: "high",
      position: { x: 1500, y: 2200 },
      radius: 300,
      blobPath: "",
      isDiscovered: false,
      lootMultiplier: 2,
    },
    {
      id: "region_special_1",
      name: "Askeri Üs",
      type: "special",
      risk: "extreme",
      position: { x: 2500, y: 1500 },
      radius: 400,
      blobPath: "",
      isDiscovered: false,
      lootMultiplier: 3,
    },
  ];

  const wipeStart = Date.now();

  return {
    seed,
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    landPolygon: `0,0 ${MAP_WIDTH},0 ${MAP_WIDTH},${MAP_HEIGHT} 0,${MAP_HEIGHT}`,
    terrainPatches: [],
    heightContours: [],
    rivers: [],
    regions,
    base: { position: basePos, hp: 600, maxHp: 600 },
    trees: [],
    rocks: [],
    wipeStartTime: wipeStart,
    wipeEndTime: wipeStart + WIPE_DURATION_MS,
  };
}

// ─── Bot oluştur ──────────────────────────────────────────────────────────────
function createBot(
  clanId: string,
  basePos: Position,
  index: number,
): EnemyBot {
  const id = uid("bot");
  const now = Date.now();

  // Base etrafında başlangıç pozisyonu
  const angle = (index / 8) * Math.PI * 2;
  const radius = 50 + Math.random() * 100;
  const startPos: Position = {
    x: basePos.x + Math.cos(angle) * radius,
    y: basePos.y + Math.sin(angle) * radius,
  };

  // FAZ 3.2 — rastgele rol
  const roleRoll = Math.random();
  const botRole: BotRole = roleRoll < 0.35 ? "fighter" : roleRoll < 0.60 ? "farmer" : roleRoll < 0.85 ? "coward" : "guard";

  return {
    id,
    name: BOT_NAMES[index % BOT_NAMES.length],
    clanId,
    position: startPos,
    direction: Math.random() * Math.PI * 2,
    hp: 100,
    maxHp: 100,
    personality: PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)],
    role: botRole,
    raidTargetClanId: null,
    raidTargetPosition: null,
    phase: "idle",
    targetRegionId: null,
    targetRegionPosition: null,
    arrivedAt: null,
    farmDuration: 20000,
    lastLootTick: 0,
    unloadStarted: null,
    visitedRegions: [],
    patrolTarget: null,
    patrolStarted: null,
    helpTargetPos: null,
    searchStarted: null,
    chaseStarted: null,
    hitStunUntil: null,
    carriedLoot: [],
    equipment: { weapon: null, head: null, body: null, feet: null, tool: null },
    healCooldowns: { bandaj: 0, medical_siringa: 0, buyuk_medkit: 0 },
    targetLootId: null,
    targetLootPosition: null,
    hidingStarted: null,
    hidingFleeTarget: null,
    lastHidingMove: null,
    lastHidingLook: null,
    isAlive: true,
    lastTickedAt: now,
  };
}

// ─── Klan eğilimi ataması ─────────────────────────────────────────────────────
function randomTendency(): "builder" | "farmer" | "balanced" {
  const r = Math.random();
  if (r < 0.30) return "builder";
  if (r < 0.70) return "farmer";
  return "balanced";
}

// ─── Klan oluştur ─────────────────────────────────────────────────────────────
function createClan(
  nameIndex: number,
  basePos: Position,
  botCount: number,
): { clan: EnemyClan; bots: EnemyBot[] } {
  const clanId = uid("clan");
  const bots: EnemyBot[] = [];

  for (let i = 0; i < botCount; i++) {
    bots.push(createBot(clanId, basePos, i));
  }

  const clan: EnemyClan = {
    id: clanId,
    name: CLAN_NAMES[nameIndex % CLAN_NAMES.length],
    color: `hsl(${(nameIndex * 60) % 360}, 70%, 50%)`,
    tendency: randomTendency(),
    base: {
      id: uid("clanbase"),
      clanId,
      position: basePos,
      hp: 500,
      maxHp: 500,
      storage: [],
      tier: 1,
      destroyed: false,
    },
    botIds: bots.map((b) => b.id),
  };

  return { clan, bots };
}

// ─── Ana fabrika ──────────────────────────────────────────────────────────────
export function createInitialWorldState(userId: string): WorldState {
  const now = Date.now();
  const seed = `world_${userId}_${now}`;
  const map = createInitialMap(seed);

  // Oyuncu
  const player: ServerPlayer = {
    id: uid("player"),
    name: "Komutan",
    position: { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 },
    direction: -Math.PI / 2,
    hp: 100,
    maxHp: 100,
    bodyZoneHp: { head: 15, body: 55, arms: 15, legs: 15 },
    hunger: 100,
    thirst: 100,
    isAlive: true,
    skills: {
      combat: 1, building: 1, navigation: 1,
      survival: 1, carrying: 1, awareness: 1,
    },
    inventory: { slots: [], maxSlots: 24 },
    equipment: { weapon: null, head: null, body: null, feet: null, tool: null },
    status: "idle",
    bedPosition: null,
  };

  // Oyuncu base'i
  const base: ServerBase = {
    hp: 600,
    maxHp: 600,
    tier: 1,
    position: { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 },
    storage: [],
    modules: [],
    lastRepairAt: null,
    lastAttackedAt: null,
  };

  // 4-5 klan oluştur, her biri 2-5 bot
  // Klan pozisyonlarını bölgelerin yakınına koy — suya düşmesinler
  // (basit harita kara olduğu için bölge pozisyonları güvenli)
  const regionPositions = map.regions.map((r) => r.position);
  const clanConfigs = [
    { botCount: 2, pos: regionPositions[0] ?? randPos() },
    { botCount: 3, pos: regionPositions[1] ?? randPos() },
    { botCount: 4, pos: regionPositions[2] ?? randPos() },
    { botCount: 5, pos: regionPositions[3] ?? randPos() },
    { botCount: 2, pos: regionPositions[4] ?? randPos() },
  ];

  const allClans: EnemyClan[] = [];
  const allBots: Record<string, EnemyBot> = {};

  for (let i = 0; i < clanConfigs.length; i++) {
    const { clan, bots } = createClan(i, clanConfigs[i].pos, clanConfigs[i].botCount);
    allClans.push(clan);
    for (const bot of bots) {
      allBots[bot.id] = bot;
    }
  }

  const wipeStart = now;

  return {
    map,
    player,
    base,
    bots: allBots,
    clans: allClans,
    droppedLoots: [],
    combat: {
      inCombat: false,
      enemies: [],
      round: 0,
      startedAt: null,
    },
    activeCommands: {},
    wipeStartTime: wipeStart,
    wipeEndTime: wipeStart + WIPE_DURATION_MS,
    lastTickAt: now,
  };
}
