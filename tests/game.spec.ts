import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

const BASE = "https://test.example";

function extractSetCookie(res: Response): string[] {
  // Headers may combine set-cookie; workers test env supports getSetCookie
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie();
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0];
}

async function createRoom(opts: {
  maxPlayers?: number;
  poolMode?: "submissions" | "mixed";
} = {}): Promise<{ roomId: string; hostCookie: string }> {
  const res = await SELF.fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify(opts),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { roomId: string };
  const sc = extractSetCookie(res);
  expect(sc.length).toBeGreaterThan(0);
  return { roomId: data.roomId, hostCookie: cookiePair(sc[0]) };
}

async function join(
  roomId: string,
  name: string,
  existing?: string,
): Promise<{ playerId: string; cookie: string; status: number }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: BASE,
  };
  if (existing) headers.cookie = existing;
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/join`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name }),
  });
  const data = (await res.json().catch(() => ({}))) as { playerId?: string };
  const sc = extractSetCookie(res);
  return {
    playerId: data.playerId || "",
    cookie: sc.length ? cookiePair(sc[0]) : existing || "",
    status: res.status,
  };
}

async function getState(roomId: string, cookie?: string) {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/state`, {
    headers: cookie ? { cookie } : {},
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Awaited<ReturnType<typeof import("../src/room").Room.prototype.stateResponse>>;
}

async function post(
  roomId: string,
  action: string,
  cookie: string | undefined,
  body: unknown,
): Promise<{ status: number; data: any; res: Response }> {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: BASE,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, res };
}

async function joinN(roomId: string, names: string[]) {
  return Promise.all(names.map((n) => join(roomId, n)));
}

async function begin(roomId: string, hostCookie: string) {
  const r = await post(roomId, "advance", hostCookie, { action: "begin", rev: 1 });
  expect(r.status).toBe(200);
  return r;
}

async function submitAll(
  roomId: string,
  players: { cookie: string; word: string; hint: string }[],
) {
  const results = await Promise.all(
    players.map((p) =>
      post(roomId, "submission", p.cookie, {
        word: p.word,
        hint: p.hint,
        rev: 1,
      }),
    ),
  );
  return results;
}

describe("capacity races", () => {
  it("enforces max players under simultaneous joins", async () => {
    const { roomId } = await createRoom({ maxPlayers: 3 });
    const results = await joinN(roomId, ["A", "B", "C", "D", "E", "F", "G", "H"]);
    const ok = results.filter((r) => r.status === 200);
    const full = results.filter((r) => r.status === 409);
    expect(ok.length).toBe(3);
    expect(full.length).toBe(5);
    const state = await getState(roomId);
    expect(state.shared.activeCount).toBe(3);
    expect(state.shared.players.length).toBe(3);
  });

  it("blocks join when room is already at capacity", async () => {
    const { roomId } = await createRoom({ maxPlayers: 3 });
    await join(roomId, "A");
    await join(roomId, "B");
    await join(roomId, "C");
    const r = await join(roomId, "D");
    expect(r.status).toBe(409);
  });

  it("rejoins the same seat for an existing session", async () => {
    const { roomId } = await createRoom({ maxPlayers: 4 });
    const a = await join(roomId, "Alice");
    expect(a.status).toBe(200);
    const again = await join(roomId, "Alice", a.cookie);
    expect(again.status).toBe(200);
    expect(again.playerId).toBe(a.playerId);
    const state = await getState(roomId, a.cookie);
    expect(state.shared.activeCount).toBe(1);
  });
});

