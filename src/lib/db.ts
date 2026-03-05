import { PrismaClient } from "@/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { createClient } from "@libsql/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function createPrismaClient() {
  const url = process.env.TURSO_DATABASE_URL || "file:prisma/dev.db";
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const client = createClient(authToken ? { url, authToken } : { url });
  const adapter = new PrismaLibSql(client);
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma || createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
