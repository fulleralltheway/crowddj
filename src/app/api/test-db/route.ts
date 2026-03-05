import { PrismaClient } from "@/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const url = process.env.TURSO_DATABASE_URL!;
    const authToken = process.env.TURSO_AUTH_TOKEN!;
    const adapter = new PrismaLibSql({ url, authToken });
    const prisma = new PrismaClient({ adapter });
    const userCount = await prisma.user.count();
    return NextResponse.json({ ok: true, userCount, url: url.substring(0, 30) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message, name: e.name }, { status: 500 });
  }
}
