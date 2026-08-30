/**
 * world.routes.ts — Dünya state ve aksiyon endpoint'leri.
 *
 * GET  /world/state       → Kullanıcının mevcut dünya state'ini döndür
 * POST /world/action      → Oyuncu aksiyonu uygula (komut ver, item kullan vb.)
 * GET  /world/events      → Okunmamış olayları listele
 * POST /world/map         → Client'tan harita yükle (ilk açılışta)
 */

import { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { worldManager } from "../world/WorldManager";
import { prisma } from "../db/prisma";

// JWT payload tipi
interface JwtPayload {
  userId: string;
  username: string;
}

// Aksiyon şeması
const actionSchema = z.object({
  type: z.enum([
    "move_player",
    "give_command",
    "use_item",
    "deposit_loot",
    "upgrade_base",
  ]),
  payload: z.record(z.unknown()),
});

export async function worldRoutes(fastify: FastifyInstance): Promise<void> {
  // Tüm /world route'ları JWT gerektiriyor
  // İSTİSNA: /world/sync?beacon=TOKEN — sendBeacon header gönderemediği için
  // token query'de gelir, manuel doğrulanır (sayfa kapanışı kaydı için)
  fastify.addHook("onRequest", async (request, reply) => {
    // Beacon isteği mi? Query'de beacon token varsa manuel doğrula
    const beaconToken = (request.query as { beacon?: string } | null)?.beacon;
    if (beaconToken && request.url.startsWith("/world/sync")) {
      try {
        const payload = fastify.jwt.verify(beaconToken) as JwtPayload;
        (request as { user: JwtPayload }).user = payload;
        return; // Doğrulandı — hook'tan çık
      } catch {
        return reply.code(401).send({ error: "Giriş yapmanız gerekiyor." });
      }
    }

    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "Giriş yapmanız gerekiyor." });
    }
  });

  // ─── GET /world/state ───────────────────────────────────────────────────
  fastify.get("/world/state", async (request, reply) => {
    const { userId } = request.user as JwtPayload;

    const loop = await worldManager.getOrCreate(userId);
    const state = loop.getState();

    // Son aktivite güncelle
    loop.onUserActivity();

    return reply.send({ state });
  });

  // ─── POST /world/action ─────────────────────────────────────────────────
  fastify.post("/world/action", async (request, reply) => {
    const { userId } = request.user as JwtPayload;

    const parsed = actionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const loop = await worldManager.getOrCreate(userId);
    loop.onUserActivity();

    const { type, payload } = parsed.data;

    // Aksiyona göre state güncelle
    switch (type) {
      case "move_player": {
        const pos = payload as { x: number; y: number };
        const state = loop.getState();
        loop.applyAction({
          player: {
            ...state.player,
            position: { x: pos.x, y: pos.y },
          },
        });
        break;
      }

      case "deposit_loot": {
        // Oyuncunun envanterindeki itemları base deposuna aktar
        const state = loop.getState();
        const newStorage = [...state.base.storage, ...state.player.inventory.slots];
        loop.applyAction({
          base: { ...state.base, storage: newStorage },
          player: {
            ...state.player,
            inventory: { ...state.player.inventory, slots: [] },
          },
        });
        break;
      }

      // Diğer aksiyonlar ilerleyen aşamalarda eklenecek
      default:
        return reply.code(400).send({ error: `Bilinmeyen aksiyon: ${type}` });
    }

    const newState = loop.getState();
    return reply.send({ state: newState });
  });

  // ─── GET /world/events ──────────────────────────────────────────────────
  fastify.get("/world/events", async (request, reply) => {
    const { userId } = request.user as JwtPayload;

    // Kullanıcının world ID'sini bul
    const world = await prisma.world.findUnique({ where: { userId } });
    if (!world) {
      return reply.code(404).send({ error: "Dünya bulunamadı." });
    }

    const events = await prisma.worldEvent.findMany({
      where: { worldId: world.id, seenByUser: false },
      orderBy: { occurredAt: "asc" },
      take: 50,
    });

    // Olayları görüldü olarak işaretle
    if (events.length > 0) {
      await prisma.worldEvent.updateMany({
        where: { id: { in: events.map((e) => e.id) } },
        data: { seenByUser: true },
      });
    }

    return reply.send({ events });
  });

  // ─── POST /world/sync ─────────────────────────────────────────────────────
  // Client periyodik olarak bot/clan state'ini gönderir, sunucu kaydeder
  // Bu sayede oyunu kapatınca client'taki son state sunucuda kalır
  fastify.post("/world/sync", async (request, reply) => {
    const { userId } = request.user as JwtPayload;

    const body = request.body as {
      bots?: unknown;
      clans?: unknown;
      player?: unknown;
      base?: unknown;
    };

    const loop = await worldManager.getOrCreate(userId);
    const currentState = loop.getState();

    const updates: Record<string, unknown> = {};
    if (body.bots) updates.bots = body.bots;
    if (body.clans) updates.clans = body.clans;
    // Player'ı tamamen değiştirme — MERGE et.
    // Client kısmi player gönderir (position, hp, inventory, equipment, skills).
    // direction, bedPosition, bodyZoneHp gibi alanlar kaybolmasın diye mevcut
    // state ile birleştir.
    if (body.player) {
      updates.player = { ...currentState.player, ...(body.player as object) };
    }
    if (body.base) updates.base = body.base;

    if (Object.keys(updates).length > 0) {
      loop.applyAction(updates);
      loop.onUserActivity();
    }

    return reply.send({ ok: true });
  });

  // ─── POST /world/map ─────────────────────────────────────────────────────
  // Client haritayı + klanları + botları üretip buraya gönderir (ilk açılışta)
  // Sunucu bunları kaydeder, sonraki açılışlarda aynı veriyi döndürür
  fastify.post("/world/map", async (request, reply) => {
    const { userId } = request.user as JwtPayload;

    const body = request.body as {
      map: unknown;
      clans?: unknown;
      bots?: unknown;
    };
    if (!body?.map) {
      return reply.code(400).send({ error: "Harita verisi eksik." });
    }

    const loop = await worldManager.getOrCreate(userId);
    const state = loop.getState();

    // Güncellenecek alanları topla
    const updates: Record<string, unknown> = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map: body.map as any,
    };

    // Klanlar ve botlar geldiyse onları da kaydet
    if (body.clans) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updates.clans = body.clans as any;
    }
    if (body.bots) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updates.bots = body.bots as any;
    }

    loop.applyAction(updates);
    loop.onUserActivity();

    return reply.send({ ok: true });
  });
}
