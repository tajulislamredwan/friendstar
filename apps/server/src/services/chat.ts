import { hooks } from './hooks.ts';
import type {
  ConversationSummary,
  FileMeta,
  GroupInfo,
  GroupRole,
  Message,
  MessageHit,
  MessageStatus,
  PublicUser,
} from '@friendstar/shared';
import {
  all,
  one,
  run,
  tx,
  type ConversationRow,
  type FileRow,
  type MessageRow,
} from '../db/database.ts';
import { forbidden, HttpError, likeEscape, newId, notFound, nowIso, signFileUrl } from '../lib/util.ts';
import { hub } from '../realtime/hub.ts';
import { areContacts, eitherBlocked, getPrivacyRow, requireUser, toPublicUser } from './users.ts';
import { notifyNewMessage, markConversationNotificationsRead } from './notifications.ts';
import { claimOfflineReply, getOfflineReplySettings } from './offlineReply.ts';

/* ---------- Membership ---------- */

export function isMember(conversationId: string, userId: string): boolean {
  return !!one('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conversationId, userId);
}

/** Non-members get 404 rather than 403 so conversation IDs are never confirmed. */
export function requireMembership(conversationId: string, userId: string): ConversationRow {
  const conv = one<ConversationRow>('SELECT * FROM conversations WHERE id = ?', conversationId);
  if (!conv || !isMember(conversationId, userId)) throw notFound('Conversation not found');
  return conv;
}

export function getConversationRow(conversationId: string): ConversationRow | undefined {
  return one<ConversationRow>('SELECT * FROM conversations WHERE id = ?', conversationId);
}

export function memberIds(conversationId: string): string[] {
  return all<{ user_id: string }>(
    'SELECT user_id FROM conversation_members WHERE conversation_id = ? ORDER BY rowid',
    conversationId,
  ).map((r) => r.user_id);
}

/** Everyone in the conversation except `userId`. */
export function otherMemberIds(conversationId: string, userId: string): string[] {
  return memberIds(conversationId).filter((id) => id !== userId);
}

export const isGroupRow = (conv: Pick<ConversationRow, 'kind'>) => conv.kind === 'group';

/** The other person in a direct chat. */
export function peerOf(conversationId: string, userId: string): string {
  const row = one<{ user_id: string }>(
    'SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?',
    conversationId,
    userId,
  );
  if (!row) throw notFound('Conversation not found');
  return row.user_id;
}

export function canMessage(senderId: string, recipientId: string): boolean {
  if (eitherBlocked(senderId, recipientId)) return false;
  const p = getPrivacyRow(recipientId);
  if (p.who_can_message === 'contacts' && !areContacts(senderId, recipientId)) return false;
  return true;
}

/* ---------- Groups (read side) ---------- */

export interface GroupInfoRow {
  conversation_id: string;
  title: string;
  avatar_file_id: string | null;
  created_by: string;
  created_at: string;
}

export function getGroupRow(conversationId: string): GroupInfoRow | undefined {
  return one<GroupInfoRow>('SELECT * FROM group_info WHERE conversation_id = ?', conversationId);
}

export function isGroupAdmin(conversationId: string, userId: string): boolean {
  return !!one('SELECT 1 FROM group_admins WHERE conversation_id = ? AND user_id = ?', conversationId, userId);
}

function groupInfo(conversationId: string, viewerId: string): GroupInfo {
  const g = getGroupRow(conversationId);
  const admins = new Set(
    all<{ user_id: string }>('SELECT user_id FROM group_admins WHERE conversation_id = ?', conversationId).map((r) => r.user_id),
  );
  const role = (id: string): GroupRole => (admins.has(id) ? 'admin' : 'member');
  const members = memberIds(conversationId)
    .map((id) => ({ ...toPublicUser(requireUser(id), viewerId), role: role(id) }))
    .sort((a, b) => (a.role === b.role ? a.displayName.localeCompare(b.displayName) : a.role === 'admin' ? -1 : 1));
  return {
    title: g?.title ?? 'Group',
    avatarUrl: g?.avatar_file_id ? signFileUrl(g.avatar_file_id, viewerId) : null,
    createdBy: g?.created_by ?? '',
    myRole: role(viewerId),
    memberCount: members.length,
    members,
  };
}

/** Groups are shown through the same `peer` slot as direct chats, with a synthetic identity. */
function groupIdentity(conversationId: string, info: Pick<GroupInfo, 'title' | 'avatarUrl' | 'memberCount'>): PublicUser {
  return {
    id: conversationId,
    username: '',
    friendId: '',
    displayName: info.title,
    bio: `${info.memberCount} members`,
    avatarUrl: info.avatarUrl,
    lastSeenAt: null,
    online: null,
  };
}

/** The `peer` identity shown for a conversation: the other person, or the group. */
export function conversationIdentity(conversationId: string, viewerId: string): PublicUser {
  const conv = getConversationRow(conversationId);
  if (conv && isGroupRow(conv)) return groupIdentity(conversationId, groupInfo(conversationId, viewerId));
  return toPublicUser(requireUser(peerOf(conversationId, viewerId)), viewerId);
}

/* ---------- Serialization ---------- */

export function fileMeta(fileId: string | null, viewerId: string): FileMeta | null {
  if (!fileId) return null;
  const f = one<FileRow>('SELECT * FROM files WHERE id = ?', fileId);
  if (!f) return null;
  return {
    id: f.id,
    name: f.original_name,
    mimeType: f.mime_type,
    size: f.size_bytes,
    url: signFileUrl(f.id, viewerId),
    width: f.width,
    height: f.height,
  };
}

/**
 * Direct chats: read receipts are reciprocal, so both users must have them on for "read" to show.
 * Groups: "delivered" / "read" once every other member has received / read the message.
 */
function computeStatus(m: MessageRow): MessageStatus {
  if (m.kind === 'system') return 'read';
  const conv = getConversationRow(m.conversation_id);
  if (conv && isGroupRow(conv)) return m.read_at ? 'read' : m.delivered_at ? 'delivered' : 'sent';
  if (m.read_at) {
    const recipientId = peerOf(m.conversation_id, m.sender_id);
    const both = getPrivacyRow(m.sender_id).read_receipts && getPrivacyRow(recipientId).read_receipts;
    if (both) return 'read';
  }
  return m.delivered_at || m.read_at ? 'delivered' : 'sent';
}

export function toMessage(m: MessageRow, viewerId: string): Message {
  return {
    id: m.id,
    clientId: m.client_id,
    conversationId: m.conversation_id,
    senderId: m.sender_id,
    kind: m.kind,
    body: m.body,
    file: fileMeta(m.file_id, viewerId),
    createdAt: m.created_at,
    status: computeStatus(m),
  };
}

export function unreadCount(conversationId: string, userId: string): number {
  const row = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
     WHERE m.conversation_id = ? AND m.sender_id != ? AND m.kind != 'system'
       AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)`,
    userId,
    conversationId,
    userId,
  );
  return row?.n ?? 0;
}

export function toSummary(conv: ConversationRow, viewerId: string): ConversationSummary {
  const last = conv.last_message_id ? one<MessageRow>('SELECT * FROM messages WHERE id = ?', conv.last_message_id) : undefined;
  const base = {
    id: conv.id,
    lastMessage: last ? toMessage(last, viewerId) : null,
    unreadCount: unreadCount(conv.id, viewerId),
    updatedAt: conv.updated_at,
  };
  if (isGroupRow(conv)) {
    const group = groupInfo(conv.id, viewerId);
    return { ...base, kind: 'group', peer: groupIdentity(conv.id, group), group, canMessage: isMember(conv.id, viewerId) };
  }
  const peerId = peerOf(conv.id, viewerId);
  return {
    ...base,
    kind: 'direct',
    peer: toPublicUser(requireUser(peerId), viewerId),
    group: null,
    canMessage: canMessage(viewerId, peerId),
  };
}

export function summaryById(conversationId: string, viewerId: string): ConversationSummary {
  return toSummary(requireMembership(conversationId, viewerId), viewerId);
}

/** Push a fresh summary (e.g. new member list or title) to every member. */
export function broadcastSummary(conversationId: string) {
  const conv = getConversationRow(conversationId);
  if (!conv) return;
  for (const m of memberIds(conversationId)) hub.emit(m, 'conversation:updated', { conversation: toSummary(conv, m) });
}

/* ---------- Conversations ---------- */

export function listConversations(userId: string): ConversationSummary[] {
  const rows = all<ConversationRow>(
    `SELECT c.* FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
     WHERE m.user_id = ? AND c.last_message_id IS NOT NULL
     ORDER BY c.updated_at DESC LIMIT 200`,
    userId,
  );
  return rows.map((c) => toSummary(c, userId));
}

export function getOrCreateDirect(userId: string, peerId: string): ConversationSummary {
  if (userId === peerId) throw new HttpError(400, 'VALIDATION', 'You cannot start a chat with yourself');
  requireUser(peerId);
  const key = [userId, peerId].sort().join(':');
  let conv = one<ConversationRow>('SELECT * FROM conversations WHERE direct_key = ?', key);
  if (!conv) {
    const id = newId();
    const now = nowIso();
    tx(() => {
      run('INSERT INTO conversations (id, kind, direct_key, updated_at, created_at) VALUES (?, ?, ?, ?, ?)', id, 'direct', key, now, now);
      run('INSERT INTO conversation_members (conversation_id, user_id, last_read_at) VALUES (?, ?, ?)', id, userId, now);
      run('INSERT INTO conversation_members (conversation_id, user_id, last_read_at) VALUES (?, ?, NULL)', id, peerId);
    });
    conv = one<ConversationRow>('SELECT * FROM conversations WHERE id = ?', id)!;
  }
  return toSummary(conv, userId);
}

/* ---------- Messages ---------- */

export function listMessages(conversationId: string, userId: string, before: string | undefined, limit: number) {
  requireMembership(conversationId, userId);
  const rows = before
    ? all<MessageRow>(
        'SELECT * FROM messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?',
        conversationId,
        before,
        limit + 1,
      )
    : all<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?', conversationId, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  return { messages: page.map((m) => toMessage(m, userId)), hasMore };
}

export interface SendInput {
  clientId: string;
  kind: 'text' | 'image' | 'file';
  body: string;
  fileId?: string | null;
}

export function sendMessage(senderId: string, conversationId: string, input: SendInput): Message {
  const convRow = requireMembership(conversationId, senderId);
  const group = isGroupRow(convRow);
  const recipients = otherMemberIds(conversationId, senderId);

  // Idempotency: a retried send with the same clientId returns the original message.
  const existing = one<MessageRow>('SELECT * FROM messages WHERE sender_id = ? AND client_id = ?', senderId, input.clientId);
  if (existing) return toMessage(existing, senderId);

  if (!group && !canMessage(senderId, recipients[0] ?? '')) throw forbidden('You can’t message this person');

  const id = newId();
  const now = nowIso();
  tx(() => {
    run(
      `INSERT INTO messages (id, conversation_id, sender_id, client_id, kind, body, file_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      conversationId,
      senderId,
      input.clientId,
      input.kind,
      input.body,
      input.fileId ?? null,
      now,
    );
    if (input.fileId) run('UPDATE files SET conversation_id = ? WHERE id = ?', conversationId, input.fileId);
    run('UPDATE conversations SET last_message_id = ?, updated_at = ? WHERE id = ?', id, now, conversationId);
    run('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?', now, conversationId, senderId);
    if (group) for (const r of recipients) run('INSERT INTO group_receipts (message_id, user_id) VALUES (?, ?)', id, r);
  });

  const row = one<MessageRow>('SELECT * FROM messages WHERE id = ?', id)!;
  const conv = one<ConversationRow>('SELECT * FROM conversations WHERE id = ?', conversationId)!;
  // Recipients get the message live (their clients ack "delivered"); sender's other devices sync too.
  for (const r of recipients) hub.emit(r, 'message:new', { message: toMessage(row, r), conversation: toSummary(conv, r) });
  hub.emit(senderId, 'message:new', { message: toMessage(row, senderId), conversation: toSummary(conv, senderId) });
  const groupTitle = group ? getGroupRow(conversationId)?.title : undefined;
  for (const r of recipients) notifyNewMessage(r, senderId, conversationId, row, groupTitle);
  hooks.emitMessage(row, conversationId);
  if (!group && !input.clientId.startsWith('awayreply_') && recipients[0] && !one('SELECT 1 AS x FROM bots WHERE user_id = ?', senderId)) {
    const recipientId = recipients[0];
    if (!hub.isOnline(recipientId)) {
      const away = getOfflineReplySettings(recipientId);
      if (away.enabled && claimOfflineReply(recipientId, senderId, now.slice(0, 10), row.id)) {
        try {
          sendMessage(recipientId, conversationId, {
            clientId: `awayreply_${row.id}`,
            kind: 'text',
            body: away.message,
          });
        } catch {
          /* The original message is already saved; never fail it because of an away reply. */
        }
      }
    }
  }
  return toMessage(row, senderId);
}

