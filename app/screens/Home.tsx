import { useState } from "react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input, Label } from "../components/ui/input";
import { createRoom } from "../lib/api";
import { navigate } from "../App";
import type { PoolMode } from "../../src/shared/protocol";

export default function Home() {
  const [mode, setMode] = useState<"choose" | "create">("choose");
  const [maxPlayers, setMaxPlayers] = useState(8);
  const [poolMode, setPoolMode] = useState<PoolMode>("submissions");
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const room = await createRoom({ maxPlayers, poolMode });
      navigate(`/r/${room.roomId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create room");
    } finally {
      setBusy(false);
    }
  }

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const id = joinCode.trim().toLowerCase().replace(/.*\//, "");
    if (/^[a-f0-9]{16}$/.test(id)) {
      navigate(`/r/${id}`);
    } else {
      setError("Paste a valid invite link or room code");
    }
  }

  return (
    <div className="app-shell justify-center gap-6">
      <header className="text-center pt-8 pb-2">
        <p className="text-signal font-semibold text-sm tracking-[0.2em] uppercase mb-3">
          Party word game
        </p>
        <h1 className="display text-5xl sm:text-6xl mb-3">
          Impostor
        </h1>
        <p className="text-ink-soft text-base leading-relaxed max-w-xs mx-auto">
          Everyone gets the word. One player only gets the hint. Find them before the votes pile up.
        </p>
      </header>

      {mode === "choose" && (
        <div className="stagger flex flex-col gap-3">
          <Button size="lg" className="w-full" onClick={() => setMode("create")}>
            Create a room
          </Button>
          <Button
            size="lg"
            variant="secondary"
            className="w-full"
            onClick={() => document.getElementById("join-input")?.focus()}
          >
            Join with invite link
          </Button>
          <form onSubmit={handleJoin} className="mt-2">
            <Label htmlFor="join-input">Invite link or room code</Label>
            <div className="flex gap-2">
              <Input
                id="join-input"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                placeholder="/r/abcd1234…"
                autoComplete="off"
                spellCheck={false}
              />
              <Button type="submit" variant="gold" className="shrink-0">
                Go
              </Button>
            </div>
            {error && (
              <p className="text-signal text-sm mt-2" role="alert">
                {error}
              </p>
            )}
          </form>
        </div>
      )}

      {mode === "create" && (
        <Card className="reveal-in">
          <CardHeader>
            <CardTitle>New room</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="flex flex-col gap-5">
              <div>
                <Label htmlFor="max">Player limit</Label>
                <div className="flex items-center gap-3">
                  <input
                    id="max"
                    type="range"
                    min={3}
                    max={16}
                    value={maxPlayers}
                    onChange={(e) => setMaxPlayers(Number(e.target.value))}
                    className="flex-1 accent-signal h-2"
                  />
                  <span className="display text-2xl w-8 text-right text-gold">
                    {maxPlayers}
                  </span>
                </div>
                <p className="text-xs text-ink-soft mt-1">3–16 active players</p>
              </div>

              <div>
                <Label>Word pool</Label>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ["submissions", "Players only"],
                      ["mixed", "Mixed + bank"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setPoolMode(value)}
                      className={
                        "h-12 rounded-2xl border text-sm font-semibold transition-colors " +
                        (poolMode === value
                          ? "border-signal bg-signal-soft text-signal"
                          : "border-ink-line bg-ink text-ink-soft")
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {error && (
                <p className="text-signal text-sm" role="alert">
                  {error}
                </p>
              )}

              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="flex-1"
                  onClick={() => setMode("choose")}
                >
                  Back
                </Button>
                <Button type="submit" className="flex-1" disabled={busy}>
                  {busy ? "Creating…" : "Create"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <footer className="mt-auto pt-6 text-center text-xs text-ink-soft/80 leading-relaxed">
        <p>
          No accounts. Rooms expire after 24 hours of inactivity.
          <br />
          Names, words, and votes live only for the session.
        </p>
      </footer>
    </div>
  );
}
