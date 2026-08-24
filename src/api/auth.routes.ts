/**
 * auth.routes.ts — Kayıt ve giriş endpoint'leri.
 *
 * POST /auth/register  → yeni kullanıcı oluştur
 * POST /auth/login     → JWT token döndür
 */

import { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../db/prisma";

const registerSchema = z.object({
  username: z.string().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/, "Sadece harf, rakam ve alt çizgi"),
  password: z.string().min(6, "Şifre en az 6 karakter"),
});

const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // ─── POST /auth/register ────────────────────────────────────────────────
  fastify.post("/auth/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten().fieldErrors });
    }

    const { username, password } = parsed.data;

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      return reply.code(409).send({ error: "Bu kullanıcı adı zaten alınmış." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { username, passwordHash },
    });

    const token = fastify.jwt.sign(
      { userId: user.id, username: user.username },
      { expiresIn: process.env.JWT_EXPIRES_IN ?? "7d" }
    );

    return reply.code(201).send({
      token,
      user: { id: user.id, username: user.username },
    });
  });

  // ─── POST /auth/login ───────────────────────────────────────────────────
  fastify.post("/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Geçersiz giriş bilgileri." });
    }

    const { username, password } = parsed.data;

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      return reply.code(401).send({ error: "Kullanıcı adı veya şifre hatalı." });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return reply.code(401).send({ error: "Kullanıcı adı veya şifre hatalı." });
    }

    const token = fastify.jwt.sign(
      { userId: user.id, username: user.username },
      { expiresIn: process.env.JWT_EXPIRES_IN ?? "7d" }
    );

    return reply.send({
      token,
      user: { id: user.id, username: user.username },
    });
  });
}
