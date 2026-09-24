import { useCallback, useEffect, useRef, useState } from "react";
import { Settings2, Shuffle, Users } from "lucide-react";
import type {
  BankEntry,
  PoolMode,
  RoomStateResponse,
} from "../../shared/protocol.ts";
import { LIMITS } from "../../shared/protocol.ts";
import {
  api,
  ApiRequestError,
  clearSessionToken,
  getState,
  hasSession,
  joinRoom,
  subscribeRoom,
  type LiveStatus,
} from "../lib/api.ts";
import { Button } from "../components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input, Label, Textarea } from "../components/ui/input";
import {
  ConnectionBadge,
  ErrorBanner,
  GuideCard,
  HostBar,
  HostTag,
  InviteStrip,
  PhaseBar,
  PhaseCount,
  PlayerList,
  RoleCard,
} from "../components/game/parts.tsx";
import { navigate } from "../App";

export default function Room({ roomId }: { roomId: string }) {
  const [state, setState] = useState<RoomStateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [name, setName] = useState("");
  const [joining, setJoining] = useState(false);
  const [forceJoin, setForceJoin] = useState(false);
  // Bumped whenever the tab's credentials change (joined or switched seat) so
  // the SSE stream reconnects with the right token and stops pushing an
  // anonymous view of the room.
  const [authEpoch, setAuthEpoch] = useState(0);
  const stateRef = useRef<RoomStateResponse | null>(null);

  const apply = useCallback((next: RoomStateResponse) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await getState(roomId);
      apply(next);
      setLoadError(null);
      return next;
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : "Could not reach the server";
      setLoadError(message);
      return null;
    }
  }, [roomId, apply]);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void (async () => {
      const first = await refresh();
      if (cancelled) return;
      setLoading(false);
      if (first?.shared.phase === "CLOSED") return;
      cleanup = subscribeRoom(roomId, {
        onState: (next) => apply(next),
        onStatus: setStatus,
        onReconnect: () => {
          void refresh();
        },
      });
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [roomId, authEpoch, apply, refresh]);

  async function run(fn: () => Promise<RoomStateResponse>) {
    setError(null);
    setFieldErrors({});
    try {
      apply(await fn());
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(err.message);
        if (err.fields) setFieldErrors(err.fields);
      } else {
        setError("Something went wrong — is the server still running?");
      }
    }
  }

  async function handleJoin(event: React.FormEvent) {
    event.preventDefault();
    setJoining(true);
    setError(null);
    setFieldErrors({});
    try {
      await joinRoom(roomId, name.trim());
      setForceJoin(false);
      setAuthEpoch((epoch) => epoch + 1);
      await refresh();
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(err.message);
        if (err.fields) setFieldErrors(err.fields);
      } else {
        setError("Could not join the room");
      }
    } finally {
      setJoining(false);
    }
  }

  async function switchPlayer() {
    // Release the current seat (best effort — only possible between rounds)
    // so a full room can still fit the new player.
    if (state?.you.inRoom) {
      try {
        await api.leave(roomId);
      } catch {
        // seat may already be gone or the round may be locked; join will explain
      }
    }
    clearSessionToken(roomId);
    setForceJoin(true);
    setName("");
    setAuthEpoch((epoch) => epoch + 1);
    await refresh();
  }

  if (loading) {
    return (
      <div className="app-shell justify-center items-center">
        <p className="text-ink-soft animate-pulse">Loading room…</p>
      </div>
    );
  }

  if (loadError && !state) {
    return (
      <div className="app-shell justify-center gap-4 text-center">
        <h1 className="display text-3xl">Room unavailable</h1>
        <p className="text-ink-soft text-sm">{loadError}</p>
        <p className="text-ink-soft text-xs">
          Check that the server is running on the host machine and that you are on the same network.
        </p>
        <Button variant="secondary" onClick={() => navigate("/")}>
          Back home
        </Button>
      </div>
    );
  }

  if (state?.shared.phase === "CLOSED") {
    return (
      <div className="app-shell justify-center gap-4 text-center">
        <h1 className="display text-3xl">Room closed</h1>
        <p className="text-ink-soft text-sm">The host ended this game.</p>
        <Button onClick={() => navigate("/")}>New room</Button>
      </div>
    );
  }

  const joined = !!state?.you.inRoom;
  if ((!joined && !state?.you.isHost) || forceJoin) {
    return (
      <JoinScreen
        roomId={roomId}
        name={name}
        setName={setName}
        joining={joining}
        error={error}
        fieldErrors={fieldErrors}
        onJoin={handleJoin}
        hadSession={hasSession(roomId)}
      />
    );
  }

  if (!state) return null;

  const { shared, you } = state;
  const rev = shared.rev;
  const kick = (targetId: string) => run(() => api.remove(roomId, targetId));

  return (
    <div className="app-shell">
      <header className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="display text-2xl">Impostor</h1>
            {you.isHost && <HostTag />}
          </div>
          <p className="text-xs text-ink-soft mt-0.5">
            {shared.round > 0 ? `Round ${shared.round} · ` : ""}
            {shared.activeCount}/{shared.maxPlayers} players
          </p>
        </div>
        <ConnectionBadge status={status} />
      </header>

      <div className="mb-4">
        <InviteStrip roomId={shared.roomId} />
      </div>

      <PhaseBar phase={shared.phase} />
      <ErrorBanner message={error} />

      <main className="flex flex-col gap-4">
        {shared.phase !== "RESULTS" && <GuideCard shared={shared} you={you} />}

        {shared.phase === "LOBBY" && (
          <LobbyView
            state={state}
            onSettings={(opts) => run(() => api.settings(roomId, opts))}
            onBank={(entries) => run(() => api.bankReplace(roomId, entries))}
            onBankClear={() => run(() => api.bankClear(roomId))}
            fieldErrors={fieldErrors}
          />
        )}

        {shared.phase === "SUBMITTING" && joined && (
          <SubmitView
            state={state}
            onSubmit={(word, hint) => run(() => api.submission(roomId, word, hint))}
            fieldErrors={fieldErrors}
          />
        )}

        {shared.phase !== "LOBBY" && shared.phase !== "SUBMITTING" && (
          <RoleCard you={you} phase={shared.phase} />
        )}

        {shared.phase === "CLUES_PENDING" && joined && (
          <ClueForm
            state={state}
            onSubmit={(clue) => run(() => api.clue(roomId, clue))}
            fieldErrors={fieldErrors}
          />
        )}

        {(shared.phase === "DISCUSSION" ||
          shared.phase === "VOTING" ||
          shared.phase === "RESULTS") &&
          shared.clues && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Clues</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-2">
                  {shared.clues.map((clue) => (
                    <li
                      key={clue.playerId}
                      className="rounded-2xl border border-ink-line bg-ink px-4 py-3 flex items-baseline justify-between gap-3"
                    >
                      <span className="text-sm text-ink-soft font-semibold shrink-0">
                        {clue.name}
                      </span>
                      <span className="font-semibold text-right">{clue.clue}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

        {shared.phase === "VOTING" && joined && (
          <VoteView
            state={state}
            onVote={(targetId) => run(() => api.vote(roomId, targetId))}
            fieldErrors={fieldErrors}
            onKick={undefined}
          />
        )}

        {shared.phase === "RESULTS" && <ResultsView state={state} />}

        <section>
          <h2 className="text-xs font-bold tracking-badges uppercase text-ink-soft mb-2">
            Players
          </h2>
          <PlayerList
            players={shared.players}
            youId={you.playerId}
            phase={shared.phase}
            isHost={you.isHost}
            tally={shared.tally}
            onKick={kick}
            impostorId={shared.result?.impostorId ?? null}
          />
          <PhaseCount state={state} />
        </section>
      </main>

      <HostControls
        state={state}
        onRun={run}
        roomId={roomId}
        rev={rev}
        onSwitchPlayer={switchPlayer}
      />

      <footer className="mt-6 text-center text-2xs text-ink-soft/70 pb-2 flex flex-col gap-2 items-center">
        <span>Disconnecting keeps your seat. Refresh to rejoin.</span>
        {!you.isHost && joined && (
          <button
            type="button"
            onClick={switchPlayer}
            className="underline underline-offset-2 hover:text-ink-soft"
          >
            Join as a different player
          </button>
        )}
      </footer>
    </div>
  );
}

function JoinScreen({
  roomId,
  name,
  setName,
  joining,
  error,
  fieldErrors,
  onJoin,
  hadSession,
}: {
  roomId: string;
  name: string;
  setName: (value: string) => void;
  joining: boolean;
  error: string | null;
  fieldErrors: Record<string, string>;
  onJoin: (event: React.FormEvent) => void;
  hadSession: boolean;
}) {
  return (
    <div className="app-shell justify-center gap-6">
      <header className="text-center">
        <p className="text-signal font-semibold text-sm tracking-label uppercase mb-2">
          You&apos;re invited
        </p>
        <h1 className="display text-4xl">Join the table</h1>
        <p className="text-ink-soft text-sm mt-2 font-mono">room {roomId.slice(0, 8)}</p>
      </header>
      <Card>
        <CardContent className="p-5">
          <form onSubmit={onJoin} className="flex flex-col gap-4">
            <div>
              <Label htmlFor="name">Display name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={LIMITS.NAME_MAX}
                placeholder="What should we call you?"
                autoComplete="nickname"
                autoFocus
                required
              />
              {fieldErrors.name && (
                <p className="text-signal text-xs mt-1">{fieldErrors.name}</p>
              )}
            </div>
            {error && (
              <p className="text-signal text-sm" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" size="lg" disabled={joining || !name.trim()}>
              {joining ? "Joining…" : "Join room"}
            </Button>
            {hadSession && (
              <p className="text-center text-xs text-ink-soft">
                Joining with a new name starts a new seat. Refreshing without joining restores
                your old seat.
              </p>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function HostControls({
  state,
  onRun,
  roomId,
  onSwitchPlayer,
}: {
  state: RoomStateResponse;
  onRun: (fn: () => Promise<RoomStateResponse>) => void;
  roomId: string;
  rev: number;
  onSwitchPlayer: () => void;
}) {
  const { shared, you } = state;
  if (!you.isHost) return null;

  const missing = shared.players.filter((p) => !p.submitted).map((p) => p.name);
  const clueMissing = shared.players.filter((p) => !p.clueSubmitted).map((p) => p.name);
  const voteMissing = shared.players.filter((p) => !p.hasVoted).map((p) => p.name);

  switch (shared.phase) {
    case "LOBBY":
      return (
        <HostBar>
          <Button
            size="lg"
            disabled={shared.activeCount < LIMITS.MIN_PLAYERS}
            onClick={() => onRun(() => api.advance(roomId, "begin"))}
          >
            {shared.activeCount < LIMITS.MIN_PLAYERS
              ? `Need ${LIMITS.MIN_PLAYERS}+ players (${shared.activeCount} in)`
              : `Open word round · ${shared.activeCount} players`}
          </Button>
          {shared.activeCount >= LIMITS.MIN_PLAYERS && shared.activeCount < 4 && (
            <p className="text-center text-xs text-ink-soft">
              You can start small — 3 players means one round each.
            </p>
          )}
          {!you.inRoom && (
            <Button variant="ghost" onClick={onSwitchPlayer}>
              Join as a player too
            </Button>
          )}
        </HostBar>
      );
    case "SUBMITTING":
      return (
        <HostBar>
          <Button
            size="lg"
            disabled={missing.length > 0 || shared.activeCount < LIMITS.MIN_PLAYERS}
            onClick={() => onRun(() => api.start(roomId))}
          >
            {missing.length ? `Waiting on ${missing.join(", ")}` : "Start round"}
          </Button>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="flex-1"
              onClick={() => onRun(() => api.advance(roomId, "cancel"))}
            >
              Clear words
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="flex-1"
              onClick={() => onRun(() => api.advance(roomId, "close"))}
            >
              Close room
            </Button>
          </div>
        </HostBar>
      );
    case "ROLE_REVEAL":
      return (
        <HostBar>
          <Button size="lg" onClick={() => onRun(() => api.advance(roomId, "advance"))}>
            Roles shown — collect clues
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => onRun(() => api.advance(roomId, "cancel"))}
          >
            Reset round
          </Button>
        </HostBar>
      );
    case "CLUES_PENDING":
      return (
        <HostBar>
          <p className="text-center text-xs text-ink-soft">
            {clueMissing.length
              ? `Waiting on ${clueMissing.join(", ")}`
              : "All clues in — revealing now…"}
          </p>
          <Button
            variant="danger"
            size="sm"
            onClick={() => onRun(() => api.advance(roomId, "cancel"))}
          >
            Reset round before reveal
          </Button>
        </HostBar>
      );
    case "DISCUSSION":
      return (
        <HostBar>
          <Button size="lg" onClick={() => onRun(() => api.advance(roomId, "advance"))}>
            Start voting
          </Button>
        </HostBar>
      );
    case "VOTING":
      return (
        <HostBar>
          <Button variant="secondary" onClick={() => onRun(() => api.advance(roomId, "force_results"))}>
            {voteMissing.length
              ? `Reveal now without ${voteMissing.join(", ")}`
              : "Reveal results"}
          </Button>
        </HostBar>
      );
    case "RESULTS":
      return (
        <HostBar>
          <Button size="lg" onClick={() => onRun(() => api.advance(roomId, "advance"))}>
            Next round
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onRun(() => api.advance(roomId, "close"))}>
            Close room
          </Button>
        </HostBar>
      );
    default:
      return null;
  }
}

function LobbyView({
  state,
  onSettings,
  onBank,
  onBankClear,
  fieldErrors,
}: {
  state: RoomStateResponse;
  onSettings: (opts: { maxPlayers?: number; poolMode?: PoolMode }) => void;
  onBank: (entries: BankEntry[]) => void;
  onBankClear: () => void;
  fieldErrors: Record<string, string>;
}) {
  const { shared, you } = state;
  const [showSettings, setShowSettings] = useState(false);
  const [bankText, setBankText] = useState("");
  const [bankMsg, setBankMsg] = useState<string | null>(null);

  if (!you.isHost) {
    return (
      <Card>
        <CardContent className="p-5 text-sm text-ink-soft flex items-center gap-3">
          <Users className="h-5 w-5 shrink-0" />
          {shared.activeCount >= shared.maxPlayers
            ? "The room is full. Wait for the host to start."
            : "Invite more people, or just wait for the host to start."}
        </CardContent>
      </Card>
    );
  }

  function importBank() {
    setBankMsg(null);
    try {
      const parsed = JSON.parse(bankText) as BankEntry[] | { entries: BankEntry[] };
      const entries = Array.isArray(parsed) ? parsed : parsed.entries;
      if (!Array.isArray(entries)) throw new Error("Expected an array of {word, hint}");
      onBank(entries);
      setBankMsg(`Imported ${entries.length} pairs`);
      setBankText("");
    } catch (err) {
      setBankMsg(err instanceof Error ? err.message : "Invalid JSON");
    }
  }

  function exportBank() {
    const entries = you.bank ?? [];
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "word-bank.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle className="text-lg">Room setup</CardTitle>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowSettings((v) => !v)}
          aria-expanded={showSettings}
        >
          <Settings2 className="h-4 w-4" />
          {showSettings ? "Hide" : "Edit"}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-2 text-sm text-ink-soft">
          <Badge tone="neutral">
            {shared.maxPlayers} players max
          </Badge>
          <Badge tone={shared.poolMode === "mixed" ? "gold" : "neutral"}>
            <Shuffle className="h-3 w-3" />
            {shared.poolMode === "mixed" ? "Players + host bank" : "Player words only"}
          </Badge>
        </div>

        {showSettings && (
          <div className="flex flex-col gap-4 pt-1">
            <div>
              <Label htmlFor="limit">Player limit · {shared.maxPlayers}</Label>
              <input
                id="limit"
                type="range"
                min={Math.max(LIMITS.MIN_PLAYERS, shared.activeCount)}
                max={LIMITS.MAX_PLAYERS}
                value={shared.maxPlayers}
                onChange={(e) => onSettings({ maxPlayers: Number(e.target.value) })}
                className="w-full accent-signal h-2"
              />
              {fieldErrors.maxPlayers && (
                <p className="text-signal text-xs mt-1">{fieldErrors.maxPlayers}</p>
              )}
            </div>
            <div>
              <Label>Word pool</Label>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["submissions", "Player words only"],
                    ["mixed", "Players + bank"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => onSettings({ poolMode: value })}
                    className={
                      "h-11 rounded-2xl border text-sm font-semibold px-2 " +
                      (shared.poolMode === value
                        ? "border-signal bg-signal-soft text-signal"
                        : "border-ink-line bg-ink text-ink-soft hover:border-ink-soft/50")
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {shared.poolMode === "mixed" && (
              <div>
                <Label htmlFor="bank">Host word bank (JSON)</Label>
                <Textarea
                  id="bank"
                  value={bankText}
                  onChange={(e) => setBankText(e.target.value)}
                  placeholder='[{"word":"lantern","hint":"light in the dark"}]'
                  rows={3}
                  className="font-mono text-xs"
                />
                <div className="flex gap-2 mt-2">
                  <Button size="sm" variant="gold" onClick={importBank} disabled={!bankText.trim()}>
                    Import
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={exportBank}
                    disabled={!shared.bankSize}
                  >
                    Export
                  </Button>
                  <Button size="sm" variant="ghost" onClick={onBankClear} disabled={!shared.bankSize}>
                    Clear
                  </Button>
                </div>
                <p className="text-xs text-ink-soft mt-2">
                  {shared.bankSize} pairs stored · max {LIMITS.BANK_MAX_ENTRIES} pairs
                </p>
                {bankMsg && <p className="text-xs text-gold mt-1">{bankMsg}</p>}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SubmitView({
  state,
  onSubmit,
  fieldErrors,
}: {
  state: RoomStateResponse;
  onSubmit: (word: string, hint: string) => void;
  fieldErrors: Record<string, string>;
}) {
  const existing = state.you.mySubmission;
  const [word, setWord] = useState(existing?.word ?? "");
  const [hint, setHint] = useState(existing?.hint ?? "");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (existing && !dirty) {
      setWord(existing.word);
      setHint(existing.hint);
    }
  }, [existing, dirty]);

  const submitted = !!existing && !dirty;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Your secret word</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(word, hint);
            setDirty(false);
          }}
        >
          <div>
            <Label htmlFor="word">Word</Label>
            <Input
              id="word"
              value={word}
              maxLength={LIMITS.WORD_MAX}
              onChange={(e) => {
                setWord(e.target.value);
                setDirty(true);
              }}
              placeholder="e.g. lantern"
              autoComplete="off"
            />
            <div className="flex justify-between mt-1">
              {fieldErrors.word ? (
                <p className="text-signal text-xs">{fieldErrors.word}</p>
              ) : (
                <span />
              )}
              <span className="text-2xs text-ink-soft">
                {word.length}/{LIMITS.WORD_MAX}
              </span>
            </div>
          </div>
          <div>
            <Label htmlFor="hint">Hint (only the impostor sees this)</Label>
            <Textarea
              id="hint"
              value={hint}
              maxLength={LIMITS.HINT_MAX}
              onChange={(e) => {
                setHint(e.target.value);
                setDirty(true);
              }}
              placeholder="e.g. light in the dark"
              rows={3}
            />
            <div className="flex justify-between mt-1">
              {fieldErrors.hint ? (
                <p className="text-signal text-xs">{fieldErrors.hint}</p>
              ) : (
                <span />
              )}
              <span className="text-2xs text-ink-soft">
                {hint.length}/{LIMITS.HINT_MAX}
              </span>
            </div>
          </div>
          <Button type="submit" size="lg" disabled={!word.trim() || !hint.trim()}>
            {submitted ? "Update word" : "Submit word"}
          </Button>
          {submitted && (
            <p className="text-center text-crew text-sm font-semibold">
              Saved — others only see that you&apos;re ready
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function ClueForm({
  state,
  onSubmit,
  fieldErrors,
}: {
  state: RoomStateResponse;
  onSubmit: (clue: string) => void;
  fieldErrors: Record<string, string>;
}) {
  const [clue, setClue] = useState(state.you.myClue ?? "");
  const saved = !!state.you.myClue;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Your clue</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-ink-soft text-sm mb-3">One to three words. Hidden until everyone is in.</p>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(clue);
          }}
        >
          <Input
            value={clue}
            maxLength={LIMITS.CLUE_MAX}
            onChange={(e) => setClue(e.target.value)}
            placeholder="e.g. flickers softly"
            autoComplete="off"
          />
          {fieldErrors.clue && <p className="text-signal text-xs">{fieldErrors.clue}</p>}
          <Button type="submit" size="lg" disabled={!clue.trim()}>
            {saved ? "Update clue" : "Lock clue"}
          </Button>
          {saved && <p className="text-center text-crew text-sm">Clue saved</p>}
        </form>
      </CardContent>
    </Card>
  );
}

function VoteView({
  state,
  onVote,
  fieldErrors,
}: {
  state: RoomStateResponse;
  onVote: (targetId: string) => void;
  fieldErrors: Record<string, string>;
  onKick?: undefined;
}) {
  const { shared, you } = state;
  const [selected, setSelected] = useState<string | null>(null);
  const voted = shared.players.find((p) => p.id === you.playerId)?.hasVoted ?? false;
  const selectedName = shared.players.find((p) => p.id === selected)?.name;

  if (voted) {
    return (
      <Card>
        <CardContent className="p-5 text-center">
          <p className="text-crew font-semibold">Vote locked</p>
          <p className="text-ink-soft text-sm mt-1">
            Results reveal when everyone has voted.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Who is the impostor?</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-ink-soft text-sm mb-3">Tap a player, then confirm. No self-votes.</p>
        <PlayerList
          players={shared.players}
          youId={you.playerId}
          phase={shared.phase}
          selectedId={selected}
          onSelect={setSelected}
        />
        {fieldErrors.targetId && (
          <p className="text-signal text-xs mt-2">{fieldErrors.targetId}</p>
        )}
        <Button
          size="lg"
          className="w-full mt-4"
          disabled={!selected}
          onClick={() => selected && onVote(selected)}
        >
          {selectedName ? `Vote ${selectedName}` : "Pick a player"}
        </Button>
      </CardContent>
    </Card>
  );
}

function ResultsView({ state }: { state: RoomStateResponse }) {
  const { shared, you } = state;
  const result = shared.result;
  const iWon =
    result &&
    ((result.crewWin && !you.role?.impostor) || (!result.crewWin && you.role?.impostor));

  return (
    <>
      <Card
        className={
          "reveal-in border-2 " +
          (result?.crewWin
            ? "border-crew/60 bg-crew-soft/50"
            : "border-signal bg-signal-soft/50")
        }
      >
        <CardHeader>
          <p className="text-xs font-bold tracking-label uppercase text-ink-soft">
            {result?.crewWin ? "Crew wins" : result?.tie ? "Tie — impostor survives" : "Impostor wins"}
          </p>
          <CardTitle className="text-2xl">
            {result?.impostorName} was the impostor
          </CardTitle>
        </CardHeader>
        <CardContent>
          {iWon !== undefined && (
            <p className="text-sm font-semibold mb-4">
              {iWon ? "You won this round." : "You lost this round."}
            </p>
          )}
          <div className="flex flex-col gap-2">
            {(shared.tally ?? []).map((row) => (
              <div
                key={row.targetId}
                className="flex items-center justify-between rounded-2xl border border-ink-line bg-ink px-4 py-3"
              >
                <span className={row.targetId === result?.impostorId ? "text-signal font-bold" : ""}>
                  {row.name}
                </span>
                <Badge tone={row.votes > 0 ? "signal" : "neutral"}>
                  {row.votes} vote{row.votes === 1 ? "" : "s"}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      {shared.votesDetail && shared.votesDetail.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">How everyone voted</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1.5 text-sm">
              {shared.votesDetail.map((vote) => (
                <li key={vote.voterId} className="flex justify-between gap-3">
                  <span className="text-ink-soft">{vote.voterName}</span>
                  <span className="font-semibold">→ {vote.targetName}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}
