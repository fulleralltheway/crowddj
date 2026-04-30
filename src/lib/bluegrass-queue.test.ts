import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted to the top of the file, so any references it captures
// must be created via vi.hoisted() (which is also hoisted). Plain `const`
// declarations would fire AFTER the mock factory and trip a TDZ error.
const { mockTrack } = vi.hoisted(() => ({
  mockTrack: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    bluegrassSessionTrack: mockTrack,
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  },
}));

import {
  getNextSessionTrack,
  markCurrentPlayed,
  assignSortOrders,
  hasUnplayed,
} from "./bluegrass-queue";

beforeEach(() => {
  mockTrack.findFirst.mockReset();
  mockTrack.updateMany.mockReset();
  mockTrack.update.mockReset();
  mockTrack.count.mockReset();
});

describe("getNextSessionTrack", () => {
  it("returns null when the queue has no unplayed rows", async () => {
    mockTrack.findFirst.mockResolvedValue(null);
    const r = await getNextSessionTrack("sess1");
    expect(r).toBeNull();
    expect(mockTrack.findFirst).toHaveBeenCalledWith({
      // isPlaying: false excludes the currently-playing row so we don't
      // return the row that's still playing as "next" (queue-bug fix).
      where: { sessionId: "sess1", isPlayed: false, isPlaying: false },
      orderBy: { sortOrder: "asc" },
    });
  });

  it("returns the lowest-sortOrder unplayed row", async () => {
    const row = { id: "t2", sortOrder: 1, isPlayed: false, spotifyUri: "spotify:track:b" };
    mockTrack.findFirst.mockResolvedValue(row);
    const r = await getNextSessionTrack("sess1");
    expect(r).toBe(row);
  });
});

describe("markCurrentPlayed", () => {
  it("flips isPlayed + isPlaying when a matching unplayed row exists", async () => {
    mockTrack.updateMany.mockResolvedValue({ count: 1 });
    const n = await markCurrentPlayed("sess1", "spotify:track:abc");
    expect(n).toBe(1);
    expect(mockTrack.updateMany).toHaveBeenCalledWith({
      where: { sessionId: "sess1", spotifyUri: "spotify:track:abc", isPlayed: false },
      data: { isPlayed: true, isPlaying: false },
    });
  });

  it("returns 0 when no row matches (e.g. Spotify advanced outside the queue)", async () => {
    mockTrack.updateMany.mockResolvedValue({ count: 0 });
    const n = await markCurrentPlayed("sess1", "spotify:track:not-in-queue");
    expect(n).toBe(0);
  });
});

describe("assignSortOrders", () => {
  it("renumbers ids contiguously starting at 0 by default", async () => {
    mockTrack.update.mockImplementation(({ where, data }: { where: { id: string }; data: { sortOrder: number } }) =>
      Promise.resolve({ id: where.id, sortOrder: data.sortOrder })
    );
    await assignSortOrders(["a", "b", "c"]);
    expect(mockTrack.update).toHaveBeenNthCalledWith(1, { where: { id: "a" }, data: { sortOrder: 0 } });
    expect(mockTrack.update).toHaveBeenNthCalledWith(2, { where: { id: "b" }, data: { sortOrder: 1 } });
    expect(mockTrack.update).toHaveBeenNthCalledWith(3, { where: { id: "c" }, data: { sortOrder: 2 } });
  });

  it("renumbers contiguously starting at a custom offset", async () => {
    mockTrack.update.mockResolvedValue({});
    await assignSortOrders(["x", "y"], 10);
    expect(mockTrack.update).toHaveBeenNthCalledWith(1, { where: { id: "x" }, data: { sortOrder: 10 } });
    expect(mockTrack.update).toHaveBeenNthCalledWith(2, { where: { id: "y" }, data: { sortOrder: 11 } });
  });

  it("is a no-op when ids is empty", async () => {
    await assignSortOrders([]);
    expect(mockTrack.update).not.toHaveBeenCalled();
  });
});

describe("hasUnplayed", () => {
  it("returns true when count > 0", async () => {
    mockTrack.count.mockResolvedValue(3);
    expect(await hasUnplayed("sess1")).toBe(true);
  });

  it("returns false when count is 0", async () => {
    mockTrack.count.mockResolvedValue(0);
    expect(await hasUnplayed("sess1")).toBe(false);
  });
});
