import { createHash, randomBytes, randomInt } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  LIMITS,
  normalizeWord,
  wordCount,
  type BankEntry,
  type Phase,
  type PlayerPublic,
  type PoolMode,
  type PrivateRole,
  type RoomStateResponse,
  type SelfState,
  type SharedRoomState,
} from "../shared/protocol.ts";

export interface Player {
  id: string;
  name: string;
  nameNorm: string;
  sessionHash: string;
  seat: number;
  connected: boolean;
  lastSeen: number;
  joinedAt: number;
}

export interface Selection {
  word: string;
  hint: string;
  norm: string;
  source: "player" | "bank";
  impostorId: string;
}

export interface RoomData {
  id: string;
  createdAt: number;
  lastActive: number;
  phase: Phase;
  round: number;
  rev: number;
  maxPlayers: number;
  poolMode: PoolMode;
  hostHash: string;
  closedAt?: number;
  players: Player[];
  bank: BankEntry[];
  submissions: Record<string, { word: string; hint: string }>;
  selection: Selection | null;
  clues: Record<string, string>;
  votes: Record<string, string>;
  cluesRevealed: boolean;
  votesRevealed: boolean;
}

interface Candidate {
  word: string;
  hint: string;
  norm: string;
  source: "player" | "bank";
  authors: string[];
}

interface SseClient {
  res: ServerResponse;
  session?: string;
  host?: string;
}

export class ApiError extends Error {
  status: number;
  fields?: Record<string, string>;

