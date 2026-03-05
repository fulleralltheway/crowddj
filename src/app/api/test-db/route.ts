import { NextResponse } from "next/server";

export async function GET() {
  const tursoUrl = process.env.TURSO_DATABASE_URL || "(not set)";
  const hasAuth = !!process.env.TURSO_AUTH_TOKEN;
  const dbUrl = process.env.DATABASE_URL || "(not set)";
  return NextResponse.json({
    tursoUrl: tursoUrl.substring(0, 30) + "...",
    hasAuthToken: hasAuth,
    databaseUrl: dbUrl.substring(0, 30) + "...",
  });
}
