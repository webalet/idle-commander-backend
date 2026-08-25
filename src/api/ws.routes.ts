/**
 * ws.routes.ts — WebSocket endpoint'i.
 *
 * GET /ws → WebSocket bağlantısı (JWT query param'da)
 * Client bağlanınca world state push'lanır, her tick'te güncelleme gönderilir.
 */

import { FastifyInstance } from "fastify";
import { worldManager } from "../world/WorldManager";

export async function wsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/ws", { websocket: true }, (socket, request) => {
    // JWT token query'den al
    const token = (request.query as { token?: string }).token;
    if (!token) {
      socket.close(1008, "Token gerekli");
      return;
    }

    // Token doğrula
    let payload: { userId: string; username: string };
    try {
      payload = fastify.jwt.verify(token) as typeof payload;
    } catch {
      socket.close(1008, "Geçersiz token");
      return;
    }

    const userId = payload.userId;
    console.log(`[WS] Bağlandı — userId: ${userId}`);

    // İlk state'i gönder
    worldManager.getOrCreate(userId).then((loop) => {
      socket.send(JSON.stringify({
        type: "state",
        state: loop.getState(),
      }));

      // Periyodik state push — her 2 saniyede
      const pushInterval = setInterval(() => {
        if (socket.readyState !== 1) {
          clearInterval(pushInterval);
          return;
        }
        try {
          socket.send(JSON.stringify({
            type: "state",
            state: loop.getState(),
          }));
        } catch {
          clearInterval(pushInterval);
        }
      }, 2000);

      socket.on("close", () => {
        clearInterval(pushInterval);
        console.log(`[WS] Kapandı — userId: ${userId}`);
      });
    });
  });
}
