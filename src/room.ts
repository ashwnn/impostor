import {
  type BankEntry,
  type ClueRequest,
  type HostAction,
  type Phase,
  type PlayerPublic,
  type PoolMode,
  type PrivateRole,
  type RoomStateResponse,
  type SelfState,
  type SharedRoomState,
  type SubmissionRequest,
  type VoteRequest,
  LIMITS,
  normalizeWord,
  wordCount,
} from "./shared/protocol";

export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

interface PlayerRow {
  id: string;
  name: string;
  name_norm: string;
  session_hash: string;
  seat: number;
  connected: number;
  last_seen: number;
  [key: string]: SqlStorageValue;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

function err(message: string, status = 400, fields?: Record<string, string>): Response {
  return json({ error: message, fields }, { status });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomInt(maxExclusive: number): number {
  if (maxExclusive <= 0) throw new RangeError("maxExclusive must be positive");
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= limit);
  return value % maxExclusive;
}

function pick<T>(arr: readonly T[]): T {
  return arr[randomInt(arr.length)];
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function sessionCookieName(roomId: string): string {
  return `imp_s_${roomId}`;
}

function hostCookieName(roomId: string): string {
  return `imp_h_${roomId}`;
}

function cookie(name: string, value: string, maxAgeSec: number, secure: boolean): string {
  const securePart = secure ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${securePart}`;
}

function wantsSecure(request: Request): boolean {
  const fwd = request.headers.get("X-Forwarded-Proto");
  if (fwd) return fwd === "https";
  return new URL(request.url).protocol === "https:";
}

export class Room {
  private state: DurableObjectState;
  private env: Env;
  private initialized = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private sql(): SqlStorage {
    return this.state.storage.sql;
  }

  private ensureSchema(): void {
    if (this.initialized) return;
    this.sql().exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_norm TEXT NOT NULL UNIQUE,
        session_hash TEXT NOT NULL,
        seat INTEGER NOT NULL,
        connected INTEGER NOT NULL DEFAULT 0,
        last_seen INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS bank (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        word TEXT NOT NULL,
        hint TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS submissions (
        round INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        word TEXT NOT NULL,
        hint TEXT NOT NULL,
        PRIMARY KEY (round, player_id)
      );
      CREATE TABLE IF NOT EXISTS rounds (
        round INTEGER PRIMARY KEY,
        selected_word TEXT,
        selected_hint TEXT,
        selected_norm TEXT,
        selected_source TEXT,
        impostor_id TEXT
      );
      CREATE TABLE IF NOT EXISTS clues (
        round INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        clue TEXT NOT NULL,
        PRIMARY KEY (round, player_id)
      );
      CREATE TABLE IF NOT EXISTS votes (
        round INTEGER NOT NULL,
        voter_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        PRIMARY KEY (round, voter_id)
      );
    `);
    this.initialized = true;
  }

  private getMeta(key: string): string | null {
    const row = this.sql()
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
      .toArray()[0];
    return row ? row.value : null;
  }

