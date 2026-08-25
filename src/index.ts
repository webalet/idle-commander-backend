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
