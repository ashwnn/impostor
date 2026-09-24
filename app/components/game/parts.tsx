import { useState } from "react";
import {
  Check,
  Copy,
  Crown,
  Eye,
  EyeOff,
  Lightbulb,
  Users,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import type {
  Phase,
  PlayerPublic,
  RoomStateResponse,
  SelfState,
  SharedRoomState,
} from "../../../shared/protocol.ts";
import type { LiveStatus } from "../../lib/api.ts";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";

export function ConnectionBadge({ status }: { status: LiveStatus }) {
  const live = status === "live";
  return (
    <Badge tone={live ? "crew" : "neutral"} className="gap-1">
      {live ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
      {live ? "Live" : status === "connecting" ? "Connecting" : "Reconnecting"}
    </Badge>
  );
}

const STEP_LABELS: Record<Phase, string> = {
  LOBBY: "Lobby",
  SUBMITTING: "Secret words",
  ROLE_REVEAL: "Roles",
  CLUES_PENDING: "Clues",
  DISCUSSION: "Discussion",
  VOTING: "Vote",
  RESULTS: "Results",
  CLOSED: "Closed",
};

export function PhaseBar({ phase }: { phase: Phase }) {
  const steps: Phase[] = [
    "LOBBY",
    "SUBMITTING",
    "ROLE_REVEAL",
    "CLUES_PENDING",
    "DISCUSSION",
    "VOTING",
    "RESULTS",
  ];
  const idx = steps.indexOf(phase);
  return (
    <div className="mb-4">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-2xs font-semibold text-ink-soft">
          Step {Math.max(idx + 1, 1)} of {steps.length}
        </span>
        <span className="text-xs font-bold text-signal">{STEP_LABELS[phase]}</span>
      </div>
      <div
        className="flex gap-1"
        role="progressbar"
        aria-label="Round progress"
        aria-valuenow={Math.max(idx + 1, 1)}
        aria-valuemin={1}
        aria-valuemax={steps.length}
      >
        {steps.map((step, i) => (
          <span
            key={step}
            className={
              "h-1.5 flex-1 rounded-full transition-colors " +
              (i <= idx ? "bg-signal" : "bg-ink-line")
            }
          />
        ))}
      </div>
    </div>
  );
}

export function GuideCard({
  shared,
  you,
}: {
  shared: SharedRoomState;
  you: SelfState;
}) {
  const { phase } = shared;
  const waiting = shared.players.filter((p) => !p.submitted).map((p) => p.name);
  const clueWaiting = shared.players.filter((p) => !p.clueSubmitted).map((p) => p.name);
  const voteWaiting = shared.players.filter((p) => !p.hasVoted).map((p) => p.name);

  let title = "";
  let body = "";
  let icon = <Lightbulb className="h-5 w-5" />;

  switch (phase) {
    case "LOBBY":
      title = you.isHost ? "Waiting for players" : "You're in";
      body = you.isHost
        ? `Share the invite link. Open the word round once ${3}+ players have joined.`
        : "The host will open the word round once everyone has joined.";
      icon = <Users className="h-5 w-5" />;
      break;
    case "SUBMITTING":
      title = "Everyone writes a secret word";
      body = waiting.length
        ? `Waiting on ${waiting.join(", ")}. You can edit your word until the host starts.`
        : "All words are in. The host can start the round.";
      break;
    case "ROLE_REVEAL":
      title = you.role?.impostor ? "You are the impostor" : "You are on the crew";
      body = you.role?.impostor
        ? "You only get the hint. Read it, then bluff like you know the word."
        : "Memorize the word. Don't say it out loud. The impostor only has a hint.";
      icon = you.role?.impostor ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />;
      break;
    case "CLUES_PENDING":
      title = "Write one clue";
      body = clueWaiting.length
        ? `Clues stay hidden until everyone is done. Waiting on ${clueWaiting.join(", ")}.`
        : "All clues are in.";
      break;
    case "DISCUSSION":
      title = "Read the clues together";
      body = "Talk it through out loud. When you're ready, the host starts the vote.";
      break;
    case "VOTING":
      title = "Vote for the impostor";
      body = voteWaiting.length
        ? `Votes reveal together. Waiting on ${voteWaiting.join(", ")}.`
        : "Everyone has voted.";
      break;
    case "RESULTS":
      title = shared.result?.crewWin
        ? "Crew wins"
        : shared.result?.tie
          ? "Tie — the impostor survives"
          : "Impostor wins";
      body = `${shared.result?.impostorName ?? "Someone"} was the impostor.`;
      break;
    default:
      return null;
  }

  return (
    <Card className="border-ink-line bg-ink-raised/60">
      <CardContent className="p-4 flex gap-3">
        <span className="text-gold shrink-0 mt-0.5">{icon}</span>
        <div>
          <p className="font-bold text-body leading-snug">{title}</p>
          <p className="text-ink-soft text-sm mt-1 leading-relaxed">{body}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function RoleCard({ you, phase }: { you: SelfState; phase: Phase }) {
  if (!you.role) return null;
  if (phase === "LOBBY" || phase === "SUBMITTING" || phase === "CLOSED") return null;
  const impostor = you.role.impostor;
  return (
    <Card
      className={
        "reveal-in border-2 " +
        (impostor
          ? "border-signal bg-signal-soft/50"
          : "border-crew/60 bg-crew-soft/50")
      }
    >
      <CardHeader className="pb-1">
        <p
          className={
            "text-xs font-bold tracking-label uppercase " +
            (impostor ? "text-signal" : "text-crew")
          }
        >
          {impostor ? "Impostor" : "Crew"}
        </p>
      </CardHeader>
      <CardContent className="pt-1">
        {impostor ? (
          <>
            <p className="text-xs text-ink-soft mb-1">Your hint</p>
            <p className="display text-3xl sm:text-4xl text-gold break-words">
              {you.role.hint || "—"}
            </p>
            <p className="text-ink-soft text-sm mt-3">
              No word for you. Stay vague, echo the others.
            </p>
          </>
        ) : (
          <>
            <p className="text-xs text-ink-soft mb-1">Your word</p>
            <p className="display text-3xl sm:text-4xl break-words">{you.role.word}</p>
            <p className="text-ink-soft text-sm mt-3">
              Keep it secret. Spot who sounds unsure.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function statusFor(
  p: PlayerPublic,
  phase: Phase,
  tally: SharedRoomState["tally"] | undefined,
): { label: string; tone: "neutral" | "crew" | "gold" | "signal" } | null {
  switch (phase) {
    case "LOBBY":
      return p.connected
        ? { label: "ready", tone: "crew" }
        : { label: "offline", tone: "neutral" };
    case "SUBMITTING":
      return p.submitted ? { label: "word in", tone: "gold" } : { label: "writing…", tone: "neutral" };
    case "CLUES_PENDING":
      return p.clueSubmitted ? { label: "clue in", tone: "gold" } : { label: "thinking…", tone: "neutral" };
    case "VOTING":
      return p.hasVoted ? { label: "voted", tone: "crew" } : { label: "deciding…", tone: "neutral" };
    case "RESULTS": {
      const votes = tally?.find((t) => t.targetId === p.id)?.votes ?? 0;
      return { label: `${votes} vote${votes === 1 ? "" : "s"}`, tone: votes > 0 ? "signal" : "neutral" };
    }
    default:
      return null;
  }
}

export function PlayerList({
  players,
  youId,
  phase,
  isHost,
  tally,
  onKick,
  selectedId,
  onSelect,
  impostorId,
}: {
  players: PlayerPublic[];
  youId: string | null;
  phase: Phase;
  isHost?: boolean;
  tally?: SharedRoomState["tally"];
  onKick?: (id: string) => void;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  impostorId?: string | null;
}) {
  const canKick = isHost && (phase === "LOBBY" || phase === "SUBMITTING");
  return (
    <ul className="stagger flex flex-col gap-2">
      {players.map((p) => {
        const isYou = p.id === youId;
        const status = statusFor(p, phase, tally);
        const selected = selectedId === p.id;
        const content = (
          <>
            <span
              className={
                "h-2.5 w-2.5 rounded-full shrink-0 " +
                (p.connected ? "bg-crew" : "bg-ink-soft/40")
              }
              aria-hidden
            />
            <span className="font-semibold truncate flex-1 min-w-0">
              {p.name}
              {isYou && <span className="text-ink-soft font-normal"> · you</span>}
              {impostorId === p.id && <span className="text-signal font-bold"> · impostor</span>}
              {!p.connected && <span className="text-ink-soft font-normal"> · offline</span>}
            </span>
            {status && <Badge tone={status.tone}>{status.label}</Badge>}
          </>
        );

        const rowClass =
          "flex items-center gap-3 rounded-2xl border px-4 py-3.5 w-full text-left " +
          (selected
            ? "border-signal bg-signal-soft"
            : "border-ink-line bg-ink-raised");

        return (
          <li key={p.id} className="flex items-center gap-2">
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(p.id)}
                disabled={isYou}
                aria-pressed={selected}
                className={rowClass + (isYou ? " opacity-50" : " active:border-signal/40")}
              >
                {content}
              </button>
            ) : (
              <div className={rowClass}>{content}</div>
            )}
            {canKick && !isYou && onKick && (
              <button
                type="button"
                onClick={() => onKick(p.id)}
                aria-label={`Remove ${p.name}`}
                title={`Remove ${p.name}`}
                className="shrink-0 h-11 w-11 rounded-full border border-ink-line text-ink-soft active:text-signal active:border-signal/50 flex items-center justify-center"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function InviteStrip({ roomId }: { roomId: string }) {
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/r/${roomId}`;
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 truncate rounded-xl border border-ink-line bg-ink px-3 py-2 text-xs text-ink-soft">
        {link}
      </code>
      <Button
        size="sm"
        variant="gold"
        onClick={() => {
          void navigator.clipboard?.writeText(link);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

export function HostTag() {
  return (
    <Badge tone="gold" className="gap-1">
      <Crown className="h-3 w-3" /> Host
    </Badge>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Card className="border-signal/40 bg-signal-soft/60 mb-4">
      <CardContent className="p-3 text-sm text-signal" role="alert">
        {message}
      </CardContent>
    </Card>
  );
}

export function HostBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky bottom-0 -mx-4 mt-6 pt-3 bar-safe bg-gradient-to-t from-ink via-ink/95 to-transparent border-t border-ink-line/60">
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

export function PhaseCount({ state }: { state: RoomStateResponse }) {
  const { shared } = state;
  const counted = shared.players.filter((p) => {
    if (shared.phase === "SUBMITTING") return p.submitted;
    if (shared.phase === "CLUES_PENDING") return p.clueSubmitted;
    if (shared.phase === "VOTING") return p.hasVoted;
    return true;
  }).length;
  if (!["SUBMITTING", "CLUES_PENDING", "VOTING"].includes(shared.phase)) return null;
  return (
    <p className="text-center text-xs text-ink-soft">
      {counted} of {shared.activeCount} done
    </p>
  );
}

export { CardTitle };
