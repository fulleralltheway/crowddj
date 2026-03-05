import { createClient } from "@libsql/client";
import { NextResponse } from "next/server";

export async function GET() {
  const url = (process.env.TURSO_DATABASE_URL || "").trim();
  const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim();
  const info = {
    urlFull: url,
    urlLen: url.length,
    authLen: authToken.length,
    urlCharCodes: Array.from(url).map(c => c.charCodeAt(0)),
  };
  try {
    const client = createClient({ url, authToken });
    const result = await client.execute("SELECT COUNT(*) as cnt FROM User");
    return NextResponse.json({ ok: true, count: result.rows[0]?.cnt, ...info });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message, name: e.name, ...info }, { status: 500 });
  }
}
