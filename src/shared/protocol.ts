export const PHASES = [
  "LOBBY",
  "SUBMITTING",
  "ROLE_REVEAL",
  "CLUES_PENDING",
  "DISCUSSION",
  "VOTING",
  "RESULTS",
  "CLOSED",
] as const;

export type Phase = (typeof PHASES)[number];

export type PoolMode = "submissions" | "mixed";

export const LIMITS = {
  WORD_MAX: 40,
  HINT_MAX: 100,
  CLUE_MAX: 40,
  CLUE_MAX_WORDS: 3,
  NAME_MAX: 32,
  MIN_PLAYERS: 3,
  MAX_PLAYERS: 16,
  DEFAULT_PLAYERS: 8,
  BANK_MAX_ENTRIES: 500,
  BANK_MAX_BYTES: 200_000,
  ROOM_IDLE_MS: 24 * 60 * 60 * 1000,
  ROOM_CLOSED_DELETE_MS: 5 * 60 * 1000,
} as const;

export interface BankEntry {
  word: string;
  hint: string;
}

export interface PlayerPublic {
  id: string;
  name: string;
  connected: boolean;
  submitted: boolean;
  clueSubmitted: boolean;
  hasVoted: boolean;
}

export interface SharedRoomState {
  roomId: string;
  phase: Phase;
  round: number;
  rev: number;
  maxPlayers: number;
  poolMode: PoolMode;
  activeCount: number;
  players: PlayerPublic[];
  bankSize: number;
  bankLocked: boolean;
  cluesRevealed: boolean;
  votesRevealed: boolean;
  clues: { playerId: string; name: string; clue: string }[] | null;
  tally: { targetId: string; name: string; votes: number }[] | null;
  result: {
    impostorId: string;
    impostorName: string;
    crewWin: boolean;
    selectedImpostorVotes: number;
    maxVotes: number;
    tie: boolean;
  } | null;
  error: string | null;
}

export interface PrivateRole {
  impostor: boolean;
  word?: string;
  hint?: string;
}

export interface SelfState {
  playerId: string | null;
  name: string | null;
  isHost: boolean;
  inRoom: boolean;
  role: PrivateRole | null;
  mySubmission: { word: string; hint: string } | null;
  myClue: string | null;
  myVote: string | null;
  bank?: BankEntry[];
}

export interface RoomStateResponse {
  shared: SharedRoomState;
  you: SelfState;
}

export interface CreateRoomRequest {
  maxPlayers?: number;
  poolMode?: PoolMode;
}

export interface CreateRoomResponse {
  roomId: string;
  invitePath: string;
}

export interface JoinRequest {
  name: string;
}

export interface SubmissionRequest {
  word: string;
  hint: string;
  rev: number;
}

export interface ClueRequest {
  clue: string;
  rev: number;
}

export interface VoteRequest {
  targetId: string;
  rev: number;
}

export type HostAction =
  | "begin"
  | "advance"
  | "cancel"
  | "close"
  | "force_results";

export interface AdvanceRequest {
  action: HostAction;
  rev: number;
}

export interface RemoveRequest {
  targetId: string;
}

export interface BankRequest {
  entries?: BankEntry[];
  clear?: boolean;
  poolMode?: PoolMode;
}

export interface SettingsRequest {
  maxPlayers?: number;
  poolMode?: PoolMode;
}

export interface ApiError {
  error: string;
  fields?: Record<string, string>;
  state?: RoomStateResponse;
}

export function normalizeWord(word: string): string {
  return word.trim().replace(/\s+/g, " ").toLowerCase();
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}
