import { normalizeFriendId } from '@friendstar/shared';
import { adminBots, adminLogins, adminSummary, adminUsers, deleteAdminBot, renameAdminBot, requireOwner } from '../services/admin.ts';
import { createAdminAnnouncementPreview, listAdminAnnouncements, sendAdminAnnouncement } from '../services/adminAnnouncements.ts';
import { adminPasswordResetRequests, issueAdminPasswordReset } from '../services/passwordResets.ts';
import { hasAiImageProvider, refreshBotStatuses } from '../services/bots.ts';
import { listActiveGroupCalls, listGroupCallHistory } from '../services/groupCalls.ts';
import { userIdByFriendId } from '../services/identity.ts';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import {
  aiImagePromptSchema,
  adminPasswordResetIssueSchema,
  adminAnnouncementSendSchema,
  adminBotUpdateSchema,
  addMembersSchema,
  createGroupSchema,
  createTextStatusSchema,
  statusMediaFieldsSchema,
  setRoleSchema,
  updateGroupSchema,
  createConversationSchema,
  listMessagesSchema,
  offlineReplySchema,
  privacySchema,
  searchSchema,
  sendFileFieldsSchema,
  sendTextSchema,
  updateProfileSchema,
} from '@friendstar/shared';
import { config } from '../config.ts';
import { one, run, type FileRow } from '../db/database.ts';
import { HttpError, notFound, verifyFileSignature } from '../lib/util.ts';
import { parse, requireAuth, uid } from '../middleware/http.ts';
import {
  getOrCreateDirect,
  isMember,
  listConversations,
  listMessages,
  markRead,
  searchMessages,
  sendMessage,
  summaryById,
} from '../services/chat.ts';
import { attachmentUpload, avatarUpload, registerUpload, statusMediaUpload } from '../services/files.ts';
import { addMembers, createGroup, removeMember, renameGroup, setGroupAvatar, setMemberRole } from '../services/groups.ts';
import { createStatus, deleteStatus, listStatusViewers, listStatuses, markStatusViewed } from '../services/statuses.ts';
import { DEFAULT_ICE_SERVERS, listCalls } from '../services/calls.ts';
import { listNotifications, markAllNotificationsRead, markNotificationRead } from '../services/notifications.ts';
import { getOfflineReplySettings, updateOfflineReplySettings } from '../services/offlineReply.ts';
import {
  block,
  broadcastPresence,
  getPrivacyRow,
  listBlocked,
  requireUser,
  hasBlocked,
  listPeople,
  searchUsers,
  toMe,
  toPrivacy,
  toPublicUser,
  unblock,
  updatePrivacy,
  updateProfile,
} from '../services/users.ts';
import { fileMeta } from '../services/chat.ts';

export const apiRouter = Router();

