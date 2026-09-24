import type {
  BankEntry,
  RoomStateResponse,
  PoolMode,
} from "../../src/shared/protocol";

async function parse<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`) as Error & {
      fields?: Record<string, string>;
      status?: number;
    };
    err.status = res.status;
    if (data && typeof data === "object" && "fields" in data) {
      err.fields = (data as { fields?: Record<string, string> }).fields;
    }
    throw err;
  }
  return data;
}

export async function createRoom(opts: {
  maxPlayers: number;
  poolMode: PoolMode;
}) {
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  });
  return parse<{ roomId: string; invitePath: string }>(res);
}

export async function joinRoom(roomId: string, name: string) {
  const res = await fetch(`/api/rooms/${roomId}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return parse<{ ok: boolean; playerId: string; rejoined: boolean }>(res);
}

export async function getState(roomId: string): Promise<RoomStateResponse> {
  const res = await fetch(`/api/rooms/${roomId}/state`);
  return parse<RoomStateResponse>(res);
}

async function post<T>(roomId: string, action: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/rooms/${roomId}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return parse<T>(res);
}

export const api = {
  submission: (roomId: string, word: string, hint: string, rev: number) =>
    post<RoomStateResponse>(roomId, "submission", { word, hint, rev }),
  start: (roomId: string, rev: number) =>
    post<RoomStateResponse>(roomId, "start", { rev }),
  clue: (roomId: string, clue: string, rev: number) =>
    post<RoomStateResponse>(roomId, "clue", { clue, rev }),
  vote: (roomId: string, targetId: string, rev: number) =>
    post<RoomStateResponse>(roomId, "vote", { targetId, rev }),
  advance: (
    roomId: string,
    action: "begin" | "advance" | "cancel" | "close" | "force_results",
    rev: number,
  ) => post<RoomStateResponse>(roomId, "advance", { action, rev }),
  remove: (roomId: string, targetId: string) =>
    post<RoomStateResponse>(roomId, "remove", { targetId }),
  settings: (
    roomId: string,
    opts: { maxPlayers?: number; poolMode?: PoolMode },
  ) => post<RoomStateResponse>(roomId, "settings", opts),
  bankReplace: (roomId: string, entries: BankEntry[]) =>
    post<RoomStateResponse>(roomId, "bank", { entries }),
  bankClear: (roomId: string) =>
    post<RoomStateResponse>(roomId, "bank", { clear: true }),
};

export function openRoomSocket(
  roomId: string,
  onMessage: (data: RoomStateResponse) => void,
): WebSocket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${roomId}/ws`);
  ws.addEventListener("message", (ev) => {
    try {
      const data = JSON.parse(String(ev.data)) as RoomStateResponse;
      if (data && data.shared) onMessage(data);
    } catch {
      /* ignore */
    }
  });
  return ws;
}
