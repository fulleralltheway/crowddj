import { PrismaClient } from "@/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    let url = process.env.TURSO_DATABASE_URL || "file:prisma/dev.db";
    const authToken = process.env.TURSO_AUTH_TOKEN;
    // Convert libsql:// to https:// for compatibility with web transport
    if (url.startsWith("libsql://")) {
      url = url.replace("libsql://", "https://");
    }
    const adapter = new PrismaLibSql(authToken ? { url, authToken } : { url });
    const prisma = new PrismaClient({ adapter });
    const userCount = await prisma.user.count();
    await prisma.$disconnect();
    return NextResponse.json({ ok: true, userCount, url: url.substring(0, 30) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message, stack: e.stack?.split("\n").slice(0, 5) }, { status: 500 });
  }
}
