/**
 * WorldLoop.ts — Tek bir kullanıcı dünyasının tick döngüsü.
 *
 * Her kullanıcı için bir WorldLoop instance'ı olur.
 * Aktifken her TICK_INTERVAL_MS'de tickWorld() çağırır.
 * Kullanıcı yoksa uyur, döndüğünde lazy sim ile günceller.
 */

import { PrismaClient } from "@prisma/client";
import { WorldState } from "../types/worldState";
import { tickWorld } from "../engine/tickWorld";
import { simulateOfflineEvolution } from "../engine/offlineSimulation";

const prisma = new PrismaClient();

const TICK_INTERVAL_MS = parseInt(process.env.WORLD_TICK_MS ?? "5000", 10);
const SLEEP_AFTER_MS = parseInt(process.env.WORLD_SLEEP_AFTER_MS ?? "1800000", 10); // 30 dk
const DB_SAVE_EVERY_N_TICKS = 6; // Her 6 tick'te bir DB'ye yaz (30 saniye)

export class WorldLoop {
  readonly worldId: string;
  readonly userId: string;

  private state: WorldState;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastActiveAt: number;
  private ticksSinceLastSave = 0;
  public isSleeping = false;

  constructor(worldId: string, userId: string, initialState: WorldState) {
    this.worldId = worldId;
    this.userId = userId;
    this.state = initialState;
    this.lastActiveAt = Date.now();
  }

  // ─── Döngüyü başlat ────────────────────────────────────────────────────────
  start(): void {
    if (this.interval) return; // Zaten çalışıyor
    this.isSleeping = false;

    this.interval = setInterval(() => {
      this.tick().catch((err) => {
        console.error(`[WorldLoop] Tick hatası (world: ${this.worldId}):`, err);
      });
    }, TICK_INTERVAL_MS);

    console.log(`[WorldLoop] Başladı — userId: ${this.userId}`);
  }

  // ─── Döngüyü durdur (uyku) ─────────────────────────────────────────────────
  async sleep(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isSleeping = true;

    // Uyumadan önce DB'ye yaz
    await this.saveToDb(true);
    console.log(`[WorldLoop] Uyudu — userId: ${this.userId}`);
  }

  // ─── Uyanan dünyayı güncelle ───────────────────────────────────────────────
  async wakeUp(): Promise<void> {
    this.lastActiveAt = Date.now();

    if (!this.isSleeping) {
      // Zaten uyanık — sadece lastActive güncelle
      return;
    }

    // DB'den taze state'i yükle
    const world = await prisma.world.findUnique({ where: { id: this.worldId } });
    if (world) {
      const savedState = world.worldState as unknown as WorldState;
      // FAZ 3.2 — Offline evrim simülasyonu (klan tier, savaş, yıkım, spawn)
      // lazySimulate yerine simulateOfflineEvolution — klan gelişimi için
      console.log(`[WorldLoop] Offline evrim sim başlıyor — userId: ${this.userId}`);
      const result = simulateOfflineEvolution(savedState, Date.now());
      this.state = result.newState;
      console.log(`[WorldLoop] Offline evrim tamamlandı — userId: ${this.userId}`);

      // Olayları DB'ye kaydet
      if (result.events.length > 0) {
        try {
          await prisma.worldEvent.createMany({
            data: result.events.map(ev => ({
              worldId: this.worldId,
              type: ev.type,
              description: ev.description,
              data: (ev.data ?? undefined) as object | undefined,
              seenByUser: false,
            })) as any,
          });
        } catch (err) {
          console.error(`[WorldLoop] Event kayıt hatası:`, err);
        }
      }

      // Wipe olduysa DB'yi güncelle
      if (result.wiped) {
        await prisma.world.update({
          where: { id: this.worldId },
          data: { worldState: this.state as object },
        });
      }
    }

    this.start();
  }

  // ─── Kullanıcı aktivitesi bildirimi ───────────────────────────────────────
  onUserActivity(): void {
    this.lastActiveAt = Date.now();
  }

  // ─── Mevcut state snapshot'ı (API için) ──────────────────────────────────
  getState(): WorldState {
    return this.state;
  }

  // ─── State'e dışarıdan değişiklik uygula (oyuncu aksiyonları) ─────────────
  applyAction(changes: Partial<WorldState>): void {
    this.state = { ...this.state, ...changes };
    this.lastActiveAt = Date.now();
  }

  // ─── Tek tick ─────────────────────────────────────────────────────────────
  private async tick(): Promise<void> {
    const now = Date.now();

    // Uyku kontrolü — uzun süredir aktif kullanıcı yoksa uyu
    if (now - this.lastActiveAt > SLEEP_AFTER_MS) {
      await this.sleep();
      return;
    }

    // Dünyayı tick et
    const { newState } = tickWorld(this.state, now);
    this.state = newState;
    this.ticksSinceLastSave++;

    // Periyodik DB kayıt
    if (this.ticksSinceLastSave >= DB_SAVE_EVERY_N_TICKS) {
      await this.saveToDb(false);
      this.ticksSinceLastSave = 0;
    }
  }

  // ─── DB'ye kaydet ─────────────────────────────────────────────────────────
  private async saveToDb(isSleeping: boolean): Promise<void> {
    try {
      await prisma.world.update({
        where: { id: this.worldId },
        data: {
          worldState: this.state as object,
          lastTickAt: new Date(this.state.lastTickAt),
          lastActiveAt: new Date(this.lastActiveAt),
          isSleeping,
          sleepStartAt: isSleeping ? new Date() : null,
          tickCount: { increment: this.ticksSinceLastSave },
        },
      });
    } catch (err) {
      console.error(`[WorldLoop] DB kayıt hatası (world: ${this.worldId}):`, err);
    }
  }
}
