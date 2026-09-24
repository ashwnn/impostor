import { useCallback, useEffect, useRef, useState } from "react";
import type { BankEntry, PoolMode, RoomStateResponse } from "../../src/shared/protocol";
import { LIMITS } from "../../src/shared/protocol";
import { api, getState, joinRoom, openRoomSocket } from "../lib/api";
import { Button } from "../components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input, Label, Textarea } from "../components/ui/input";
import { ErrorBanner, HostBar, PhaseBar, PlayerList, RoleCard } from "./parts";
import { navigate } from "../App";

type Status = "loading" | "need-name" | "ready" | "error" | "closed";

export default function Room({ roomId }: { roomId: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [state, setState] = useState<RoomStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [nameBusy, setNameBusy] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const syncedRef = useRef(false);

  const apply = useCallback((s: RoomStateResponse) => {
    setState(s);
    if (s.shared.phase === "CLOSED") setStatus("closed");
    else if (s.you.inRoom || s.you.isHost) setStatus("ready");
    else setStatus("need-name");
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await getState(roomId);
      apply(s);
      if (s.shared.phase === "CLOSED") setStatus("closed");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load room");
      setStatus("error");
    }
  }, [roomId, apply]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh();
      if (cancelled) return;
      const ws = openRoomSocket(roomId, (data) => {
        syncedRef.current = true;
        apply(data);
      });
      wsRef.current = ws;
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "sync" }));
      });
      // Fallback poll if WS stays silent
      const poll = window.setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) void refresh();
      }, 5000);
      return () => window.clearInterval(poll);
    })();
    return () => {
      cancelled = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [roomId, apply, refresh]);

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    setNameBusy(true);
    setError(null);
    try {
      await joinRoom(roomId, name.trim());
      const s = await getState(roomId);
      apply(s);
      wsRef.current?.send(JSON.stringify({ type: "sync" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join");
    } finally {
      setNameBusy(false);
    }
  }

  async function run(fn: () => Promise<RoomStateResponse>) {
    setError(null);
    setFieldErrors({});
    try {
      const s = await fn();
      apply(s);
    } catch (err) {
      const e = err as Error & { fields?: Record<string, string> };
      setError(e.message);
      if (e.fields) setFieldErrors(e.fields);
    }
  }

  if (status === "loading") {
    return (
      <div className="app-shell justify-center items-center">
        <p className="text-ink-soft animate-pulse">Loading room…</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="app-shell justify-center gap-4 text-center">
        <h1 className="display text-3xl">Room unavailable</h1>
        <p className="text-ink-soft text-sm">{error}</p>
        <Button variant="secondary" onClick={() => navigate("/")}>
          Back home
        </Button>
      </div>
    );
  }

  if (status === "closed") {
    return (
      <div className="app-shell justify-center gap-4 text-center">
        <h1 className="display text-3xl">Room closed</h1>
        <p className="text-ink-soft text-sm">
          This game has ended or expired. Create a new room to play again.
        </p>
        <Button onClick={() => navigate("/")}>New room</Button>
      </div>
    );
  }

  if (status === "need-name" || !state) {
    return (
      <div className="app-shell justify-center gap-6">
        <header className="text-center">
          <p className="text-signal font-semibold text-sm tracking-[0.18em] uppercase mb-2">
            Invite
          </p>
          <h1 className="display text-4xl">Join the table</h1>
        </header>
        <Card>
          <CardContent className="p-5">
            <form onSubmit={handleJoin} className="flex flex-col gap-4">
              <div>
                <Label htmlFor="name">Display name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={LIMITS.NAME_MAX}
                  placeholder="What should we call you?"
                  autoComplete="nickname"
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
              <Button type="submit" size="lg" disabled={nameBusy || !name.trim()}>
                {nameBusy ? "Joining…" : "Join room"}
              </Button>
            </form>
          </CardContent>
        </Card>
        <p className="text-center text-xs text-ink-soft">
          No account needed. Your seat is remembered on this device.
        </p>
        <div className="mt-auto" />
      </div>
    );
  }

  const { shared, you } = state;
  const rev = shared.rev;

  return (
    <div className="app-shell">
      <header className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h1 className="display text-2xl">Impostor</h1>
          <p className="text-xs text-ink-soft font-mono mt-0.5">
            /r/{roomId.slice(0, 8)}… · round {shared.round || "—"} ·{" "}
            {shared.activeCount}/{shared.maxPlayers}
          </p>
        </div>
        <Badge tone="gold">{shared.poolMode === "mixed" ? "Mixed pool" : "Player words"}</Badge>
      </header>

      <PhaseBar shared={shared} />
      <ErrorBanner message={error} />

      {you.isHost && (
        <p className="text-[11px] text-gold font-semibold mb-3 tracking-wide">
          Host controls active
        </p>
      )}

      <main className="flex flex-col gap-5 stagger">
        {shared.phase === "LOBBY" && (
          <LobbyView
            state={state}
            onSettings={(opts) => run(() => api.settings(roomId, opts))}
            onBank={(entries) => run(() => api.bankReplace(roomId, entries))}
            onBankClear={() => run(() => api.bankClear(roomId))}
            onBegin={() => run(() => api.advance(roomId, "begin", rev))}
            onRemove={(id) => run(() => api.remove(roomId, id))}
            fieldErrors={fieldErrors}
          />
        )}

        {shared.phase === "SUBMITTING" && (
          <SubmittingView
            state={state}
            onSubmit={(word, hint) => run(() => api.submission(roomId, word, hint, rev))}
            onStart={() => run(() => api.start(roomId, rev))}
            onCancel={() => run(() => api.advance(roomId, "cancel", rev))}
            fieldErrors={fieldErrors}
          />
        )}

        {(shared.phase === "ROLE_REVEAL" ||
          shared.phase === "CLUES_PENDING" ||
          shared.phase === "DISCUSSION" ||
          shared.phase === "VOTING" ||
          shared.phase === "RESULTS") && (
          <RoleCard you={you} phase={shared.phase} />
        )}

        {shared.phase === "ROLE_REVEAL" && (
          <Card>
            <CardHeader>
              <CardTitle>Memorize your role</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-ink-soft text-sm mb-4">
                Crew: keep the word secret. Impostor: bluff from the hint alone.
                When everyone is ready, the host opens clue writing.
              </p>
              {you.isHost && (
                <HostBar>
                  <Button size="lg" onClick={() => run(() => api.advance(roomId, "advance", rev))}>
                    Open clue writing
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => run(() => api.advance(roomId, "cancel", rev))}
                  >
                    Reset round
                  </Button>
                </HostBar>
              )}
            </CardContent>
          </Card>
        )}

        {shared.phase === "CLUES_PENDING" && (
          <ClueView
            state={state}
            onSubmit={(clue) => run(() => api.clue(roomId, clue, rev))}
            onCancel={() => run(() => api.advance(roomId, "cancel", rev))}
            fieldErrors={fieldErrors}
          />
        )}

        {shared.phase === "DISCUSSION" && (
          <CluesRevealedView state={state} />
        )}

        {shared.phase === "DISCUSSION" && you.isHost && (
          <HostBar>
            <Button
              size="lg"
              onClick={() => run(() => api.advance(roomId, "advance", rev))}
            >
              Start voting
            </Button>
          </HostBar>
        )}

        {shared.phase === "VOTING" && (
          <VoteView
            state={state}
            onVote={(id) => run(() => api.vote(roomId, id, rev))}
            onForce={() => run(() => api.advance(roomId, "force_results", rev))}
            fieldErrors={fieldErrors}
          />
        )}

        {shared.phase === "RESULTS" && <ResultsView state={state} />}

        {shared.phase === "RESULTS" && you.isHost && (
          <HostBar>
            <Button
              size="lg"
              onClick={() => run(() => api.advance(roomId, "advance", rev))}
            >
              Next round
            </Button>
            <Button
              variant="secondary"
              onClick={() => run(() => api.advance(roomId, "close", rev))}
            >
              Close room
            </Button>
          </HostBar>
        )}
      </main>

      <section className="mt-6">
        <h2 className="text-xs font-bold tracking-[0.16em] uppercase text-ink-soft mb-2">
          Players
        </h2>
        <PlayerList
          players={shared.players}
          youId={you.playerId}
          showVotes={shared.phase === "RESULTS"}
          votesRevealed={shared.votesRevealed}
          tally={shared.tally}
        />
        {shared.phase === "SUBMITTING" && you.isHost && (
          <HostBar>
            <Button
              size="lg"
              disabled={
                shared.activeCount < LIMITS.MIN_PLAYERS ||
                shared.players.some((p) => !p.submitted)
              }
              onClick={() => run(() => api.start(roomId, rev))}
            >
              Start round
            </Button>
            <p className="text-center text-xs text-ink-soft pb-1">
              {shared.players.some((p) => !p.submitted)
                ? "Waiting for every word"
                : "All words in — start when ready"}
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => run(() => api.advance(roomId, "cancel", rev))}
            >
              Reset submissions
            </Button>
          </HostBar>
        )}
        {shared.phase === "LOBBY" && you.isHost && shared.activeCount >= LIMITS.MIN_PLAYERS && (
          <HostBar>
            <Button size="lg" onClick={() => run(() => api.advance(roomId, "begin", rev))}>
              Open submissions ({shared.activeCount} players)
            </Button>
          </HostBar>
        )}
      </section>

      <footer className="mt-8 text-center text-[11px] text-ink-soft/70 pb-2">
        Disconnect keeps your seat. Rooms expire after 24h idle.
      </footer>
    </div>
  );
}

