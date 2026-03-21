import NextAuth from "next-auth";
import SpotifyProvider from "next-auth/providers/spotify";
import { PrismaAdapter } from "./prisma-adapter";
import { prisma } from "./db";

const scopes = [
  "user-read-email",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "streaming",
  "playlist-modify-private",
].join(" ");

// In-memory lock to prevent concurrent token refreshes from racing
// and revoking each other's refresh tokens via Spotify's token rotation
let refreshPromise: Promise<{ access_token: string; expires_at: number; refresh_token: string } | null> | null = null;

async function refreshSpotifyToken(accountId: string, refreshToken: string) {
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

  const tokens = await res.json();

  if (res.ok) {
    const newData = {
      access_token: tokens.access_token as string,
      expires_at: Math.floor(Date.now() / 1000 + tokens.expires_in),
      refresh_token: (tokens.refresh_token ?? refreshToken) as string,
    };
    await prisma.account.update({
      where: { id: accountId },
      data: newData,
    });
    return newData;
  }

  console.error("[auth] Spotify token refresh failed:", res.status, JSON.stringify(tokens));
  if (tokens.error === "invalid_grant") {
    return null; // token revoked
  }
  return null;
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  basePath: "/api/auth",
  adapter: PrismaAdapter(prisma),
  providers: [
    SpotifyProvider({
      clientId: process.env.SPOTIFY_CLIENT_ID!,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET!,
      authorization: `https://accounts.spotify.com/authorize?scope=${encodeURIComponent(scopes)}`,
      allowDangerousEmailAccountLinking: true,
    }),
  ],
  callbacks: {
    async session({ session, user }) {
      session.user.id = user.id;

      const account = await prisma.account.findFirst({
        where: { userId: user.id, provider: "spotify" },
      });

      if (account) {
        if (account.expires_at && account.expires_at * 1000 < Date.now()) {
          // Token expired — refresh with deduplication so concurrent
          // requests don't race and revoke each other's tokens
          try {
            if (!refreshPromise) {
              refreshPromise = refreshSpotifyToken(account.id, account.refresh_token!)
                .finally(() => { refreshPromise = null; });
            }
            const result = await refreshPromise;
            if (result) {
              (session as any).accessToken = result.access_token;
            } else {
              (session as any).tokenError = "RefreshTokenRevoked";
            }
          } catch (err) {
            console.error("[auth] Spotify token refresh error:", err);
          }
        } else {
          (session as any).accessToken = account.access_token;
        }
      }

      return session;
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
});
