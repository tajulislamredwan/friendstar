import type {
  PublicUser,
  AdminLoginEvent,
  AdminAnnouncementPreview,
  AdminAnnouncementRecord,
  AdminSummary,
  AdminUserRow,
  AdminBotRow,
  AdminPasswordResetRequest,
  GroupCallInfo,
  PeoplePage,
  ApiErrorBody,
  AuthResponse,
  CallInfo,
  ConversationSummary,
  GroupRole,
  IceServer,
  Message,
  StatusBackground,
  StatusFeedEntry,
  StatusItem,
  StatusMusicTrackId,
  StatusViewer,
  Me,
  PrivacySettings,
  OfflineReplySettings,
  FileMeta,
} from '@friendstar/shared';
import { ApiError, Emitter, type Backend, type CallEvent, type CallPayload, type ConnectionState } from './backend.ts';
import { createTransport, type RealtimeTransport } from './realtime.ts';


const SIGNED_IN_HINT = 'fs_signed_in';

export class HttpBackend implements Backend {
  readonly mode = 'server' as const;
  /** Access token lives only in memory; the refresh token is an httpOnly cookie. */
  private accessToken: string | null = null;
  private refreshing: Promise<boolean> | null = null;
  private bus = new Emitter();
  private conn = new Emitter();
  private rt: RealtimeTransport = createTransport({
    onEvent: (ev, payload) => this.bus.emit(ev, payload as never),
    onState: (state: ConnectionState) => this.conn.emit('state', state),
    onUnauthorized: async () => ((await this.refresh()) ? this.accessToken : null),
  });

