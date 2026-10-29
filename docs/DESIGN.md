# FriendStar — Phase 1 MVP Design

FriendStar is an original one-to-one messenger. Phase 1 covers sign-up/sign-in, profiles, real-time 1:1 text chat with sent/delivered/read ticks, unread counts, basic image and file sharing, search, in-app notifications, privacy settings, and a responsive, mobile-first UI with light and dark mode.

> Update: Phase 2 has since built group chat, status stories and one-to-one voice/video calls. See [PHASE2.md](PHASE2.md). This document describes the Phase 1 baseline, where those features were shown as "Coming Soon".

**Brand.** Name "FriendStar", a rounded five-point star logo (custom SVG), a deep indigo/violet primary (`#5B4BDB`) with a warm amber star accent (`#FFB020`). Message bubbles are rounded "pill" cards, own messages in indigo, others in a neutral surface. Nothing is taken from WhatsApp's name, logo, green palette or layout.

**Stack.** TypeScript end to end. Server: Node 24, Express 5, Socket.IO, built-in `node:sqlite`, zod validation. Web: React 19, Vite, Tailwind CSS v4, Zustand, React Router. Shared types and zod schemas live in one workspace package used by both sides.

---

## 1. Database schema (SQLite)

All IDs are random strings (`nanoid`, 21 chars). Times are ISO-8601 UTC strings.

```sql
users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,   -- 3–20 chars, [a-z0-9_]
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,                     -- bcrypt, cost 12
  display_name TEXT NOT NULL,                      -- 1–40 chars
  bio TEXT NOT NULL DEFAULT '',                    -- ≤ 140 chars
  avatar_file_id TEXT NULL REFERENCES files(id),
  last_seen_at TEXT NULL,
  created_at TEXT NOT NULL
)

privacy_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen TEXT NOT NULL DEFAULT 'everyone',      -- everyone | contacts | nobody
  profile_photo TEXT NOT NULL DEFAULT 'everyone',  -- everyone | contacts | nobody
  read_receipts INTEGER NOT NULL DEFAULT 1,        -- 0/1, reciprocal
  who_can_message TEXT NOT NULL DEFAULT 'everyone',-- everyone | contacts
  discoverable INTEGER NOT NULL DEFAULT 1          -- appear in user search
)

blocks (
  blocker_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
)

refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,                 -- SHA-256 of the opaque token
  family_id TEXT NOT NULL,                         -- rotation family (reuse detection)
  expires_at TEXT NOT NULL,
  revoked_at TEXT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
)

conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'direct',             -- only 'direct' in Phase 1
  direct_key TEXT UNIQUE NOT NULL,                 -- "<minUserId>:<maxUserId>" prevents duplicates
  last_message_id TEXT NULL,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
)

conversation_members (
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TEXT NULL,                          -- drives unread count
  muted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
)

messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,                         -- idempotency key from the sender
  kind TEXT NOT NULL,                              -- text | image | file
  body TEXT NOT NULL DEFAULT '',                   -- ≤ 4000 chars (caption for media)
  file_id TEXT NULL REFERENCES files(id),
  created_at TEXT NOT NULL,                        -- = "sent"
  delivered_at TEXT NULL,
  read_at TEXT NULL,
  UNIQUE (sender_id, client_id)
)
INDEX messages_conv_created ON messages(conversation_id, created_at)

files (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  conversation_id TEXT NULL REFERENCES conversations(id), -- NULL for avatars
  storage_name TEXT NOT NULL,                      -- random name on disk, never user-supplied
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER NULL, height INTEGER NULL,
  created_at TEXT NOT NULL
)

notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                              -- new_message | system
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  conversation_id TEXT NULL,
  actor_id TEXT NULL,
  read_at TEXT NULL,
  created_at TEXT NOT NULL
)
INDEX notifications_user_created ON notifications(user_id, created_at)
```