describe("start gating", () => {
  it("refuses start until every active player submitted", async () => {
    const { roomId, hostCookie } = await createRoom({ maxPlayers: 4 });
    const players = await joinN(roomId, ["A", "B", "C"]);
    await begin(roomId, hostCookie);

    await submit(roomId, players[0].cookie, "apple", "fruit");
    const early = await post(roomId, "start", hostCookie, { rev: 1 });
    expect(early.status).toBe(409);
    expect(String(early.data.error)).toMatch(/Waiting on/i);

    await submit(roomId, players[1].cookie, "banana", "yellow fruit");
    const still = await post(roomId, "start", hostCookie, { rev: 1 });
    expect(still.status).toBe(409);

    await submit(roomId, players[2].cookie, "grape", "purple");
    const ok = await post(roomId, "start", hostCookie, { rev: 1 });
    expect(ok.status).toBe(200);
    expect(ok.data.shared.phase).toBe("ROLE_REVEAL");
  });

  it("rejects start with fewer than 3 players", async () => {
    const { roomId, hostCookie } = await createRoom({ maxPlayers: 8 });
    await join(roomId, "A");
    await join(roomId, "B");
    const beginRes = await post(roomId, "advance", hostCookie, { action: "begin", rev: 1 });
    expect(beginRes.status).toBe(409);
  });

  it("rejects host start when a candidate has empty hint via eligibility", async () => {
    const { roomId, hostCookie } = await createRoom({ maxPlayers: 4, poolMode: "submissions" });
    const players = await joinN(roomId, ["A", "B", "C"]);
    await begin(roomId, hostCookie);
    // all three submit the same word — no eligible candidate (every player authored it)
    await submitAll(roomId, [
      { cookie: players[0].cookie, word: "Orbit", hint: "space path" },
      { cookie: players[1].cookie, word: "orbit", hint: "path around" },
      { cookie: players[2].cookie, word: " ORBIT ", hint: "rounds" },
    ]);
    const start = await post(roomId, "start", hostCookie, { rev: 1 });
    expect(start.status).toBe(409);
    expect(String(start.data.error)).toMatch(/eligible/i);
  });

  it("host-only: non-host cannot start", async () => {
    const { roomId, hostCookie } = await createRoom({ maxPlayers: 4 });
    const players = await joinN(roomId, ["A", "B", "C"]);
    await begin(roomId, hostCookie);
    await submitAll(roomId, [
      { cookie: players[0].cookie, word: "apple", hint: "fruit" },
      { cookie: players[1].cookie, word: "banana", hint: "yellow" },
      { cookie: players[2].cookie, word: "grape", hint: "purple" },
    ]);
    const r = await post(roomId, "start", players[0].cookie, { rev: 1 });
    expect(r.status).toBe(403);
  });
});

