import type {
  BankEntry,
  PoolMode,
  RoomStateResponse,
} from "../../shared/protocol.ts";

const hostKey = (roomId: string) => `impostor.host.${roomId}`;
const sessionKey = (roomId: string) => `impostor.session.${roomId}`;
const lastKey = (roomId: string) => `impostor.last.${roomId}`;

/** Host authority for this room, kept across sessions on this browser. */
export function getHostToken(roomId: string): string | null {
  return localStorage.getItem(hostKey(roomId));
}

export function saveHostToken(roomId: string, token: string): void {
  localStorage.setItem(hostKey(roomId), token);
}

/**
 * Player session for this room, per tab first (so several tabs can sit as
 * different players) and falling back to the last session so a closed tab
 * can rejoin its seat.
 */
export function getSessionToken(roomId: string): string | null {
  return (
    sessionStorage.getItem(sessionKey(roomId)) ??
    localStorage.getItem(lastKey(roomId))
  );
}

export function hasSession(roomId: string): boolean {
  return getSessionToken(roomId) !== null;
}

export function saveSessionToken(roomId: string, token: string): void {
  sessionStorage.setItem(sessionKey(roomId), token);
  localStorage.setItem(lastKey(roomId), token);
}

/** Forget the current seat so this tab can join as someone else. */
export function clearSessionToken(roomId: string): void {
  sessionStorage.removeItem(sessionKey(roomId));
  localStorage.removeItem(lastKey(roomId));
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function authHeaders(roomId: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const session = getSessionToken(roomId);
  if (session) headers.Authorization = `Bearer ${session}`;
  const host = getHostToken(roomId);
  if (host) headers["X-Host-Token"] = host;
  return headers;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, init);
  const data = (await res.json().catch(() => ({}))) as T & {
    error?: string;
    fields?: Record<string, string>;
  };
  if (!res.ok) {
    throw new ApiRequestError(data?.error ?? `Request failed (${res.status})`, res.status, data?.fields);
  }
  return data;
}

function post<T>(path: string, body: unknown, roomId?: string): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(roomId ? authHeaders(roomId) : {}),
    },
    body: JSON.stringify(body),
  });
}

export async function createRoom(opts: {
  maxPlayers: number;
  poolMode: PoolMode;
}): Promise<{ roomId: string; hostToken: string; invitePath: string }> {
  const data = await post<{ roomId: string; hostToken: string; invitePath: string }>(
    "/api/rooms",
    opts,
  );
  saveHostToken(data.roomId, data.hostToken);
  return data;
}

export interface JoinResult {
  playerId: string;
  name: string;
  sessionToken: string;
  rejoined: boolean;
}

export async function joinRoom(roomId: string, name: string): Promise<JoinResult> {
  const data = await post<JoinResult>(`/api/rooms/${roomId}/join`, { name }, roomId);
  saveSessionToken(roomId, data.sessionToken);
  return data;
}

export function getState(roomId: string): Promise<RoomStateResponse> {
  return request<RoomStateResponse>(`/api/rooms/${roomId}/state`, {
    headers: authHeaders(roomId),
  });
}

export const api = {
  submission: (roomId: string, word: string, hint: string) =>
    post<RoomStateResponse>(`/api/rooms/${roomId}/submission`, { word, hint }, roomId),
  start: (roomId: string) =>
    post<RoomStateResponse>(`/api/rooms/${roomId}/start`, {}, roomId),
  clue: (roomId: string, clue: string) =>
    post<RoomStateResponse>(`/api/rooms/${roomId}/clue`, { clue }, roomId),
  vote: (roomId: string, targetId: string) =>
    post<RoomStateResponse>(`/api/rooms/${roomId}/vote`, { targetId }, roomId),
  advance: (
    roomId: string,
    action: "begin" | "advance" | "cancel" | "close" | "force_results",
  ) => post<RoomStateResponse>(`/api/rooms/${roomId}/advance`, { action }, roomId),
  remove: (roomId: string, targetId: string) =>
    post<RoomStateResponse>(`/api/rooms/${roomId}/remove`, { targetId }, roomId),
  leave: (roomId: string) =>
    post<{ ok: boolean }>(`/api/rooms/${roomId}/leave`, {}, roomId),
  settings: (roomId: string, opts: { maxPlayers?: number; poolMode?: PoolMode }) =>
    post<RoomStateResponse>(`/api/rooms/${roomId}/settings`, opts, roomId),
  bankReplace: (roomId: string, entries: BankEntry[]) =>
    post<RoomStateResponse>(`/api/rooms/${roomId}/bank`, { entries }, roomId),
  bankClear: (roomId: string) =>
    post<RoomStateResponse>(`/api/rooms/${roomId}/bank`, { clear: true }, roomId),
};

export type LiveStatus = "connecting" | "live" | "reconnecting";

/**
 * Stream room state over server-sent events using fetch (so auth headers work
 * in every browser). Reconnects with backoff; caller re-fetches state on each
 * (re)connect for correctness.
 */
export function subscribeRoom(
  roomId: string,
  handlers: {
    onState: (state: RoomStateResponse) => void;
    onStatus?: (status: LiveStatus) => void;
    onReconnect?: () => void;
  },
): () => void {
  let closed = false;
  let controller: AbortController | null = null;

  const connect = async (attempt: number): Promise<void> => {
    if (closed) return;
    controller = new AbortController();
    try {
      handlers.onStatus?.("connecting");
      const res = await fetch(`/api/rooms/${roomId}/events`, {
        headers: authHeaders(roomId),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
      handlers.onStatus?.("live");
      handlers.onReconnect?.();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            handlers.onState(JSON.parse(line.slice(6)) as RoomStateResponse);
          } catch {
            // ignore malformed frame
          }
        }
      }
    } catch {
      // fall through to retry
    }
    if (!closed) {
      handlers.onStatus?.("reconnecting");
      const delay = Math.min(1000 * 2 ** Math.min(attempt, 4), 10000);
      setTimeout(() => void connect(attempt + 1), delay);
    }
  };

  void connect(0);

  return () => {
    closed = true;
    controller?.abort();
  };
}
