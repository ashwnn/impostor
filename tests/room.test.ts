import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, Room, type Player } from "../server/room.ts";
import { LIMITS } from "../shared/protocol.ts";

function makeRoom(opts: { maxPlayers?: number; poolMode?: "submissions" | "mixed" } = {}) {
  return Room.create("a".repeat(16), opts);
}

function expectApiError(fn: () => unknown, status: number, match?: RegExp) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    assert.equal(error.status, status);
    if (match) {
      const text = `${error.message} ${JSON.stringify(error.fields ?? {})}`;
      assert.match(text, match);
    }
    return error;
  }
  throw new Error("expected the call to throw");
}

function submitAll(
  room: Room,
  players: Player[],
  words: { word: string; hint: string }[],
) {
  players.forEach((player, i) => room.submit(player, words[i].word, words[i].hint));
}

const WORDS = [
  { word: "lantern", hint: "light in the dark" },
  { word: "anchor", hint: "holds a ship" },
  { word: "compass", hint: "points north" },
  { word: "quilt", hint: "warm blanket" },
  { word: "ember", hint: "glowing coal" },
  { word: "harbor", hint: "boats rest here" },
  { word: "meadow", hint: "field of grass" },
  { word: "jigsaw", hint: "many small pieces" },
];

/** Join players, open the round, submit distinct words, and start. */
function startedRoom(count = 3, opts: { poolMode?: "submissions" | "mixed" } = {}) {
  const { room, hostToken } = makeRoom({ maxPlayers: 8, ...opts });
  const names = ["Ann", "Ben", "Cal", "Dee", "Eve", "Fay", "Gus", "Hal"];
  const joins = names.slice(0, count).map((name) => room.join(name));
  const players = joins.map((j) => j.player);
  const sessions = new Map(joins.map((j) => [j.player.id, j.sessionToken]));
  room.begin();
  submitAll(room, players, WORDS.slice(0, count));
  room.start();
  const session = (playerId: string): string => {
    const token = sessions.get(playerId);
    if (!token) throw new Error("no session stashed for " + playerId);
    return token;
  };
  return { room, hostToken, players, session };
}

test("capacity: joins stop at the player limit", () => {
  const { room } = makeRoom({ maxPlayers: 3 });
  room.join("A");
  room.join("B");
  room.join("C");
  expectApiError(() => room.join("D"), 409, /full/i);
  assert.equal(room.data.players.length, 3);
});

test("capacity: host can raise the limit, not below the joined count", () => {
  const { room } = makeRoom({ maxPlayers: 8 });
  ["A", "B", "C", "D", "E"].forEach((n) => room.join(n));
  expectApiError(() => room.updateSettings({ maxPlayers: 4 }), 409, /below 5/i);
  room.updateSettings({ maxPlayers: 6 });
  room.join("F");
  assert.equal(room.data.players.length, 6);
});

test("join: duplicate names are rejected case-insensitively", () => {
  const { room } = makeRoom();
  room.join("Ann");
  expectApiError(() => room.join("ann"), 409, /taken/i);
});

test("join: names are validated", () => {
  const { room } = makeRoom();
  expectApiError(() => room.join("   "), 400, /name/i);
  expectApiError(() => room.join("x".repeat(LIMITS.NAME_MAX + 1)), 400, /at most/i);
});

test("join: new players cannot join while a round is in progress", () => {
  const { room } = startedRoom(3);
  assert.equal(room.data.phase, "ROLE_REVEAL");
  expectApiError(() => room.join("Late"), 409, /in progress/i);
});

test("join: rejoining with a session keeps the same seat", () => {
  const { room } = makeRoom();
  const { player, sessionToken } = room.join("Ann");
  const resolved = room.resolve({ session: sessionToken });
  assert.equal(resolved.player?.id, player.id);
  room.markSeen(player, false);
  assert.equal(room.data.players.find((p) => p.id === player.id)?.connected, false);
  room.markSeen(player, true);
  assert.equal(room.data.players.find((p) => p.id === player.id)?.connected, true);
});

test("join: a new player can join between rounds", () => {
  const { room, players } = startedRoom(3);
  room.advance("advance");
  players.forEach((p, i) => room.setClue(p, ["a", "b", "c"][i]));
  room.advance("advance");
  players.forEach((p, i) => room.vote(p, players[(i + 1) % 3].id));
  room.nextRound();
  assert.equal(room.data.phase, "SUBMITTING");
  room.join("Newcomer");
  assert.equal(room.data.players.length, 4);
});