function LobbyView({
  state,
  onSettings,
  onBank,
  onBankClear,
  onBegin,
  onRemove,
  fieldErrors,
}: {
  state: RoomStateResponse;
  onSettings: (o: { maxPlayers?: number; poolMode?: PoolMode }) => void;
  onBank: (entries: BankEntry[]) => void;
  onBankClear: () => void;
  onBegin: () => void;
  onRemove: (id: string) => void;
  fieldErrors: Record<string, string>;
}) {
  const { shared, you } = state;
  const [bankText, setBankText] = useState("");
  const [bankMsg, setBankMsg] = useState<string | null>(null);

  function importBank() {
    setBankMsg(null);
    try {
      const parsed = JSON.parse(bankText) as BankEntry[] | { entries: BankEntry[] };
      const entries = Array.isArray(parsed) ? parsed : parsed.entries;
      if (!Array.isArray(entries)) throw new Error("Expected an array of {word, hint}");
      onBank(entries);
      setBankMsg(`Imported ${entries.length} pairs`);
      setBankText("");
    } catch (e) {
      setBankMsg(e instanceof Error ? e.message : "Invalid JSON");
    }
  }

  function exportBank() {
    const entries = you.bank ?? [];
    const blob = new Blob([JSON.stringify(entries, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "word-bank.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Waiting for players</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-ink-soft text-sm mb-4">
            Share the invite. Need at least {LIMITS.MIN_PLAYERS} before opening submissions.
          </p>
          <InviteBlock roomId={shared.roomId} />
          {you.isHost && (
            <div className="mt-5 flex flex-col gap-4">
              <div>
                <Label htmlFor="lim">Player limit · {shared.maxPlayers}</Label>
                <input
                  id="lim"
                  type="range"
                  min={Math.max(LIMITS.MIN_PLAYERS, shared.activeCount)}
                  max={LIMITS.MAX_PLAYERS}
                  value={shared.maxPlayers}
                  onChange={(e) => onSettings({ maxPlayers: Number(e.target.value) })}
                  className="w-full accent-signal h-2"
                  disabled={shared.bankLocked}
                />
                {fieldErrors.maxPlayers && (
                  <p className="text-signal text-xs mt-1">{fieldErrors.maxPlayers}</p>
                )}
              </div>
              <div>
                <Label>Pool</Label>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ["submissions", "Players only"],
                      ["mixed", "Mixed + bank"],
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => onSettings({ poolMode: v })}
                      className={
                        "h-11 rounded-2xl border text-sm font-semibold " +
                        (shared.poolMode === v
                          ? "border-signal bg-signal-soft text-signal"
                          : "border-ink-line bg-ink text-ink-soft")
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
                    rows={4}
                    className="font-mono text-sm"
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
                    <Button size="sm" variant="ghost" onClick={onBankClear}>
                      Clear
                    </Button>
                  </div>
                  <p className="text-xs text-ink-soft mt-2">
                    {shared.bankSize} pairs stored · max {LIMITS.BANK_MAX_ENTRIES} ·{" "}
                    {LIMITS.BANK_MAX_BYTES / 1000}KB
                  </p>
                  {bankMsg && <p className="text-xs text-gold mt-1">{bankMsg}</p>}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {!you.inRoom && you.isHost && (
        <Card>
          <CardHeader>
            <CardTitle>Take a seat?</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-ink-soft text-sm">
              You are hosting. Join with a name to play, or stay host-only.
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );
}

function InviteBlock({ roomId }: { roomId: string }) {
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/r/${roomId}`;
  return (
    <div className="flex gap-2">
      <Input
        readOnly
        value={link}
        className="font-mono text-sm h-11"
        onFocus={(e) => e.currentTarget.select()}
      />
      <Button
        variant="gold"
        className="shrink-0 h-11 px-4"
        onClick={() => {
          void navigator.clipboard?.writeText(link);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function SubmittingView({
  state,
  onSubmit,
  onStart,
  onCancel,
  fieldErrors,
}: {
  state: RoomStateResponse;
  onSubmit: (word: string, hint: string) => void;
  onStart: () => void;
  onCancel: () => void;
  fieldErrors: Record<string, string>;
}) {
  const { shared, you } = state;
  const existing = you.mySubmission;
  const [word, setWord] = useState(existing?.word ?? "");
  const [hint, setHint] = useState(existing?.hint ?? "");
  const [dirty, setDirty] = useState(false);
  const submitted = !!existing && !dirty;

  useEffect(() => {
    if (existing && !dirty) {
      setWord(existing.word);
      setHint(existing.hint);
    }
  }, [existing, dirty]);

  if (!you.inRoom) {
    return (
      <Card>
        <CardContent className="p-5 text-sm text-ink-soft">
          You are spectating as host. Join with a name to submit a word.
        </CardContent>
      </Card>
    );
  }

  const allIn = shared.players.length > 0 && shared.players.every((p) => p.submitted);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Your candidate</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              setDirty(false);
              onSubmit(word, hint);
            }}
          >
            <div>
              <Label htmlFor="word">Secret word</Label>
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
              <p className="text-[11px] text-ink-soft mt-1 text-right">
                {word.length}/{LIMITS.WORD_MAX}
              </p>
              {fieldErrors.word && (
                <p className="text-signal text-xs -mt-1">{fieldErrors.word}</p>
              )}
            </div>
            <div>
              <Label htmlFor="hint">Private hint (shown to the impostor)</Label>
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
              <p className="text-[11px] text-ink-soft mt-1 text-right">
                {hint.length}/{LIMITS.HINT_MAX}
              </p>
              {fieldErrors.hint && (
                <p className="text-signal text-xs -mt-1">{fieldErrors.hint}</p>
              )}
            </div>
            <Button type="submit" size="lg" disabled={!word.trim() || !hint.trim()}>
              {submitted ? "Update submission" : "Submit word"}
            </Button>
            {submitted && (
              <p className="text-center text-crew text-sm font-semibold">
                In · others only see that you submitted
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            Lobby
            <Badge tone={allIn ? "crew" : "neutral"}>
              {shared.players.filter((p) => p.submitted).length}/{shared.activeCount}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <PlayerList players={shared.players} youId={you.playerId} />
        </CardContent>
      </Card>
    </>
  );
}

function ClueView({
  state,
  onSubmit,
  onCancel,
  fieldErrors,
}: {
  state: RoomStateResponse;
  onSubmit: (clue: string) => void;
  onCancel: () => void;
  fieldErrors: Record<string, string>;
}) {
  const { shared, you } = state;
  const [clue, setClue] = useState(you.myClue ?? "");

  if (!you.inRoom) {
    return (
      <Card>
        <CardContent className="p-5 text-sm text-ink-soft">
          Waiting for players to write clues.
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>One clue</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-ink-soft text-sm mb-3">
            1–3 words. Hidden until everyone is in.
          </p>
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
            {fieldErrors.clue && (
              <p className="text-signal text-xs">{fieldErrors.clue}</p>
            )}
            <Button type="submit" size="lg" disabled={!clue.trim()}>
              Lock clue
            </Button>
            {you.myClue && (
              <p className="text-center text-crew text-sm">Your clue is in</p>
            )}
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <PlayerList players={shared.players} youId={you.playerId} />
        </CardContent>
      </Card>
      {you.isHost && (
        <HostBar>
          <Button variant="danger" onClick={onCancel}>
            Reset round before reveal
          </Button>
        </HostBar>
      )}
    </>
  );
}

function CluesRevealedView({ state }: { state: RoomStateResponse }) {
  const { shared } = state;
  return (
    <Card>
      <CardHeader>
        <CardTitle>All clues</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="stagger flex flex-col gap-2">
          {(shared.clues || []).map((c) => (
            <li
              key={c.playerId}
              className="rounded-2xl border border-ink-line bg-ink px-4 py-3 flex items-baseline justify-between gap-3"
            >
              <span className="text-sm text-ink-soft font-semibold shrink-0">{c.name}</span>
              <span className="font-semibold text-right">{c.clue}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-ink-soft mt-3">
          Discuss out loud, then the host opens the vote.
        </p>
      </CardContent>
    </Card>
  );
}

function VoteView({
  state,
  onVote,
  onForce,
  fieldErrors,
}: {
  state: RoomStateResponse;
  onVote: (id: string) => void;
  onForce: () => void;
  fieldErrors: Record<string, string>;
}) {
  const { shared, you } = state;
  const [selected, setSelected] = useState<string | null>(null);
  const voted = shared.players.find((p) => p.id === you.playerId)?.hasVoted ?? false;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Vote out the impostor</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-ink-soft text-sm mb-3">
            One vote. No self-votes. Revealed together when everyone is in.
          </p>
          <PlayerList
            players={shared.players}
            youId={you.playerId}
            selectedId={selected}
            onSelect={setSelected}
          />
          {fieldErrors.targetId && (
            <p className="text-signal text-xs mt-2">{fieldErrors.targetId}</p>
          )}
          {voted ? (
            <p className="text-center text-crew text-sm font-semibold mt-4">
              Vote locked
            </p>
          ) : (
            <Button
              size="lg"
              className="w-full mt-4"
              disabled={!selected}
              onClick={() => selected && onVote(selected)}
            >
              Cast vote
            </Button>
          )}
          {!voted && (
            <p className="text-center text-xs text-ink-soft mt-2">
              {shared.players.filter((p) => p.hasVoted).length}/{shared.activeCount} voted
            </p>
          )}
        </CardContent>
      </Card>
      {you.isHost && (
        <HostBar>
          <Button variant="secondary" onClick={onForce}>
            Reveal votes early
          </Button>
        </HostBar>
      )}
    </>
  );
}

function ResultsView({ state }: { state: RoomStateResponse }) {
  const { shared, you } = state;
  const result = shared.result;
  const iWon =
    result &&
    ((result.crewWin && !you.role?.impostor) ||
      (!result.crewWin && you.role?.impostor));

  return (
    <>
      <Card
        className={
          "reveal-in border-2 " +
          (result?.crewWin ? "border-crew/50 bg-crew-soft/40" : "border-signal bg-signal-soft/40")
        }
      >
        <CardHeader>
          <p className="text-xs font-bold tracking-[0.18em] uppercase text-ink-soft">
            {result?.crewWin ? "Crew wins" : result?.tie ? "Tie · impostor lives" : "Impostor wins"}
          </p>
          <CardTitle className="text-2xl">
            {result?.impostorName} was the impostor
          </CardTitle>
        </CardHeader>
        <CardContent>
          {iWon !== null && iWon !== undefined && (
            <p className="text-sm font-semibold mb-3">
              {iWon ? "You won this round." : "You lost this round."}
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {(shared.tally || []).map((t) => (
              <li
                key={t.targetId}
                className="flex items-center justify-between rounded-2xl border border-ink-line bg-ink px-4 py-3"
              >
                <span className={t.targetId === result?.impostorId ? "text-signal font-bold" : ""}>
                  {t.name}
                  {t.targetId === result?.impostorId && " · impostor"}
                </span>
                <Badge tone={t.votes > 0 ? "signal" : "neutral"}>
                  {t.votes} vote{t.votes === 1 ? "" : "s"}
                </Badge>
              </li>
            ))}
          </ul>
          {!you.role && (
            <p className="text-xs text-ink-soft mt-3">
              The secret word stays private to crew.
            </p>
          )}
        </CardContent>
      </Card>
      <RoleCard you={you} phase={shared.phase} />
    </>
  );
}
