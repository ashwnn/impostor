# Impostor

Mobile-first party word game on Cloudflare Workers. One Worker serves the React/Vite static app and API; each room is a SQLite-backed Durable Object with hibernating WebSockets.

## How to play

1. Host creates a room (3–16 player limit) and copies the invite link `/r/{id}`.
2. Guests open the link, enter a display name — no accounts.
3. Every active player submits a **private candidate word + hint** before Start.
4. Host presses **Start**. One eligible candidate is chosen (never a word every player wrote; the impostor is never an author).
5. Crew sees the word. The impostor sees only the hint.
6. Everyone writes a short clue; clues reveal together; discuss; one vote each.
7. Unique plurality on the impostor → crew wins; otherwise impostor wins (ties spare the impostor).
8. Host starts the next round with fresh submissions.

**Pool modes**

- `submissions` — only player-submitted words.
- `mixed` — 50/50 between host bank and player submissions when both exist.

Host can import/export a JSON word bank in the lobby:

```json
[
  { "word": "lantern", "hint": "light in the dark" },
  { "word": "anchor", "hint": "holds a ship in place" }
]
```

Limits: word 40 chars, hint 100, clue 1–3 words / 40 chars, name 32, bank ≤500 pairs / 200KB.

## Architecture

| Piece | Choice |
| --- | --- |
| UI | Vite + React + TypeScript, mobile-first, ShadCN-style components |
| Server | One Cloudflare Worker (static assets + `/api/*`) |
| Room state | One SQLite-backed Durable Object per room |
| Live updates | Hibernating WebSockets (personalized snapshots) |

State machine: `LOBBY → SUBMITTING → ROLE_REVEAL → CLUES_PENDING → DISCUSSION → VOTING → RESULTS → SUBMITTING`, with `CLOSED`.

Secrets (selected word, impostor id, other players’ submissions, unrevealed votes) stay server-side. Each client receives a filtered shared snapshot plus only its own role payload.

Sessions: high-entropy tokens in `HttpOnly; SameSite=Lax; Secure` cookies (room-scoped player seat + separate host authority). Tokens are stored as SHA-256 hashes.

Rooms expire 24h after last activity (Durable Object alarm + storage wipe). Closed rooms delete after ~5 minutes.

## Setup

```bash
npm ci
npx wrangler login   # once
npm run deploy       # builds frontend + wrangler deploy
```

Local development:

```bash
npm run dev          # vite build && wrangler dev (http://127.0.0.1:8787)
```

Open the printed URL, create a room, share the invite.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run build` | Typecheck + Vite production build → `dist/` |
| `npm run deploy` | Build, then `wrangler deploy` using checked-in `wrangler.jsonc` |
| `npm test` | Vitest in Workers runtime (capacity races, start gating, secrecy, voting) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run dev` | Local Worker + built assets |

## Tests

```bash
npm test
```

Focused coverage:

- **Capacity races** — simultaneous joins cannot exceed the host limit; full rooms reject; session rejoin keeps one seat.
- **Start gating** — Start blocked until every active player submitted; host-only; ≥3 players; no eligible word → clear error.
- **Secrecy** — impostor payload never contains the selected word; authors never become impostor; reconnect preserves seat/role.
- **Voting** — no self-votes, no double votes, reveal only when all are in, plurality/tie outcomes, next round resets submissions.

## Security notes

- Origin checked on mutations and WebSocket upgrades.
- Server validates role, phase, membership, host actions, and input limits.
- User text is rendered as text, never HTML.
- Optional hardening: Cloudflare rate limiting on create/join; host can kick in lobby and close the room.
- Invite links are unguessable (128-bit) but act as bearer capability until capacity fills — close or don’t share publicly if that matters.

## Deploy config

`wrangler.jsonc` is checked in:

- Static assets from `./dist` with SPA fallback
- `run_worker_first: ["/api/*"]`
- Durable Object binding `ROOM` + SQLite migration (`new_sqlite_classes`)

First deploy creates the Worker and DO class from that config. Subsequent deploys: `npm run deploy` while `wrangler login` session is valid.

### Optional CI

Use a scoped Cloudflare API token (Workers Scripts + Durable Objects write) as `CLOUDFLARE_API_TOKEN` and run `npm ci && npm run deploy`. Not required for MVP.

## Privacy

Guest names, words, hints, clues, and votes exist only for the room lifetime. No analytics on content. Rooms and browser sessions are ephemeral.
