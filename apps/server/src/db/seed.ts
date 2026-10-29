/* Seeds demo accounts and a few conversations. Run: pnpm seed  (wipes the local database first) */
import fs from 'node:fs';
import { config } from '../config.ts';

for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.dbFile + suffix, { force: true });

const { registerUser } = await import('../services/auth.ts');
const { getOrCreateDirect } = await import('../services/chat.ts');
const { run, all } = await import('./database.ts');
const { newId } = await import('../lib/util.ts');
const { updatePrivacy } = await import('../services/users.ts');

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
if (!DEMO_PASSWORD) throw new Error('Set DEMO_PASSWORD in your local environment before seeding.');

const people = [
  { username: 'alice', displayName: 'Alice Rahman', bio: 'Coffee, code and constellations ☕✨' },
  { username: 'bob', displayName: 'Bob Chowdhury', bio: 'Weekend cyclist. Weekday debugger.' },
  { username: 'carol', displayName: 'Carol Das', bio: 'Designer who loves rounded corners.' },
  { username: 'dan', displayName: 'Dan Hossain', bio: 'Only takes messages from friends.' },
];

const users: Record<string, string> = {};
for (const p of people) {
  const u = await registerUser({ ...p, email: `${p.username}@friendstar.dev`, password: DEMO_PASSWORD });
  run('UPDATE users SET bio = ? WHERE id = ?', p.bio, u.id);
  users[p.username] = u.id;
}
updatePrivacy(users.dan, { whoCanMessage: 'contacts', lastSeen: 'nobody' });

function seedChat(a: string, b: string, lines: [string, string][], minutesAgo: number) {
  const conv = getOrCreateDirect(users[a], users[b]);
  let t = Date.now() - minutesAgo * 60_000;
  const rows = lines.map(([who, body]) => {
    t += 45_000;
    return { id: newId(), who, body, at: new Date(t).toISOString() };
  });
  // `a` has read everything. `b` has read everything up to their own last reply;
  // anything `a` sent after that is still unread for `b`.
  const bLastIdx = rows.map((r) => r.who).lastIndexOf(b);
  const bReadAt = bLastIdx >= 0 ? rows[bLastIdx].at : null;
  rows.forEach((r, i) => {
    const readAt = r.who === b ? r.at : i < bLastIdx ? rows[bLastIdx].at : null;
    run(
      `INSERT INTO messages (id, conversation_id, sender_id, client_id, kind, body, created_at, delivered_at, read_at)
       VALUES (?, ?, ?, ?, 'text', ?, ?, ?, ?)`,
      r.id,
      conv.id,
      users[r.who],
      newId(),
      r.body,
      r.at,
      r.at,
      readAt,
    );
  });
  const last = rows[rows.length - 1];
  run('UPDATE conversations SET last_message_id = ?, updated_at = ? WHERE id = ?', last.id, last.at, conv.id);
  run('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?', last.at, conv.id, users[a]);
  run('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?', bReadAt, conv.id, users[b]);
}

seedChat(
  'bob',
  'alice',
  [
    ['alice', 'Hey Bob! Are we still on for the ride on Friday? 🚴'],
    ['bob', 'Absolutely. 7am at the lake?'],
    ['alice', 'Perfect. I’ll bring the snacks.'],
    ['bob', 'Deal. Also — did you see the new FriendStar dark mode? 🌙'],
    ['bob', 'It looks so good.'],
  ],
  90,
);
seedChat(
  'carol',
  'alice',
  [
    ['alice', 'Carol, can you send me the logo files?'],
    ['carol', 'Sure! Exporting them now.'],
    ['carol', 'Sent over email too, just in case.'],
  ],
  30,
);
seedChat('dan', 'bob', [['dan', 'Bob, lunch tomorrow?'], ['bob', 'Yes! 1pm works.']], 300);

console.log('Seeded local demo accounts.');
for (const p of all<{ username: string; email: string }>('SELECT username, email FROM users ORDER BY username')) {
  console.log(`  • ${p.username}  <${p.email}>`);
}
