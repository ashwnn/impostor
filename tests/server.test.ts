import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { after, before, test } from "node:test";

let server: ChildProcess;
let base = "";
let serverOutput = "";

before(async () => {
  const dataDir = mkdtempSync(joinPath(tmpdir(), "impostor-test-"));
  server = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      "server/index.ts",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, PORT: "0", HOST: "127.0.0.1", IMPOSTOR_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout?.on("data", (chunk) => {
    serverOutput += String(chunk);
  });
  server.stderr?.on("data", (chunk) => {
    serverOutput += String(chunk);
  });
  base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("server did not start:\n" + serverOutput)),
      20000,
    );
    const check = () => {
      const match = serverOutput.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    };
    server.stdout?.on("data", check);
    server.on("exit", (code) =>
      reject(new Error(`server exited (${code}):\n` + serverOutput)),
    );
  });
});

after(() => {
  server.kill("SIGTERM");
});

interface Reply {
  status: number;
  body: any;
  headers: Headers;
}

async function call(
  path: string,
  init: { method?: string; body?: unknown; session?: string; host?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.session) headers.Authorization = `Bearer ${init.session}`;
  if (init.host) headers["X-Host-Token"] = init.host;
  const res = await fetch(base + path, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, headers: res.headers };
}

async function createRoom(maxPlayers = 4, poolMode = "submissions") {
  const reply = await call("/api/rooms", { body: { maxPlayers, poolMode } });
  assert.equal(reply.status, 200);
  return reply.body as { roomId: string; hostToken: string; invitePath: string };
}

async function joinRoom(roomId: string, name: string) {
  const reply = await call(`/api/rooms/${roomId}/join`, { body: { name } });
  assert.equal(reply.status, 200);
  return reply.body as {
    playerId: string;
    name: string;
    sessionToken: string;
    rejoined: boolean;
  };
}

