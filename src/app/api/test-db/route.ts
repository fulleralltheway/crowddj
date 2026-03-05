import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const userCount = await prisma.user.count();
    return NextResponse.json({ ok: true, userCount });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message, stack: e.stack }, { status: 500 });
  }
}
