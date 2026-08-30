/**
 * WorldManager.ts — Tüm aktif dünyaları yöneten merkezi sınıf.
 *
 * Sunucu başlayınca tek bir WorldManager instance'ı oluşturulur.
 * Her kullanıcı giriş yaptığında getOrCreate() çağrılır.
 * Dünya memory'de tutulur, periyodik olarak DB'ye yazılır.
 */

import { PrismaClient } from "@prisma/client";
import { WorldLoop } from "./WorldLoop";
import { WorldState } from "../types/worldState";
import { createInitialWorldState } from "./worldFactory";
import { simulateOfflineEvolution } from "../engine/offlineSimulation";

const prisma = new PrismaClient();

export class WorldManager {
  // userId → WorldLoop eşlemesi
  private worlds = new Map<string, WorldLoop>();

  // ─── Kullanıcının dünyasını getir veya oluştur ──────────────────────────
  async getOrCreate(userId: string): Promise<WorldLoop> {
    // Bellekte zaten var mı?
    const existing = this.worlds.get(userId);
    if (existing) {
      existing.onUserActivity();
      // Uyuyorsa uyandır
      if (existing.isSleeping) {
        await existing.wakeUp();
      }
      return existing;
    }

    // DB'den yükle
    let world = await prisma.world.findUnique({ where: { userId } });

    if (world) {
      // Mevcut dünyayı yükle
      let state = world.worldState as unknown as WorldState;

      // FAZ 3.1 — Offline klan evrimi simülasyonu
      // Son tick'ten bu yana uzun süre geçmişse istatistiksel sim çalıştır
      const lastTick = state.lastTickAt ?? 0;
      const elapsed = Date.now() - lastTick;
      const STALE_THRESHOLD = 5 * 60 * 1000; // 5 dk'dan fazla geçmişse simüle et

      if (elapsed > STALE_THRESHOLD) {
        console.log(`[WorldManager] Stale world — offline evrim sim başlıyor (elapsed: ${Math.round(elapsed/1000)}s)`);
        const result = simulateOfflineEvolution(state, Date.now());
        state = result.newState;

        // Olayları DB'ye kaydet (WorldEvent tablosu)
        if (result.events.length > 0) {
          try {
            await prisma.worldEvent.createMany({
              data: result.events.map(ev => ({
                worldId: world.id,
                type: ev.type,
                description: ev.description,
                data: (ev.data ?? undefined) as object | undefined,
                seenByUser: false,
              })) as any,
            });
          } catch (err) {
            console.error("[WorldManager] Event kayıt hatası:", err);
          }
        }

        // Wipe olduysa DB'yi güncelle
        if (result.wiped) {
          await prisma.world.update({
            where: { id: world.id },
            data: {
              worldState: state as object,
              lastTickAt: new Date(state.lastTickAt),
              wipeStartTime: new Date(state.wipeStartTime),
              wipeEndTime: new Date(state.wipeEndTime),
            },
          });
        }
      }

      const loop = new WorldLoop(world.id, userId, state);

      if (elapsed > STALE_THRESHOLD) {
        await loop.wakeUp();
      } else {
        loop.start();
      }

      this.worlds.set(userId, loop);
      return loop;
    }

    // Yeni dünya oluştur
    const initialState = createInitialWorldState(userId);

    const newWorld = await prisma.world.create({
      data: {
        userId,
        worldState: initialState as object,
        wipeStartTime: new Date(initialState.wipeStartTime),
        wipeEndTime: new Date(initialState.wipeEndTime),
        lastTickAt: new Date(initialState.lastTickAt),
        lastActiveAt: new Date(),
      },
    });

    const loop = new WorldLoop(newWorld.id, userId, initialState);
    loop.start();
    this.worlds.set(userId, loop);

    console.log(`[WorldManager] Yeni dünya oluşturuldu — userId: ${userId}`);
    return loop;
  }

  // ─── Kullanıcının dünyasını doğrudan al (yoksa null) ───────────────────
  get(userId: string): WorldLoop | null {
    return this.worlds.get(userId) ?? null;
  }

  // ─── Sunucu kapanırken tüm dünyaları kaydet ─────────────────────────────
  async shutdownAll(): Promise<void> {
    console.log(`[WorldManager] Sunucu kapanıyor — ${this.worlds.size} dünya kaydediliyor...`);
    const promises: Promise<void>[] = [];
    for (const loop of this.worlds.values()) {
      promises.push(loop.sleep());
    }
    await Promise.all(promises);
    console.log("[WorldManager] Tüm dünyalar kaydedildi.");
  }

  // ─── Aktif dünya sayısı (monitoring için) ─────────────────────────────
  get activeCount(): number {
    return [...this.worlds.values()].filter((w) => !w.isSleeping).length;
  }

  get totalCount(): number {
    return this.worlds.size;
  }
}

// Singleton — tüm uygulama bu instance'ı kullanır
export const worldManager = new WorldManager();