/** A centred "Alice added Bob" style message. Counts as activity but never as unread. */
export function addSystemMessage(conversationId: string, actorId: string, body: string) {
  const id = newId();
  const now = nowIso();
  tx(() => {
    run(
      `INSERT INTO messages (id, conversation_id, sender_id, client_id, kind, body, created_at, delivered_at, read_at)
       VALUES (?, ?, ?, ?, 'system', ?, ?, ?, ?)`,
      id,
      conversationId,
      actorId,
      `sys-${id}`,
      body,
      now,
      now,
      now,
    );
    run('UPDATE conversations SET last_message_id = ?, updated_at = ? WHERE id = ?', id, now, conversationId);
  });
  const row = one<MessageRow>('SELECT * FROM messages WHERE id = ?', id)!;
  const conv = getConversationRow(conversationId)!;
  for (const m of memberIds(conversationId)) {
    hub.emit(m, 'message:new', { message: toMessage(row, m), conversation: toSummary(conv, m) });
  }
}

type StatusGroup = Map<string, { sender: string; conv: string; ids: string[] }>;
function groupBySender(map: StatusGroup, m: MessageRow) {
  const key = `${m.conversation_id}|${m.sender_id}`;
  const g = map.get(key) ?? { sender: m.sender_id, conv: m.conversation_id, ids: [] };
  g.ids.push(m.id);
  map.set(key, g);
}