  private setMeta(key: string, value: string): void {
    this.sql().exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private getMetaNum(key: string, fallback = 0): number {
    const v = this.getMeta(key);
    return v === null ? fallback : Number(v);
  }

  private getPhase(): Phase {
    return (this.getMeta("phase") as Phase) || "LOBBY";
  }

  private setPhase(phase: Phase): void {
    this.setMeta("phase", phase);
  }

  private getRound(): number {
    return this.getMetaNum("round", 0);
  }

  private getRev(): number {
    return this.getMetaNum("rev", 1);
  }

  private bumpRev(): number {
    const next = this.getRev() + 1;
    this.setMeta("rev", String(next));
    return next;
  }

  private touch(): void {
    this.setMeta("last_active", String(Date.now()));
    this.scheduleExpiry();
  }

  private scheduleExpiry(): void {
    const phase = this.getPhase();
    const lastActive = this.getMetaNum("last_active", Date.now());
    if (phase === "CLOSED") {
      void this.state.storage.setAlarm(Date.now() + LIMITS.ROOM_CLOSED_DELETE_MS);
    } else {
      void this.state.storage.setAlarm(lastActive + LIMITS.ROOM_IDLE_MS);
    }
  }

  private listPlayers(): PlayerRow[] {
    return this.sql()
      .exec<PlayerRow>("SELECT * FROM players ORDER BY seat ASC")
      .toArray();
  }

  private async playerFromRequest(request: Request, roomId: string): Promise<PlayerRow | null> {
    const cookies = parseCookies(request.headers.get("Cookie"));
    const token = cookies[sessionCookieName(roomId)];
    if (!token) return null;
    const hash = await sha256Hex(token);
    const row = this.sql()
      .exec<PlayerRow>("SELECT * FROM players WHERE session_hash = ?", hash)
      .toArray()[0];
    return row || null;
  }

  private async isHost(request: Request, roomId: string): Promise<boolean> {
    const cookies = parseCookies(request.headers.get("Cookie"));
    const token = cookies[hostCookieName(roomId)];
    if (!token) return false;
    const stored = this.getMeta("host_hash");
    if (!stored) return false;
    return (await sha256Hex(token)) === stored;
  }

  private submittedIds(round: number): Set<string> {
    const rows = this.sql()
      .exec<{ player_id: string }>("SELECT player_id FROM submissions WHERE round = ?", round)
      .toArray();
    return new Set(rows.map((r) => r.player_id));
  }

  private clueIds(round: number): Set<string> {
    const rows = this.sql()
      .exec<{ player_id: string }>("SELECT player_id FROM clues WHERE round = ?", round)
      .toArray();
    return new Set(rows.map((r) => r.player_id));
  }

  private voteRows(round: number): { voter_id: string; target_id: string }[] {
    return this.sql()
      .exec<{ voter_id: string; target_id: string }>(
        "SELECT voter_id, target_id FROM votes WHERE round = ?",
        round,
      )
      .toArray();
  }

  private sharedState(error: string | null = null): SharedRoomState {
    const roomId = this.getMeta("room_id") || "";
    const phase = this.getPhase();
    const round = this.getRound();
    const players = this.listPlayers();
    const submitted = this.submittedIds(round);
    const clues = this.clueIds(round);
    const votes = new Set(this.voteRows(round).map((v) => v.voter_id));
    const poolMode = (this.getMeta("pool_mode") as PoolMode) || "submissions";
    const bankSize = this.sql().exec("SELECT id FROM bank").toArray().length;
    const cluesRevealed = this.getMeta("clues_revealed") === "1";
    const votesRevealed = this.getMeta("votes_revealed") === "1";

    const playerPublic: PlayerPublic[] = players.map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected === 1,
      submitted: submitted.has(p.id),
      clueSubmitted: clues.has(p.id),
      hasVoted: votes.has(p.id),
    }));

    let sharedClues: SharedRoomState["clues"] = null;
    if (cluesRevealed || phase === "DISCUSSION" || phase === "VOTING" || phase === "RESULTS") {
      const rows = this.sql()
        .exec<{ player_id: string; clue: string }>(
          "SELECT player_id, clue FROM clues WHERE round = ?",
          round,
        )
        .toArray();
      sharedClues = rows.map((r) => {
        const p = players.find((x) => x.id === r.player_id);
        return { playerId: r.player_id, name: p?.name || "Player", clue: r.clue };
      });
    }

    let tally: SharedRoomState["tally"] = null;
    let result: SharedRoomState["result"] = null;
    if (votesRevealed || phase === "RESULTS") {
      const voteList = this.voteRows(round);
      const counts = new Map<string, number>();
      for (const v of voteList) {
        counts.set(v.target_id, (counts.get(v.target_id) || 0) + 1);
      }
      const playersById = new Map(players.map((p) => [p.id, p]));
      tally = [...counts.entries()].map(([targetId, votesN]) => ({
        targetId,
        name: playersById.get(targetId)?.name || "Player",
        votes: votesN,
      }));
      tally.sort((a, b) => b.votes - a.votes);

      const roundRow = this.sql()
        .exec<{ impostor_id: string | null }>(
          "SELECT impostor_id FROM rounds WHERE round = ?",
          round,
        )
        .toArray()[0];
      const impostorId = roundRow?.impostor_id;
      if (impostorId) {
        const impostorVotes = counts.get(impostorId) || 0;
        const maxVotes = tally.length ? tally[0].votes : 0;
        const uniqueTop =
          tally.length > 0 &&
          (tally.length === 1 || tally[0].votes > tally[1].votes);
        const isTop = uniqueTop && tally[0]?.targetId === impostorId;
        const tie = !uniqueTop && maxVotes > 0;
        result = {
          impostorId,
          impostorName: playersById.get(impostorId)?.name || "Player",
          crewWin: isTop,
          selectedImpostorVotes: impostorVotes,
          maxVotes,
          tie,
        };
      }
    }

    return {
      roomId,
      phase,
      round,
      rev: this.getRev(),
      maxPlayers: this.getMetaNum("max_players", LIMITS.DEFAULT_PLAYERS),
      poolMode,
      activeCount: players.length,
      players: playerPublic,
      bankSize,
      bankLocked: phase !== "LOBBY",
      cluesRevealed: cluesRevealed || phase === "DISCUSSION" || phase === "VOTING" || phase === "RESULTS",
      votesRevealed: votesRevealed || phase === "RESULTS",
      clues: sharedClues,
      tally,
      result,
      error,
    };
  }

  private async privateRole(playerId: string | null): Promise<PrivateRole | null> {
    if (!playerId) return null;
    const phase = this.getPhase();
    const resetPhases: Phase[] = ["LOBBY", "SUBMITTING"];
    if (resetPhases.includes(phase)) return null;
    if (phase === "CLOSED") return null;
    const round = this.getRound();
    const row = this.sql()
      .exec<{ selected_word: string | null; selected_hint: string | null; impostor_id: string | null }>(
        "SELECT selected_word, selected_hint, impostor_id FROM rounds WHERE round = ?",
        round,
      )
      .toArray()[0];
    if (!row || !row.selected_word) return null;

    const isImpostor = row.impostor_id === playerId;
    if (isImpostor) {
      return { impostor: true, hint: row.selected_hint || undefined };
    }
    return { impostor: false, word: row.selected_word };
  }

  private hostBank(): BankEntry[] | undefined {
    return this.sql()
      .exec<{ word: string; hint: string }>("SELECT word, hint FROM bank ORDER BY id")
      .toArray()
      .map((r) => ({ word: r.word, hint: r.hint }));
  }

  private async selfState(request: Request, roomId: string): Promise<SelfState> {
    const player = await this.playerFromRequest(request, roomId);
    const isHost = await this.isHost(request, roomId);
    const round = this.getRound();
    const phase = this.getPhase();

    let mySubmission: SelfState["mySubmission"] = null;
    let myClue: string | null = null;
    let myVote: string | null = null;
    if (player) {
      const sub = this.sql()
        .exec<{ word: string; hint: string }>(
          "SELECT word, hint FROM submissions WHERE round = ? AND player_id = ?",
          round,
          player.id,
        )
        .toArray()[0];
      if (sub) mySubmission = { word: sub.word, hint: sub.hint };
      const clue = this.sql()
        .exec<{ clue: string }>(
          "SELECT clue FROM clues WHERE round = ? AND player_id = ?",
          round,
          player.id,
        )
        .toArray()[0];
      if (clue) myClue = clue.clue;
      const vote = this.sql()
        .exec<{ target_id: string }>(
          "SELECT target_id FROM votes WHERE round = ? AND voter_id = ?",
          round,
          player.id,
        )
        .toArray()[0];
      if (vote && (this.getMeta("votes_revealed") === "1" || phase === "RESULTS")) {
        myVote = vote.target_id;
      } else if (vote) {
        // hide target until reveal; just flag presence via phase
        myVote = null;
      }
    }

    return {
      playerId: player?.id || null,
      name: player?.name || null,
      isHost,
      inRoom: !!player,
      role: await this.privateRole(player?.id || null),
      mySubmission,
      myClue,
      myVote,
      ...(isHost ? { bank: this.hostBank() } : {}),
    };
  }

  async stateResponse(request: Request): Promise<RoomStateResponse> {
    const roomId = this.getMeta("room_id") || "";
    return {
      shared: this.sharedState(),
      you: await this.selfState(request, roomId),
    };
  }

  private broadcast(): void {
    const sockets = this.state.getWebSockets();
    // Fire-and-forget personalized snapshots; each socket tags its player.
    void this.broadcastAsync(sockets);
  }

  private async broadcastAsync(sockets: WebSocket[]): Promise<void> {
    const roomId = this.getMeta("room_id") || "";
    const shared = this.sharedState();
    for (const ws of sockets) {
      try {
        const playerId = (ws as unknown as { __playerId?: string }).__playerId || null;
        const isHost = (ws as unknown as { __isHost?: boolean }).__isHost || false;
        const you: SelfState = {
          playerId,
          name: playerId
            ? this.listPlayers().find((p) => p.id === playerId)?.name || null
            : null,
          isHost,
          inRoom: !!playerId,
          role: await this.privateRole(playerId),
          mySubmission: null,
          myClue: null,
          myVote: null,
          ...(isHost ? { bank: this.hostBank() } : {}),
        };
        if (playerId) {
          const round = this.getRound();
          const sub = this.sql()
            .exec<{ word: string; hint: string }>(
              "SELECT word, hint FROM submissions WHERE round = ? AND player_id = ?",
              round,
              playerId,
            )
            .toArray()[0];
          if (sub) you.mySubmission = { word: sub.word, hint: sub.hint };
          const clue = this.sql()
            .exec<{ clue: string }>(
              "SELECT clue FROM clues WHERE round = ? AND player_id = ?",
              round,
              playerId,
            )
            .toArray()[0];
          if (clue) you.myClue = clue.clue;
          const phase = this.getPhase();
          const vote = this.sql()
            .exec<{ target_id: string }>(
              "SELECT target_id FROM votes WHERE round = ? AND voter_id = ?",
              round,
              playerId,
            )
            .toArray()[0];
          if (vote && (this.getMeta("votes_revealed") === "1" || phase === "RESULTS")) {
            you.myVote = vote.target_id;
          }
        }
        ws.send(JSON.stringify({ shared, you }));
      } catch {
        // socket may be closing
      }
    }
  }

  // --- API handlers ---

  async handleCreate(request: Request, roomId: string): Promise<Response> {
    this.ensureSchema();
    if (this.getMeta("room_id")) {
      return err("Room already exists", 409);
    }
    const body = (await request.json().catch(() => ({}))) as {
      maxPlayers?: number;
      poolMode?: PoolMode;
    };
    const maxPlayers = body.maxPlayers ?? LIMITS.DEFAULT_PLAYERS;
    if (
      !Number.isInteger(maxPlayers) ||
      maxPlayers < LIMITS.MIN_PLAYERS ||
      maxPlayers > LIMITS.MAX_PLAYERS
    ) {
      return err("maxPlayers must be between 3 and 16", 400, {
        maxPlayers: "Choose 3–16 players",
      });
    }
    const poolMode: PoolMode = body.poolMode === "mixed" ? "mixed" : "submissions";

    const hostToken = randomToken();
    this.setMeta("room_id", roomId);
    this.setMeta("host_hash", await sha256Hex(hostToken));
    this.setMeta("max_players", String(maxPlayers));
    this.setMeta("pool_mode", poolMode);
    this.setMeta("phase", "LOBBY");
    this.setMeta("round", "0");
    this.setMeta("rev", "1");
    this.setMeta("created_at", String(Date.now()));
    this.setMeta("last_active", String(Date.now()));
    this.scheduleExpiry();

    return json(
      { roomId, invitePath: `/r/${roomId}` },
      {
        headers: {
          "set-cookie": cookie(hostCookieName(roomId), hostToken, 7 * 24 * 3600, wantsSecure(request)),
        },
      },
    );
  }

  async handleJoin(request: Request, roomId: string): Promise<Response> {
    this.ensureSchema();
    this.touch();

    const phase = this.getPhase();
    if (phase === "CLOSED") return err("This room is closed", 410);

    const cookies = parseCookies(request.headers.get("Cookie"));
    const existingToken = cookies[sessionCookieName(roomId)];
    if (existingToken) {
      const hash = await sha256Hex(existingToken);
      const existing = this.sql()
        .exec<PlayerRow>("SELECT * FROM players WHERE session_hash = ?", hash)
        .toArray()[0];
      if (existing) {
        this.sql().exec("UPDATE players SET connected = 1, last_seen = ? WHERE id = ?", Date.now(), existing.id);
        this.bumpRev();
        this.broadcast();
        return json(
          { ok: true, playerId: existing.id, rejoined: true },
          {
            headers: {
              "set-cookie": cookie(sessionCookieName(roomId), existingToken, 7 * 24 * 3600, wantsSecure(request)),
            },
          },
        );
      }
    }

    if (phase !== "LOBBY" && phase !== "SUBMITTING") {
      return err("Round in progress — new players cannot join", 409);
    }

    const body = (await request.json().catch(() => ({}))) as { name?: string };
    const name = (body.name || "").trim();
    if (!name) {
      return err("Name is required", 400, { name: "Enter a display name" });
    }
    if (name.length > LIMITS.NAME_MAX) {
      return err(`Name must be at most ${LIMITS.NAME_MAX} characters`, 400, {
        name: `Max ${LIMITS.NAME_MAX} characters`,
      });
    }
    const nameNorm = name.toLowerCase();
    if (this.sql().exec("SELECT id FROM players WHERE name_norm = ?", nameNorm).toArray().length) {
      return err("That name is already taken", 409, { name: "Name already taken" });
    }

    const maxPlayers = this.getMetaNum("max_players", LIMITS.DEFAULT_PLAYERS);
    const active = this.listPlayers();
    if (active.length >= maxPlayers) {
      return err("Room is full", 409, { name: "Room is full" });
    }

    const playerId = randomToken(16);
    const sessionToken = randomToken();
    const seat = active.length
      ? Math.max(...active.map((p) => p.seat)) + 1
      : 1;
    this.sql().exec(
      "INSERT INTO players (id, name, name_norm, session_hash, seat, connected, last_seen) VALUES (?, ?, ?, ?, ?, 1, ?)",
      playerId,
      name,
      nameNorm,
      await sha256Hex(sessionToken),
      seat,
      Date.now(),
    );
    this.bumpRev();
    this.broadcast();

    return json(
      { ok: true, playerId, rejoined: false },
      {
        headers: {
          "set-cookie": cookie(sessionCookieName(roomId), sessionToken, 7 * 24 * 3600, wantsSecure(request)),
        },
      },
    );
  }

  async handleState(request: Request): Promise<Response> {
    this.ensureSchema();
    this.touch();
    if (!this.getMeta("room_id")) return err("Room not found", 404);
    return json(await this.stateResponse(request));
  }

  async handleSubmission(request: Request, roomId: string): Promise<Response> {
    this.ensureSchema();
    this.touch();
    const player = await this.playerFromRequest(request, roomId);
    if (!player) return err("Join the room first", 401);

    const phase = this.getPhase();
    if (phase !== "SUBMITTING") {
      return err("Submissions are not open", 409, undefined);
    }

    const body = (await request.json().catch(() => ({}))) as SubmissionRequest;
    const word = (body.word || "").trim().replace(/\s+/g, " ");
    const hint = (body.hint || "").trim();
    const fields: Record<string, string> = {};
    if (!word) fields.word = "Enter a word";
    else if (word.length > LIMITS.WORD_MAX) fields.word = `Max ${LIMITS.WORD_MAX} characters`;
    if (!hint) fields.hint = "Enter a hint";
    else if (hint.length > LIMITS.HINT_MAX) fields.hint = `Max ${LIMITS.HINT_MAX} characters`;
    if (Object.keys(fields).length) {
      return err("Check your submission", 400, fields);
    }

    const round = this.getRound();
    this.sql().exec(
      `INSERT INTO submissions (round, player_id, word, hint) VALUES (?, ?, ?, ?)
       ON CONFLICT(round, player_id) DO UPDATE SET word = excluded.word, hint = excluded.hint`,
      round,
      player.id,
      word,
      hint,
    );
    this.bumpRev();
    this.broadcast();
    return json(await this.stateResponse(request));
  }

  private validateStart(): { ok: true } | { ok: false; error: string } {
    const phase = this.getPhase();
    if (phase !== "SUBMITTING") {
      return { ok: false, error: "Start is only available while submissions are open" };
    }
    const players = this.listPlayers();
    if (players.length < LIMITS.MIN_PLAYERS) {
      return { ok: false, error: `Need at least ${LIMITS.MIN_PLAYERS} players to start` };
    }
    const round = this.getRound();
    const submitted = this.submittedIds(round);
    const missing = players.filter((p) => !submitted.has(p.id));
    if (missing.length) {
      return {
        ok: false,
        error: `Waiting on: ${missing.map((p) => p.name).join(", ")}`,
      };
    }
    return { ok: true };
  }

  private eligibleCandidates(): {
    word: string;
    hint: string;
    norm: string;
    source: "player" | "bank";
    authors: string[];
  }[] {
    const round = this.getRound();
    const players = this.listPlayers();
    const playerIds = new Set(players.map((p) => p.id));
    const subs = this.sql()
      .exec<{ player_id: string; word: string; hint: string }>(
        "SELECT player_id, word, hint FROM submissions WHERE round = ?",
        round,
      )
      .toArray();

    // group player submissions by normalized word
    const groups = new Map<string, { word: string; hint: string; authors: string[] }>();
    for (const s of subs) {
      if (!playerIds.has(s.player_id)) continue;
      const norm = normalizeWord(s.word);
      if (!norm) continue;
      const g = groups.get(norm);
      if (g) {
        g.authors.push(s.player_id);
      } else {
        groups.set(norm, { word: s.word.trim().replace(/\s+/g, " "), hint: s.hint, authors: [s.player_id] });
      }
    }

    const out: {
      word: string;
      hint: string;
      norm: string;
      source: "player" | "bank";
      authors: string[];
    }[] = [];

    for (const [norm, g] of groups) {
      if (!g.hint || normalizeWord(g.hint) === norm) continue;
      // eligible only if at least one active player did not submit this word
      const authorSet = new Set(g.authors);
      const nonAuthors = players.filter((p) => !authorSet.has(p.id));
      if (nonAuthors.length === 0) continue;
      out.push({
        word: g.word,
        hint: g.hint,
        norm,
        source: "player",
        authors: g.authors,
      });
    }

    if (this.getMeta("pool_mode") === "mixed") {
      const bank = this.sql()
        .exec<{ word: string; hint: string }>("SELECT word, hint FROM bank")
        .toArray();
      for (const b of bank) {
        const norm = normalizeWord(b.word);
        if (!norm) continue;
        if (!b.hint || normalizeWord(b.hint) === norm) continue;
        const authors = subs
          .filter((s) => normalizeWord(s.word) === norm && playerIds.has(s.player_id))
          .map((s) => s.player_id);
        const authorSet = new Set(authors);
        const nonAuthors = players.filter((p) => !authorSet.has(p.id));
        if (nonAuthors.length === 0) continue;
        // avoid exact duplicate of a player-source candidate with same norm already handled —
        // bank entries are separate copies; keep them if norm differs OR player source lacks eligibility
        const already = out.some((c) => c.norm === norm && c.source === "player");
        if (already) continue;
        out.push({
          word: b.word.trim().replace(/\s+/g, " "),
          hint: b.hint,
          norm,
          source: "bank",
          authors,
        });
      }
    }

    return out;
  }

  async handleStart(request: Request, roomId: string): Promise<Response> {
    this.ensureSchema();
    this.touch();
    if (!(await this.isHost(request, roomId))) return err("Host only", 403);

    const gate = this.validateStart();
    if (!gate.ok) {
      return err(gate.error, 409);
    }

    const candidates = this.eligibleCandidates();
    if (candidates.length === 0) {
      return err(
        "No eligible word — at least one player must not have submitted the chosen word, and every candidate needs a valid distinct hint",
        409,
      );
    }

    // 50/50 source choice when mixed and both sources present
    const poolMode = this.getMeta("pool_mode");
    let pool = candidates;
    if (poolMode === "mixed") {
      const fromPlayer = candidates.filter((c) => c.source === "player");
      const fromBank = candidates.filter((c) => c.source === "bank");
      if (fromPlayer.length && fromBank.length) {
        pool = randomInt(2) === 0 ? fromPlayer : fromBank;
      } else {
        pool = candidates;
      }
    } else {
      pool = candidates.filter((c) => c.source === "player");
      if (pool.length === 0) pool = candidates;
    }

    const selected = pick(pool);
    const players = this.listPlayers();
    const authorSet = new Set(selected.authors);
    const impostorPool = players.filter((p) => !authorSet.has(p.id));
    if (impostorPool.length === 0) {
      return err("No eligible impostor — every player authored that word", 409);
    }
    const impostor = pick(impostorPool);

    // round was opened by begin; store selection for the current round
    const round = Math.max(this.getRound(), 1);
    this.setMeta("round", String(round));
    this.sql().exec(
      `INSERT INTO rounds (round, selected_word, selected_hint, selected_norm, selected_source, impostor_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      round,
      selected.word,
      selected.hint,
      selected.norm,
      selected.source,
      impostor.id,
    );
    this.setMeta("clues_revealed", "0");
    this.setMeta("votes_revealed", "0");
    this.setPhase("ROLE_REVEAL");
    this.bumpRev();
    this.broadcast();
    return json(await this.stateResponse(request));
  }

  async handleClue(request: Request, roomId: string): Promise<Response> {
    this.ensureSchema();
    this.touch();
    const player = await this.playerFromRequest(request, roomId);
    if (!player) return err("Join the room first", 401);
    if (this.getPhase() !== "CLUES_PENDING") {
      return err("Clues are not open", 409);
    }

    const body = (await request.json().catch(() => ({}))) as { clue?: string; rev?: number };
    const clue = (body.clue || "").trim().replace(/\s+/g, " ");
    const fields: Record<string, string> = {};
    if (!clue) fields.clue = "Enter a clue";
    else if (clue.length > LIMITS.CLUE_MAX) fields.clue = `Max ${LIMITS.CLUE_MAX} characters`;
    else if (wordCount(clue) > LIMITS.CLUE_MAX_WORDS) fields.clue = `Max ${LIMITS.CLUE_MAX_WORDS} words`;
    if (Object.keys(fields).length) return err("Check your clue", 400, fields);

    const round = this.getRound();
    this.sql().exec(
      `INSERT INTO clues (round, player_id, clue) VALUES (?, ?, ?)
       ON CONFLICT(round, player_id) DO UPDATE SET clue = excluded.clue`,
      round,
      player.id,
      clue,
    );

    // auto-reveal when all active players submitted
    const players = this.listPlayers();
    const have = this.clueIds(round);
    if (players.every((p) => have.has(p.id))) {
      this.setMeta("clues_revealed", "1");
      this.setPhase("DISCUSSION");
    }
    this.bumpRev();
    this.broadcast();
    return json(await this.stateResponse(request));
  }

  async handleVote(request: Request, roomId: string): Promise<Response> {
    this.ensureSchema();
    this.touch();
    const player = await this.playerFromRequest(request, roomId);
    if (!player) return err("Join the room first", 401);
    if (this.getPhase() !== "VOTING") return err("Voting is not open", 409);

    const body = (await request.json().catch(() => ({}))) as VoteRequest;
    const targetId = body.targetId || "";
    if (!targetId) return err("Choose a player", 400, { targetId: "Required" });
    if (targetId === player.id) return err("You cannot vote for yourself", 400, { targetId: "No self-votes" });
    const target = this.listPlayers().find((p) => p.id === targetId);
    if (!target) return err("Invalid vote target", 400, { targetId: "Not in room" });

    const round = this.getRound();
    const existing = this.sql()
      .exec("SELECT voter_id FROM votes WHERE round = ? AND voter_id = ?", round, player.id)
      .toArray();
    if (existing.length) return err("You already voted", 409);

    this.sql().exec(
      "INSERT INTO votes (round, voter_id, target_id) VALUES (?, ?, ?)",
      round,
      player.id,
      targetId,
    );

    const players = this.listPlayers();
    const voted = new Set(this.voteRows(round).map((v) => v.voter_id));
    if (players.every((p) => voted.has(p.id))) {
      this.setMeta("votes_revealed", "1");
      this.setPhase("RESULTS");
    }
    this.bumpRev();
    this.broadcast();
    return json(await this.stateResponse(request));
  }

  private clearRoundData(round: number): void {
    this.sql().exec("DELETE FROM submissions WHERE round = ?", round);
    this.sql().exec("DELETE FROM clues WHERE round = ?", round);
    this.sql().exec("DELETE FROM votes WHERE round = ?", round);
    this.sql().exec("DELETE FROM rounds WHERE round = ?", round);
  }

  async handleAdvance(request: Request, roomId: string): Promise<Response> {
    this.ensureSchema();
    this.touch();
    if (!(await this.isHost(request, roomId))) return err("Host only", 403);

    const body = (await request.json().catch(() => ({}))) as { action?: HostAction };
    const action = body.action;
    const phase = this.getPhase();
    const round = this.getRound();

    switch (action) {
      case "begin": {
        if (phase !== "LOBBY") return err("Already started", 409);
        const players = this.listPlayers();
        if (players.length < LIMITS.MIN_PLAYERS) {
          return err(`Need at least ${LIMITS.MIN_PLAYERS} players`, 409);
        }
        this.setMeta("round", "1");
        this.clearRoundData(1);
        this.setMeta("clues_revealed", "0");
        this.setMeta("votes_revealed", "0");
        this.setPhase("SUBMITTING");
        break;
      }
      case "advance": {
        if (phase === "ROLE_REVEAL") {
          this.setPhase("CLUES_PENDING");
        } else if (phase === "DISCUSSION") {
          this.setPhase("VOTING");
        } else if (phase === "RESULTS") {
          // next round: clear submissions/clues/votes/roles
          const next = round + 1;
          this.setMeta("round", String(next));
          this.clearRoundData(round);
          this.setMeta("clues_revealed", "0");
          this.setMeta("votes_revealed", "0");
          this.setPhase("SUBMITTING");
        } else {
          return err(`Cannot advance from ${phase}`, 409);
        }
        break;
      }
      case "cancel": {
        if (phase === "ROLE_REVEAL" || phase === "CLUES_PENDING" || phase === "SUBMITTING") {
          // reset current round, keep roster; return to SUBMITTING with fresh slate
          if (round > 0) this.clearRoundData(round);
          if (round === 0) {
            this.setMeta("round", "1");
          }
          this.setMeta("clues_revealed", "0");
          this.setMeta("votes_revealed", "0");
          this.setPhase(round > 0 ? "SUBMITTING" : "LOBBY");
          if (round > 0) {
            // keep round number, fresh submissions
            this.setPhase("SUBMITTING");
          }
        } else {
          return err("Cannot cancel in this phase", 409);
        }
        break;
      }
      case "force_results": {
        if (phase !== "VOTING") return err("Not in voting", 409);
        this.setMeta("votes_revealed", "1");
        this.setPhase("RESULTS");
        break;
      }
      case "close": {
        if (phase === "CLOSED") return err("Already closed", 409);
        this.setPhase("CLOSED");
        this.scheduleExpiry();
        break;
      }
      default:
        return err("Unknown action", 400);
    }

    this.bumpRev();
    this.broadcast();
    return json(await this.stateResponse(request));
  }

  async handleRemove(request: Request, roomId: string): Promise<Response> {
    this.ensureSchema();
    this.touch();
    if (!(await this.isHost(request, roomId))) return err("Host only", 403);

    const phase = this.getPhase();
    // remove only before start lock (LOBBY or SUBMITTING)
    if (phase !== "LOBBY" && phase !== "SUBMITTING") {
      return err("Cancel the round before removing players", 409);
    }

    const body = (await request.json().catch(() => ({}))) as { targetId?: string };
    const targetId = body.targetId || "";
    if (!targetId) return err("targetId required", 400);
    const round = this.getRound();
    this.sql().exec("DELETE FROM players WHERE id = ?", targetId);
    this.sql().exec("DELETE FROM submissions WHERE round = ? AND player_id = ?", round, targetId);
    this.bumpRev();
    this.broadcast();
    return json(await this.stateResponse(request));
  }

  async handleSettings(request: Request, roomId: string): Promise<Response> {
    this.ensureSchema();
    this.touch();
    if (!(await this.isHost(request, roomId))) return err("Host only", 403);
    if (this.getPhase() !== "LOBBY") return err("Settings locked after start", 409);

    const body = (await request.json().catch(() => ({}))) as {
      maxPlayers?: number;
      poolMode?: PoolMode;
    };
    if (body.maxPlayers !== undefined) {
      const n = body.maxPlayers;
      if (!Number.isInteger(n) || n < LIMITS.MIN_PLAYERS || n > LIMITS.MAX_PLAYERS) {
        return err("maxPlayers must be between 3 and 16", 400, {
          maxPlayers: "Choose 3–16",
        });
      }
      const active = this.listPlayers().length;
      if (n < active) {
        return err(`Cannot go below ${active} joined players`, 409, {
          maxPlayers: `Min ${active}`,
        });
      }
      this.setMeta("max_players", String(n));
    }
    if (body.poolMode !== undefined) {
      if (body.poolMode !== "mixed" && body.poolMode !== "submissions") {
        return err("Invalid pool mode", 400);
      }
      this.setMeta("pool_mode", body.poolMode);
    }
    this.bumpRev();
    this.broadcast();
    return json(await this.stateResponse(request));
  }

  async handleBank(request: Request, roomId: string): Promise<Response> {
    this.ensureSchema();
    this.touch();
    if (!(await this.isHost(request, roomId))) return err("Host only", 403);
    if (this.getPhase() !== "LOBBY") return err("Bank locked after start", 409);

    const raw = await request.text();
    if (raw.length > LIMITS.BANK_MAX_BYTES) {
      return err("Bank payload too large", 413);
    }
    const body = raw ? (JSON.parse(raw) as { entries?: BankEntry[]; clear?: boolean }) : {};

    if (body.clear) {
      this.sql().exec("DELETE FROM bank");
      this.bumpRev();
      this.broadcast();
      return json(await this.stateResponse(request));
    }

    const entries = body.entries;
    if (!Array.isArray(entries)) return err("entries must be an array", 400);
    if (entries.length > LIMITS.BANK_MAX_ENTRIES) {
      return err(`Max ${LIMITS.BANK_MAX_ENTRIES} entries`, 400);
    }
    const fields: Record<string, string> = {};
    const cleaned: BankEntry[] = [];
    entries.forEach((e, i) => {
      const word = typeof e?.word === "string" ? e.word.trim().replace(/\s+/g, " ") : "";
      const hint = typeof e?.hint === "string" ? e.hint.trim() : "";
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
    if (Object.keys(fields).length) {
      return err("Fix bank entries", 400, fields);
    }
    if (cleaned.length > LIMITS.BANK_MAX_ENTRIES) {
      return err(`Max ${LIMITS.BANK_MAX_ENTRIES} entries`, 400);
    }

    this.sql().exec("DELETE FROM bank");
    for (const e of cleaned) {
      this.sql().exec("INSERT INTO bank (word, hint) VALUES (?, ?)", e.word, e.hint);
    }
    this.bumpRev();
    this.broadcast();
    return json(await this.stateResponse(request));
  }

  async handleWsUpgrade(request: Request, roomId: string): Promise<Response> {
    this.ensureSchema();
    this.touch();
    if (this.getPhase() === "CLOSED") return err("Room closed", 410);
    if (!this.getMeta("room_id")) return err("Room not found", 404);

    const player = await this.playerFromRequest(request, roomId);
    const isHost = await this.isHost(request, roomId);
    if (!player && !isHost) return err("Unauthorized", 401);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.state.acceptWebSocket(server);
    (server as unknown as { __playerId?: string | null }).__playerId = player?.id ?? null;
    (server as unknown as { __isHost?: boolean }).__isHost = isHost;

    // send initial snapshot
    const shared = this.sharedState();
    const you: SelfState = {
      playerId: player?.id ?? null,
      name: player?.name ?? null,
      isHost,
      inRoom: !!player,
      role: await this.privateRole(player?.id ?? null),
      mySubmission: player ? this.selfSubmission(player.id) : null,
      myClue: player ? this.selfClue(player.id) : null,
      myVote: null,
      ...(isHost ? { bank: this.hostBank() } : {}),
    };
    server.send(JSON.stringify({ shared, you }));

    return new Response(null, { status: 101, webSocket: client });
  }

  private selfSubmission(playerId: string): { word: string; hint: string } | null {
    const sub = this.sql()
      .exec<{ word: string; hint: string }>(
        "SELECT word, hint FROM submissions WHERE round = ? AND player_id = ?",
        this.getRound(),
        playerId,
      )
      .toArray()[0];
    return sub ? { word: sub.word, hint: sub.hint } : null;
  }

  private selfClue(playerId: string): string | null {
    const row = this.sql()
      .exec<{ clue: string }>(
        "SELECT clue FROM clues WHERE round = ? AND player_id = ?",
        this.getRound(),
        playerId,
      )
      .toArray()[0];
    return row?.clue || null;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // clients may send {type:"ping"}; respond with fresh snapshot
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      const data = JSON.parse(text) as { type?: string };
      if (data.type === "sync") {
        const playerId = (ws as unknown as { __playerId?: string }).__playerId || null;
        const isHost = (ws as unknown as { __isHost?: boolean }).__isHost || false;
        const shared = this.sharedState();
        const you: SelfState = {
          playerId,
          name: playerId ? this.listPlayers().find((p) => p.id === playerId)?.name || null : null,
          isHost,
          inRoom: !!playerId,
          role: await this.privateRole(playerId),
          mySubmission: playerId ? this.selfSubmission(playerId) : null,
          myClue: playerId ? this.selfClue(playerId) : null,
          myVote: null,
        };
        ws.send(JSON.stringify({ shared, you }));
      }
    } catch {
      // ignore malformed
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const playerId = (ws as unknown as { __playerId?: string }).__playerId;
    if (playerId) {
      this.sql().exec("UPDATE players SET connected = 0, last_seen = ? WHERE id = ?", Date.now(), playerId);
      // Network disconnection never deletes the seat.
      this.broadcast();
    }
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const roomId = this.getMeta("room_id") || url.searchParams.get("room") || "";

    if (path.endsWith("/create") && method === "POST") {
      // room id is the DO name — already known from routing
      const name = this.state.id.name || "";
      return this.handleCreate(request, name);
    }
    if (path.endsWith("/join") && method === "POST") {
      return this.handleJoin(request, this.getMeta("room_id") || this.state.id.name || "");
    }
    if (path.endsWith("/state") && method === "GET") {
      return this.handleState(request);
    }
    if (path.endsWith("/submission") && method === "POST") {
      return this.handleSubmission(request, this.getMeta("room_id") || "");
    }
    if (path.endsWith("/start") && method === "POST") {
      return this.handleStart(request, this.getMeta("room_id") || this.state.id.name || "");
    }
    if (path.endsWith("/clue") && method === "POST") {
      return this.handleClue(request, this.getMeta("room_id") || "");
    }
    if (path.endsWith("/vote") && method === "POST") {
      return this.handleVote(request, this.getMeta("room_id") || "");
    }
    if (path.endsWith("/advance") && method === "POST") {
      return this.handleAdvance(request, this.getMeta("room_id") || this.state.id.name || "");
    }
    if (path.endsWith("/remove") && method === "POST") {
      return this.handleRemove(request, this.getMeta("room_id") || "");
    }
    if (path.endsWith("/settings") && method === "POST") {
      return this.handleSettings(request, this.getMeta("room_id") || "");
    }
    if (path.endsWith("/bank") && method === "POST") {
      return this.handleBank(request, this.getMeta("room_id") || "");
    }
    if (path.endsWith("/ws") && method === "GET") {
      const upgrade = request.headers.get("Upgrade") || "";
      if (upgrade.toLowerCase() !== "websocket") {
        return err("Expected websocket", 426);
      }
      return this.handleWsUpgrade(request, this.getMeta("room_id") || this.state.id.name || "");
    }

    return err("Not found", 404);
  }
}
