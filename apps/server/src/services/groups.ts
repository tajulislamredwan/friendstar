import { leaveGroupCallsIn } from './groupCalls.ts';
import { GROUP_LIMITS, type ConversationSummary, type GroupRole } from '@friendstar/shared';
import { all, one, run, tx } from '../db/database.ts';
import { forbidden, HttpError, newId, nowIso } from '../lib/util.ts';
import { hub } from '../realtime/hub.ts';
import {
  addSystemMessage,
  broadcastSummary,
  canMessage,
  dropGroupReceipts,
  getGroupRow,
  isGroupAdmin,
  isGroupRow,
  isMember,
  memberIds,
  requireMembership,
  summaryById,
} from './chat.ts';
import { pushNotification } from './notifications.ts';
import { requireUser } from './users.ts';

const nameOf = (userId: string) => requireUser(userId).display_name;
const listNames = (ids: string[]) => {
  const names = ids.map(nameOf);
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

function requireGroup(conversationId: string, userId: string) {
  const conv = requireMembership(conversationId, userId);
  if (!isGroupRow(conv)) throw new HttpError(400, 'VALIDATION', 'This is not a group');
  return conv;
}

function requireAdmin(conversationId: string, userId: string) {
  requireGroup(conversationId, userId);
  if (!isGroupAdmin(conversationId, userId)) throw forbidden('Only group admins can do that');
}

/** People can only be added by someone they would accept a direct message from (blocks + privacy). */
function vetNewMembers(actorId: string, ids: string[]): string[] {
  const unique = [...new Set(ids)].filter((id) => id !== actorId);
  for (const id of unique) {
    requireUser(id);
    if (!canMessage(actorId, id)) throw forbidden(`${nameOf(id)} can’t be added to groups by you`);
  }
  return unique;
}

export function createGroup(creatorId: string, title: string, memberIdsIn: string[]): ConversationSummary {
  const members = vetNewMembers(creatorId, memberIdsIn);
  if (!members.length) throw new HttpError(400, 'VALIDATION', 'Pick at least one friend');
  if (members.length + 1 > GROUP_LIMITS.maxMembers) throw new HttpError(400, 'VALIDATION', `Groups can have up to ${GROUP_LIMITS.maxMembers} members`);
  const id = newId();
  const now = nowIso();
  tx(() => {
    run('INSERT INTO conversations (id, kind, direct_key, updated_at, created_at) VALUES (?, ?, ?, ?, ?)', id, 'group', `group:${id}`, now, now);
    run('INSERT INTO group_info (conversation_id, title, created_by, created_at) VALUES (?, ?, ?, ?)', id, title, creatorId, now);
    run('INSERT INTO group_admins (conversation_id, user_id) VALUES (?, ?)', id, creatorId);
    run('INSERT INTO conversation_members (conversation_id, user_id, last_read_at) VALUES (?, ?, ?)', id, creatorId, now);
    for (const m of members) run('INSERT INTO conversation_members (conversation_id, user_id, last_read_at) VALUES (?, ?, NULL)', id, m);
  });
  addSystemMessage(id, creatorId, `${nameOf(creatorId)} created the group “${title}”`);
  for (const m of members) {
    pushNotification(m, 'group', title, `${nameOf(creatorId)} added you to the group`, id, creatorId);
  }
  return summaryById(id, creatorId);
}

export function renameGroup(userId: string, conversationId: string, title: string): ConversationSummary {
  requireAdmin(conversationId, userId);
  const old = getGroupRow(conversationId)?.title;
  if (old === title) return summaryById(conversationId, userId);
  run('UPDATE group_info SET title = ? WHERE conversation_id = ?', title, conversationId);
  addSystemMessage(conversationId, userId, `${nameOf(userId)} renamed the group to “${title}”`);
  broadcastSummary(conversationId);
  return summaryById(conversationId, userId);
}

export function addMembers(userId: string, conversationId: string, ids: string[]): ConversationSummary {
  requireAdmin(conversationId, userId);
  const fresh = vetNewMembers(userId, ids).filter((id) => !isMember(conversationId, id));
  if (!fresh.length) return summaryById(conversationId, userId);
  if (memberIds(conversationId).length + fresh.length > GROUP_LIMITS.maxMembers) {
    throw new HttpError(400, 'VALIDATION', `Groups can have up to ${GROUP_LIMITS.maxMembers} members`);
  }
  const now = nowIso();
  tx(() => {
    // New members start "caught up" so they don't inherit an unread backlog.
    for (const m of fresh) run('INSERT INTO conversation_members (conversation_id, user_id, last_read_at) VALUES (?, ?, ?)', conversationId, m, now);
  });
  const title = getGroupRow(conversationId)?.title ?? 'a group';
  addSystemMessage(conversationId, userId, `${nameOf(userId)} added ${listNames(fresh)}`);
  broadcastSummary(conversationId);
  for (const m of fresh) pushNotification(m, 'group', title, `${nameOf(userId)} added you to the group`, conversationId, userId);
  return summaryById(conversationId, userId);
}

/** Remove someone (admins), or leave (anyone removing themselves). */
export function removeMember(userId: string, conversationId: string, targetId: string): ConversationSummary | null {
  const leaving = userId === targetId;
  if (leaving) requireGroup(conversationId, userId);
  else requireAdmin(conversationId, userId);
  if (!isMember(conversationId, targetId)) throw new HttpError(404, 'NOT_FOUND', 'That person isn’t in this group');

  const body = leaving ? `${nameOf(userId)} left` : `${nameOf(userId)} removed ${nameOf(targetId)}`;
  leaveGroupCallsIn(conversationId, targetId);
  tx(() => {
    run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conversationId, targetId);
    run('DELETE FROM group_admins WHERE conversation_id = ? AND user_id = ?', conversationId, targetId);
  });
  dropGroupReceipts(conversationId, targetId);
  hub.emit(targetId, 'conversation:removed', { conversationId });

  const remaining = memberIds(conversationId);
  if (!remaining.length) {
    // Last one out: remove the group entirely (messages and receipts cascade).
    tx(() => {
      run('DELETE FROM notifications WHERE conversation_id = ?', conversationId);
      run('DELETE FROM conversations WHERE id = ?', conversationId);
      run('DELETE FROM files WHERE conversation_id = ?', conversationId);
    });
    return null;
  }
  // A group always keeps at least one admin.
  const admins = all<{ user_id: string }>('SELECT user_id FROM group_admins WHERE conversation_id = ?', conversationId);
  if (!admins.length) run('INSERT INTO group_admins (conversation_id, user_id) VALUES (?, ?)', conversationId, remaining[0]);

  addSystemMessage(conversationId, userId, body);
  broadcastSummary(conversationId);
  return leaving ? null : summaryById(conversationId, userId);
}