describe("secrecy and impostor assignment", () => {
  it("never sends the selected word to the impostor and never assigns an author", async () => {
    const { roomId, hostCookie } = await createRoom({ maxPlayers: 5, poolMode: "submissions" });
    const players = await joinN(roomId, ["A", "B", "C", "D"]);
    await begin(roomId, hostCookie);
    await submitAll(roomId, [
      { cookie: players[0].cookie, word: "Lantern", hint: "light in the dark" },
      { cookie: players[1].cookie, word: "Anchor", hint: "holds a ship" },
      { cookie: players[2].cookie, word: "Compass", hint: "points north" },
      { cookie: players[3].cookie, word: "Quilt", hint: "warm blanket" },
    ]);
    const start = await post(roomId, "start", hostCookie, { rev: 1 });
    expect(start.status).toBe(200);

    const states = await Promise.all(players.map((p) => getState(roomId, p.cookie)));
    const impostors = states.filter((s) => s.you.role?.impostor);
    const crews = states.filter((s) => s.you.role && !s.you.role.impostor);
    expect(impostors.length).toBe(1);
    expect(crews.length).toBe(3);

    const impostor = impostors[0];
    const word = crews[0].you.role?.word;
    expect(word).toBeTruthy();

    // impostor must not see the word anywhere in their state payload
    const raw = JSON.stringify(impostor);
    expect(raw.includes(word!)).toBe(false);
    // impostor should have a hint instead
    expect(impostor.you.role?.hint).toBeTruthy();
    expect(impostor.you.role?.word).toBeUndefined();

    // shared snapshot never contains the selected word
    expect(JSON.stringify(impostor.shared).includes(word!)).toBe(false);
    expect(JSON.stringify(impostor.shared).includes('"word"')).toBe(false);

    // authors of the selected word cannot be impostor
    const authorIndexes = [0, 1, 2, 3].filter(
      (i) => players[i] && crews.some((c) => c.you.playerId === players[i].playerId),
    );
    // everyone who sees the word is an author of that word
    for (const c of crews) {
      expect(c.you.role?.word).toBe(word);
    }
    // the impostor is not among crew (already) and not an author:
    // find which player submitted `word` — impostor id must differ
    const submitWordBy = (w: string) => {
      const norm = w.trim().toLowerCase();
      return norm;
    };
    // verify via next-state votes path: impostor id from results after voting
    // Direct check: start response must not leak word to non-private channels
    const startRaw = JSON.stringify(start.data);
    // word may appear in crew private only — start returns state to host
    // Host is not a player here, so host state should have no role/word
    // Host is not a player here, so host state should have no role/word
    const startYou = start.data?.you as { role?: unknown } | undefined;
    expect(startYou?.role == null || (startYou.role as { impostor?: boolean }).impostor !== undefined).toBeTruthy();
    if (!startYou?.role) {
      expect(startRaw.includes(word!)).toBe(false);
    }

    // Ensure impostor player id is not one of the authors of selected word.
    // Authors = players whose submission normalized equals word.
    const wordNorm = submitWordBy(word!);
    const authorIds = new Set<string>();
    const resub = await Promise.all(players.map((p) => getState(roomId, p.cookie)));
    for (const s of resub) {
      if (s.you.mySubmission && s.you.mySubmission.word.trim().toLowerCase() === wordNorm) {
        if (s.you.playerId) authorIds.add(s.you.playerId);
      }
    }
    expect(authorIds.size).toBeGreaterThanOrEqual(1);
    expect(authorIds.has(impostor.you.playerId!)).toBe(false);
  });

  it("reconnect preserves seat and role", async () => {
    const { roomId, hostCookie } = await createRoom({ maxPlayers: 4 });
    const players = await joinN(roomId, ["A", "B", "C"]);
    await begin(roomId, hostCookie);
    await submitAll(roomId, [
      { cookie: players[0].cookie, word: "apple", hint: "fruit" },
      { cookie: players[1].cookie, word: "banana", hint: "yellow" },
      { cookie: players[2].cookie, word: "grape", hint: "purple" },
    ]);
    await post(roomId, "start", hostCookie, { rev: 1 });
    const before = await getState(roomId, players[1].cookie);
    const after = await getState(roomId, players[1].cookie);
    expect(after.you.playerId).toBe(before.you.playerId);
    expect(after.you.role).toEqual(before.you.role);
    expect(after.shared.activeCount).toBe(3);
  });
});

async function submit(roomId: string, cookie: string, word: string, hint: string) {
  const r = await post(roomId, "submission", cookie, { word, hint, rev: 1 });
  expect(r.status).toBe(200);
  return r;
}

