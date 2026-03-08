const SPOTIFY_API = "https://api.spotify.com/v1";

export async function getSpotifyToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(
        `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
      ).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || "Failed to refresh token");
  return data.access_token;
}

export async function getUserPlaylists(accessToken: string) {
  const res = await fetch(`${SPOTIFY_API}/me/playlists?limit=50`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Failed to fetch playlists");
  const data = await res.json();
  return data.items;
}

export async function searchPlaylists(accessToken: string, query: string) {
  const res = await fetch(
    `${SPOTIFY_API}/search?q=${encodeURIComponent(query)}&type=playlist&limit=10`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error("Failed to search playlists");
  const data = await res.json();
  return data.playlists.items;
}

export async function getPlaylistTracks(accessToken: string, playlistId: string) {
  const tracks = [];
  let url: string | null = `${SPOTIFY_API}/playlists/${playlistId}/tracks?limit=100`;

  while (url) {
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error("Failed to fetch playlist tracks");
    const data = await res.json();
    tracks.push(...data.items);
    url = data.next;
  }

  return tracks
    .filter((item: any) => item.track && !item.track.is_local && item.track.name)
    .map((item: any) => ({
      spotifyUri: item.track.uri,
      trackName: item.track.name,
      artistName: item.track.artists.map((a: any) => a.name).join(", "),
      albumArt: item.track.album.images?.[0]?.url || null,
      durationMs: item.track.duration_ms,
      previewUrl: item.track.preview_url || null,
    }));
}

export async function searchTracks(accessToken: string, query: string) {
  const res = await fetch(
    `${SPOTIFY_API}/search?q=${encodeURIComponent(query)}&type=track&limit=10`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error("Failed to search tracks");
  const data = await res.json();
  return data.tracks.items.map((track: any) => ({
    spotifyUri: track.uri,
    trackName: track.name,
    artistName: track.artists.map((a: any) => a.name).join(", "),
    albumArt: track.album.images?.[0]?.url || null,
    durationMs: track.duration_ms,
    previewUrl: track.preview_url || null,
    isExplicit: track.explicit ?? false,
  }));
}

export async function startPlayback(
  accessToken: string,
  uris: string[],
  deviceId?: string,
  positionMs?: number
) {
  const body: any = { uris };
  if (positionMs !== undefined) body.position_ms = positionMs;
  const params = deviceId ? `?device_id=${deviceId}` : "";
  const res = await fetch(`${SPOTIFY_API}/me/player/play${params}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 204) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || "Failed to start playback");
  }
}

export async function pausePlayback(accessToken: string) {
  const res = await fetch(`${SPOTIFY_API}/me/player/pause`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 204) throw new Error("Failed to pause");
}

export async function resumePlayback(accessToken: string) {
  const res = await fetch(`${SPOTIFY_API}/me/player/play`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 204) throw new Error("Failed to resume");
}

export async function skipToNext(accessToken: string) {
  const res = await fetch(`${SPOTIFY_API}/me/player/next`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 204) throw new Error("Failed to skip");
}

export async function addToQueue(accessToken: string, uri: string) {
  const res = await fetch(
    `${SPOTIFY_API}/me/player/queue?uri=${encodeURIComponent(uri)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (!res.ok && res.status !== 204) throw new Error("Failed to add to queue");
}

export async function getDevices(accessToken: string) {
  const res = await fetch(`${SPOTIFY_API}/me/player/devices`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.devices || [];
}

export async function setVolume(accessToken: string, volumePercent: number) {
  const vol = Math.max(0, Math.min(100, Math.round(volumePercent)));
  const res = await fetch(`${SPOTIFY_API}/me/player/volume?volume_percent=${vol}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 204) throw new Error("Failed to set volume");
}

export async function getCurrentPlayback(accessToken: string) {
  const res = await fetch(`${SPOTIFY_API}/me/player`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error("Failed to get playback");
  return res.json();
}

export async function getAudioFeatures(
  accessToken: string,
  trackIds: string[]
): Promise<({ id: string; tempo: number; energy: number; danceability: number } | null)[]> {
  if (trackIds.length === 0) return [];

  const results: ({ id: string; tempo: number; energy: number; danceability: number } | null)[] = [];

  // Batch in chunks of 100 (Spotify API limit)
  for (let i = 0; i < trackIds.length; i += 100) {
    const batch = trackIds.slice(i, i + 100);
    const ids = batch.join(",");
    try {
      const res = await fetch(`${SPOTIFY_API}/audio-features?ids=${ids}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        // Push nulls for failed batch
        results.push(...batch.map(() => null));
        continue;
      }
      const data = await res.json();
      for (const feature of data.audio_features) {
        if (feature) {
          results.push({
            id: feature.id,
            tempo: feature.tempo,
            energy: feature.energy,
            danceability: feature.danceability,
          });
        } else {
          results.push(null);
        }
      }
    } catch {
      results.push(...batch.map(() => null));
    }
  }

  return results;
}