export function setMemberRole(userId: string, conversationId: string, targetId: string, role: GroupRole): ConversationSummary {
  requireAdmin(conversationId, userId);
  if (!isMember(conversationId, targetId)) throw new HttpError(404, 'NOT_FOUND', 'That person isn’t in this group');
  if (role === 'admin') {
    run('INSERT OR IGNORE INTO group_admins (conversation_id, user_id) VALUES (?, ?)', conversationId, targetId);
  } else {
    const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM group_admins WHERE conversation_id = ?', conversationId)?.n ?? 0;
    if (count <= 1 && isGroupAdmin(conversationId, targetId)) throw new HttpError(400, 'VALIDATION', 'A group needs at least one admin');
    run('DELETE FROM group_admins WHERE conversation_id = ? AND user_id = ?', conversationId, targetId);
  }
  broadcastSummary(conversationId);
  return summaryById(conversationId, userId);
}

export function setGroupAvatar(userId: string, conversationId: string, fileId: string | null): ConversationSummary {
  requireAdmin(conversationId, userId);
  run('UPDATE group_info SET avatar_file_id = ? WHERE conversation_id = ?', fileId, conversationId);
  if (fileId) addSystemMessage(conversationId, userId, `${nameOf(userId)} changed the group photo`);
  broadcastSummary(conversationId);
  return summaryById(conversationId, userId);
}

/**
 * Account deletion: take the user out of every group without deleting the group for others.
 * Their own messages in groups are removed (messages reference the sender row).
 */
export function purgeUserFromGroups(userId: string) {
  // Current groups plus groups they already left but still have messages in.
  const groupIds = all<{ conversation_id: string }>(
    `SELECT cm.conversation_id FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
      WHERE cm.user_id = ? AND c.kind = 'group'
     UNION
     SELECT m.conversation_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.sender_id = ? AND c.kind = 'group'`,
    userId,
    userId,
  ).map((r) => r.conversation_id);
  for (const id of groupIds) {
    tx(() => {
      run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', id, userId);
      run('DELETE FROM group_admins WHERE conversation_id = ? AND user_id = ?', id, userId);
      run('DELETE FROM notifications WHERE conversation_id = ? AND actor_id = ?', id, userId);
      run('DELETE FROM messages WHERE conversation_id = ? AND sender_id = ?', id, userId);
    });
    dropGroupReceipts(id, userId);
    const remaining = memberIds(id);
    if (!remaining.length) {
      tx(() => {
        run('DELETE FROM notifications WHERE conversation_id = ?', id);
        run('DELETE FROM conversations WHERE id = ?', id);
        run('DELETE FROM files WHERE conversation_id = ?', id);
      });
      continue;
    }
    if (!one('SELECT 1 FROM group_admins WHERE conversation_id = ?', id)) {
      run('INSERT INTO group_admins (conversation_id, user_id) VALUES (?, ?)', id, remaining[0]);
    }
    const last = one<{ id: string; created_at: string }>(
      'SELECT id, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1',
      id,
    );
    run('UPDATE conversations SET last_message_id = ? WHERE id = ?', last?.id ?? null, id);
    if (!last) {
      // Keep the group visible for the others with a fresh system line.
      addSystemMessage(id, remaining[0], 'A member deleted their account');
    } else {
      broadcastSummary(id);
    }
  }
  run('DELETE FROM calls WHERE caller_id = ? OR callee_id = ?', userId, userId);
}