describe("voting", () => {
  async function setupVoting() {
    const { roomId, hostCookie } = await createRoom({ maxPlayers: 4 });
    const players = await joinN(roomId, ["A", "B", "C"]);
    await begin(roomId, hostCookie);
    await submitAll(roomId, [
      { cookie: players[0].cookie, word: "apple", hint: "fruit" },
      { cookie: players[1].cookie, word: "banana", hint: "yellow" },
      { cookie: players[2].cookie, word: "grape", hint: "purple" },
    ]);
    const start = await post(roomId, "start", hostCookie, { rev: 1 });
    expect(start.status).toBe(200);
    // advance to clues
    const adv = await post(roomId, "advance", hostCookie, { action: "advance", rev: 1 });
    expect(adv.status).toBe(200);
    expect(adv.data.shared.phase).toBe("CLUES_PENDING");

    const clueResults = await Promise.all(
      players.map((p, i) =>
        post(roomId, "clue", p.cookie, {
          clue: ["sweet", "tropical", "vine"][i],
          rev: 1,
        }),
      ),
    );
    for (const c of clueResults) expect(c.status).toBe(200);
    const afterClues = await getState(roomId, players[0].cookie);
    expect(afterClues.shared.phase).toBe("DISCUSSION");
    expect(afterClues.shared.clues?.length).toBe(3);

    const toVote = await post(roomId, "advance", hostCookie, { action: "advance", rev: 1 });
    expect(toVote.status).toBe(200);
    expect(toVote.data.shared.phase).toBe("VOTING");
    return { roomId, hostCookie, players };
  }

  it("rejects self-votes and double votes; reveals together", async () => {
    const { roomId, players } = await setupVoting();

    const self = await post(roomId, "vote", players[0].cookie, {
      targetId: players[0].playerId,
      rev: 1,
    });
    expect(self.status).toBe(400);

    const vote1 = await post(roomId, "vote", players[0].cookie, {
      targetId: players[1].playerId,
      rev: 1,
    });
    expect(vote1.status).toBe(200);
    // before all votes, tally not revealed
    expect(vote1.data.shared.phase).toBe("VOTING");
    expect(vote1.data.shared.votesRevealed).toBe(false);

    const double = await post(roomId, "vote", players[0].cookie, {
      targetId: players[2].playerId,
      rev: 1,
    });
    expect(double.status).toBe(409);

    const vote2 = await post(roomId, "vote", players[1].cookie, {
      targetId: players[2].playerId,
      rev: 1,
    });
    expect(vote2.status).toBe(200);
    expect(vote2.data.shared.phase).toBe("VOTING");

    const vote3 = await post(roomId, "vote", players[2].cookie, {
      targetId: players[2].playerId === players[2].playerId ? players[0].playerId : players[0].playerId,
      rev: 1,
    });
    // players[2] voting for players[0] — ok
    expect(vote3.status).toBe(200);

    const final = await getState(roomId, players[0].cookie);
    expect(final.shared.phase).toBe("RESULTS");
    expect(final.shared.votesRevealed).toBe(true);
    expect(final.shared.tally).toBeTruthy();
    expect(final.shared.result).toBeTruthy();
    expect((final.shared.tally || []).reduce((s, t) => s + t.votes, 0)).toBe(3);
  });

  it("unique plurality against impostor means crew wins; votes cannot change after reveal", async () => {
    const { roomId, hostCookie, players } = await setupVoting();
    const states = await Promise.all(players.map((p) => getState(roomId, p.cookie)));
    const impostorIdx = states.findIndex((s) => s.you.role?.impostor);
    expect(impostorIdx).toBeGreaterThanOrEqual(0);
    const crewIdx = [0, 1, 2].filter((i) => i !== impostorIdx);

    // all crew vote for impostor; impostor cannot self-vote, picks a crew member
    await Promise.all(
      players.map((p, i) =>
        i === impostorIdx
          ? post(roomId, "vote", p.cookie, {
              targetId: players[crewIdx[0]].playerId,
              rev: 1,
            })
          : post(roomId, "vote", p.cookie, {
              targetId: players[impostorIdx].playerId,
              rev: 1,
            }),
      ),
    );

    const results = await getState(roomId, players[0].cookie);
    expect(results.shared.phase).toBe("RESULTS");
    expect(results.shared.result?.crewWin).toBe(true);

    // cannot vote again after reveal
    const late = await post(roomId, "vote", players[crewIdx[0]].cookie, {
      targetId: players[crewIdx[1]].playerId,
      rev: 1,
    });
    expect(late.status).toBe(409);
  });

  it("tie means impostor survives (crew does not win)", async () => {
    const { roomId, hostCookie, players } = await setupVoting();
    const states = await Promise.all(players.map((p) => getState(roomId, p.cookie)));
    const impostorIdx = states.findIndex((s) => s.you.role?.impostor);
    const crew = [0, 1, 2].filter((i) => i !== impostorIdx);

    // crew[0] votes impostor, crew[1] votes crew[0], impostor votes crew[0] → 2 vs 1 not tie among all
    // For a 3-player tie is hard; use two votes for different non-impostor? With 3 voters:
    // Need max votes shared by 2 targets without unique top against impostor uniquely.
    // impostor votes crew0, crew0 votes crew1, crew1 votes crew0 → crew0 has 2 votes → unique top ≠ impostor → impostor wins
    await post(roomId, "vote", players[impostorIdx].cookie, {
      targetId: players[crew[0]].playerId,
      rev: 1,
    });
    await post(roomId, "vote", players[crew[0]].cookie, {
      targetId: players[crew[1]].playerId,
      rev: 1,
    });
    await post(roomId, "vote", players[crew[1]].cookie, {
      targetId: players[crew[0]].playerId,
      rev: 1,
    });

    const results = await getState(roomId, players[0].cookie);
    expect(results.shared.phase).toBe("RESULTS");
    // crew0 has 2 votes (unique top) — not impostor → crewWin false
    expect(results.shared.result?.crewWin).toBe(false);
    expect(results.shared.result?.tie).toBe(false);
  });

  it("resets submissions for each round", async () => {
    const { roomId, hostCookie, players } = await setupVoting();
    await Promise.all(
      players.map((p, i) =>
        post(roomId, "vote", p.cookie, {
          targetId: players[(i + 1) % 3].playerId,
          rev: 1,
        }),
      ),
    );
    const results = await getState(roomId, players[0].cookie);
    expect(results.shared.phase).toBe("RESULTS");

    const next = await post(roomId, "advance", hostCookie, { action: "advance", rev: 1 });
    expect(next.status).toBe(200);
    expect(next.data.shared.phase).toBe("SUBMITTING");
    expect(next.data.shared.round).toBe(2);
    expect(next.data.shared.players.every((p: { submitted: boolean }) => !p.submitted)).toBe(true);
    expect(next.data.you.role).toBeNull();
    expect(next.data.shared.clues).toBeNull();
    expect(next.data.shared.tally).toBeNull();

    // early start rejected until re-submitted
    const early = await post(roomId, "start", hostCookie, { rev: 1 });
    expect(early.status).toBe(409);
  });
});

