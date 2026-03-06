import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

// In-memory reaction store (resets on cold start, which is fine for ephemeral reactions)
const reactions: Map<string, { emoji: string; count: number; timestamp: number }[]> = new Map();

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const { emoji } = await req.json();

  const allowed = ["🔥", "❤️", "😍", "🎵", "👏", "💀"];
  if (!allowed.includes(emoji)) {
    return NextResponse.json({ error: "Invalid emoji" }, { status: 400 });
  }

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || !room.isActive) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  if (!reactions.has(code)) reactions.set(code, []);
  const roomReactions = reactions.get(code)!;

  // Clean old reactions (older than 10 seconds)
  const now = Date.now();
  while (roomReactions.length > 0 && roomReactions[0].timestamp < now - 10000) {
    roomReactions.shift();
  }

  roomReactions.push({ emoji, count: 1, timestamp: now });

  return NextResponse.json({ success: true });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;

  const roomReactions = reactions.get(code) || [];
  const now = Date.now();

  // Return reactions from last 10 seconds, grouped
  const recent = roomReactions.filter((r) => r.timestamp > now - 10000);
  const grouped: Record<string, number> = {};
  recent.forEach((r) => {
    grouped[r.emoji] = (grouped[r.emoji] || 0) + 1;
  });

  return NextResponse.json(grouped);
}