test("HTTP: create, join, and state", async () => {
  const room = await createRoom();
  assert.match(room.roomId, /^[a-f0-9]{16}$/);
  assert.match(room.hostToken, /^[a-f0-9]{64}$/);

  const ann = await joinRoom(room.roomId, "Ann");
  assert.equal(ann.rejoined, false);

  const state = await call(`/api/rooms/${room.roomId}/state`, { session: ann.sessionToken });
  assert.equal(state.status, 200);
  assert.equal(state.body.shared.phase, "LOBBY");
  assert.equal(state.body.you.inRoom, true);
  assert.equal(state.body.you.name, "Ann");

  const again = await call(`/api/rooms/${room.roomId}/join`, {
    body: { name: "Ann" },
    session: ann.sessionToken,
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.rejoined, true);
  assert.equal(again.body.playerId, ann.playerId);
});

test("HTTP: capacity is enforced under parallel joins", async () => {
  const room = await createRoom(4);
  const replies = await Promise.all(
    Array.from({ length: 10 }, (_, i) => call(`/api/rooms/${room.roomId}/join`, { body: { name: `P${i}` } })),
  );
  const ok = replies.filter((r) => r.status === 200);
  const full = replies.filter((r) => r.status === 409);
  assert.equal(ok.length, 4);
  assert.equal(full.length, 6);
  assert.equal(new Set(ok.map((r) => r.body.playerId)).size, 4);

  const state = await call(`/api/rooms/${room.roomId}/state`);
  assert.equal(state.body.shared.activeCount, 4);
  assert.equal(state.body.shared.players.length, 4);
});

test("HTTP: host-only routes reject players", async () => {
  const room = await createRoom();
  const ann = await joinRoom(room.roomId, "Ann");
  const denied = await call(`/api/rooms/${room.roomId}/advance`, {
    body: { action: "begin" },
    session: ann.sessionToken,
  });
  assert.equal(denied.status, 403);

  const badHost = await call(`/api/rooms/${room.roomId}/advance`, {
    body: { action: "begin" },
    host: "0".repeat(64),
  });
  assert.equal(badHost.status, 403);
});

test("HTTP: full round flow with secrecy and SSE updates", async () => {
  const room = await createRoom(4);
  const players = await Promise.all(
    ["Ann", "Ben", "Cal"].map((name) => joinRoom(room.roomId, name)),
  );

  // SSE stream for Ann: receives the initial frame and pushed updates.
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/rooms/${room.roomId}/events`, {
    headers: { Authorization: `Bearer ${players[0].sessionToken}` },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const nextFrame = async (): Promise<any> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const parts = buffer.split("\n\n");
      for (let i = 0; i < parts.length - 1; i += 1) {
        const line = parts[i].split("\n").find((l) => l.startsWith("data: "));
        if (line) {
          buffer = parts.slice(i + 1).join("\n\n");
          return JSON.parse(line.slice(6));
        }
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended early");
      buffer += decoder.decode(value, { stream: true });
    }
    throw new Error("no SSE frame within 5s");
  };

  const initial = await nextFrame();
  assert.equal(initial.shared.phase, "LOBBY");

  await call(`/api/rooms/${room.roomId}/advance`, {
    body: { action: "begin" },
    host: room.hostToken,
  });
  const afterBegin = await nextFrame();
  assert.equal(afterBegin.shared.phase, "SUBMITTING");

  // Start is blocked until everyone submitted.
  const early = await call(`/api/rooms/${room.roomId}/start`, { host: room.hostToken, body: {} });
  assert.equal(early.status, 409);
  assert.match(String(early.body.error), /Waiting on/i);

  const words = [
    { word: "lantern", hint: "light in the dark" },
    { word: "anchor", hint: "holds a ship" },
    { word: "compass", hint: "points north" },
  ];
  await Promise.all(
    players.map((player, i) =>
      call(`/api/rooms/${room.roomId}/submission`, {
        body: words[i],
        session: player.sessionToken,
      }),
    ),
  );

  const start = await call(`/api/rooms/${room.roomId}/start`, { host: room.hostToken, body: {} });
  assert.equal(start.status, 200);
  assert.equal(start.body.shared.phase, "ROLE_REVEAL");

  // Mutations pushed to the SSE stream (submission frames come first).
  let pushed = await nextFrame();
  const deadline = Date.now() + 5000;
  while (pushed.shared.phase !== "ROLE_REVEAL" && Date.now() < deadline) {
    pushed = await nextFrame();
  }
  assert.equal(pushed.shared.phase, "ROLE_REVEAL");

  // Secrecy: find the impostor from each player's private view.
  const states = await Promise.all(
    players.map((p) =>
      call(`/api/rooms/${room.roomId}/state`, { session: p.sessionToken }),
    ),
  );
  const impostorIndex = states.findIndex((s) => s.body.you.role?.impostor);
  assert.notEqual(impostorIndex, -1);
  const crewIndex = states.findIndex((s) => s.body.you.role && !s.body.you.role.impostor);
  const word = states[crewIndex].body.you.role.word as string;

  const impostorRaw = JSON.stringify(states[impostorIndex].body);
  assert.equal(impostorRaw.includes(word), false, "word leaked to impostor");
  assert.equal(states[impostorIndex].body.you.role.word, undefined);
  assert.ok(states[impostorIndex].body.you.role.hint);
  assert.equal(
    JSON.stringify(states[impostorIndex].body.shared).includes(word),
    false,
    "word leaked into shared state",
  );

  // The impostor must not be an author of the selected word.
  const authorIds = states
    .filter((s) => s.body.you.mySubmission?.word === word)
    .map((s) => s.body.you.playerId);
  assert.equal(authorIds.includes(states[impostorIndex].body.you.playerId), false);

  // Clues reveal together.
  await call(`/api/rooms/${room.roomId}/advance`, {
    body: { action: "advance" },
    host: room.hostToken,
  });
  const clueTexts = ["bright", "night", "lamp"];
  await Promise.all(
    players.map((p, i) =>
      call(`/api/rooms/${room.roomId}/clue`, { body: { clue: clueTexts[i] }, session: p.sessionToken }),
    ),
  );
  const afterClues = await call(`/api/rooms/${room.roomId}/state`);
  assert.equal(afterClues.body.shared.phase, "DISCUSSION");
  assert.equal(afterClues.body.shared.clues.length, 3);

  await call(`/api/rooms/${room.roomId}/advance`, {
    body: { action: "advance" },
    host: room.hostToken,
  });

  // Self-vote rejected, then everyone votes for the impostor.
  const selfVote = await call(`/api/rooms/${room.roomId}/vote`, {
    body: { targetId: players[impostorIndex].playerId },
    session: players[impostorIndex].sessionToken,
  });
  assert.equal(selfVote.status, 400);

  await Promise.all(
    players.map((p, i) =>
      call(`/api/rooms/${room.roomId}/vote`, {
        body: {
          targetId:
            i === impostorIndex
              ? players[(impostorIndex + 1) % players.length].playerId
              : players[impostorIndex].playerId,
        },
        session: p.sessionToken,
      }),
    ),
  );

  const results = await call(`/api/rooms/${room.roomId}/state`);
  assert.equal(results.body.shared.phase, "RESULTS");
  assert.equal(results.body.shared.result.crewWin, true);
  assert.equal(results.body.shared.votesDetail.length, 3);

  // Next round resets everything.
  await call(`/api/rooms/${room.roomId}/advance`, {
    body: { action: "advance" },
    host: room.hostToken,
  });
  const next = await call(`/api/rooms/${room.roomId}/state`, {
    session: players[0].sessionToken,
  });
  assert.equal(next.body.shared.phase, "SUBMITTING");
  assert.equal(next.body.shared.round, 2);
  assert.equal(next.body.you.role, null);
  assert.equal(next.body.you.mySubmission, null);
  assert.equal(
    next.body.shared.players.every((p: { submitted: boolean }) => !p.submitted),
    true,
  );

  controller.abort();
});

test("HTTP: closed rooms reject joins with 410", async () => {
  const room = await createRoom(4);
  await joinRoom(room.roomId, "Ann");
  const closed = await call(`/api/rooms/${room.roomId}/advance`, {
    body: { action: "close" },
    host: room.hostToken,
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.shared.phase, "CLOSED");

  const late = await call(`/api/rooms/${room.roomId}/join`, { body: { name: "Late" } });
  assert.equal(late.status, 410);
});

test("HTTP: unknown and malformed room ids are rejected", async () => {
  const missing = await call(`/api/rooms/${"f".repeat(16)}/state`);
  assert.equal(missing.status, 404);
  const bad = await call("/api/rooms/not-a-room/state");
  assert.equal(bad.status, 400);
});
