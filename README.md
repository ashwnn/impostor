# Impostor

A mobile-first party word game that runs entirely on your LAN. One machine starts the
server; everyone else joins from a browser. No accounts, no cloud, no internet required.

Everyone gets the same secret word — except one player, who only gets a hint. Players
submit candidate words, give clues, argue out loud, and vote out the impostor.

**[Landing page](https://ashwnn.github.io/impostor/)** (GitHub Pages) · source is this repo.

## Quick start

Requires **Node 22.6+** (the server runs TypeScript directly via type stripping).

```bash
git clone https://github.com/ashwnn/impostor.git
cd impostor
npm install
npm start
```

The server prints a link for every network interface:

```
  Impostor is running
  Local:  http://127.0.0.1:8787
  LAN:    http://192.168.1.5:8787
```

Share the LAN link. First launch serves a fresh build; use `npm run dev` to rebuild and
start in one step, or `npm run dev:ui` for a Vite dev server with hot reload (it proxies
`/api` to `http://127.0.0.1:8787`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `IMPOSTOR_DATA_DIR` | `./data` | Where room JSON files live |

## How to play

1. **Host** creates a room (3–16 players) and shares the invite link.
2. **Guests** open the link, type a display name, and they're in.
3. **Everyone submits** one candidate word plus a hint before the round can start.
   Submissions are private; the room only shows who is ready.
4. **Host presses Start.** One candidate is chosen — never a word every active player
   wrote, and the impostor is never one of its authors.
5. **Crew** sees the word. **Impostor** sees the hint and an explicit label.
6. **Clues** are written one at a time (1–3 words), hidden until all are in, then revealed
   together.
7. **Discussion** out loud, then **one vote per player** — no self-votes, revealed together.
8. **Unique plurality** on the impostor means the crew wins; a tie spares the impostor.
9. **Next round** starts with fresh submissions for every player.

Reconnecting is automatic: the browser stores its room seat and restores it after a
refresh. `Join as a different player` frees the seat and takes a new one. The host can
remove players between rounds.

### Host controls

- Player limit (3–16) and word pool, editable in the lobby.
- JSON word bank: import/export/clear hundreds of word/hint pairs.
- `Players only` pool: every candidate comes from the players.
- `Players + bank` pool: a round draws from the host bank or player submissions (50/50).
- Start, reset round, force results, next round, close room.

Word bank format:

```json
[
  { "word": "lantern", "hint": "light in the dark" },
  { "word": "anchor", "hint": "holds a ship in place" }
]
```

Limits: word 40 chars, hint 100, clue 1–3 words / 40 chars, name 32, bank ≤500 pairs.

## Development

```bash
npm run build      # typecheck + production build into dist/
npm run dev        # build, then start the server
npm start          # start the server (serves the last build)
npm run dev:ui     # Vite dev server for the UI, proxying /api to :8787
npm test           # node:test suite (unit + HTTP integration)
npm run lint       # ESLint with @shadcn/lint design-system rules
npm run typecheck  # tsc --noEmit
```

### Tests

`npm test` runs 38 checks with Node's built-in test runner:

- **Room logic** (`tests/room.test.ts`): capacity limits, join/rejoin/name rules, start
  gating, duplicate-word eligibility, impostor-never-an-author, secret isolation, clue
  reveal, voting, resets, bank validation, expiry, host tokens, presence.
- **HTTP integration** (`tests/server.test.ts`): a real server process on a random port —
  parallel joins under capacity, host-only enforcement, SSE updates, full round flow with
  per-player secrecy checks, closed rooms, malformed ids.

### Linting

`@shadcn/lint` enforces design-system rules over the Tailwind v4 classes in `app/`: no
arbitrary values, no raw palette colors, no inline styles, unknown classes, unreadable
dynamic classes, and which classes each UI component accepts (`eslint.config.mjs`). Theme
tokens live in `app/index.css`.

## Architecture

One Node process, zero runtime dependencies:

| Piece | Choice |
| --- | --- |
| HTTP server | `node:http` — static files from `dist/`, JSON API, SSE |
| Live updates | Server-sent events (fetch streaming, token in headers) |
| Room state | In-memory `Room` per room, persisted as one JSON file (atomic writes) |
| Auth | Room-scoped bearer tokens in `Authorization` / `X-Host-Token` headers |
| UI | React + Vite + Tailwind v4, mobile-first |

All mutations are plain JSON `POST`s; the server validates phase, role, membership, host
authority, and input limits, then pushes each client its own filtered view over SSE.
Secrets (the selected word, the impostor, unrevealed votes, other players' submissions)
never leave the server.

Rooms expire after 24 hours of inactivity; closed rooms are deleted after 5 minutes.
Room files live in `data/` and are safe to delete when the server is stopped.

### Why a single Node process

A party game has 3–16 players in one place. Node's single-threaded event loop already
serializes joins, starts, and votes, so there is no need for a coordination layer; JSON
files are plenty for rooms this small. The earlier Cloudflare Workers/Durable Object
version is kept in this repo's history for reference.

## GitHub Pages

`site/` is a static landing page deployed by `.github/workflows/pages.yml` to GitHub Pages
on every push that touches it. The game itself cannot be hosted there: a browser page
served over HTTPS cannot call a plain-HTTP LAN server (mixed content), so the app is
served by the host machine over the local network instead.

## Security notes

- This is LAN software: traffic between devices is plain HTTP on your local network. Use
  it on networks you trust.
- Tokens are 256-bit random values stored hashed (SHA-256) on the server; host authority
  is separate from player seats.
- Input is validated server-side; user text is rendered as text, never HTML.
- A leaked invite link can fill seats until the host raises the limit or closes the room.