/** Re-check group messages whose receipts changed; promote to delivered / read once everyone has it. */
function settleGroupReceipts(messageIds: string[], at: string) {
  const delivered: StatusGroup = new Map();
  const read: StatusGroup = new Map();
  for (const id of messageIds) {
    const m = one<MessageRow>('SELECT * FROM messages WHERE id = ?', id);
    if (!m) continue;
    const pending = one<{ undelivered: number | null; unread: number | null }>(
      `SELECT SUM(CASE WHEN delivered_at IS NULL THEN 1 ELSE 0 END) AS undelivered,
              SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread
         FROM group_receipts WHERE message_id = ?`,
      id,
    );
    if (!m.read_at && !(pending?.unread ?? 0)) {
      run('UPDATE messages SET read_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id = ?', at, at, id);
      groupBySender(read, m);
    } else if (!m.delivered_at && !(pending?.undelivered ?? 0)) {
      run('UPDATE messages SET delivered_at = ? WHERE id = ?', at, id);
      groupBySender(delivered, m);
    }
  }
  for (const g of delivered.values()) {
    hub.emit(g.sender, 'message:status', { conversationId: g.conv, messageIds: g.ids, status: 'delivered', at });
  }
  for (const g of read.values()) {
    hub.emit(g.sender, 'message:status', { conversationId: g.conv, messageIds: g.ids, status: 'read', at });
  }
}

