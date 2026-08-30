/**
 * wipe-db.ts — Tüm veritabanını sıfırlar
 * 
 * Kullanıcılar, dünyalar ve olaylar silinir.
 * Yeni hesap açıp sıfırdan harita oluşturmak için.
 * 
 * Çalıştırma: npx ts-node scripts/wipe-db.ts
 */

import { PrismaClient } from "@prisma/client";
import * as dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

async function wipeDatabase(): Promise<void> {
  console.log("⚠️  Veritabanı sıfırlanıyor...");

  // WorldEvent → World → User sırasıyla sil (foreign key bağımlılığı)
  // User silince World cascade ile silinir, WorldEvent'ler de worldId ile.
  // En güvenli: önce WorldEvent, sonra World, sonra User.

  const deletedEvents = await prisma.worldEvent.deleteMany({});
  console.log(`✓ WorldEvent silindi: ${deletedEvents.count} kayıt`);

  const deletedWorlds = await prisma.world.deleteMany({});
  console.log(`✓ World silindi: ${deletedWorlds.count} kayıt`);

  const deletedUsers = await prisma.user.deleteMany({});
  console.log(`✓ User silindi: ${deletedUsers.count} kayıt`);

  console.log("\n✅ Veritabanı tamamen sıfırlandı!");
  console.log("Artık yeni hesap açıp sıfırdan harita oluşturabilirsin.");
}

wipeDatabase()
  .catch((err) => {
    console.error("❌ Hata:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
