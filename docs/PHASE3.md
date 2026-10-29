# FriendStar Phase 3: public IDs, People, group calls, bots and the owner admin page

Live at **https://chat.friendstar.workers.dev**. Existing accounts, chats and files were kept; older accounts got an ID automatically the first time the new version started.

## Everyone has a FriendStar ID

Every account gets a short public ID such as `FS-P8HE9V` (6 characters, with confusable letters like O/0 and I/1 left out). It is shown on:

- the **People** tab ("Your FriendStar ID" card with Copy and Share),
- every person's row in People and Search,
- profile pages and **Settings**.

Each ID has a share link, `https://chat.friendstar.workers.dev/u/FS-XXXXXX`. Opening it shows that person's profile with a **Message** button. If you're signed out, you go back to the profile after signing in.

**Finding people.** Typing someone's **exact email** or **exact ID** always finds them, unless one of you has blocked the other. Typing part of a **name, surname or username** finds anyone who leaves "Appear in search" on (Settings → Privacy). The People tab lists everyone who joined, newest first, with their IDs. Bots appear at the top.

Data: table `friend_ids(user_id PK → users ON DELETE CASCADE, code UNIQUE)`. `PublicUser` now includes `friendId` and `bot`. API: `GET /api/people?cursor=` (directory page), `GET /api/people/by-id/:code` (profile from an ID), and `GET /api/search?q=` (now also matches exact email/ID).

## Group calls (voice and video)

Any group chat has voice and video call buttons in its header.

- Starting a call **rings every online member** with a "Join / Not now" card. Members who come in later see a **"Call in progress · Join"** banner in the chat.
- Up to **6 people** per call. Each tile shows the person's name, whether their mic is muted, and whether their camera is on.
- Mute, camera on/off and Leave work as you'd expect. You can minimise the call to a floating pill and keep chatting.
- When the last person leaves, the chat gets a summary line ("Group video call · 3 joined · 4:12"), and the call appears in the **Calls** tab history.

How it works: each person connects directly to every other person (a WebRTC "mesh"). The server only keeps track of who's in the call and passes connection setup messages between them. Audio and video never touch the server and are encrypted end to end by WebRTC. For each pair, the person who joined later starts the connection, so both sides never try at once. If a connection drops, it retries once.

Data: `group_calls(id, conversation_id, started_by, media, status, created_at, ended_at)` and `call_participants(call_id, user_id, joined_at, left_at)`. One-to-one calls still use the separate `calls` table. Realtime events: client → server `gcall:start | gcall:join | gcall:leave | gcall:signal`; server → client `gcall:update {call, ring}` and `gcall:signal`. REST: `GET /api/group-calls` (calls running in my groups) and `GET /api/group-calls/history`.

**Reliability fix (found in live testing).** On the real network, a third person could get a slightly late "someone joined" update while their own join was still in progress. Their app then gave up, even though the server had already put them in the call. Now a joining app waits for its own confirmation and ignores those late updates. If the server puts it into a call that started at the same moment, the app adopts that call. If nothing confirms the join within 12 seconds, the app tells the server it has left, so nobody is left as a "ghost" participant.

**Why 6?** In a mesh, every person uploads their video once for each other person. With 6 people, each phone sends 5 streams and receives 5. That works on good Wi-Fi or 4G, but it gets heavy beyond that. More people would need a media server (an SFU), which isn't free.

## Bots

| Bot | Live ID | What it does |
|---|---|---|
| **Star AI** (AI) · @starai | `FS-CQY2A9` | Real AI assistant (Cloudflare Workers AI). Answers in English or Bangla. In groups it replies only when someone writes `@starai`. |
| **Nova Guide** · @novaguide | `FS-Z72WPH` | Sends every new person a welcome message with their ID and tips. Say "help", "id", "group", "call", "status", "privacy", "search" or "bots". |
| **Echo Bot** · @echobot | `FS-7JJNNS` | Repeats what you send. Handy for testing ticks and photos. |
| **Lucky** · @luckybot | `FS-WYXU6H` | Dice, coin flips, jokes and quotes. Type "help". |

Bot IDs on a local copy are different because each copy creates its own. Bots have a coloured badge, show "typing…" before they answer, keep a demo Status, can't be called, and can't be signed in to. Star AI is capped at **30 messages per person per day** and **200 per day for the whole app**, which keeps it inside Cloudflare's free daily AI allowance. When the cap is reached, it says so politely.

## Owner-only admin page

`https://chat.friendstar.workers.dev/admin` (also linked as **Admin** in the side bar or Settings). It only works for accounts whose email is in the Worker variable `OWNER_EMAILS`, which is currently `contact.tajuljayan@gmail.com`. Everyone else gets a "not found" page, and the API returns 404.

The page shows:

- **Totals:** people, online now, sign-ups and sign-ins today, failed sign-ins today, messages, groups and bots.
- **People:** a searchable list with name, username, email, FriendStar ID, join date, last sign-in, device and country/IP, plus each person's sign-in history.
- **Sign-in history:** every register, sign-in and failed attempt, with time, device ("Chrome on Android"), country and IP.

Passwords are stored only as bcrypt hashes, so nobody (including the owner) can see them. The page says so.

Data: `login_events(id, user_id NULL, login_tried, kind register|login|login_failed, at, ip, country, user_agent)`. IP and country come from Cloudflare's `cf-connecting-ip` and `cf-ipcountry` headers. API: `GET /api/admin/summary`, `/api/admin/users`, `/api/admin/logins`.

## Other polish

- New **People** tab. The mobile bar is now Chats · Status · Calls · People · Settings, and the Alerts bell moved into the Chats header. On desktop, the side rail also has Search and Alerts.
- ID chips with one-tap copy, a share button that uses the phone's share sheet, bot badges, and a clearer "New chat" flow that links to People.
- Group call screen: a tile grid that fits 1 to 6 people, mute and camera-off badges, a participant counter (`3/6`) and a minimise button.

## Tests

- `node scripts/phase3-smoke.mjs [baseUrl]`: about 40 API/WebSocket checks (IDs, search by email/ID/name, directory, bots including Star AI, 3-person group call signalling, history, admin 404 for non-owners). `--owner` adds admin checks; use it only locally.
- `python3 scripts/e2e_phase3.py [baseUrl] [shotsDir]`: three real browsers with fake cameras. Checks People/ID/search/share link, the bot chat, and a 3-person group video where everyone receives everyone, plus minimise, leave, the summary line and Calls history.
- Both pass against the live site (run twice after the final deploy), along with the Phase 1/2 suites `cf-smoke.mjs` and `phase2-smoke.mjs`.