/** Forget a former member's pending receipts so group ticks can still complete. */
export function dropGroupReceipts(conversationId: string, userId: string) {
  const ids = all<{ message_id: string }>(
    `SELECT r.message_id FROM group_receipts r JOIN messages m ON m.id = r.message_id
      WHERE r.user_id = ? AND m.conversation_id = ?`,
    userId,
    conversationId,
  ).map((r) => r.message_id);
  if (!ids.length) return;
  for (const id of ids) run('DELETE FROM group_receipts WHERE message_id = ? AND user_id = ?', id, userId);
  settleGroupReceipts(ids, nowIso());
}

/** Mark messages delivered to `userId`; notifies the senders. */
export function markDelivered(userId: string, messageIds?: string[]) {
  const now = nowIso();
  const inList = messageIds?.length ? `AND m.id IN (${messageIds.map(() => '?').join(',')})` : '';
  const ids = messageIds ?? [];

  // Group messages: per-member receipts.
  const receipts = all<{ message_id: string }>(
    `SELECT r.message_id FROM group_receipts r JOIN messages m ON m.id = r.message_id
      WHERE r.user_id = ? AND r.delivered_at IS NULL ${inList} LIMIT 1000`,
    userId,
    ...ids,
  ).map((r) => r.message_id);
  if (receipts.length) {
    tx(() => {
      for (const id of receipts) run('UPDATE group_receipts SET delivered_at = ? WHERE message_id = ? AND user_id = ?', now, id, userId);
    });
    settleGroupReceipts(receipts, now);
  }

  // Direct messages.
  const rows = all<MessageRow>(
    `SELECT m.* FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
       JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'direct'
     WHERE m.sender_id != ? AND m.delivered_at IS NULL ${inList} LIMIT 1000`,
    userId,
    userId,
    ...ids,
  );
  if (!rows.length) return;
  tx(() => {
    for (const m of rows) run('UPDATE messages SET delivered_at = ? WHERE id = ?', now, m.id);
  });
  const byConv: StatusGroup = new Map();
  for (const m of rows) groupBySender(byConv, m);
  for (const g of byConv.values()) {
    hub.emit(g.sender, 'message:status', { conversationId: g.conv, messageIds: g.ids, status: 'delivered', at: now });
  }
}

