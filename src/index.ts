/**
 * index.ts — Sunucu giriş noktası.
 * Fastify başlatır, route'ları kaydeder, WorldManager'ı ayağa kaldırır.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import websocket from "@fastify/websocket";
import dotenv from "dotenv";

import { authRoutes } from "./api/auth.routes";
import { worldRoutes } from "./api/world.routes";
import { wsRoutes } from "./api/ws.routes";
import { worldManager } from "./world/WorldManager";

dotenv.config();

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const JWT_SECRET = process.env.JWT_SECRET ?? "fallback-secret-change-in-production";

const fastify = Fastify({
  logger: {
    level: process.env.NODE_ENV === "production" ? "warn" : "info",
  },
});

async function bootstrap(): Promise<void> {
  // ─── Plugin'ler ─────────────────────────────────────────────────────────
  await fastify.register(cors, {
    origin: true, // Geliştirmede tüm origin'lere izin ver
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  });

  await fastify.register(jwt, {
    secret: JWT_SECRET,
  });

  await fastify.register(websocket);

  // ─── Health check ────────────────────────────────────────────────────────
  fastify.get("/health", async () => ({
    status: "ok",
    activeWorlds: worldManager.activeCount,
    totalWorlds: worldManager.totalCount,
    uptime: process.uptime(),
  }));

  // ─── Admin: Veritabanını sıfırla (tüm kullanıcılar + dünyalar) ────────────
  // Korumalı: ADMIN_SECRET env değişkeni ile. Railway'de set et.
  // Çağrı: POST /admin/wipe  body: { "secret": "..." } veya { "ADMIN_SECRET": "..." }
  fastify.post("/admin/wipe", async (request, reply) => {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret) {
      return reply.code(503).send({ error: "ADMIN_SECRET env tanımlı değil — Railway Variables'tan ekle" });
    }
    const body = request.body as { secret?: string; ADMIN_SECRET?: string } | null;
    const provided = body?.secret ?? body?.ADMIN_SECRET;
    if (!provided || provided !== adminSecret) {
      return reply.code(403).send({ error: "Yetkisiz — secret yanlış" });
    }

    try {
      const { PrismaClient } = await import("@prisma/client");
      const prisma = new PrismaClient();

      const deletedEvents = await prisma.worldEvent.deleteMany({});
      const deletedWorlds = await prisma.world.deleteMany({});
      const deletedUsers = await prisma.user.deleteMany({});

      await prisma.$disconnect();

      // Aktif dünyaları bellekten de temizle
      await worldManager.shutdownAll();

      return {
        success: true,
        deleted: {
          events: deletedEvents.count,
          worlds: deletedWorlds.count,
          users: deletedUsers.count,
        },
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "Sıfırlama hatası", detail: String(err) });
    }
  });

  // ─── Route'lar ───────────────────────────────────────────────────────────
  await fastify.register(authRoutes);
  await fastify.register(worldRoutes);
  await fastify.register(wsRoutes);

  // ─── Sunucuyu başlat ─────────────────────────────────────────────────────
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`[Server] Çalışıyor → http://localhost:${PORT}`);
  console.log(`[Server] Ortam: ${process.env.NODE_ENV ?? "development"}`);
}

// ─── Düzgün kapanma ──────────────────────────────────────────────────────────
async function shutdown(): Promise<void> {
  console.log("\n[Server] Kapatılıyor...");
  await worldManager.shutdownAll();
  await fastify.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ─── Başlat ──────────────────────────────────────────────────────────────────
bootstrap().catch((err) => {
  console.error("[Server] Başlatma hatası:", err);
  process.exit(1);
});