/* Files are fetched by <img>/<a> tags, so they use signed URLs instead of the Bearer header. */
apiRouter.get('/files/:id', (req, res) => {
  const { u, exp, sig } = req.query as Record<string, string | undefined>;
  const id = String(req.params.id);
  if (!u || !exp || !sig || !verifyFileSignature(id, u, Number(exp), sig)) throw notFound('File not found');
  const file = one<FileRow>('SELECT * FROM files WHERE id = ?', id);
  if (!file) throw notFound('File not found');
  // Attachments are available only to a conversation member, including the owner.
  if (file.conversation_id && !isMember(file.conversation_id, u)) throw notFound('File not found');
  const fullPath = path.join(config.uploadDir, file.storage_name);
  if (!fs.existsSync(fullPath)) throw notFound('File not found');

  const inline = (file.mime_type.startsWith('image/') || file.mime_type.startsWith('video/')) && req.query.download !== '1';
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
  );
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start: number;
    let end: number;
    if (!match || (!match[1] && !match[2])) {
      res.setHeader('Content-Range', `bytes */${file.size_bytes}`);
      res.status(416).end();
      return;
    }
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) {
        res.setHeader('Content-Range', `bytes */${file.size_bytes}`);
        res.status(416).end();
        return;
      }
      start = Math.max(0, file.size_bytes - suffix);
      end = file.size_bytes - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : file.size_bytes - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= file.size_bytes || end < start) {
      res.setHeader('Content-Range', `bytes */${file.size_bytes}`);
      res.status(416).end();
      return;
    }
    end = Math.min(end, file.size_bytes - 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${file.size_bytes}`);
    res.setHeader('Content-Length', String(end - start + 1));
    fs.createReadStream(fullPath, { start, end }).pipe(res);
    return;
  }
  res.setHeader('Content-Length', String(file.size_bytes));
  fs.createReadStream(fullPath).pipe(res);
});

apiRouter.use(requireAuth);

/* ---------- Me / profile ---------- */
apiRouter.patch('/me', (req, res) => {
  const patch = parse(updateProfileSchema, req.body);
  const user = updateProfile(uid(req), patch);
  res.json({ user: toMe(user) });
});

apiRouter.post('/me/avatar', avatarUpload.single('file'), (req, res) => {
  if (!req.file) throw new HttpError(400, 'VALIDATION', 'Choose an image');
  const { id } = registerUpload(req.file, uid(req));
  run('UPDATE users SET avatar_file_id = ? WHERE id = ?', id, uid(req));
  res.json({ user: toMe(requireUser(uid(req))) });
});

apiRouter.delete('/me/avatar', (req, res) => {
  run('UPDATE users SET avatar_file_id = NULL WHERE id = ?', uid(req));
  res.json({ user: toMe(requireUser(uid(req))) });
});

apiRouter.get('/me/privacy', (req, res) => {
  res.json({ privacy: toPrivacy(getPrivacyRow(uid(req))) });
});
apiRouter.get('/me/offline-reply', (req, res) => {
  res.json({ settings: getOfflineReplySettings(uid(req)) });
});
apiRouter.patch('/me/offline-reply', (req, res) => {
  const patch = parse(offlineReplySchema, req.body);
  res.json({ settings: updateOfflineReplySettings(uid(req), patch) });
});

apiRouter.patch('/me/privacy', (req, res) => {
  const patch = parse(privacySchema, req.body);
  const privacy = updatePrivacy(uid(req), patch);
  broadcastPresence(uid(req)); // peers immediately see last-seen changes
  res.json({ privacy });
});

apiRouter.get('/me/blocks', (req, res) => {
  res.json({ users: listBlocked(uid(req)) });
});
apiRouter.post('/me/blocks/:userId', (req, res) => {
  block(uid(req), String(req.params.userId));
  res.status(204).end();
});
apiRouter.delete('/me/blocks/:userId', (req, res) => {
  unblock(uid(req), String(req.params.userId));
  res.status(204).end();
});

/* ---------- Users & search ---------- */
apiRouter.get('/users/:id', (req, res) => {
  res.json({ user: toPublicUser(requireUser(String(req.params.id)), uid(req)) });
});

apiRouter.get('/search', (req, res) => {
  const { q } = parse(searchSchema, req.query);
  res.json({ users: searchUsers(uid(req), q), messages: searchMessages(uid(req), q) });
});

/* ---------- Conversations & messages ---------- */
apiRouter.get('/conversations', (req, res) => {
  res.json({ conversations: listConversations(uid(req)) });
});

apiRouter.post('/conversations', (req, res) => {
  const { userId } = parse(createConversationSchema, req.body);
  res.json({ conversation: getOrCreateDirect(uid(req), userId) });
});

apiRouter.get('/conversations/:id', (req, res) => {
  res.json({ conversation: summaryById(String(req.params.id), uid(req)) });
});

apiRouter.get('/conversations/:id/messages', (req, res) => {
  const { before, limit } = parse(listMessagesSchema, req.query);
  res.json(listMessages(String(req.params.id), uid(req), before, limit));
});

apiRouter.post('/conversations/:id/messages', attachmentUpload.single('file'), (req, res) => {
  const conversationId = String(req.params.id);
  const me = uid(req);
  if (req.file) {
    let fields;
    try {
      fields = parse(sendFileFieldsSchema, req.body);
    } catch (err) {
      fs.rmSync(path.join(config.uploadDir, req.file.filename), { force: true });
      throw err;
    }
    const { id, isImage } = registerUpload(req.file, me);
    const message = sendMessage(me, conversationId, {
      clientId: fields.clientId,
      kind: isImage ? 'image' : 'file',
      body: fields.body,
      fileId: id,
    });
    res.status(201).json({ message });
    return;
  }
  const input = parse(sendTextSchema, req.body);
  res.status(201).json({ message: sendMessage(me, conversationId, input) });
});

apiRouter.post('/conversations/:id/ai-image', (req, res) => {
  parse(aiImagePromptSchema, req.body);
  if (!hasAiImageProvider()) throw new HttpError(503, 'INTERNAL', 'Image generation is available only on the Cloudflare AI deployment.');
  throw new HttpError(503, 'INTERNAL', 'Image generation is not configured on this server.');
});

apiRouter.post('/conversations/:id/read', (req, res) => {
  res.json({ conversation: markRead(String(req.params.id), uid(req)) });
});

/* ---------- Notifications ---------- */
apiRouter.get('/notifications', (req, res) => {
  res.json(listNotifications(uid(req)));
});
apiRouter.post('/notifications/read-all', (req, res) => {
  markAllNotificationsRead(uid(req));
  res.status(204).end();
});
apiRouter.post('/notifications/:id/read', (req, res) => {
  const unread = markNotificationRead(uid(req), String(req.params.id));
  res.json({ unread });
});

/* ---------- Groups ---------- */
apiRouter.post('/groups', (req, res) => {
  const { title, memberIds } = parse(createGroupSchema, req.body);
  res.status(201).json({ conversation: createGroup(uid(req), title, memberIds) });
});
apiRouter.patch('/groups/:id', (req, res) => {
  const { title } = parse(updateGroupSchema, req.body);
  res.json({ conversation: renameGroup(uid(req), String(req.params.id), title) });
});
apiRouter.post('/groups/:id/avatar', avatarUpload.single('file'), (req, res) => {
  if (!req.file) throw new HttpError(400, 'VALIDATION', 'Choose an image');
  const { id } = registerUpload(req.file, uid(req));
  res.json({ conversation: setGroupAvatar(uid(req), String(req.params.id), id) });
});
apiRouter.post('/groups/:id/members', (req, res) => {
  const { userIds } = parse(addMembersSchema, req.body);
  res.json({ conversation: addMembers(uid(req), String(req.params.id), userIds) });
});
apiRouter.delete('/groups/:id/members/:userId', (req, res) => {
  const conversation = removeMember(uid(req), String(req.params.id), String(req.params.userId));
  res.json({ conversation });
});
apiRouter.patch('/groups/:id/members/:userId', (req, res) => {
  const { role } = parse(setRoleSchema, req.body);
  res.json({ conversation: setMemberRole(uid(req), String(req.params.id), String(req.params.userId), role) });
});

/* ---------- Status stories ---------- */
apiRouter.get('/statuses', (req, res) => {
  refreshBotStatuses();
  res.json(listStatuses(uid(req)));
});
apiRouter.post('/statuses', statusMediaUpload, (req, res) => {
  const me = uid(req);
  const uploaded = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
  const mediaFile = uploaded.file?.[0];
  const musicFile = uploaded.musicFile?.[0];
  if (mediaFile || musicFile) {
    try {
      if (mediaFile) {
        const fields = parse(statusMediaFieldsSchema, req.body);
        const media = registerUpload(mediaFile, me);
        const music = musicFile ? registerUpload(musicFile, me) : null;
        res.status(201).json({ status: createStatus(me, { kind: media.isVideo ? 'video' : 'image', body: fields.caption, fileId: media.id, musicTrackId: fields.musicTrackId, musicFileId: music?.id, expiresInHours: fields.expiresInHours }) });
      } else {
        const fields = parse(createTextStatusSchema, req.body);
        const music = registerUpload(musicFile!, me);
        res.status(201).json({ status: createStatus(me, { kind: 'text', body: fields.body, bg: fields.bg, musicTrackId: fields.musicTrackId, musicFileId: music.id, expiresInHours: fields.expiresInHours }) });
      }
    } catch (err) {
      for (const f of [...(uploaded.file ?? []), ...(uploaded.musicFile ?? [])]) fs.rmSync(path.join(config.uploadDir, f.filename), { force: true });
      throw err;
    }
    return;
  }
  const { body, bg, musicTrackId, expiresInHours } = parse(createTextStatusSchema, req.body);
  res.status(201).json({ status: createStatus(me, { kind: 'text', body, bg, musicTrackId, expiresInHours }) });
});
apiRouter.post('/statuses/:id/view', (req, res) => {
  markStatusViewed(uid(req), String(req.params.id));
  res.status(204).end();
});
apiRouter.get('/statuses/:id/viewers', (req, res) => {
  res.json({ viewers: listStatusViewers(uid(req), String(req.params.id)) });
});
apiRouter.delete('/statuses/:id', (req, res) => {
  deleteStatus(uid(req), String(req.params.id));
  res.status(204).end();
});

/* ---------- Calls ---------- */
apiRouter.get('/group-calls', (req, res) => {
  res.json({ calls: listActiveGroupCalls(uid(req)) });
});
apiRouter.get('/group-calls/history', (req, res) => {
  res.json({ calls: listGroupCallHistory(uid(req)) });
});
/* ---------- People directory & invite links ---------- */
apiRouter.get('/people', (req, res) => {
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.slice(0, 80) : undefined;
  res.json(listPeople(uid(req), cursor));
});
apiRouter.get('/people/by-id/:code', (req, res) => {
  const code = normalizeFriendId(String(req.params.code));
  const id = code ? userIdByFriendId(code) : undefined;
  if (!id || hasBlocked(id, uid(req))) throw notFound('No one has that FriendStar ID');
  res.json({ user: toPublicUser(requireUser(id), uid(req)) });
});
/* ---------- Admin (owner only) ---------- */
apiRouter.get('/admin/summary', (req, res) => {
  requireOwner(uid(req));
  res.setHeader('Cache-Control', 'no-store');
  res.json(adminSummary());
});
apiRouter.get('/admin/users', (req, res) => {
  requireOwner(uid(req));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ users: adminUsers(typeof req.query.q === 'string' ? req.query.q.slice(0, 120) : '') });
});
apiRouter.get('/admin/logins', (req, res) => {
  requireOwner(uid(req));
  res.setHeader('Cache-Control', 'no-store');
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 80) : undefined);
  res.json({ events: adminLogins({ userId: str(req.query.userId), before: str(req.query.before), limit: Number(req.query.limit) || 100 }) });
});
apiRouter.get('/admin/password-reset-requests', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ requests: adminPasswordResetRequests(uid(req)) });
});
apiRouter.post('/admin/password-reset-requests/:id/issue', (req, res) => {
  requireOwner(uid(req));
  const { verified } = parse(adminPasswordResetIssueSchema, req.body);
  const result = issueAdminPasswordReset(uid(req), String(req.params.id), verified);
  res.setHeader('Cache-Control', 'no-store');
  res.json(result);
});
apiRouter.get('/admin/announcements', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ announcements: listAdminAnnouncements(uid(req)) });
});
apiRouter.post('/admin/announcements/preview', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ preview: createAdminAnnouncementPreview(uid(req), req.body) });
});
apiRouter.post('/admin/announcements/send', (req, res) => {
  const { previewId } = parse(adminAnnouncementSendSchema, req.body);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ announcement: sendAdminAnnouncement(uid(req), previewId) });
});
apiRouter.get('/calls', (req, res) => {
  res.json({ calls: listCalls(uid(req)) });
});
apiRouter.get('/calls/ice', (_req, res) => {
  res.json({ iceServers: DEFAULT_ICE_SERVERS });
});
apiRouter.get('/admin/bots', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ bots: adminBots(uid(req)) });
});
apiRouter.patch('/admin/bots/:id', (req, res) => {
  const { displayName } = parse(adminBotUpdateSchema, req.body);
  res.json({ bot: renameAdminBot(uid(req), String(req.params.id), displayName) });
});
apiRouter.delete('/admin/bots/:id', (req, res) => {
  res.json(deleteAdminBot(uid(req), String(req.params.id)));
});
apiRouter.post('/admin/announcements/attachment', (req, _res, next) => { requireOwner(uid(req)); next(); }, attachmentUpload.single('file'), (req, res) => {
  if (!req.file) throw new HttpError(400, 'VALIDATION', 'Choose a file');
  const { id } = registerUpload(req.file, uid(req));
  res.json({ file: fileMeta(id, uid(req)) });
});