**Derived values.**
- Message status for the sender: `read` if `read_at` is set **and** both users have read receipts on; otherwise `delivered` if `delivered_at` is set; otherwise `sent`.
- Unread count: messages in the conversation from the other user with `created_at > my last_read_at`.
- "Contacts" (for privacy rules) = users you share a conversation with that contains at least one message.

---

## 2. API contract

Base URL `/api`. JSON in and out. Errors use one shape: `{ "error": { "code": "VALIDATION" | "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" | "PAYLOAD_TOO_LARGE" | "INTERNAL", "message": string, "fields"?: Record<string,string> } }`.

Authenticated routes need `Authorization: Bearer <accessToken>`. The refresh token travels only in an httpOnly cookie `fs_rt` scoped to `/api/auth`.

### Auth
| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/auth/register` | `{ username, email, password, displayName }` | `201 { user: Me, accessToken }` + sets `fs_rt` |
| POST | `/auth/login` | `{ login (username or email), password }` | `200 { user: Me, accessToken }` + sets `fs_rt` |
| POST | `/auth/refresh` | — (cookie) | `200 { user: Me, accessToken }` + rotates `fs_rt` |
| POST | `/auth/logout` | — (cookie) | `204`, revokes the token family, clears cookie |
| GET | `/auth/me` | — | `200 { user: Me }` |

### Profile & users
| Method | Path | Body / query | Response |
|---|---|---|---|
| PATCH | `/me` | `{ displayName?, bio? }` | `{ user: Me }` |
| POST | `/me/avatar` | multipart `file` (image ≤ 5 MB) | `{ user: Me }` |
| DELETE | `/me/avatar` | — | `{ user: Me }` |
| GET | `/users/:id` | — | `{ user: PublicUser }` (privacy-filtered) |
| GET | `/search?q=` | q 1–50 chars | `{ users: PublicUser[], messages: MessageHit[] }` |

### Privacy & blocking
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/me/privacy` | — | `{ privacy: PrivacySettings }` |
| PATCH | `/me/privacy` | partial `PrivacySettings` | `{ privacy: PrivacySettings }` |
| GET | `/me/blocks` | — | `{ users: PublicUser[] }` |
| POST | `/me/blocks/:userId` | — | `204` |
| DELETE | `/me/blocks/:userId` | — | `204` |

