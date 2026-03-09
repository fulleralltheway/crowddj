"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LoginContent() {
  const searchParams = useSearchParams();
  const error = searchParams.get("error");

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-4 select-none">
      <div className="max-w-sm w-full text-center space-y-8 lg:max-w-md lg:bg-bg-card/50 lg:backdrop-blur-xl lg:border lg:border-white/[0.06] lg:rounded-3xl lg:p-10 lg:shadow-[0_8px_32px_rgba(0,0,0,0.3)]">
        <div className="space-y-2">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent/10 mb-4 lg:w-20 lg:h-20 lg:rounded-3xl">
            <svg className="w-8 h-8 text-accent lg:w-10 lg:h-10" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
            </svg>
          </div>
          <h1 className="text-3xl font-bold lg:text-4xl">PartyQueue</h1>
          <p className="text-text-secondary lg:text-lg">
            Connect your Spotify to start hosting
          </p>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-sm text-red-400">
            Sign in failed. Please try again.
          </div>
        )}

        <button
          onClick={() => signIn("spotify", { callbackUrl: "/dashboard" })}
          className="w-full py-3.5 bg-[#1DB954] hover:bg-[#1ed760] text-black font-semibold rounded-xl transition-colors flex items-center justify-center gap-3 lg:py-4 lg:text-base lg:rounded-2xl"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
          </svg>
          Sign in with Spotify
        </button>

        <a href="/" className="block text-text-secondary text-sm hover:text-white transition-colors">
          Back to home
        </a>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}
