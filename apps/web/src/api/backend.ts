import type {
  AdminLoginEvent,
  AdminSummary,
  AdminUserRow,
  AdminAnnouncementPreview,
  AdminAnnouncementRecord,
  AdminBotRow,
  AdminPasswordResetRequest,
  GroupCallInfo,
  PeoplePage,
  CallInfo,
  ClientToServerEvents,
  GroupRole,
  IceServer,
  StatusBackground,
  StatusMusicTrackId,
  StatusFeedEntry,
  StatusItem,
  StatusViewer,
  AppNotification,
  ConversationSummary,
  LoginInput,
  Me,
  Message,
  MessageHit,
  PrivacySettings,
  OfflineReplySettings,
  PublicUser,
  RegisterInput,
  ServerToClientEvents,
  UpdateProfileInput,
  ErrorCode,
  FileMeta,
} from '@friendstar/shared';

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public fields?: Record<string, string>,
    public status = 0,
  ) {
    super(message);
  }
}

export type RealtimeEvent = keyof ServerToClientEvents;
export type RealtimePayload<E extends RealtimeEvent> = Parameters<ServerToClientEvents[E]>[0];
export type CallEvent =
  | 'call:start'
  | 'call:accept'
  | 'call:decline'
  | 'call:end'
  | 'call:signal'
  | 'gcall:start'
  | 'gcall:join'
  | 'gcall:leave'
  | 'gcall:signal';
export type CallPayload<E extends CallEvent> = Parameters<ClientToServerEvents[E]>[0];

export type ConnectionState = 'connecting' | 'online' | 'offline';

/**
 * Everything the UI needs from a backend. `HttpBackend` talks to the FriendStar server;
 * `DemoBackend` runs fully in the browser for the hosted preview. Same contract, same UI.
 */
export interface Backend {
  readonly mode: 'server' | 'demo';

  restoreSession(): Promise<Me | null>;
  register(input: RegisterInput): Promise<Me>;
  login(input: LoginInput): Promise<Me>;
  logout(): Promise<void>;
  requestPasswordReset(identifier: string): Promise<{ message: string }>;
  completePasswordReset(token: string, password: string): Promise<void>;

  updateProfile(patch: UpdateProfileInput): Promise<Me>;
  uploadAvatar(file: File): Promise<Me>;
  removeAvatar(): Promise<Me>;

  getPrivacy(): Promise<PrivacySettings>;
  updatePrivacy(patch: Partial<PrivacySettings>): Promise<PrivacySettings>;
  getOfflineReplySettings(): Promise<OfflineReplySettings>;
  updateOfflineReplySettings(patch: Partial<OfflineReplySettings>): Promise<OfflineReplySettings>;
  listBlocked(): Promise<PublicUser[]>;
  block(userId: string): Promise<void>;
  unblock(userId: string): Promise<void>;

  getUser(userId: string): Promise<PublicUser>;
  search(q: string): Promise<{ users: PublicUser[]; messages: MessageHit[] }>;

  listConversations(): Promise<ConversationSummary[]>;
  openConversation(userId: string): Promise<ConversationSummary>;
  getConversation(id: string): Promise<ConversationSummary>;
  listMessages(conversationId: string, before?: string): Promise<{ messages: Message[]; hasMore: boolean }>;
  sendText(conversationId: string, clientId: string, body: string): Promise<Message>;
  sendFile(conversationId: string, clientId: string, file: File, caption: string): Promise<Message>;
  generateAIImage(conversationId: string, prompt: string): Promise<{ message: Message; conversation: ConversationSummary }>;
  markRead(conversationId: string): Promise<ConversationSummary>;

  listNotifications(): Promise<{ notifications: AppNotification[]; unread: number }>;
  readNotification(id: string): Promise<number>;
  readAllNotifications(): Promise<void>;

  /* Groups */
  createGroup(title: string, memberIds: string[]): Promise<ConversationSummary>;
  renameGroup(id: string, title: string): Promise<ConversationSummary>;
  setGroupAvatar(id: string, file: File): Promise<ConversationSummary>;
  addGroupMembers(id: string, userIds: string[]): Promise<ConversationSummary>;
  /** Returns null when you removed yourself (left the group). */
  removeGroupMember(id: string, userId: string): Promise<ConversationSummary | null>;
  setGroupRole(id: string, userId: string, role: GroupRole): Promise<ConversationSummary>;

  /* Status stories */
  listStatuses(): Promise<{ mine: StatusItem[]; feed: StatusFeedEntry[] }>;
  postTextStatus(body: string, bg: StatusBackground, musicTrackId?: StatusMusicTrackId | null, expiresInHours?: number, musicFile?: File | null): Promise<StatusItem>;
  postStatusMedia(file: File, caption: string, musicTrackId?: StatusMusicTrackId | null, expiresInHours?: number, musicFile?: File | null): Promise<StatusItem>;
  viewStatus(id: string): Promise<void>;
  statusViewers(id: string): Promise<StatusViewer[]>;
  deleteStatus(id: string): Promise<void>;

  /* Calls */
  listCalls(): Promise<CallInfo[]>;
  iceServers(): Promise<IceServer[]>;
  /** Ongoing group calls in my groups. */
  listGroupCalls(): Promise<GroupCallInfo[]>;
  groupCallHistory(): Promise<GroupCallInfo[]>;
  /* People directory */
  listPeople(cursor?: string): Promise<PeoplePage>;
  userByFriendId(code: string): Promise<PublicUser>;
  /* Admin (owner only) */
  adminSummary(): Promise<AdminSummary>;
  adminUsers(q?: string): Promise<AdminUserRow[]>;
  adminPasswordResetRequests(): Promise<AdminPasswordResetRequest[]>;
  issueAdminPasswordReset(requestId: string, verified: true): Promise<{ token: string; expiresAt: string }>;
  adminBots(): Promise<AdminBotRow[]>;
  renameAdminBot(id: string, displayName: string): Promise<AdminBotRow>;
  deleteAdminBot(id: string): Promise<void>;
  adminLogins(opts?: { userId?: string; before?: string }): Promise<AdminLoginEvent[]>;
  uploadAdminAttachment(file: File): Promise<FileMeta>;
  previewAdminAnnouncement(draft: { title: string; body: string; fileId?: string | null }): Promise<AdminAnnouncementPreview>;
  sendAdminAnnouncement(previewId: string): Promise<AdminAnnouncementRecord>;
  adminAnnouncements(): Promise<AdminAnnouncementRecord[]>;
  emitCall<E extends CallEvent>(event: E, payload: CallPayload<E>): void;

  on<E extends RealtimeEvent>(event: E, handler: (payload: RealtimePayload<E>) => void): () => void;
  onConnection(handler: (state: ConnectionState) => void): () => void;
  emitTyping(conversationId: string, isTyping: boolean): void;
  emitRecording(conversationId: string, isRecording: boolean): void;
  ackDelivered(messageIds: string[]): void;
}

/** Tiny typed event bus shared by both backends. */
export class Emitter {
  private handlers = new Map<string, Set<(p: unknown) => void>>();
  on(event: string, handler: (p: never) => void) {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as (p: unknown) => void);
    this.handlers.set(event, set);
    return () => set.delete(handler as (p: unknown) => void);
  }
  emit(event: string, payload: unknown) {
    this.handlers.get(event)?.forEach((h) => h(payload));
  }
}