### Conversations & messages
| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/conversations` | — | `{ conversations: ConversationSummary[] }` sorted by `updatedAt` desc |
| POST | `/conversations` | `{ userId }` | `{ conversation: ConversationSummary }` (get-or-create) |
| GET | `/conversations/:id` | — | `{ conversation: ConversationSummary }` |
| GET | `/conversations/:id/messages` | `?before=<iso>&limit=1..100` | `{ messages: Message[], hasMore }` oldest→newest |
| POST | `/conversations/:id/messages` | `{ clientId, kind:'text', body }` or multipart `{ clientId, body?, file }` | `201 { message: Message }` (idempotent on `clientId`) |
| POST | `/conversations/:id/read` | — | `{ conversation: ConversationSummary }` |
| GET | `/files/:id` | `?download=1` | file bytes; only conversation members (or anyone allowed to see an avatar) |

### Notifications
| Method | Path | Response |
|---|---|---|
| GET | `/notifications` | `{ notifications: Notification[], unread: number }` |
| POST | `/notifications/read-all` | `204` |

### Core types (in `packages/shared`)
```ts
type Me = PublicUser & { email: string; createdAt: string };
type PublicUser = { id; username; displayName; bio; avatarUrl: string|null; lastSeenAt: string|null; online: boolean|null; isBlocked?: boolean };
type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';   // 'sending'/'failed' are client-only
type Message = { id; clientId; conversationId; senderId; kind: 'text'|'image'|'file'; body; file: FileMeta|null; createdAt; status: MessageStatus };
type ConversationSummary = { id; peer: PublicUser; lastMessage: Message|null; unreadCount: number; updatedAt; canMessage: boolean };
type PrivacySettings = { lastSeen: Audience; profilePhoto: Audience; readReceipts: boolean; whoCanMessage: 'everyone'|'contacts'; discoverable: boolean };
```

### Real-time (Socket.IO, path `/socket.io`)
Handshake: `auth: { token: accessToken }`. The server joins each socket to room `user:<id>`.

| Direction | Event | Payload |
|---|---|---|
| server → client | `message:new` | `{ message, conversation }` |
| server → client | `message:status` | `{ conversationId, messageIds, status: 'delivered'|'read', at }` |
| server → client | `conversation:updated` | `{ conversation }` (unread counts, last message) |
| server → client | `presence` | `{ userId, online, lastSeenAt }` (privacy-filtered per viewer) |
| server → client | `typing` | `{ conversationId, userId, isTyping }` |
| server → client | `notification:new` | `{ notification, unread }` |
| client → server | `typing` | `{ conversationId, isTyping }` |
| client → server | `message:delivered` | `{ messageIds }` (ack after the client receives them) |

Delivery rules: when a message is created and the recipient has at least one live socket, the server pushes it; the recipient client acks with `message:delivered`. When the recipient connects later, all undelivered messages addressed to them are marked delivered. Reading happens through `POST /conversations/:id/read`.

---

## 3. Screen flow

```
Splash (restore session via /auth/refresh)
 ├── not signed in → Welcome → Sign in ⇄ Create account
 └── signed in → App shell
      ├── Chats (home)            list, unread badges, last message, ticks, search bar
      │    ├── New chat           user search → opens/creates conversation
      │    └── Chat room          header (peer, presence/typing) · messages · composer (text, attach image/file)
      │         └── Peer profile  avatar, bio, block/unblock
      ├── Search                  people + messages; tap message → chat room scrolled to it
      ├── Notifications           list, mark all read, tap → chat room
      ├── Coming Soon             Groups · Voice calls · Video calls · Stories (disabled cards)
      └── Settings
           ├── Profile            name, bio, avatar
           ├── Privacy            last seen, profile photo, read receipts, who can message, discoverable, blocked users
           ├── Appearance         Light / Dark / System
           ├── Notifications      browser notifications permission, sound
           └── Sign out