test("start: needs at least three players", () => {
  const { room } = makeRoom();
  room.join("A");
  room.join("B");
  expectApiError(() => room.begin(), 409, /at least/i);
});

test("start: blocked until every active player submitted", () => {
  const { room } = makeRoom();
  const players = ["A", "B", "C"].map((n) => room.join(n).player);
  room.begin();
  room.submit(players[0], "apple", "fruit");
  room.submit(players[1], "banana", "yellow fruit");
  expectApiError(() => room.start(), 409, /Waiting on: C/);
  room.submit(players[2], "grape", "purple");
  room.start();
  assert.equal(room.data.phase, "ROLE_REVEAL");
});

test("start: submissions are rejected outside the submission phase", () => {
  const { room, players } = startedRoom(3);
  expectApiError(() => room.submit(players[0], "x", "y"), 409, /not open/i);
});

test("start: a word everyone submitted cannot be selected", () => {
  const { room } = makeRoom();
  const players = ["A", "B", "C"].map((n) => room.join(n).player);
  room.begin();
  submitAll(room, players, [
    { word: "Orbit", hint: "space path" },
    { word: "orbit", hint: "around a planet" },
    { word: " ORBIT ", hint: "loop" },
  ]);
  expectApiError(() => room.start(), 409, /No eligible word/i);
});

test("duplicate words: impostor is never one of the authors", () => {
  for (let i = 0; i < 40; i += 1) {
    const { room } = makeRoom();
    const players = ["A", "B", "C"].map((n) => room.join(n).player);
    room.begin();
    submitAll(room, players, [
      { word: "apple", hint: "fruit" },
      { word: "Apple", hint: "a fruit" },
      { word: "banana", hint: "yellow" },
    ]);
    room.start();
    const selection = room.data.selection;
    assert.ok(selection);
    const authors = new Set(
      Object.entries(room.data.submissions)
        .filter(([, s]) => s.word.trim().toLowerCase() === selection.norm)
        .map(([id]) => id),
    );
    assert.equal(authors.size >= 1, true);
    assert.equal(authors.has(selection.impostorId), false);
  }
});

test("secrecy: the impostor sees the hint only, never the word", () => {
  const { room, session } = startedRoom(4);
  const selection = room.data.selection;
  assert.ok(selection);

  for (const player of room.data.players) {
    const state = room.stateFor({ session: session(player.id) });
    const role = state.you.role;
    assert.ok(role);
    if (player.id === selection.impostorId) {
      assert.equal(role.impostor, true);
      assert.equal(role.word, undefined);
      assert.equal(role.hint, selection.hint);
      const raw = JSON.stringify(state);
      assert.equal(raw.includes(selection.word), false, "word leaked to impostor");
    } else {
      assert.equal(role.impostor, false);
      assert.equal(role.word, selection.word);
    }
    assert.equal(JSON.stringify(state.shared).includes(selection.word), false);
  }
});

test("secrecy: other players' submissions are never exposed", () => {
  const { room, players, session } = startedRoom(3);
  const selection = room.data.selection;
  assert.ok(selection);
  const state = room.stateFor({ session: session(players[0].id) });
  const raw = JSON.stringify(state);
  const mine = state.you.mySubmission?.word.toLowerCase();
  assert.equal(mine, "lantern");
  const hidden = ["lantern", "anchor", "compass"].filter(
    (w) => w !== mine && w !== selection.word.toLowerCase(),
  );
  assert.ok(hidden.length > 0);
  for (const word of hidden) {
    assert.equal(raw.includes(word), false, `submission leaked: ${word}`);
  }
});

test("clues: hidden until everyone submits, then revealed together", () => {
  const { room, players } = startedRoom(3);
  room.advance("advance");
  assert.equal(room.data.phase, "CLUES_PENDING");
  room.setClue(players[0], "bright");
  assert.equal(room.data.cluesRevealed, false);
  assert.equal(room.stateFor({}).shared.clues, null);

  room.setClue(players[1], "night");
  assert.equal(room.data.phase, "CLUES_PENDING");
  room.setClue(players[2], "lamp");
  assert.equal(room.data.phase, "DISCUSSION");
  const state = room.stateFor({});
  assert.equal(state.shared.cluesRevealed, true);
  assert.equal(state.shared.clues?.length, 3);
});

test("clues: 1-3 words and max length are enforced", () => {
  const { room, players } = startedRoom(3);
  room.advance("advance");
  expectApiError(() => room.setClue(players[0], ""), 400, /clue/i);
  expectApiError(() => room.setClue(players[0], "one two three four"), 400, /words/i);
  expectApiError(
    () => room.setClue(players[0], "x".repeat(LIMITS.CLUE_MAX + 1)),
    400,
    /characters/i,
  );
});

