import type { PlayerPublic, SharedRoomState, SelfState } from "../../src/shared/protocol";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

export function PhaseBar({ shared }: { shared: SharedRoomState }) {
  const steps = [
    "LOBBY",
    "SUBMITTING",
    "ROLE_REVEAL",
    "CLUES_PENDING",
    "DISCUSSION",
    "VOTING",
    "RESULTS",
  ] as const;
  const labels: Record<string, string> = {
    LOBBY: "Lobby",
    SUBMITTING: "Words",
    ROLE_REVEAL: "Roles",
    CLUES_PENDING: "Clues",
    DISCUSSION: "Clues out",
    VOTING: "Vote",
    RESULTS: "Results",
    CLOSED: "Closed",
  };
  const idx = steps.indexOf(shared.phase as (typeof steps)[number]);
  return (
    <div className="flex items-center justify-between gap-1 mb-4 text-[11px] font-semibold">
      {steps.map((s, i) => {
        const active = i === idx;
        const done = idx >= 0 && i < idx;
        return (
          <span
            key={s}
            className={
              "flex-1 text-center py-1.5 rounded-full border truncate " +
              (active
                ? "bg-signal-soft border-signal/50 text-signal"
                : done
                  ? "bg-ink-raised border-ink-line text-ink-soft"
                  : "bg-transparent border-transparent text-ink-soft/40")
            }
            title={labels[s]}
          >
            {labels[s]}
          </span>
        );
      })}
    </div>
  );
}

export function PlayerList({
  players,
  youId,
  showVotes,
  selectedId,
  onSelect,
  votesRevealed,
  tally,
}: {
  players: PlayerPublic[];
  youId: string | null;
  showVotes?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  votesRevealed?: boolean;
  tally?: { targetId: string; votes: number }[] | null;
}) {
  return (
    <ul className="stagger flex flex-col gap-2">
      {players.map((p) => {
        const isYou = p.id === youId;
        const selected = selectedId === p.id;
        const votes = votesRevealed
          ? tally?.find((t) => t.targetId === p.id)?.votes ?? 0
          : null;
        const inner = (
          <>
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={
                  "h-2.5 w-2.5 rounded-full shrink-0 " +
                  (p.connected ? "bg-crew" : "bg-ink-soft/40")
                }
                aria-hidden
              />
              <span className="font-semibold truncate">
                {p.name}
                {isYou && <span className="text-ink-soft font-normal"> · you</span>}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {showVotes && (
                <Badge tone={votes && votes > 0 ? "signal" : "neutral"}>
                  {votesRevealed ? `${votes ?? 0} vote${votes === 1 ? "" : "s"}` : p.hasVoted ? "voted" : "…"}
                </Badge>
              )}
              {!showVotes && p.submitted && (
                <Badge tone="gold">word in</Badge>
              )}
              {!showVotes && !p.submitted && sharedPhaseNeedsWord(p) && (
                <Badge>waiting</Badge>
              )}
              {showVotes && !votesRevealed && p.hasVoted && null}
            </div>
          </>
        );
        if (onSelect) {
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onSelect(p.id)}
                disabled={p.id === youId}
                className={
                  "w-full flex items-center justify-between gap-3 rounded-2xl border px-4 py-3.5 text-left transition-colors " +
                  (selected
                    ? "border-signal bg-signal-soft"
                    : "border-ink-line bg-ink-raised hover:border-ink-soft/50") +
                  (p.id === youId ? " opacity-50" : "")
                }
              >
                {inner}
              </button>
            </li>
          );
        }
        return (
          <li
            key={p.id}
            className="flex items-center justify-between gap-3 rounded-2xl border border-ink-line bg-ink-raised px-4 py-3.5"
          >
            {inner}
          </li>
        );
      })}
    </ul>
  );
}

function sharedPhaseNeedsWord(p: PlayerPublic): boolean {
  return !p.submitted;
}

export function HostBar({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="sticky bottom-0 -mx-4 mt-6 pt-3 pb-1 bg-gradient-to-t from-ink via-ink/95 to-transparent border-t border-ink-line/60">
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Card className="border-signal/40 bg-signal-soft/60 mb-4">
      <CardContent className="p-3 text-sm text-signal">{message}</CardContent>
    </Card>
  );
}

export function RoleCard({ you, phase }: { you: SelfState; phase: string }) {
  if (!you.role || phase === "LOBBY" || phase === "SUBMITTING" || phase === "CLOSED") {
    return null;
  }
  const impostor = you.role.impostor;
  return (
    <Card
      className={
        "reveal-in border-2 " +
        (impostor ? "border-signal bg-signal-soft/40" : "border-crew/50 bg-crew-soft/40")
      }
    >
      <CardHeader className="pb-1">
        <p
          className={
            "text-xs font-bold tracking-[0.18em] uppercase " +
            (impostor ? "text-signal" : "text-crew")
          }
        >
          {impostor ? "You are the impostor" : "You are crew"}
        </p>
      </CardHeader>
      <CardContent className="pt-1">
        {impostor ? (
          <>
            <p className="text-ink-soft text-sm mb-2">
              You do not know the word. Blend in.
            </p>
            <p className="text-xs text-ink-soft mb-1">Your hint</p>
            <p className="display text-3xl sm:text-4xl text-gold break-words">
              {you.role.hint || "—"}
            </p>
          </>
        ) : (
          <>
            <p className="text-ink-soft text-sm mb-2">Your word</p>
            <p className="display text-3xl sm:text-4xl break-words">
              {you.role.word}
            </p>
            <p className="text-ink-soft text-sm mt-3">
              Protect it. The impostor only has a hint.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
