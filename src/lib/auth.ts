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
].join(" ");

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [
    SpotifyProvider({
      clientId: process.env.SPOTIFY_CLIENT_ID!,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET!,
      authorization: `https://accounts.spotify.com/authorize?scope=${encodeURIComponent(scopes)}`,
    }),
  ],
  callbacks: {
    async session({ session, user }) {
      session.user.id = user.id;

      // Get Spotify access token
      const account = await prisma.account.findFirst({
        where: { userId: user.id, provider: "spotify" },
      });

      if (account) {
        // Check if token is expired
        if (account.expires_at && account.expires_at * 1000 < Date.now()) {
          try {
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
                refresh_token: account.refresh_token!,
              }),
            });

            const tokens = await res.json();

            if (res.ok) {
              await prisma.account.update({
                where: { id: account.id },
                data: {
                  access_token: tokens.access_token,
                  expires_at: Math.floor(Date.now() / 1000 + tokens.expires_in),
                  refresh_token: tokens.refresh_token ?? account.refresh_token,
                },
              });
              (session as any).accessToken = tokens.access_token;
            }
          } catch {
            // Token refresh failed
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
  },
});