test("voting: self-votes and double votes are rejected", () => {
  const { room, players } = startedRoom(3);
  room.advance("advance");
  players.forEach((p, i) => room.setClue(p, ["a", "b", "c"][i]));
  room.advance("advance");
  assert.equal(room.data.phase, "VOTING");

  expectApiError(() => room.vote(players[0], players[0].id), 400, /yourself/i);
  room.vote(players[0], players[1].id);
  expectApiError(() => room.vote(players[0], players[2].id), 409, /already/i);
});

test("voting: reveal happens only after every active player voted", () => {
  const { room, players } = startedRoom(3);
  room.advance("advance");
  players.forEach((p, i) => room.setClue(p, ["a", "b", "c"][i]));
  room.advance("advance");
  room.vote(players[0], players[1].id);
  let state = room.stateFor({});
  assert.equal(state.shared.votesRevealed, false);
  assert.equal(state.shared.tally, null);
  room.vote(players[1], players[2].id);
  room.vote(players[2], players[0].id);
  state = room.stateFor({});
  assert.equal(room.data.phase, "RESULTS");
  assert.equal(state.shared.votesRevealed, true);
  assert.equal(state.shared.tally?.reduce((sum, t) => sum + t.votes, 0), 3);
  assert.equal(state.shared.votesDetail?.length, 3);
});

test("voting: unique plurality on the impostor means crew wins", () => {
  const { room, players } = startedRoom(3);
  const impostorId = room.data.selection?.impostorId;
  assert.ok(impostorId);
  room.advance("advance");
  players.forEach((p, i) => room.setClue(p, ["a", "b", "c"][i]));
  room.advance("advance");
  const impostor = players.find((p) => p.id === impostorId);
  const crew = players.filter((p) => p.id !== impostorId);
  assert.ok(impostor);
  room.vote(crew[0], impostorId);
  room.vote(crew[1], impostorId);
  room.vote(impostor, crew[0].id);
  const result = room.stateFor({}).shared.result;
  assert.equal(result?.crewWin, true);
  assert.equal(result?.tie, false);
  assert.equal(result?.selectedImpostorVotes, 2);
});

test("voting: a tie spares the impostor", () => {
  const { room, players } = startedRoom(4);
  room.advance("advance");
  players.forEach((p, i) => room.setClue(p, ["a", "b", "c", "d"][i]));
  room.advance("advance");
  room.vote(players[0], players[1].id);
  room.vote(players[1], players[0].id);
  room.vote(players[2], players[3].id);
  room.vote(players[3], players[2].id);
  const result = room.stateFor({}).shared.result;
  assert.equal(result?.crewWin, false);
  assert.equal(result?.tie, true);
  assert.equal(result?.maxVotes, 1);
});

test("voting: host can force results while some players have not voted", () => {
  const { room, players } = startedRoom(3);
  room.advance("advance");
  players.forEach((p, i) => room.setClue(p, ["a", "b", "c"][i]));
  room.advance("advance");
  room.vote(players[0], players[1].id);
  room.forceResults();
  assert.equal(room.data.phase, "RESULTS");
  assert.equal(room.stateFor({}).shared.tally?.length, 1);
});

test("resets: next round clears words, clues, votes, and roles", () => {
  const { room, players, session } = startedRoom(3);
  room.advance("advance");
  players.forEach((p, i) => room.setClue(p, ["a", "b", "c"][i]));
  room.advance("advance");
  players.forEach((p, i) => room.vote(p, players[(i + 1) % 3].id));
  assert.equal(room.data.phase, "RESULTS");

  room.nextRound();
  const state = room.stateFor({ session: session(players[0].id) });
  assert.equal(state.shared.phase, "SUBMITTING");
  assert.equal(state.shared.round, 2);
  assert.deepEqual(room.data.submissions, {});
  assert.deepEqual(room.data.clues, {});
  assert.deepEqual(room.data.votes, {});
  assert.equal(room.data.selection, null);
  assert.equal(state.you.role, null);
  assert.equal(state.you.mySubmission, null);
  assert.equal(state.shared.clues, null);
  assert.equal(state.shared.tally, null);
  expectApiError(() => room.start(), 409, /Waiting on/i);
});

