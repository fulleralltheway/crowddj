import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { hostname: "i.scdn.co" },
      { hostname: "mosaic.scdn.co" },
      { hostname: "image-cdn-ak.spotifycdn.com" },
      { hostname: "image-cdn-fa.spotifycdn.com" },
    ],
  },
};

export default nextConfig;