  /* ---------- transport ---------- */
  private async request<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
    const isForm = body instanceof FormData;
    const res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body && !isForm ? { 'content-type': 'application/json' } : {}),
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: isForm ? body : body ? JSON.stringify(body) : undefined,
    }).catch(() => {
      throw new ApiError('INTERNAL', 'Can’t reach FriendStar. Check your connection.');
    });

    if (res.status === 401 && retry && !path.startsWith('/auth/')) {
      if (await this.refresh()) return this.request<T>(method, path, body, false);
    }
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as T & Partial<ApiErrorBody>;
    if (!res.ok) {
      const e = data.error;
      throw new ApiError(e?.code ?? 'INTERNAL', e?.message ?? `Request failed (${res.status})`, e?.fields, res.status);
    }
    return data;
  }

  /** Single-flight refresh so parallel 401s trigger one rotation. */
  private refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      try {
        const data = await this.request<AuthResponse>('POST', '/auth/refresh', undefined, false);
        this.setToken(data.accessToken);
        return true;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 0 || error.status >= 500)) throw error;
        this.setToken(null);
        return false;
      } finally {
        setTimeout(() => (this.refreshing = null), 0);
      }
    })();
    return this.refreshing;
  }

  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private setToken(token: string | null) {
    this.accessToken = token;
    // Non-secret hint so guests don't fire a refresh probe (and a 401) on every page load.
    if (token) localStorage.setItem(SIGNED_IN_HINT, '1');
    else localStorage.removeItem(SIGNED_IN_HINT);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (token) {
      // Refresh a minute before the 15-minute access token expires.
      this.refreshTimer = setTimeout(() => void this.refresh(), 14 * 60 * 1000);
      this.rt.connect(token);
    } else {
      this.rt.disconnect();
    }
  }

  /* ---------- auth ---------- */
  async restoreSession(): Promise<Me | null> {
    if (!localStorage.getItem(SIGNED_IN_HINT)) return null;
    if (!(await this.refresh())) return null;
    return (await this.request<{ user: Me }>('GET', '/auth/me')).user;
  }
  async register(input: Parameters<Backend['register']>[0]) {
    const data = await this.request<AuthResponse>('POST', '/auth/register', input);
    this.setToken(data.accessToken);
    return data.user;
  }
  async login(input: Parameters<Backend['login']>[0]) {
    const data = await this.request<AuthResponse>('POST', '/auth/login', input);
    this.setToken(data.accessToken);
    return data.user;
  }
  async logout() {
    await this.request('POST', '/auth/logout').catch(() => undefined);
    this.setToken(null);
  }
  requestPasswordReset(identifier: string) {
    return this.request<{ message: string }>('POST', '/auth/password-reset/request', { identifier });
  }
  async completePasswordReset(token: string, password: string) {
    await this.request<{ message: string }>('POST', '/auth/password-reset/complete', { token, password });
  }

  /* ---------- profile & privacy ---------- */
  async updateProfile(patch: Parameters<Backend['updateProfile']>[0]) {
    return (await this.request<{ user: Me }>('PATCH', '/me', patch)).user;
  }
  async uploadAvatar(file: File) {
    const fd = new FormData();
    fd.append('file', file);
    return (await this.request<{ user: Me }>('POST', '/me/avatar', fd)).user;
  }
  async removeAvatar() {
    return (await this.request<{ user: Me }>('DELETE', '/me/avatar')).user;
  }
  async getPrivacy() {
    return (await this.request<{ privacy: PrivacySettings }>('GET', '/me/privacy')).privacy;
  }
  async updatePrivacy(patch: Partial<PrivacySettings>) {
    return (await this.request<{ privacy: PrivacySettings }>('PATCH', '/me/privacy', patch)).privacy;
  }
  async getOfflineReplySettings() {
    return (await this.request<{ settings: OfflineReplySettings }>('GET', '/me/offline-reply')).settings;
  }
  async updateOfflineReplySettings(patch: Partial<OfflineReplySettings>) {
    return (await this.request<{ settings: OfflineReplySettings }>('PATCH', '/me/offline-reply', patch)).settings;
  }
  async listBlocked() {
    return (await this.request<{ users: Me[] }>('GET', '/me/blocks')).users;
  }
  async block(userId: string) {
    await this.request('POST', `/me/blocks/${encodeURIComponent(userId)}`);
  }
  async unblock(userId: string) {
    await this.request('DELETE', `/me/blocks/${encodeURIComponent(userId)}`);
  }

  /* ---------- users & search ---------- */
  async getUser(userId: string) {
    return (await this.request<{ user: Me }>('GET', `/users/${encodeURIComponent(userId)}`)).user;
  }
  search(q: string) {
    return this.request<Awaited<ReturnType<Backend['search']>>>('GET', `/search?q=${encodeURIComponent(q)}`);
  }

  /* ---------- conversations ---------- */
  async listConversations() {
    return (await this.request<{ conversations: ConversationSummary[] }>('GET', '/conversations')).conversations;
  }
  async openConversation(userId: string) {
    return (await this.request<{ conversation: ConversationSummary }>('POST', '/conversations', { userId })).conversation;
  }
  async getConversation(id: string) {
    return (await this.request<{ conversation: ConversationSummary }>('GET', `/conversations/${encodeURIComponent(id)}`))
      .conversation;
  }
  listMessages(conversationId: string, before?: string) {
    const qs = before ? `?before=${encodeURIComponent(before)}` : '';
    return this.request<Awaited<ReturnType<Backend['listMessages']>>>(
      'GET',
      `/conversations/${encodeURIComponent(conversationId)}/messages${qs}`,
    );
  }
  async sendText(conversationId: string, clientId: string, body: string) {
    const r = await this.request<{ message: Awaited<ReturnType<Backend['sendText']>> }>(
      'POST',
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      { clientId, kind: 'text', body },
    );
    return r.message;
  }
  async sendFile(conversationId: string, clientId: string, file: File, caption: string) {
    const fd = new FormData();
    fd.append('clientId', clientId);
    fd.append('body', caption);
    fd.append('file', file);
    const r = await this.request<{ message: Awaited<ReturnType<Backend['sendFile']>> }>(
      'POST',
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      fd,
    );
    return r.message;
  }
  async generateAIImage(conversationId: string, prompt: string) {
    return this.request<{ message: Message; conversation: ConversationSummary }>(
      'POST',
      `/conversations/${encodeURIComponent(conversationId)}/ai-image`,
      { prompt },
    );
  }
  async markRead(conversationId: string) {
    return (
      await this.request<{ conversation: ConversationSummary }>('POST', `/conversations/${encodeURIComponent(conversationId)}/read`)
    ).conversation;
  }

  /* ---------- notifications ---------- */
  listNotifications() {
    return this.request<Awaited<ReturnType<Backend['listNotifications']>>>('GET', '/notifications');
  }
  async readNotification(id: string) {
    return (await this.request<{ unread: number }>('POST', `/notifications/${encodeURIComponent(id)}/read`)).unread;
  }
  async readAllNotifications() {
    await this.request('POST', '/notifications/read-all');
  }

  /* ---------- groups ---------- */
  private async conv(method: string, path: string, body?: unknown) {
    return (await this.request<{ conversation: ConversationSummary }>(method, path, body)).conversation;
  }
  createGroup(title: string, memberIds: string[]) {
    return this.conv('POST', '/groups', { title, memberIds });
  }
  renameGroup(id: string, title: string) {
    return this.conv('PATCH', `/groups/${encodeURIComponent(id)}`, { title });
  }
  setGroupAvatar(id: string, file: File) {
    const fd = new FormData();
    fd.append('file', file);
    return this.conv('POST', `/groups/${encodeURIComponent(id)}/avatar`, fd);
  }
  addGroupMembers(id: string, userIds: string[]) {
    return this.conv('POST', `/groups/${encodeURIComponent(id)}/members`, { userIds });
  }
  async removeGroupMember(id: string, userId: string) {
    const r = await this.request<{ conversation: ConversationSummary | null }>(
      'DELETE',
      `/groups/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
    );
    return r.conversation ?? null;
  }
  setGroupRole(id: string, userId: string, role: GroupRole) {
    return this.conv('PATCH', `/groups/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, { role });
  }

  /* ---------- status ---------- */
  listStatuses() {
    return this.request<{ mine: StatusItem[]; feed: StatusFeedEntry[] }>('GET', '/statuses');
  }
  async postTextStatus(body: string, bg: StatusBackground, musicTrackId?: StatusMusicTrackId | null, expiresInHours = 24, musicFile?: File | null) {
    if (musicFile) {
      const fd = new FormData();
      fd.append('body', body); fd.append('bg', bg); fd.append('expiresInHours', String(expiresInHours));
      if (musicTrackId) fd.append('musicTrackId', musicTrackId);
      fd.append('musicFile', musicFile);
      return (await this.request<{ status: StatusItem }>('POST', '/statuses', fd)).status;
    }
    return (await this.request<{ status: StatusItem }>('POST', '/statuses', { body, bg, musicTrackId, expiresInHours })).status;
  }
  async postStatusMedia(file: File, caption: string, musicTrackId?: StatusMusicTrackId | null, expiresInHours = 24, musicFile?: File | null) {
    const fd = new FormData();
    fd.append('caption', caption);
    if (musicTrackId) fd.append('musicTrackId', musicTrackId);
    fd.append('expiresInHours', String(expiresInHours));
    fd.append('file', file);
    if (musicFile) fd.append('musicFile', musicFile);
    return (await this.request<{ status: StatusItem }>('POST', '/statuses', fd)).status;
  }
  async viewStatus(id: string) {
    await this.request('POST', `/statuses/${encodeURIComponent(id)}/view`);
  }
  async statusViewers(id: string) {
    return (await this.request<{ viewers: StatusViewer[] }>('GET', `/statuses/${encodeURIComponent(id)}/viewers`)).viewers;
  }
  async deleteStatus(id: string) {
    await this.request('DELETE', `/statuses/${encodeURIComponent(id)}`);
  }

  /* ---------- calls ---------- */
  async listCalls() {
    return (await this.request<{ calls: CallInfo[] }>('GET', '/calls')).calls;
  }
  async groupCallHistory() {
    return (await this.request<{ calls: GroupCallInfo[] }>('GET', '/group-calls/history')).calls;
  }
  async listGroupCalls() {
    return (await this.request<{ calls: GroupCallInfo[] }>('GET', '/group-calls')).calls;
  }
  async listPeople(cursor?: string) {
    return this.request<PeoplePage>('GET', `/people${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
  }
  async userByFriendId(code: string) {
    return (await this.request<{ user: PublicUser }>('GET', `/people/by-id/${encodeURIComponent(code)}`)).user;
  }
  async adminSummary() {
    return this.request<AdminSummary>('GET', '/admin/summary');
  }
  async adminUsers(q = '') {
    return (await this.request<{ users: AdminUserRow[] }>('GET', `/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`)).users;
  }
  async adminPasswordResetRequests() {
    return (await this.request<{ requests: AdminPasswordResetRequest[] }>('GET', '/admin/password-reset-requests')).requests;
  }
  issueAdminPasswordReset(requestId: string, verified: true) {
    return this.request<{ token: string; expiresAt: string }>(
      'POST',
      `/admin/password-reset-requests/${encodeURIComponent(requestId)}/issue`,
      { verified },
    );
  }
  async adminBots() {
    return (await this.request<{ bots: AdminBotRow[] }>('GET', '/admin/bots')).bots;
  }
  async renameAdminBot(id: string, displayName: string) {
    return (await this.request<{ bot: AdminBotRow }>('PATCH', `/admin/bots/${encodeURIComponent(id)}`, { displayName })).bot;
  }
  async deleteAdminBot(id: string) {
    await this.request('DELETE', `/admin/bots/${encodeURIComponent(id)}`);
  }
  async uploadAdminAttachment(file: File) {
    const fd = new FormData(); fd.append('file', file);
    return (await this.request<{ file: FileMeta }>('POST', '/admin/announcements/attachment', fd)).file;
  }
  async adminLogins(opts: { userId?: string; before?: string } = {}) {
    const qs = new URLSearchParams();
    if (opts.userId) qs.set('userId', opts.userId);
    if (opts.before) qs.set('before', opts.before);
    qs.set('limit', '100');
    return (await this.request<{ events: AdminLoginEvent[] }>('GET', `/admin/logins?${qs}`)).events;
  }
  async previewAdminAnnouncement(draft: { title: string; body: string; fileId?: string | null }) {
    return (await this.request<{ preview: AdminAnnouncementPreview }>('POST', '/admin/announcements/preview', draft)).preview;
  }
  async sendAdminAnnouncement(previewId: string) {
    return (await this.request<{ announcement: AdminAnnouncementRecord }>('POST', '/admin/announcements/send', { previewId })).announcement;
  }
  async adminAnnouncements() {
    return (await this.request<{ announcements: AdminAnnouncementRecord[] }>('GET', '/admin/announcements')).announcements;
  }
  async iceServers() {
    return (await this.request<{ iceServers: IceServer[] }>('GET', '/calls/ice')).iceServers;
  }
  emitCall<E extends CallEvent>(event: E, payload: CallPayload<E>) {
    (this.rt.emit as (e: string, p: unknown) => void)(event, payload);
  }

  /* ---------- realtime ---------- */
  on: Backend['on'] = (event, handler) => this.bus.on(event, handler as (p: never) => void);
  onConnection(handler: (s: ConnectionState) => void) {
    return this.conn.on('state', handler as (p: never) => void);
  }
  emitTyping(conversationId: string, isTyping: boolean) {
    this.rt.emit('typing', { conversationId, isTyping });
  }
  emitRecording(conversationId: string, isRecording: boolean) {
    this.rt.emit('recording', { conversationId, isRecording });
  }
  ackDelivered(messageIds: string[]) {
    if (messageIds.length) this.rt.emit('message:delivered', { messageIds });
  }
}