test("resets: cancel round returns to submissions with a clean slate", () => {
  const { room, players } = startedRoom(3);
  room.advance("advance");
  room.setClue(players[0], "bright");
  room.advance("cancel");
  assert.equal(room.data.phase, "SUBMITTING");
  assert.deepEqual(room.data.submissions, {});
  assert.deepEqual(room.data.clues, {});
  assert.equal(room.data.selection, null);
  assert.equal(room.stateFor({}).you.role, null);
});

test("resets: round number stays put when a round is cancelled", () => {
  const { room } = startedRoom(3);
  assert.equal(room.data.round, 1);
  room.advance("cancel");
  assert.equal(room.data.round, 1);
  assert.equal(room.data.phase, "SUBMITTING");
});

test("remove: frees the name and clears the pending submission", () => {
  const { room } = makeRoom();
  const players = ["A", "B", "C"].map((n) => room.join(n).player);
  room.begin();
  room.submit(players[0], "apple", "fruit");
  room.removePlayer(players[0].id);
  assert.equal(room.data.players.length, 2);
  assert.equal(room.data.submissions[players[0].id], undefined);
  room.join("A");
});

test("remove: blocked once the round has started", () => {
  const { room, players } = startedRoom(3);
  expectApiError(() => room.removePlayer(players[0].id), 409, /Reset/i);
});

test("settings and bank lock after the round opens", () => {
  const { room } = startedRoom(3);
  expectApiError(() => room.updateSettings({ maxPlayers: 6 }), 409, /lock/i);
  expectApiError(() => room.replaceBank([{ word: "a", hint: "b" }]), 409, /lock/i);
});

test("bank: entries are validated and mixed mode can select a bank word", () => {
  const { room } = makeRoom({ maxPlayers: 4, poolMode: "mixed" });
  expectApiError(
    () => room.replaceBank([{ word: "lantern", hint: "lantern" }]),
    400,
    /Fix bank/i,
  );
  room.replaceBank([{ word: "lantern", hint: "light in the dark" }]);
  assert.equal(room.data.bank.length, 1);

  const players = ["A", "B", "C"].map((n) => room.join(n).player);
  room.begin();
  const resubmit = () =>
    submitAll(room, players, [
      { word: "apple", hint: "fruit" },
      { word: "banana", hint: "yellow" },
      { word: "grape", hint: "purple" },
    ]);
  resubmit();

  let sawBank = false;
  for (let i = 0; i < 60 && !sawBank; i += 1) {
    room.start();
    if (room.data.selection?.source === "bank") sawBank = true;
    room.advance("cancel");
    resubmit();
  }
  assert.equal(sawBank, true, "mixed mode never drew a bank word in 60 rounds");
});

test("secrecy: submissions-only mode never draws from the bank", () => {
  const { room } = makeRoom({ maxPlayers: 4 });
  const players = ["A", "B", "C"].map((n) => room.join(n).player);
  room.begin();
  const resubmit = () =>
    submitAll(room, players, [
      { word: "apple", hint: "fruit" },
      { word: "banana", hint: "yellow" },
      { word: "grape", hint: "purple" },
    ]);
  resubmit();
  for (let i = 0; i < 20; i += 1) {
    room.start();
    assert.equal(room.data.selection?.source, "player");
    room.advance("cancel");
    resubmit();
  }
});

test("expiry: idle rooms expire after 24h, closed rooms after 5 minutes", () => {
  const { room } = makeRoom();
  assert.equal(room.isExpired(), false);
  room.data.lastActive = Date.now() - LIMITS.ROOM_IDLE_MS - 1;
  assert.equal(room.isExpired(), true);

  const { room: closed } = makeRoom();
  closed.data.phase = "CLOSED";
  closed.data.closedAt = Date.now() - LIMITS.ROOM_CLOSED_DELETE_MS - 1;
  assert.equal(closed.isExpired(), true);
  closed.data.closedAt = Date.now();
  assert.equal(closed.isExpired(), false);
});

test("host: token authenticates, random tokens do not", () => {
  const { room, hostToken } = makeRoom();
  assert.equal(room.resolve({ host: hostToken }).isHost, true);
  assert.equal(room.resolve({ host: "nope" }).isHost, false);
  assert.equal(room.resolve({}).isHost, false);
});

test("presence: connected flag follows SSE subscribers", () => {
  const { room } = makeRoom();
  const { player, sessionToken } = room.join("Ann");
  const fake = { writeHead() {}, write() {}, end() {} };
  const unsubscribe = room.subscribe(fake as never, { session: sessionToken });
  assert.equal(room.data.players[0].connected, true);
  unsubscribe();
  assert.equal(room.data.players[0].connected, false);
  assert.equal(player.id, room.data.players[0].id);
});
