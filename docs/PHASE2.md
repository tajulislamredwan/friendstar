# FriendStar Phase 2: Groups, Status and Calls

Phase 2 turns on the three features that showed "Coming soon" in Phase 1: group chats, 24-hour status updates, and one-to-one voice and video calls. Everything runs on the same code in both versions: the local Node server and the live Cloudflare site at https://chat.friendstar.workers.dev. Group calls are the only feature still marked as future work.

## What people can do now

**Group chats.** Start a group from the people icon on the Chats screen, pick friends, then name it. Groups have a photo, up to 256 members, and admins. Admins can rename the group, change its photo, add or remove people, and make others admin. Anyone can leave. If the last admin leaves, another member becomes admin automatically. Group events ("Ayesha created the group", "Rafi was added") show as small centred system lines. Each group message shows the sender's name. The read tick turns amber only once every member has read the message. Search finds group messages for current members only.

**Status.** The Status tab shows updates from people you chat with. Rings mark updates you haven't seen. You can post a text update on one of six colour backgrounds, or a photo with a caption. Updates disappear after 24 hours. The viewer has tap-to-advance progress bars. On your own updates you can see who viewed them, and you can delete them. Status follows your profile-photo privacy setting and blocks.

**Calls.** The phone and camera buttons in a chat start a voice or video call. The other person gets a full-screen incoming-call card with a ringtone, Accept and Decline. During a call you can mute, turn the camera off, flip the camera (on phones), and shrink the call to a small bar so you can keep chatting. Calls ring for 45 seconds. If nobody answers, or the other person is offline or already on a call, the caller sees why and the other person gets a missed-call alert. The Calls tab lists your history with one-tap call-back.

## How calls work

Calls use WebRTC, so audio and video go directly between the two devices, encrypted (DTLS-SRTP). The server only passes along the short setup messages: offer, answer and network candidates. These go over the same live connection the chat uses, and the server only forwards them between the two people on that call.

The devices find each other using public STUN servers (Cloudflare and Google). This works on most home Wi-Fi and most mobile networks. Some strict networks block direct connections, such as certain mobile carriers, office or university Wi-Fi, and some VPNs. On those, a call can ring and connect but stay silent or fail to start. Fixing that needs a TURN relay server. The code already supports Cloudflare's TURN service: set the Worker secrets `TURN_KEY_ID` and `TURN_KEY_API_TOKEN`, and the app hands out short-lived TURN credentials automatically (`apps/worker/src/turn.ts`). This isn't switched on, because it needs a TURN key in the Cloudflare dashboard and may need billing details.

## Database additions

All changes are new tables (`CREATE TABLE IF NOT EXISTS` in `apps/server/src/db/schema.ts`), so existing accounts and chats were kept when the live site was upgraded.

| Table | Purpose |
|---|---|
| `group_info` | Title, photo, creator for conversations with `kind = 'group'` |
| `group_admins` | Who can manage each group |
| `group_receipts` | Per-member delivered/read times for group messages |
| `statuses` | Text or photo updates with `expires_at` (24 h) |
| `status_views` | Who viewed which update, and when |
| `calls` | Call log: caller, callee, audio/video, status (`ringing`, `ongoing`, `ended`, `missed`, `declined`, `busy`, `unavailable`), answered/ended times |

Messages gained a `system` kind for group events. Expired statuses and their photos are cleaned up automatically.

## API additions

All under `/api` and authenticated with the access token.

| Method and path | What it does |
|---|---|
| `POST /groups` `{ title, memberIds }` | Create a group |
| `PATCH /groups/:id` `{ title }` | Rename (admin) |
| `POST /groups/:id/avatar` (multipart `file`) | Set the group photo (admin) |
| `POST /groups/:id/members` `{ userIds }` | Add people (admin; respects their "who can message me" setting and blocks) |
| `DELETE /groups/:id/members/:userId` | Remove someone (admin), or leave (your own id) |
| `PATCH /groups/:id/members/:userId` `{ role }` | Make admin or member (admin) |
| `GET /statuses` | `{ mine, feed: [{ user, items, allViewed }] }` |
| `POST /statuses` | JSON `{ body, bg }` for text, or multipart `file` + `caption` for a photo |
| `POST /statuses/:id/view` | Mark as seen |
| `GET /statuses/:id/viewers` | Who viewed (owner only) |
| `DELETE /statuses/:id` | Delete your update |
| `GET /calls` | Call history |
| `GET /calls/ice` | STUN (and TURN, when configured) servers for WebRTC |

The existing conversation and message endpoints work for groups unchanged. `ConversationSummary` now has `kind` and `group` (members, roles, `myRole`).

**New realtime events.** Client to server: `call:start`, `call:accept`, `call:decline`, `call:end`, `call:signal`. Server to client: `call:update`, `call:signal`, `status:new`, `conversation:removed` (you were removed from a group). Both servers route client events through one shared dispatcher (`apps/server/src/services/events.ts`), so the Socket.IO and Cloudflare WebSocket versions behave the same.

## Screens

The bottom tab bar (and the desktop side rail) is now **Chats, Status, Calls, Alerts and Settings**. Search moved to the Chats header.

- Chats: the header has Search, New group and New chat. Group rows show a group avatar and "Name: message" previews.
- Group room: sender names on bubbles and system lines. The header opens Group info (photo, rename, members with Admin badges, add/remove/promote, Leave group).
- Status: My status at the top, then recent and viewed updates. There's a text composer with colour swatches and a photo composer with caption. The full-screen viewer has progress bars and a viewers list for your own updates.
- Calls: history with incoming/outgoing/missed icons and call-back buttons. The call overlay covers incoming, ringing, connecting, connected and minimised states.

## Privacy and safety rules

- Only group members can read, send or search a group's messages. Removed members lose access to the history straight away.
- You can only add people who would accept a direct message from you.
- Status is visible only to people you have a one-to-one chat with, following your profile-photo privacy setting. Blocked people never see it, and only you see your viewers.
- Calls are one-to-one only. Blocked or restricted calls look the same as "unavailable", so a block is never revealed. Call setup messages are size-checked and only relayed between the two people on that call.
- The site's security headers allow the camera and microphone for FriendStar itself only (`Permissions-Policy: camera=(self), microphone=(self)`). The browser asks for permission the first time you call.
- Deleting an account also removes its group memberships, messages in groups (including groups it already left), statuses and call history. Groups carry on for the remaining members.

## Tests

- `node scripts/phase2-smoke.mjs [baseUrl]`: about 55 API and WebSocket checks for groups, status and calls with three throwaway accounts, which are deleted afterwards (Cloudflare build).
- `python3 scripts/e2e_phase2.py [baseUrl] [screenshotDir]`: a two-browser test that creates a group, posts and views a status, and makes a real WebRTC video call with a fake camera. It checks that video frames arrive, then tests mute, hang-up, call history, a declined call and dark mode. It passes on the live site, on local `wrangler dev`, and on the local Node server.
