import { useState } from "react";
import { BookOpen, Link2, Play, Plus, Users } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input, Label } from "../components/ui/input";
import { createRoom } from "../lib/api";
import { navigate } from "../App";
import type { PoolMode } from "../../shared/protocol.ts";
import { LIMITS } from "../../shared/protocol.ts";

const REPO_URL = "https://github.com/ashwnn/impostor";

export default function Home() {
  const [mode, setMode] = useState<"choose" | "create" | "how">("choose");
  const [maxPlayers, setMaxPlayers] = useState<number>(LIMITS.DEFAULT_PLAYERS);
  const [poolMode, setPoolMode] = useState<PoolMode>("submissions");
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const room = await createRoom({ maxPlayers, poolMode });
      navigate(`/r/${room.roomId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the room");
    } finally {
      setBusy(false);
    }
  }

  function handleJoin(event: React.FormEvent) {
    event.preventDefault();
    const id = joinCode.trim().toLowerCase().replace(/.*\//, "");
    if (/^[a-f0-9]{16}$/.test(id)) {
      navigate(`/r/${id}`);
    } else {
      setError("Paste a full invite link or the 16-character room code");
    }
  }

  return (
    <div className="app-shell justify-center gap-5">
      <header className="text-center pt-6 pb-1">
        <p className="text-signal font-semibold text-sm tracking-hero uppercase mb-3">
          Party word game
        </p>
        <h1 className="display text-5xl sm:text-6xl mb-3">Impostor</h1>
        <p className="text-ink-soft text-base leading-relaxed max-w-xs mx-auto">
          Everyone gets the same secret word — except one player, who only gets a hint.
          Trade clues, then vote them out.
        </p>
      </header>

      {mode === "choose" && (
        <div className="stagger flex flex-col gap-3">
          <Button size="lg" className="w-full" onClick={() => setMode("create")}>
            <Plus className="h-5 w-5" />
            Create a room
          </Button>

          <form onSubmit={handleJoin} className="mt-2">
            <Label htmlFor="join-input">Join with an invite link</Label>
            <div className="flex gap-2">
              <Input
                id="join-input"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                placeholder="http://192.168.1.5:8787/r/…"
                autoComplete="off"
                spellCheck={false}
              />
              <Button type="submit" variant="gold" className="shrink-0">
                <Link2 className="h-4 w-4" />
                Join
              </Button>
            </div>
            {error && (
              <p className="text-signal text-sm mt-2" role="alert">
                {error}
              </p>
            )}
          </form>

          <Button variant="ghost" onClick={() => setMode("how")}>
            <BookOpen className="h-4 w-4" />
            How does it work?
          </Button>
        </div>
      )}

      {mode === "how" && (
        <Card className="reveal-in">
          <CardHeader>
            <CardTitle>How a round plays out</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            <Step
              icon={<Users className="h-5 w-5" />}
              title="1 · Everyone writes a word"
              body="Each player secretly submits a candidate word and a hint. The host picks the round's word from those candidates."
            />
            <Step
              icon={<Play className="h-5 w-5" />}
              title="2 · One player is the impostor"
              body="The crew sees the word. The impostor only sees the hint. Nobody who wrote the chosen word can be the impostor."
            />
            <Step
              icon={<BookOpen className="h-5 w-5" />}
              title="3 · Clues, talk, vote"
              body="Everyone gives one clue, all clues reveal together, you argue out loud, then each player casts one vote."
            />
            <p className="text-ink-soft text-xs border-t border-ink-line pt-3">
              One person runs the game server on their machine. Everyone else opens the
              invite link over the same Wi-Fi or LAN. No accounts, no internet needed.
            </p>
            <Button variant="secondary" onClick={() => setMode("choose")}>
              Back
            </Button>
          </CardContent>
        </Card>
      )}

      {mode === "create" && (
        <Card className="reveal-in">
          <CardHeader>
            <CardTitle>New room</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="flex flex-col gap-5">
              <div>
                <Label htmlFor="limit">Player limit · {maxPlayers}</Label>
                <input
                  id="limit"
                  type="range"
                  min={LIMITS.MIN_PLAYERS}
                  max={LIMITS.MAX_PLAYERS}
                  value={maxPlayers}
                  onChange={(e) => setMaxPlayers(Number(e.target.value))}
                  className="w-full accent-signal h-2"
                />
                <p className="text-xs text-ink-soft mt-1">
                  {LIMITS.MIN_PLAYERS}–{LIMITS.MAX_PLAYERS} players, not counting you if you
                  only host
                </p>
              </div>

              <fieldset>
                <legend className="text-sm font-medium text-ink-soft mb-1.5">Word pool</legend>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ["submissions", "Player words"],
                      ["mixed", "Players + host bank"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setPoolMode(value)}
                      aria-pressed={poolMode === value}
                      className={
                        "h-12 rounded-2xl border text-sm font-semibold transition-colors px-2 " +
                        (poolMode === value
                          ? "border-signal bg-signal-soft text-signal"
                          : "border-ink-line bg-ink text-ink-soft hover:border-ink-soft/50")
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-ink-soft mt-1.5">
                  {poolMode === "mixed"
                    ? "Rounds draw from player words and your JSON word bank."
                    : "Every candidate comes from the players themselves."}
                </p>
              </fieldset>

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
                  {busy ? "Creating…" : "Create room"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <footer className="mt-auto pt-6 text-center text-xs text-ink-soft/80 leading-relaxed">
        <p>
          Rooms live only while the server runs.
          <br />
          <a className="underline underline-offset-2 hover:text-ink-soft" href={REPO_URL}>
            Source on GitHub
          </a>
        </p>
      </footer>
    </div>
  );
}

function Step({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex gap-3">
      <span className="text-gold shrink-0 mt-0.5">{icon}</span>
      <div>
        <p className="font-bold text-body leading-snug">{title}</p>
        <p className="text-ink-soft mt-1 leading-relaxed">{body}</p>
      </div>
    </div>
  );
}
