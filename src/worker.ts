import { Room, type Env } from "./room";

export { Room };
export type { Env };

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isValidRoomId(id: string): boolean {
  return /^[a-f0-9]{16}$/.test(id);
}

/** Reject cross-origin mutations and WS upgrades at the edge. */
function originRejected(request: Request): Response | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  try {
    const originUrl = new URL(origin);
    const reqUrl = new URL(request.url);
    if (originUrl.host === reqUrl.host) return null;
    return jsonError("Origin mismatch", 403);
  } catch {
    return jsonError("Invalid origin", 403);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    const parts = path.split("/").filter(Boolean);
    if (parts[1] !== "rooms") {
      return jsonError("Not found", 404);
    }

    const isUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    if (isUpgrade || (request.method !== "GET" && request.method !== "HEAD")) {
      const rejected = originRejected(request);
      if (rejected) return rejected;
    }

    // Buffer body once so DO fetch does not re-read a closed stream.
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();

    const forward = (doPath: string, method = request.method): Request => {
      const headers = new Headers(request.headers);
      headers.delete("Content-Length");
      headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
      return new Request(`https://room${doPath}`, {
        method,
        body: body && body.byteLength > 0 ? body : method === "GET" ? undefined : body,
        headers,
        redirect: "manual",
      });
    };

    // POST /api/rooms
    if (parts.length === 2 && request.method === "POST") {
      const roomId = crypto
        .getRandomValues(new Uint8Array(8))
        .reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
      const stub = env.ROOM.idFromName(roomId);
      const ns = env.ROOM.get(stub);
      return ns.fetch(forward("/create", "POST"));
    }

    const roomId = parts[2];
    if (!roomId || !isValidRoomId(roomId)) {
      return jsonError("Invalid room id", 400);
    }
    const action = parts[3] || "";
    const stub = env.ROOM.idFromName(roomId);
    const ns = env.ROOM.get(stub);

    if (isUpgrade) {
      return ns.fetch(forward("/ws", "GET"));
    }

    return ns.fetch(forward(`/${action || "state"}`));
  },
};
