"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowUp, Music, Search, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { transitions, variants } from "@/lib/motion";
import { cn } from "@/lib/utils";

const tracks = [
  { id: "1", title: "Tennessee Whiskey", artist: "Chris Stapleton", votes: 48, hot: true, voted: true },
  { id: "2", title: "Wagon Wheel", artist: "Old Crow Medicine Show", votes: 31, hot: false, voted: false },
  { id: "3", title: "Blue Eyes Crying in the Rain", artist: "Willie Nelson", votes: 19, hot: false, voted: false },
  { id: "4", title: "Wake Me Up Before You Go-Go", artist: "Wham!", votes: 14, hot: false, voted: false },
  { id: "5", title: "Take Me Home, Country Roads", artist: "John Denver", votes: 11, hot: false, voted: true },
  { id: "6", title: "Sweet Caroline", artist: "Neil Diamond", votes: 7, hot: false, voted: false },
];

export default function DesignPreviewPage() {
  const [trackList, setTrackList] = useState(tracks);

  function toggleVote(id: string) {
    setTrackList((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, voted: !t.voted, votes: t.voted ? t.votes - 1 : t.votes + 1 }
          : t
      )
    );
  }

  return (
    <div className="min-h-dvh bg-[color:var(--surface-1)]">
      <div className="mx-auto max-w-md px-4 pb-24 pt-10 safe-top">
        {/* ============== VENUE HEADER ============== */}
        <motion.header
          initial="hidden"
          animate="show"
          variants={variants.fadeUp}
          className="mb-8"
        >
          <div className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-[color:var(--bb-blue)]">
            Tonight · Live Queue
          </div>
          <h1 className="mt-2 font-display text-[40px] font-semibold leading-[1.05] tracking-[-0.025em]">
            Bluegrass
            <br />
            Ballroom
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            <span className="font-semibold text-[color:var(--bb-blue)]">74</span>{" "}
            dancing ·{" "}
            <span className="font-semibold text-[color:var(--bb-blue)]">23</span>{" "}
            in queue
          </p>
        </motion.header>

        {/* ============== NOW PLAYING ============== */}
        <motion.section
          initial="hidden"
          animate="show"
          variants={variants.scaleIn}
          className="relative mb-10 overflow-hidden rounded-2xl border border-[color:var(--surface-3)] bg-[color:var(--surface-2)] p-6 shadow-[var(--shadow-glow-blue)]"
        >
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(circle at top right, rgba(0,87,225,0.22), transparent 60%)",
            }}
          />
          <div className="relative">
            <div className="mb-3 flex items-center gap-2 font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-[color:var(--amber)]">
              <motion.span
                animate={{ opacity: [1, 0.4, 1] }}
                transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                className="inline-block h-2 w-2 rounded-full bg-[color:var(--amber)]"
                style={{ boxShadow: "0 0 10px var(--amber)" }}
              />
              Now Playing
            </div>
            <h2 className="font-display text-[26px] font-semibold leading-tight tracking-[-0.015em]">
              Mr. Brightside
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">The Killers</p>

            <div className="mt-5 h-1 overflow-hidden rounded-full bg-[color:var(--surface-4)]">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: "38%" }}
                transition={{ ...transitions.hero, delay: 0.4 }}
                className="h-full rounded-full"
                style={{
                  background:
                    "linear-gradient(90deg, var(--bb-blue), var(--bb-blue-hover))",
                }}
              />
            </div>
            <div className="mt-2 flex justify-between font-mono text-[11px] text-muted-foreground">
              <span>1:23</span>
              <span>3:42</span>
            </div>
          </div>
        </motion.section>

        {/* ============== UP NEXT ============== */}
        <div className="mb-3 flex items-end justify-between">
          <h3 className="font-display text-lg font-medium tracking-tight">
            Up Next
          </h3>
          <span className="font-mono text-xs font-medium uppercase tracking-[0.05em] text-muted-foreground">
            {trackList.length} tracks
          </span>
        </div>

        <div className="space-y-2">
          <AnimatePresence>
            {trackList.map((track, i) => (
              <motion.button
                key={track.id}
                layout
                custom={i}
                variants={variants.listItem(i)}
                initial="hidden"
                animate="show"
                whileTap={{ scale: 0.98 }}
                onClick={() => toggleVote(track.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl border bg-[color:var(--surface-2)] p-3 text-left transition-colors",
                  track.hot
                    ? "border-[color:var(--coral-soft,rgba(245,158,11,0.3))] shadow-[0_0_0_1px_rgba(245,158,11,0.18)]"
                    : "border-transparent hover:border-[color:var(--surface-4)] hover:bg-[color:var(--surface-3)]"
                )}
              >
                <div
                  className={cn(
                    "w-6 shrink-0 text-center font-mono text-sm font-semibold",
                    track.hot
                      ? "text-[color:var(--amber)]"
                      : "text-muted-foreground"
                  )}
                >
                  {track.hot ? "↑" : i + 1}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-medium text-foreground">
                    {track.title}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {track.artist}
                  </div>
                </div>
                <motion.div
                  animate={track.voted ? { scale: [1, 1.18, 1] } : { scale: 1 }}
                  transition={transitions.snap}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 font-mono text-sm font-semibold",
                    track.voted
                      ? "bg-[rgba(245,158,11,0.18)] text-[color:var(--amber)] shadow-[0_0_0_1px_rgba(245,158,11,0.3)]"
                      : "bg-[color:var(--surface-3)] text-foreground"
                  )}
                >
                  <ArrowUp
                    className={cn(
                      "h-3.5 w-3.5",
                      track.voted && "fill-current"
                    )}
                  />
                  {track.votes}
                </motion.div>
              </motion.button>
            ))}
          </AnimatePresence>
        </div>

        {/* ============== ACTIONS ============== */}
        <motion.div
          initial="hidden"
          animate="show"
          variants={variants.fadeUp}
          transition={{ delay: 0.3 }}
          className="mt-8 flex gap-2"
        >
          <Dialog>
            <DialogTrigger asChild>
              <Button className="flex-1" size="lg">
                <Music className="h-4 w-4" />
                Add to Queue
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Request a Track</DialogTitle>
                <DialogDescription>
                  Search Spotify and add it to tonight&apos;s queue.
                </DialogDescription>
              </DialogHeader>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Song or artist..."
                  className="pl-10"
                  autoFocus
                />
              </div>
              <DialogFooter>
                <Button variant="outline">Cancel</Button>
                <Button variant="accent">Search</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Button variant="outline" size="lg">
            Browse
          </Button>
        </motion.div>

        {/* ============== COMPONENT GALLERY ============== */}
        <motion.div
          initial="hidden"
          animate="show"
          variants={variants.fadeIn}
          transition={{ delay: 0.5 }}
          className="mt-16 space-y-6"
        >
          <h3 className="font-display text-base font-semibold text-muted-foreground">
            Component Gallery
          </h3>

          <Card>
            <CardHeader>
              <CardTitle>Buttons</CardTitle>
              <CardDescription>
                Bluegrass blue = primary / host / venue. Amber = action / energy / heat.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button>Primary</Button>
              <Button variant="accent">Accent</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="link">Link</Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Sizes</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2">
              <Button size="sm">Small</Button>
              <Button>Default</Button>
              <Button size="lg">Large</Button>
              <Button size="icon" aria-label="Sparkles">
                <Sparkles className="h-4 w-4" />
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Inputs</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input placeholder="Default input" />
              <Input placeholder="Disabled" disabled />
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Type Scale</CardTitle>
              <CardDescription>
                Inter (display + body) + JetBrains Mono (data)
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.05em] text-muted-foreground">
                  Display · Inter 800
                </div>
                <div className="font-display text-[36px] font-bold leading-[1.05] tracking-[-0.025em]">
                  Bluegrass Ballroom
                </div>
              </div>
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.05em] text-muted-foreground">
                  H1 · Inter 700
                </div>
                <div className="font-display text-[26px] font-semibold tracking-[-0.02em]">
                  Tennessee Whiskey
                </div>
              </div>
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.05em] text-muted-foreground">
                  Body · Inter 400
                </div>
                <div className="text-[15px] text-muted-foreground">
                  Vote songs up to push them higher in the queue.
                </div>
              </div>
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.05em] text-muted-foreground">
                  Mono · JetBrains 500
                </div>
                <div className="font-mono text-sm font-medium">
                  ROOM · BLUEGRASS · 23 TRACKS
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        <p className="mt-12 text-center text-xs text-muted-foreground">
          design-preview · click votes / open dialog / try the buttons
        </p>
      </div>
    </div>
  );
}