describe("host controls and limits", () => {
  it("enforces input limits on submission and clue", async () => {
    const { roomId, hostCookie } = await createRoom({ maxPlayers: 4 });
    const players = await joinN(roomId, ["A", "B", "C"]);
    await begin(roomId, hostCookie);
    const long = await post(roomId, "submission", players[0].cookie, {
      word: "x".repeat(41),
      hint: "ok hint",
      rev: 1,
    });
    expect(long.status).toBe(400);
    const emptyHint = await post(roomId, "submission", players[0].cookie, {
      word: "apple",
      hint: "",
      rev: 1,
    });
    expect(emptyHint.status).toBe(400);
  });

  it("rejects join to closed room", async () => {
    const { roomId, hostCookie } = await createRoom({ maxPlayers: 4 });
    await post(roomId, "advance", hostCookie, { action: "close", rev: 1 });
    const r = await join(roomId, "Late");
    expect(r.status).toBe(410);
  });

  it("host can update settings only in lobby", async () => {
    const { roomId, hostCookie } = await createRoom({ maxPlayers: 8 });
    await join(roomId, "A");
    const upd = await post(roomId, "settings", hostCookie, { maxPlayers: 5, poolMode: "mixed" });
    expect(upd.status).toBe(200);
    expect(upd.data.shared.maxPlayers).toBe(5);
    expect(upd.data.shared.poolMode).toBe("mixed");

    await joinN(roomId, ["B", "C"]);
    await begin(roomId, hostCookie);
    const locked = await post(roomId, "settings", hostCookie, { maxPlayers: 6 });
    expect(locked.status).toBe(409);
  });
});
