# FriendStar

A private, mobile-first messenger: one-to-one and group chats, 24-hour status updates, one-to-one and group voice/video calls, public FriendStar IDs, a People directory, and helper bots including an AI assistant. Live at **https://chat.friendstar.workers.dev**.

Design documents: [`docs/DESIGN.md`](docs/DESIGN.md) (Phase 1: database schema, API contract, screen flow, folder structure, authentication and security plan) [`docs/PHASE2.md`](docs/PHASE2.md) (groups, status and calls) and [`docs/PHASE3.md`](docs/PHASE3.md) (IDs, People, group calls, bots, owner admin page).

## What's included

- Sign up, sign in and sign out, with sessions that survive a page reload (rotating refresh tokens).
- Profiles: name, bio and photo.
- Real-time one-to-one chat over Socket.IO, with typing indicators and online/last-seen.
- Message ticks: a clock while sending, then one tick (sent), two ticks (delivered) and two amber ticks (read).
- Unread counts on each chat and on the Chats and Alerts tabs.
- Photo and file sharing up to 10 MB, with a preview before sending, a lightbox for photos and download links for files.
- Search across people, messages and file names, with jump-to-message.
- Notifications: an in-app list, toasts, a soft chime and optional browser notifications.
- Privacy: last seen, profile photo, read receipts, who can message you, search visibility, and blocking.
- Friend invites through a shareable profile link, plus a top-of-page link to download the direct-install Android beta APK from the same site.
- Secure password reset: requests receive a generic response; an owner verifies the requester and issues a one-time, 15-minute reset link. Only token hashes are stored, and existing sessions are revoked after reset. No reset email is sent.
- Light, dark and system themes; responsive layout from phones up to desktop.

Phase 2 adds:

- **Group chats** with a photo, admins, add/remove/promote, leave, system event lines, sender names and all-members-read ticks.
- **Status**: text (six colour backgrounds) or photo updates that vanish after 24 hours, with seen rings, a full-screen viewer and a viewers list.
- **Voice and video calls** (one-to-one, WebRTC, peer-to-peer and encrypted) with ringtone, accept/decline, mute, camera on/off, flip camera, minimise, missed-call alerts and a call history tab.

Phase 3 adds:

- **FriendStar IDs** (`FS-XXXXXX`) for everyone, shown on People, profiles and Settings with copy/share. Each ID has a share link at `/u/FS-XXXXXX`. An exact email or ID always finds a person; a partial name or surname finds anyone who appears in search.
- **People** tab listing everyone who joined, with their IDs.
- **Group voice and video calls** in any group: up to 6 people, members get rung, a "Join" banner in the chat, minimise, a summary line and Calls history.
- **Bots:** Star AI (Cloudflare Workers AI, English/Bangla, `@starai` in groups), Nova Guide (welcomes new people), Echo Bot and Lucky.
- **Owner-only admin page** at `/admin`: account IDs and emails, account creation and successful sign-in dates, aggregate daily totals, and in-app update announcements with an exact preview, recipient count, separate send confirmation and audit history. Private chat contents are not available in the admin page or its API, and passwords/password hashes are never shown. Only for emails in `OWNER_EMAILS`.

## Run it locally

You need Node 22.5+ (built and tested on Node 24) and pnpm 9+.

```bash
cd friendstar
pnpm install
pnpm seed          # requires DEMO_PASSWORD in your local environment; wipes local data
pnpm dev           # API on :4000, web app on http://localhost:5173
```

For a single production-style process that serves the built web app and the API together:

```bash
pnpm build && pnpm start      # open http://localhost:4000
```

Tests:

```bash
pnpm typecheck
pnpm test                      # API + realtime smoke test (uses a temporary database and a random port)
```

## Local demo accounts

`pnpm seed` creates synthetic local accounts and sample conversations, and wipes the local database. Set `DEMO_PASSWORD` in your local environment before seeding; do not use real credentials or seed production.

## Browser-only demo build

The public URL now serves the real multi-user app (see "Live hosting on Cloudflare" below). The demo build is still available for offline showcases.


