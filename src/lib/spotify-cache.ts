/**
 * Tiny in-process cache for Spotify Web API responses we re-fetch a lot.
 * Lives on the Vercel serverless instance — survives across warm
 * invocations of the same Lambda, gone on cold starts. That's fine; the
 * goal is to throttle bursts when one user reloads the picker repeatedly
 * or when fade-transitions keep refetching the same playlist mid-class.
 *
 * Per-user keys so caches don't bleed across accounts. Per-resource TTLs
 * match real-world change rates: playlists ~5min, devices ~30s, playlist
 * tracks ~5min.
 */

type CacheEntry<T> = { value: T; expiresAt: number };

const PLAYLIST_LIST_TTL_MS = 5 * 60 * 1000;
const DEVICES_TTL_MS = 30 * 1000;
const PLAYLIST_TRACKS_TTL_MS = 5 * 60 * 1000;

const playlistListCache = new Map<string, CacheEntry<unknown>>();
const devicesCache = new Map<string, CacheEntry<unknown>>();
const playlistTracksCache = new Map<string, CacheEntry<unknown>>();

function get<T>(map: Map<string, CacheEntry<unknown>>, key: string): T | null {
  const e = map.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    map.delete(key);
    return null;
  }
  return e.value as T;
}

function set<T>(map: Map<string, CacheEntry<unknown>>, key: string, value: T, ttlMs: number) {
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export async function cachedPlaylistList<T>(userId: string, fetcher: () => Promise<T>): Promise<T> {
  const cached = get<T>(playlistListCache, userId);
  if (cached !== null) return cached;
  const fresh = await fetcher();
  set(playlistListCache, userId, fresh, PLAYLIST_LIST_TTL_MS);
  return fresh;
}

export async function cachedDevices<T>(userId: string, fetcher: () => Promise<T>): Promise<T> {
  const cached = get<T>(devicesCache, userId);
  if (cached !== null) return cached;
  const fresh = await fetcher();
  set(devicesCache, userId, fresh, DEVICES_TTL_MS);
  return fresh;
}

export async function cachedPlaylistTracks<T>(playlistId: string, fetcher: () => Promise<T>): Promise<T> {
  // Keyed by playlistId — playlists are public-or-shared so different users
  // hitting the same playlist share the cache. Saves repeated fetches when
  // multiple sessions use the same set list.
  const cached = get<T>(playlistTracksCache, playlistId);
  if (cached !== null) return cached;
  const fresh = await fetcher();
  set(playlistTracksCache, playlistId, fresh, PLAYLIST_TRACKS_TTL_MS);
  return fresh;
}

/** Forced invalidation hooks for when the user changes a playlist mid-session. */
export function invalidatePlaylistList(userId: string) {
  playlistListCache.delete(userId);
}
export function invalidatePlaylistTracks(playlistId: string) {
  playlistTracksCache.delete(playlistId);
}
