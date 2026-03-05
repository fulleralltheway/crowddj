import { createClient } from "@libsql/client";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const url = process.env.TURSO_DATABASE_URL!;
    const authToken = process.env.TURSO_AUTH_TOKEN!;
    const client = createClient({ url, authToken });
    const result = await client.execute("SELECT COUNT(*) as cnt FROM User");
    return NextResponse.json({ ok: true, count: result.rows[0]?.cnt, urlPrefix: url.substring(0, 40) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message, name: e.name }, { status: 500 });
  }
}