`pnpm build:demo` produces `apps/web/dist-demo`, a static build that runs entirely in the browser with no server. Data is stored in the browser's localStorage, every tab has its own session, and tabs talk to each other through BroadcastChannel, so two tabs can chat in real time. It also includes "Nova", a guide bot that replies so you can see the ticks change. This build uses hash URLs (`/#/login`) because static hosting has no server-side routing.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | API port |
| `JWT_SECRET` | generated once into `apps/server/data/.secret` | Set your own (32+ characters) for real deployments; `REQUIRE_JWT_SECRET=1` makes it mandatory |
| `WEB_ORIGIN` | `http://localhost:5173` | Allowed CORS origin in development |
| `DATA_DIR` / `DB_FILE` | `apps/server/data/friendstar.db` | SQLite database location |
| `AUTH_RATE_LIMIT` / `API_RATE_LIMIT` | `20` / `300` per minute | Abuse limits |
| `UPLOAD_DIR` | `apps/server/uploads` | Uploaded files (served only through the API) |

## Live hosting on Cloudflare (free plan)

The public multi-user app runs at **https://chat.friendstar.workers.dev** (Worker `chat`, account subdomain `friendstar`).

How it is put together (`apps/worker`):

- **Static web app**: served by Workers Static Assets with SPA fallback and the security headers in `apps/worker/static/_headers` (CSP, HSTS, no framing).
- **API + realtime**: every `/api/*` request goes to one SQLite-backed Durable Object (`FriendStarHub`). It runs the *same* users/chat/notifications/auth services as the Node server (`apps/server/src/services`). `build.mjs` swaps in Cloudflare adapters for the database, crypto utilities, realtime hub and bcrypt (`apps/worker/src/platform`).
- **Realtime**: native hibernatable WebSockets at `/api/ws` instead of Socket.IO. The access token travels as a WebSocket subprotocol, never in the URL. The web client picks its transport at build time (`VITE_REALTIME=ws`, see `apps/web/src/api/realtime.ts`).
- **Files**: validated (type, size, magic bytes) and stored in 1 MB chunks inside the Durable Object's SQLite database, served via signed URLs.
- **Secrets**: the JWT/file-URL signing secret is generated on first start and kept only in Durable Object storage.
- **Extra endpoint**: `DELETE /api/me` with `{ "password": "..." }` deletes the account, its sessions, files, statuses, call history and its one-to-one chats (both sides). It also removes the account from groups, which carry on for everyone else. It exists only in the Cloudflare build.
- **AI bot**: the Workers AI binding `AI` powers Star AI, capped at 30 messages per person and 200 for the whole app per day to stay inside the free allowance.
- **Owner**: Worker variable `OWNER_EMAILS` (currently `contact.tajuljayan@gmail.com`) decides who can open `/admin`.
- **Calls**: WebRTC with STUN only by default. Optional TURN relay: set Worker secrets `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` (Cloudflare Realtime TURN). See [`docs/PHASE2.md`](docs/PHASE2.md).

Deploy (needs `wrangler login` for the owning account):

```bash
cd apps/worker
pnpm build:web     # builds the web app with the WebSocket transport into ./public
pnpm build         # bundles the Worker into ./dist
npx wrangler deploy
```

Local run of the Cloudflare build: `pnpm build:web && pnpm build && npx wrangler dev --port 8787`.

Checks:

- `node scripts/cf-smoke.mjs [baseUrl]` runs 37 REST/WebSocket/file checks with two throwaway accounts, then deletes them.
- `python3 scripts/prod_check.py [baseUrl]` runs a two-browser live check plus a homepage screenshot, then deletes its accounts.
- `node scripts/phase2-smoke.mjs [baseUrl]` runs about 55 group/status/call API and WebSocket checks with three throwaway accounts.
- `python3 scripts/e2e_phase2.py [baseUrl] [shotsDir]` runs the two-browser Phase 2 test, including a real video call.
- `node scripts/phase3-smoke.mjs [baseUrl]` runs about 40 checks for IDs, search, People, bots (including Star AI), group call signalling and admin access. Add `--owner` only on a local copy.
- `python3 scripts/e2e_phase3.py [baseUrl] [shotsDir]` runs a three-browser test: People/ID/search, bots, and a 3-person group video call.

Free-plan limits worth knowing: about 100,000 Worker/Durable Object requests per day (WebSocket messages count at 1/20 of a request), 5 GB total Durable Object storage, and a 10 MB upload cap set by the app. Group calls are a peer-to-peer mesh capped at 6 people. Workers AI's free allowance is about 10,000 "neurons" per day. Data is persistent; it does not reset when the object sleeps. A single Durable Object handles all users, which suits a friends-and-family group well but not thousands of concurrent users.
