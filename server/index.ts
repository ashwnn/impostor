import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, type PoolMode } from "../shared/protocol.ts";
import { ApiError, Room, type RoomData } from "./room.ts";
import { JsonStore } from "./store.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = join(ROOT, "dist");
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";
const DATA_DIR = process.env.IMPOSTOR_DATA_DIR ?? join(ROOT, "data");

const store = new JsonStore<RoomData>(DATA_DIR);
const rooms = new Map<string, Room>();
for (const data of store.loadAll()) {
  if (data?.id) rooms.set(data.id, new Room(data));
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof ApiError) {
    json(res, error.status, { error: error.message, fields: error.fields });
    return;
  }
  console.error("[impostor] unexpected error:", error);
  json(res, 500, { error: "Server error" });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > LIMITS.BODY_MAX_BYTES) throw new ApiError("Payload too large", 413);
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new ApiError("Invalid JSON body", 400);
  }
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7);
}

function hostToken(req: IncomingMessage): string | undefined {
  const header = req.headers["x-host-token"];
  return typeof header === "string" && header ? header : undefined;
}

function authOf(req: IncomingMessage): { session?: string; host?: string } {
  return { session: bearer(req), host: hostToken(req) };
}

function requireRoom(id: string): Room {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new ApiError("Invalid room id", 400);
  const room = rooms.get(id);
  if (!room) throw new ApiError("Room not found", 404);
  return room;
}

function persist(room: Room): void {
  store.save(room.toJSON());
}

function mutate(room: Room, fn: () => void): void {
  fn();
  room.touch();
  persist(room);
  room.broadcast();
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[1] !== "rooms") throw new ApiError("Not found", 404);

  if (parts.length === 2) {
    if (method !== "POST") throw new ApiError("Method not allowed", 405);
    const body = await readJson(req);
    const id = randomBytes(8).toString("hex");
    const { room, hostToken: token } = Room.create(id, {
      maxPlayers: typeof body.maxPlayers === "number" ? body.maxPlayers : undefined,
      poolMode: body.poolMode as PoolMode | undefined,
    });
    rooms.set(id, room);
    persist(room);
    json(res, 200, { roomId: id, hostToken: token, invitePath: `/r/${id}` });
    return;
  }

  const room = requireRoom(parts[2] ?? "");
  const action = parts[3] ?? "state";
  const auth = authOf(req);

  if (action === "events" && method === "GET") {
    const unsubscribe = room.subscribe(res, auth);
    req.on("close", () => {
      unsubscribe();
      room.touch();
    });
    return;
  }

  if (action === "state" && method === "GET") {
    room.touch();
    json(res, 200, room.stateFor(auth));
    return;
  }

  if (method !== "POST") throw new ApiError("Method not allowed", 405);
  const body = await readJson(req);

  if (action === "join") {
    const { player: existing } = room.resolve(auth);
    if (existing) {
      mutate(room, () => room.markSeen(existing, true));
      json(res, 200, {
        playerId: existing.id,
        name: existing.name,
        sessionToken: auth.session,
        rejoined: true,
      });
      return;
    }
    const { player, sessionToken } = room.join(String(body.name ?? ""));
    mutate(room, () => {});
    json(res, 200, {
      playerId: player.id,
      name: player.name,
      sessionToken,
      rejoined: false,
    });
    return;
  }

  if (action === "submission") {
    const { player } = room.resolve(auth);
    if (!player) throw new ApiError("Join the room first", 401);
    mutate(room, () =>
      room.submit(player, String(body.word ?? ""), String(body.hint ?? "")),
    );
    json(res, 200, room.stateFor(auth));
    return;
  }

  if (action === "clue") {
    const { player } = room.resolve(auth);
    if (!player) throw new ApiError("Join the room first", 401);
    mutate(room, () => room.setClue(player, String(body.clue ?? "")));
    json(res, 200, room.stateFor(auth));
    return;
  }

  if (action === "vote") {
    const { player } = room.resolve(auth);
    if (!player) throw new ApiError("Join the room first", 401);
    mutate(room, () => room.vote(player, String(body.targetId ?? "")));
    json(res, 200, room.stateFor(auth));
    return;
  }

  if (action === "leave") {
    const { player } = room.resolve(auth);
    if (!player) throw new ApiError("Join the room first", 401);
    mutate(room, () => room.removePlayer(player.id));
    json(res, 200, { ok: true });
    return;
  }

  const { isHost } = room.resolve(auth);
  if (!isHost) throw new ApiError("Host only", 403);

  switch (action) {
    case "start":
      mutate(room, () => room.start());
      break;
    case "advance":
      mutate(room, () => room.advance(String(body.action ?? "")));
      break;
    case "remove":
      mutate(room, () => room.removePlayer(String(body.targetId ?? "")));
      break;
    case "settings":
      mutate(room, () =>
        room.updateSettings({
          maxPlayers: typeof body.maxPlayers === "number" ? body.maxPlayers : undefined,
          poolMode: body.poolMode as PoolMode | undefined,
        }),
      );
      break;
    case "bank": {
      if (body.clear === true) {
        mutate(room, () => room.clearBank());
      } else {
        mutate(room, () => room.replaceBank(Array.isArray(body.entries) ? body.entries : []));
      }
      break;
    }
    default:
      throw new ApiError("Not found", 404);
  }
  json(res, 200, room.stateFor(auth));
}

function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") throw new ApiError("Method not allowed", 405);

  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  let filePath = resolve(DIST, rel);
  if (filePath !== DIST && !filePath.startsWith(DIST + sep)) {
    throw new ApiError("Forbidden", 403);
  }

  let resolved = filePath;
  if (!existsSync(resolved) || statSync(resolved).isDirectory()) {
    resolved = join(DIST, "index.html");
  }
  if (!existsSync(resolved)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("Frontend not built yet. Run `npm run build` first, then `npm start`.");
    return;
  }

  const type = MIME[extname(resolved)] ?? "application/octet-stream";
  const body = readFileSync(resolved);
  const immutable = rel.startsWith("assets/");
  res.writeHead(200, {
    "content-type": type,
    "content-length": body.length,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (method === "HEAD") res.end();
  else res.end(body);
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        await api(req, res, url);
      } else {
        serveStatic(req, res, url);
      }
    } catch (error) {
      sendError(res, error);
    }
  })();
});

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.isExpired(now)) {
      rooms.delete(id);
      store.remove(id);
      console.log(`[impostor] expired room ${id}`);
    }
  }
}, 60_000).unref();

setInterval(() => {
  for (const room of rooms.values()) room.heartbeat();
}, 25_000).unref();

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) out.push(info.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  const address = server.address();
  const boundPort =
    typeof address === "object" && address ? address.port : PORT;
  console.log("");
  console.log("  Impostor is running");
  console.log(`  Local:  http://127.0.0.1:${boundPort}`);
  for (const lan of lanAddresses()) {
    console.log(`  LAN:    http://${lan}:${boundPort}`);
  }
  console.log(`  Data:   ${DATA_DIR}`);
  console.log("");
  console.log("  Share a LAN link with everyone on your network.");
  console.log("");
});