```

Mobile (< 768 px): bottom tab bar (Chats, Search, Alerts, Soon, Settings); the chat room is a full-screen route with a back button. Desktop (≥ 768 px): a left rail plus list pane, with the chat room in the right pane.

---

## 4. Project folder structure

```
friendstar/
├── package.json               workspace scripts (dev, build, start, seed, test)
├── pnpm-workspace.yaml
├── docs/DESIGN.md
├── packages/shared/src/       types.ts, schemas.ts (zod), index.ts
├── apps/server/
│   ├── src/
│   │   ├── index.ts           http + socket bootstrap, static web serving
│   │   ├── app.ts             express app, helmet, CORS, rate limits, routes
│   │   ├── config.ts          env config
│   │   ├── db/                database.ts (schema + migrations), seed.ts
│   │   ├── lib/               ids, time, errors, tokens, passwords
│   │   ├── middleware/        auth.ts, validate.ts, error.ts
│   │   ├── services/          users, privacy, conversations, messages, files, notifications, presence
│   │   ├── routes/            auth, me, users, conversations, files, notifications, search
│   │   └── realtime/socket.ts
│   ├── uploads/               runtime file storage (git-ignored)
│   └── data/                  SQLite database (git-ignored)
└── apps/web/
    ├── index.html
    └── src/
        ├── main.tsx, App.tsx, index.css (theme tokens)
        ├── api/               backend.ts (interface), http.ts (REST + socket), demo.ts (in-browser demo backend)
        ├── store/             auth, chat, notifications, theme (Zustand)
        ├── components/ui/     Button, Input, Avatar, Badge, Toggle, Sheet, Logo, Spinner, EmptyState
        ├── components/chat/   ConversationItem, MessageBubble, StatusTicks, Composer (with attachment preview), DayDivider, TypingDots
        ├── components/layout/ AppShell, BottomNav, SideRail, TopBar
        ├── pages/             Welcome, Login, Register, Chats, ChatRoom, NewChat, Search, Notifications, ComingSoon, Settings/*
        └── lib/               format.ts, notify.ts, cn.ts
```

---

## 5. Authentication and security plan

**Passwords.** bcrypt with cost 12. Passwords must be 8–72 characters and contain a letter and a digit. Login returns one generic "Invalid username or password" error so it never reveals which accounts exist.

**Tokens.**
- Access token: a JWT signed HS256 with `JWT_SECRET`. It lasts 15 minutes, carries the claims `sub` and `typ:'access'`, and is held only in memory on the client, never in localStorage.
- Refresh token: 32 random bytes (base64url) in an httpOnly, `SameSite=Strict` cookie, `Secure` in production, `Path=/api/auth`, valid for 30 days. Only its SHA-256 hash is stored.
- Rotation: every refresh issues a new token and revokes the old one. Reusing a revoked token revokes its whole family, which logs out that device chain, in case the token was stolen. A 10-second grace window lets two tabs refresh at the same moment, but never applies to a token revoked by logout.
- The client keeps only a non-secret `fs_signed_in` flag in localStorage, so guests skip the refresh call on page load.
- Logout revokes the family. Because the cookie is `SameSite=Strict` and only `/api/auth/*` reads it, every other endpoint needs the Bearer header, which blocks CSRF.

**Authorization.** Each conversation, message and file query is checked against `conversation_members` for the requesting user, and non-members get `404` so IDs are never confirmed. Sending a message is rejected when either side has blocked the other, or when the recipient's `who_can_message = contacts` and the sender is not a contact. The privacy filters (last seen, online, avatar, read receipts, discoverability) run on the server inside the serializer, so hidden data never reaches the client.

**Input and output.** Every body and query is validated with zod and limited in length (message ≤ 4000 chars, JSON body ≤ 100 KB). Text is rendered as text through React, with no `dangerouslySetInnerHTML`. URLs in messages are linkified only for `http(s)` and get `rel="noopener noreferrer"`.

**Files.**
- Size limits: 10 MB for attachments, 5 MB for avatars.
- Allowed types: images (jpeg/png/gif/webp), pdf, txt, csv, zip, doc/docx, xls/xlsx, ppt/pptx. The file's first bytes are checked against its claimed image type (magic bytes).
- Files are stored under random names outside the web root and served only through `/api/files/:id` after a membership check, with `X-Content-Type-Options: nosniff`.
- Non-image files are always sent with `Content-Disposition: attachment`, and SVG is not accepted at all.

**Transport and headers.** helmet adds CSP (`default-src 'self'`, `img-src 'self' blob: data:`, `connect-src 'self' ws: wss:`), HSTS in production, frameguard and noSniff. CORS is limited to `WEB_ORIGIN` when the web app is on a different origin in development.

**Abuse limits.**
- Login and register: 20 failed attempts per minute per IP (successful sign-ins don't count, so normal use is never throttled).
- API, including session refresh: 300 requests per minute per IP.
- Socket messages: 20 per 10 seconds per socket.
- Typing events are throttled on the client.

**Sockets.** The handshake checks the access token. When the client refreshes its token it reconnects with the new one. A socket is only allowed to emit events for conversations its user belongs to.

**Secrets and data.** `JWT_SECRET` comes from the environment. In development it is generated and stored in `apps/server/data/.secret` with file mode 600. Passwords and tokens are never logged.

**Not in Phase 1.** End-to-end encryption, 2FA, email verification and password reset by email are not included. The schema leaves room to add them.