  constructor(message: string, status = 400, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

const OPEN_PHASES: Phase[] = ["LOBBY", "SUBMITTING"];
const CANCEL_PHASES: Phase[] = [
  "SUBMITTING",
  "ROLE_REVEAL",
  "CLUES_PENDING",
  "DISCUSSION",
  "VOTING",
];

function token(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function pick<T>(arr: readonly T[]): T {
  return arr[randomInt(arr.length)];
}

export class Room {
  data: RoomData;
  private clients = new Set<SseClient>();

  constructor(data: RoomData) {
    this.data = data;
  }

  static create(
    id: string,
    opts: { maxPlayers?: number; poolMode?: PoolMode },
  ): { room: Room; hostToken: string } {
    const maxPlayers = opts.maxPlayers ?? LIMITS.DEFAULT_PLAYERS;
    if (
      !Number.isInteger(maxPlayers) ||
      maxPlayers < LIMITS.MIN_PLAYERS ||
      maxPlayers > LIMITS.MAX_PLAYERS
    ) {
      throw new ApiError("maxPlayers must be between 3 and 16", 400, {
        maxPlayers: "Choose 3–16",
      });
    }
    const hostToken = token();
    const room = new Room({
      id,
      createdAt: Date.now(),
      lastActive: Date.now(),
      phase: "LOBBY",
      round: 0,
      rev: 1,
      maxPlayers,
      poolMode: opts.poolMode === "mixed" ? "mixed" : "submissions",
      hostHash: sha256(hostToken),
      players: [],
      bank: [],
      submissions: {},
      selection: null,
      clues: {},
      votes: {},
      cluesRevealed: false,
      votesRevealed: false,
    });
    return { room, hostToken };
  }

  touch(): void {
    this.data.lastActive = Date.now();
  }

  bump(): void {
    this.data.rev += 1;
  }

  resolve(auth: { session?: string; host?: string }): {
    player: Player | null;
    isHost: boolean;
  } {
    let player: Player | null = null;
    if (auth.session) {
      const hash = sha256(auth.session);
      player = this.data.players.find((p) => p.sessionHash === hash) ?? null;
    }
    const isHost = !!auth.host && sha256(auth.host) === this.data.hostHash;
    return { player, isHost };
  }

  // ---------- SSE ----------

  subscribe(res: ServerResponse, auth: { session?: string; host?: string }): () => void {
    const client: SseClient = { res, session: auth.session, host: auth.host };
    this.clients.add(client);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    this.send(client);

    const { player } = this.resolve(auth);
    if (player) {
      const count = (this.presence.get(player.id) ?? 0) + 1;
      this.presence.set(player.id, count);
      if (this.markSeen(player, true)) this.broadcast();
    }

    return () => {
      this.clients.delete(client);
      if (player) {
        const count = (this.presence.get(player.id) ?? 1) - 1;
        if (count <= 0) {
          this.presence.set(player.id, 0);
          if (this.markSeen(player, false)) this.broadcast();
        } else {
          this.presence.set(player.id, count);
        }
      }
    };
  }

  private presence = new Map<string, number>();

  private send(client: SseClient): void {
    try {
      client.res.write(`data: ${JSON.stringify(this.stateFor(client))}\n\n`);
    } catch {
      this.clients.delete(client);
    }
  }

  broadcast(): void {
    for (const client of this.clients) this.send(client);
  }

  heartbeat(): void {
    for (const client of this.clients) {
      try {
        client.res.write(": ping\n\n");
      } catch {
        this.clients.delete(client);
      }
    }
  }

  // ---------- views ----------

  private playerPublic(p: Player): PlayerPublic {
    return {
      id: p.id,
      name: p.name,
      connected: p.connected,
      submitted: p.id in this.data.submissions,
      clueSubmitted: p.id in this.data.clues,
      hasVoted: p.id in this.data.votes,
    };
  }

  private sharedState(): SharedRoomState {
    const d = this.data;
    const players = d.players.map((p) => this.playerPublic(p));
    const showClues =
      d.cluesRevealed ||
      d.phase === "DISCUSSION" ||
      d.phase === "VOTING" ||
      d.phase === "RESULTS";

    const clues = showClues
      ? d.players
          .filter((p) => p.id in d.clues)
          .map((p) => ({ playerId: p.id, name: p.name, clue: d.clues[p.id] }))
      : null;

    let tally: SharedRoomState["tally"] = null;
    let votesDetail: SharedRoomState["votesDetail"] = null;
    let result: SharedRoomState["result"] = null;
    const showVotes = d.votesRevealed || d.phase === "RESULTS";
    if (showVotes) {
      const counts = new Map<string, number>();
      for (const targetId of Object.values(d.votes)) {
        counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
      }
      const byId = new Map(d.players.map((p) => [p.id, p]));
      tally = [...counts.entries()]
        .map(([targetId, votes]) => ({
          targetId,
          name: byId.get(targetId)?.name ?? "Player",
          votes,
        }))
        .sort((a, b) => b.votes - a.votes);
      votesDetail = Object.entries(d.votes).map(([voterId, targetId]) => ({
        voterId,
        voterName: byId.get(voterId)?.name ?? "Player",
        targetId,
        targetName: byId.get(targetId)?.name ?? "Player",
      }));

      if (d.selection) {
        const impostorId = d.selection.impostorId;
        const selectedVotes = counts.get(impostorId) ?? 0;
        const maxVotes = tally.length ? tally[0].votes : 0;
        const uniqueTop =
          tally.length > 0 && (tally.length === 1 || tally[0].votes > tally[1].votes);
        const crewWin = uniqueTop && tally[0]?.targetId === impostorId;
        const tie = !uniqueTop && maxVotes > 0;
        result = {
          impostorId,
          impostorName: byId.get(impostorId)?.name ?? "Player",
          crewWin,
          tie,
          selectedImpostorVotes: selectedVotes,
          maxVotes,
        };
      }
    }

    return {
      roomId: d.id,
      phase: d.phase,
      round: d.round,
      rev: d.rev,
      maxPlayers: d.maxPlayers,
      poolMode: d.poolMode,
      activeCount: d.players.length,
      players,
      bankSize: d.bank.length,
      locked: d.phase !== "LOBBY",
      cluesRevealed: showClues,
      votesRevealed: showVotes,
      clues,
      tally,
      votesDetail,
      result,
    };
  }

  private roleFor(player: Player | null): PrivateRole | null {
    const d = this.data;
    if (!player || !d.selection) return null;
    if (d.phase === "LOBBY" || d.phase === "SUBMITTING" || d.phase === "CLOSED") {
      return null;
    }
    if (d.selection.impostorId === player.id) {
      return { impostor: true, hint: d.selection.hint };
    }
    return { impostor: false, word: d.selection.word };
  }

  private selfState(
    player: Player | null,
    isHost: boolean,
    revealVote: boolean,
  ): SelfState {
    const d = this.data;
    const sub = player ? d.submissions[player.id] : undefined;
    const clue = player ? d.clues[player.id] : undefined;
    const vote = player ? d.votes[player.id] : undefined;
    return {
      playerId: player?.id ?? null,
      name: player?.name ?? null,
      isHost,
      inRoom: !!player,
      role: this.roleFor(player),
      mySubmission: sub ? { word: sub.word, hint: sub.hint } : null,
      myClue: clue ?? null,
      myVote: vote && revealVote ? vote : null,
      ...(isHost ? { bank: d.bank.map((b) => ({ ...b })) } : {}),
    };
  }

  stateFor(auth: { session?: string; host?: string }): RoomStateResponse {
    const { player, isHost } = this.resolve(auth);
    const revealVote = this.data.votesRevealed || this.data.phase === "RESULTS";
    return {
      shared: this.sharedState(),
      you: this.selfState(player, isHost, revealVote),
    };
  }

  // ---------- membership ----------

  join(name: string): { player: Player; sessionToken: string } {
    const d = this.data;
    if (d.phase === "CLOSED") throw new ApiError("This room is closed", 410);
    const clean = name.trim();
    if (!clean) throw new ApiError("Name is required", 400, { name: "Enter a display name" });
    if (clean.length > LIMITS.NAME_MAX) {
      throw new ApiError(`Name must be at most ${LIMITS.NAME_MAX} characters`, 400, {
        name: `Max ${LIMITS.NAME_MAX} characters`,
      });
    }
    if (!OPEN_PHASES.includes(d.phase)) {
      throw new ApiError("A round is in progress — wait for the next one", 409, {
        name: "Round in progress",
      });
    }
    const norm = clean.toLowerCase();
    if (d.players.some((p) => p.nameNorm === norm)) {
      throw new ApiError("That name is already taken", 409, { name: "Name already taken" });
    }
    if (d.players.length >= d.maxPlayers) {
      throw new ApiError("Room is full", 409, { name: "Room is full" });
    }
    const sessionToken = token();
    const player: Player = {
      id: token(8),
      name: clean,
      nameNorm: norm,
      sessionHash: sha256(sessionToken),
      seat: d.players.length ? Math.max(...d.players.map((p) => p.seat)) + 1 : 1,
      connected: true,
      lastSeen: Date.now(),
      joinedAt: Date.now(),
    };
    d.players.push(player);
    this.bump();
    return { player, sessionToken };
  }

  markSeen(player: Player, connected = true): boolean {
    const changed = player.connected !== connected;
    player.connected = connected;
    player.lastSeen = Date.now();
    return changed;
  }

  removePlayer(targetId: string): void {
    const d = this.data;
    if (!OPEN_PHASES.includes(d.phase)) {
      throw new ApiError("Reset the round before removing players", 409);
    }
    const idx = d.players.findIndex((p) => p.id === targetId);
    if (idx === -1) throw new ApiError("Player not found", 404);
    d.players.splice(idx, 1);
    delete d.submissions[targetId];
    delete d.clues[targetId];
    delete d.votes[targetId];
    this.bump();
  }

  setDisconnected(player: Player): void {
    if (player.connected) {
      this.markSeen(player, false);
    }
  }

  // ---------- settings / bank ----------

  updateSettings(opts: { maxPlayers?: number; poolMode?: PoolMode }): void {
    const d = this.data;
    if (d.phase !== "LOBBY") throw new ApiError("Settings lock once words open", 409);
    if (opts.maxPlayers !== undefined) {
      const n = opts.maxPlayers;
      if (!Number.isInteger(n) || n < LIMITS.MIN_PLAYERS || n > LIMITS.MAX_PLAYERS) {
        throw new ApiError("maxPlayers must be between 3 and 16", 400, {
          maxPlayers: "Choose 3–16",
        });
      }
      if (n < d.players.length) {
        throw new ApiError(`Cannot go below ${d.players.length} joined players`, 409, {
          maxPlayers: `Min ${d.players.length}`,
        });
      }
      d.maxPlayers = n;
    }
    if (opts.poolMode !== undefined) {
      if (opts.poolMode !== "mixed" && opts.poolMode !== "submissions") {
        throw new ApiError("Invalid pool mode", 400);
      }
      d.poolMode = opts.poolMode;
    }
    this.bump();
  }

  replaceBank(entries: BankEntry[]): void {
    if (this.data.phase !== "LOBBY") throw new ApiError("Bank locks once words open", 409);
    if (!Array.isArray(entries)) throw new ApiError("entries must be an array", 400);
    if (entries.length > LIMITS.BANK_MAX_ENTRIES) {
      throw new ApiError(`Max ${LIMITS.BANK_MAX_ENTRIES} entries`, 400);
    }
    const fields: Record<string, string> = {};
    const cleaned: BankEntry[] = [];
    entries.forEach((entry, i) => {
      const word = typeof entry?.word === "string" ? entry.word.trim().replace(/\s+/g, " ") : "";
      const hint = typeof entry?.hint === "string" ? entry.hint.trim() : "";
      if (!word || word.length > LIMITS.WORD_MAX) {
        fields[`entries.${i}.word`] = "Invalid word";
        return;
      }
      if (!hint || hint.length > LIMITS.HINT_MAX) {
        fields[`entries.${i}.hint`] = "Invalid hint";
        return;
      }
      if (normalizeWord(hint) === normalizeWord(word)) {
        fields[`entries.${i}.hint`] = "Hint must differ from word";
        return;
      }
      cleaned.push({ word, hint });
    });
    if (Object.keys(fields).length) throw new ApiError("Fix bank entries", 400, fields);
    this.data.bank = cleaned;
    this.bump();
  }

  clearBank(): void {
    if (this.data.phase !== "LOBBY") throw new ApiError("Bank locks once words open", 409);
    this.data.bank = [];
    this.bump();
  }

  // ---------- round flow ----------

  begin(): void {
    const d = this.data;
    if (d.phase !== "LOBBY") throw new ApiError("Round already started", 409);
    if (d.players.length < LIMITS.MIN_PLAYERS) {
      throw new ApiError(`Need at least ${LIMITS.MIN_PLAYERS} players to start`, 409);
    }
    this.resetRoundData();
    d.round = 1;
    d.phase = "SUBMITTING";
    this.bump();
  }

  submit(player: Player, word: string, hint: string): void {
    const d = this.data;
    if (d.phase !== "SUBMITTING") throw new ApiError("Words are not open right now", 409);
    const w = word.trim().replace(/\s+/g, " ");
    const h = hint.trim();
    const fields: Record<string, string> = {};
    if (!w) fields.word = "Enter a word";
    else if (w.length > LIMITS.WORD_MAX) fields.word = `Max ${LIMITS.WORD_MAX} characters`;
    if (!h) fields.hint = "Enter a hint";
    else if (h.length > LIMITS.HINT_MAX) fields.hint = `Max ${LIMITS.HINT_MAX} characters`;
    if (Object.keys(fields).length) throw new ApiError("Check your submission", 400, fields);
    d.submissions[player.id] = { word: w, hint: h };
    this.bump();
  }

  private eligibleCandidates(): Candidate[] {
    const d = this.data;
    const playerIds = new Set(d.players.map((p) => p.id));
    const groups = new Map<string, { word: string; hint: string; authors: string[] }>();
    for (const [playerId, sub] of Object.entries(d.submissions)) {
      if (!playerIds.has(playerId)) continue;
      const norm = normalizeWord(sub.word);
      if (!norm) continue;
      const existing = groups.get(norm);
      if (existing) existing.authors.push(playerId);
      else groups.set(norm, { word: sub.word, hint: sub.hint, authors: [playerId] });
    }

    const out: Candidate[] = [];
    for (const [norm, g] of groups) {
      if (!g.hint || normalizeWord(g.hint) === norm) continue;
      const authors = new Set(g.authors);
      if (d.players.every((p) => authors.has(p.id))) continue;
      out.push({ word: g.word, hint: g.hint, norm, source: "player", authors: g.authors });
    }

    if (d.poolMode === "mixed") {
      for (const entry of d.bank) {
        const norm = normalizeWord(entry.word);
        if (!norm) continue;
        if (!entry.hint || normalizeWord(entry.hint) === norm) continue;
        if (out.some((c) => c.norm === norm)) continue;
        const authors = Object.entries(d.submissions)
          .filter(([id, s]) => playerIds.has(id) && normalizeWord(s.word) === norm)
          .map(([id]) => id);
        const authorSet = new Set(authors);
        if (d.players.every((p) => authorSet.has(p.id))) continue;
        out.push({
          word: entry.word.trim().replace(/\s+/g, " "),
          hint: entry.hint,
          norm,
          source: "bank",
          authors,
        });
      }
    }
    return out;
  }

  start(): void {
    const d = this.data;
    if (d.phase !== "SUBMITTING") {
      throw new ApiError("Start is only available while words are open", 409);
    }
    if (d.players.length < LIMITS.MIN_PLAYERS) {
      throw new ApiError(`Need at least ${LIMITS.MIN_PLAYERS} players to start`, 409);
    }
    const missing = d.players.filter((p) => !(p.id in d.submissions));
    if (missing.length) {
      throw new ApiError(`Waiting on: ${missing.map((p) => p.name).join(", ")}`, 409);
    }

    const candidates = this.eligibleCandidates();
    if (candidates.length === 0) {
      throw new ApiError(
        "No eligible word — at least one player must not have submitted the chosen word, and every candidate needs a hint different from its word",
        409,
      );
    }

    let pool = candidates;
    if (d.poolMode === "mixed") {
      const fromPlayers = candidates.filter((c) => c.source === "player");
      const fromBank = candidates.filter((c) => c.source === "bank");
      if (fromPlayers.length && fromBank.length) {
        pool = randomInt(2) === 0 ? fromPlayers : fromBank;
      }
    } else {
      pool = candidates.filter((c) => c.source === "player");
    }

    const selected = pick(pool);
    const authorSet = new Set(selected.authors);
    const impostorPool = d.players.filter((p) => !authorSet.has(p.id));
    if (!impostorPool.length) {
      throw new ApiError("No eligible impostor — every player submitted the chosen word", 409);
    }
    const impostor = pick(impostorPool);

    d.selection = {
      word: selected.word,
      hint: selected.hint,
      norm: selected.norm,
      source: selected.source,
      impostorId: impostor.id,
    };
    d.clues = {};
    d.votes = {};
    d.cluesRevealed = false;
    d.votesRevealed = false;
    d.phase = "ROLE_REVEAL";
    this.bump();
  }

  setClue(player: Player, clue: string): void {
    const d = this.data;
    if (d.phase !== "CLUES_PENDING") throw new ApiError("Clues are not open right now", 409);
    const c = clue.trim().replace(/\s+/g, " ");
    const fields: Record<string, string> = {};
    if (!c) fields.clue = "Enter a clue";
    else if (c.length > LIMITS.CLUE_MAX) fields.clue = `Max ${LIMITS.CLUE_MAX} characters`;
    else if (wordCount(c) > LIMITS.CLUE_MAX_WORDS) {
      fields.clue = `Max ${LIMITS.CLUE_MAX_WORDS} words`;
    }
    if (Object.keys(fields).length) throw new ApiError("Check your clue", 400, fields);
    d.clues[player.id] = c;
    if (d.players.every((p) => p.id in d.clues)) {
      d.cluesRevealed = true;
      d.phase = "DISCUSSION";
    }
    this.bump();
  }

  vote(player: Player, targetId: string): void {
    const d = this.data;
    if (d.phase !== "VOTING") throw new ApiError("Voting is not open right now", 409);
    if (!targetId) throw new ApiError("Choose a player", 400, { targetId: "Required" });
    if (targetId === player.id) {
      throw new ApiError("You cannot vote for yourself", 400, { targetId: "No self-votes" });
    }
    if (!d.players.some((p) => p.id === targetId)) {
      throw new ApiError("Invalid vote target", 400, { targetId: "Not in room" });
    }
    if (player.id in d.votes) throw new ApiError("You already voted", 409);
    d.votes[player.id] = targetId;
    if (d.players.every((p) => p.id in d.votes)) {
      d.votesRevealed = true;
      d.phase = "RESULTS";
    }
    this.bump();
  }

  private resetRoundData(): void {
    this.data.submissions = {};
    this.data.clues = {};
    this.data.votes = {};
    this.data.selection = null;
    this.data.cluesRevealed = false;
    this.data.votesRevealed = false;
  }

  cancelRound(): void {
    const d = this.data;
    if (!CANCEL_PHASES.includes(d.phase)) {
      throw new ApiError("Nothing to reset right now", 409);
    }
    this.resetRoundData();
    d.phase = "SUBMITTING";
    this.bump();
  }

  nextRound(): void {
    const d = this.data;
    if (d.phase !== "RESULTS") throw new ApiError("Finish the vote first", 409);
    this.resetRoundData();
    d.round += 1;
    d.phase = "SUBMITTING";
    this.bump();
  }

  forceResults(): void {
    const d = this.data;
    if (d.phase !== "VOTING") throw new ApiError("Not in voting", 409);
    d.votesRevealed = true;
    d.phase = "RESULTS";
    this.bump();
  }

  advance(action: string): void {
    const d = this.data;
    switch (action) {
      case "begin":
        this.begin();
        break;
      case "advance":
        if (d.phase === "ROLE_REVEAL") d.phase = "CLUES_PENDING";
        else if (d.phase === "DISCUSSION") d.phase = "VOTING";
        else if (d.phase === "RESULTS") return this.nextRound();
        else throw new ApiError(`Nothing to advance from ${d.phase}`, 409);
        this.bump();
        break;
      case "cancel":
        this.cancelRound();
        break;
      case "force_results":
        this.forceResults();
        break;
      case "close":
        if (d.phase === "CLOSED") throw new ApiError("Already closed", 409);
        d.phase = "CLOSED";
        d.closedAt = Date.now();
        this.bump();
        break;
      default:
        throw new ApiError("Unknown action", 400);
    }
  }

  // ---------- lifecycle ----------

  isExpired(now = Date.now()): boolean {
    if (this.data.phase === "CLOSED") {
      return !!this.data.closedAt && now - this.data.closedAt > LIMITS.ROOM_CLOSED_DELETE_MS;
    }
    return now - this.data.lastActive > LIMITS.ROOM_IDLE_MS;
  }

  toJSON(): RoomData {
    return this.data;
  }
}

export type { Selection as RoomSelection };