export function markRead(conversationId: string, userId: string): ConversationSummary {
  const convRow = requireMembership(conversationId, userId);
  const now = nowIso();

  if (isGroupRow(convRow)) {
    const ids = all<{ message_id: string }>(
      `SELECT r.message_id FROM group_receipts r JOIN messages m ON m.id = r.message_id
        WHERE r.user_id = ? AND m.conversation_id = ? AND r.read_at IS NULL`,
      userId,
      conversationId,
    ).map((r) => r.message_id);
    tx(() => {
      run('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?', now, conversationId, userId);
      for (const id of ids) {
        run(
          'UPDATE group_receipts SET read_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE message_id = ? AND user_id = ?',
          now,
          now,
          id,
          userId,
        );
      }
    });
    settleGroupReceipts(ids, now);
  } else {
    const peerId = peerOf(conversationId, userId);
    const unreadRows = all<MessageRow>(
      'SELECT * FROM messages WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL',
      conversationId,
      userId,
    );
    tx(() => {
      run('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?', now, conversationId, userId);
      run(
        'UPDATE messages SET read_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL',
        now,
        now,
        conversationId,
        userId,
      );
    });
    if (unreadRows.length) {
      const receipts = getPrivacyRow(userId).read_receipts && getPrivacyRow(peerId).read_receipts;
      hub.emit(peerId, 'message:status', {
        conversationId,
        messageIds: unreadRows.map((m) => m.id),
        status: receipts ? 'read' : 'delivered',
        at: now,
      });
    }
  }

  markConversationNotificationsRead(userId, conversationId);
  const summary = summaryById(conversationId, userId);
  hub.emit(userId, 'conversation:updated', { conversation: summary });
  return summary;
}

/** Typing indicators go to everyone else in the chat (skipping blocked pairs in direct chats). */
export function relayTyping(userId: string, conversationId: string, isTyping: boolean) {
  const conv = getConversationRow(conversationId);
  if (!conv || !isMember(conversationId, userId)) return;
  for (const other of otherMemberIds(conversationId, userId)) {
    if (!isGroupRow(conv) && eitherBlocked(userId, other)) return;
    hub.emit(other, 'typing', { conversationId, userId, isTyping });
  }
}

export function relayRecording(userId: string, conversationId: string, isRecording: boolean) {
  const conv = getConversationRow(conversationId);
  if (!conv || !isMember(conversationId, userId)) return;
  for (const other of otherMemberIds(conversationId, userId)) {
    if (!isGroupRow(conv) && eitherBlocked(userId, other)) return;
    hub.emit(other, 'recording', { conversationId, userId, isRecording });
  }
}

export function searchMessages(userId: string, q: string): MessageHit[] {
  const like = `%${likeEscape(q)}%`;
  const rows = all<MessageRow>(
    `SELECT m.* FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
       LEFT JOIN files f ON f.id = m.file_id
     WHERE m.kind != 'system' AND (m.body LIKE ? ESCAPE '\\' OR f.original_name LIKE ? ESCAPE '\\')
     ORDER BY m.created_at DESC LIMIT 30`,
    userId,
    like,
    like,
  );
  return rows.map((m) => ({
    message: toMessage(m, userId),
    conversationId: m.conversation_id,
    peer: conversationIdentity(m.conversation_id, userId),
  }));
}
