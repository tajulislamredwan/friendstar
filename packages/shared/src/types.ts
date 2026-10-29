export type Audience = 'everyone' | 'contacts' | 'nobody';
export type MessageKind = 'text' | 'image' | 'file' | 'system';
/** 'sending' and 'failed' only exist on the client before the server confirms. */
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  /** null when hidden by the user's privacy settings */
  lastSeenAt: string | null;
  /** null when hidden by the user's privacy settings */
  online: boolean | null;
  isBlocked?: boolean;
  hasBlockedYou?: boolean;
  /** Public FriendStar ID such as FS-7K2QX9; visible to everyone and searchable. */
  friendId: string;
  /** Set for built-in bots (AI assistant and demo bots). */
  bot?: BotKind | null;
}

export type BotKind = 'ai' | 'guide' | 'echo' | 'fun';

export interface Me extends PublicUser {
  email: string;
  createdAt: string;
  /** True for the app owner; unlocks the admin area. */
  isOwner: boolean;
}

export interface FileMeta {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  width: number | null;
  height: number | null;
}

export interface Message {
  id: string;
  clientId: string;
  conversationId: string;
  senderId: string;
  kind: MessageKind;
  body: string;
  file: FileMeta | null;
  createdAt: string;
  status: MessageStatus;
}

export type GroupRole = 'admin' | 'member';
export interface GroupMember extends PublicUser {
  role: GroupRole;
}
export interface GroupInfo {
  title: string;
  avatarUrl: string | null;
  createdBy: string;
  myRole: GroupRole;
  memberCount: number;
  members: GroupMember[];
}
export const GROUP_LIMITS = { maxMembers: 256, titleMax: 60 } as const;

export interface ConversationSummary {
  id: string;
  kind: 'direct' | 'group';
  /**
   * The display identity of the conversation. For direct chats this is the other person;
   * for groups it is a synthetic identity (id = conversation id, displayName = group title).
   */
  peer: PublicUser;
  group: GroupInfo | null;
  lastMessage: Message | null;
  unreadCount: number;
  updatedAt: string;
  canMessage: boolean;
}

export interface PrivacySettings {
  lastSeen: Audience;
  profilePhoto: Audience;
  readReceipts: boolean;
  whoCanMessage: 'everyone' | 'contacts';
  discoverable: boolean;
}

export interface OfflineReplySettings {
  enabled: boolean;
  message: string;
}

export interface AppNotification {
  id: string;
  type: 'new_message' | 'system' | 'announcement' | 'missed_call' | 'group';
  title: string;
  body: string;
  file: FileMeta | null;
  conversationId: string | null;
  actorId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface MessageHit {
  message: Message;
  conversationId: string;
  peer: PublicUser;
}

export interface AuthResponse {
  user: Me;
  accessToken: string;
}

export type ErrorCode =
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL';

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; fields?: Record<string, string> };
}

/* ---------- Status stories ---------- */
export const STATUS_BACKGROUNDS = ['violet', 'sunset', 'ocean', 'forest', 'midnight', 'rose'] as const;
export type StatusBackground = (typeof STATUS_BACKGROUNDS)[number];
export const STATUS_MUSIC_TRACK_IDS = ['sunrise', 'starlight', 'journey', 'moonlight'] as const;
export type StatusMusicTrackId = (typeof STATUS_MUSIC_TRACK_IDS)[number];
export interface StatusItem {
  id: string;
  userId: string;
  kind: 'text' | 'image' | 'video';
  body: string;
  bg: StatusBackground;
  musicTrackId: StatusMusicTrackId | null;
  musicFile: FileMeta | null;
  file: FileMeta | null;
  createdAt: string;
  expiresAt: string;
  viewed: boolean;
  /** Only set for your own statuses. */
  viewCount?: number;
}
export interface StatusFeedEntry {
  user: PublicUser;
  items: StatusItem[];
  allViewed: boolean;
  latestAt: string;
}
export interface StatusViewer {
  user: PublicUser;
  viewedAt: string;
}

/* ---------- Calls ---------- */
export type CallMedia = 'audio' | 'video';
export type CallStatus = 'ringing' | 'ongoing' | 'ended' | 'missed' | 'declined' | 'unavailable' | 'busy';
export interface CallInfo {
  id: string;
  conversationId: string;
  callerId: string;
  calleeId: string;
  media: CallMedia;
  status: CallStatus;
  createdAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  /** The other participant from the viewer's point of view. */
  peer: PublicUser;
}
export type CallSignal =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'candidate'; candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } }
  | { type: 'media'; video: boolean; audio: boolean };
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/* ---------- Real-time events ---------- */
export interface ServerToClientEvents {
  'message:new': (p: { message: Message; conversation: ConversationSummary }) => void;
  'message:status': (p: {
    conversationId: string;
    messageIds: string[];
    status: 'delivered' | 'read';
    at: string;
  }) => void;
  'conversation:updated': (p: { conversation: ConversationSummary }) => void;
  presence: (p: { userId: string; online: boolean | null; lastSeenAt: string | null }) => void;
  typing: (p: { conversationId: string; userId: string; isTyping: boolean }) => void;
  recording: (p: { conversationId: string; userId: string; isRecording: boolean }) => void;
  'notification:new': (p: { notification: AppNotification; unread: number }) => void;
  'conversation:removed': (p: { conversationId: string }) => void;
  'status:new': (p: { userId: string }) => void;
  'call:update': (p: { call: CallInfo }) => void;
  'call:signal': (p: { callId: string; fromUserId: string; data: CallSignal }) => void;
  /** `ring` is true only on the event that starts the call. */
  'gcall:update': (p: { call: GroupCallInfo; ring?: boolean }) => void;
  'gcall:signal': (p: { callId: string; fromUserId: string; data: CallSignal }) => void;
}

export interface ClientToServerEvents {
  typing: (p: { conversationId: string; isTyping: boolean }) => void;
  recording: (p: { conversationId: string; isRecording: boolean }) => void;
  'message:delivered': (p: { messageIds: string[] }) => void;
  'call:start': (p: { callId: string; conversationId: string; media: CallMedia }) => void;
  'call:accept': (p: { callId: string }) => void;
  'call:decline': (p: { callId: string }) => void;
  'call:end': (p: { callId: string }) => void;
  'call:signal': (p: { callId: string; data: CallSignal }) => void;
  'gcall:start': (p: { callId: string; conversationId: string; media: CallMedia }) => void;
  'gcall:join': (p: { callId: string }) => void;
  'gcall:leave': (p: { callId: string }) => void;
  'gcall:signal': (p: { callId: string; toUserId: string; data: CallSignal }) => void;
}

export const COMING_SOON_FEATURES = [
  { key: 'disappearing', title: 'Disappearing messages', description: 'Chats that tidy themselves up.' },
] as const;

/* ---------- Group calls (mesh WebRTC) ---------- */

export const GROUP_CALL_MAX = 6;

export interface GroupCallParticipant {
  user: PublicUser;
  joinedAt: string;
}

export interface GroupCallInfo {
  id: string;
  conversationId: string;
  title: string;
  media: CallMedia;
  status: 'ongoing' | 'ended';
  startedBy: string;
  createdAt: string;
  endedAt: string | null;
  participants: GroupCallParticipant[];
  /** Only on history entries: how many people joined overall, and whether the viewer did. */
  history?: { joined: number; iJoined: boolean };
}

/* ---------- People directory ---------- */

export interface PeoplePage {
  people: PublicUser[];
  nextCursor: string | null;
  total: number;
}

/* ---------- Admin (owner only) ---------- */

export interface AdminUserRow {
  id: string;
  friendId: string;
  username: string;
  displayName: string;
  email: string;
  createdAt: string;
  lastLoginAt: string | null;
  online: boolean;
  bot: BotKind | null;
  botEnabled: boolean;
  loginCount: number;
}

export interface AdminBotRow {
  id: string;
  kind: BotKind;
  username: string;
  displayName: string;
  enabled: boolean;
}

export interface AdminLoginEvent {
  id: string;
  userId: string | null;
  username: string | null;
  displayName: string | null;
  email: string | null;
  kind: 'register' | 'login';
  at: string;
}

export interface AdminPasswordResetRequest {
  id: string;
  /** Submitted username/email; exposed only through the owner-only admin API. */
  identifier: string;
  userId: string | null;
  username: string | null;
  displayName: string | null;
  email: string | null;
  status: 'pending' | 'issued' | 'completed' | 'superseded';
  requestedAt: string;
  reviewedAt: string | null;
  expiresAt: string | null;
}

export interface AdminSummary {
  users: number;
  bots: number;
  onlineNow: number;
  signupsToday: number;
  loginsToday: number;
  failedLoginsToday: number;
  messages: number;
  groups: number;
}

export interface AdminAnnouncementPreview {
  previewId: string;
  title: string;
  body: string;
  file: FileMeta | null;
  recipientCount: number;
  expiresAt: string;
}

export interface AdminAnnouncementRecord {
  id: string;
  title: string;
  body: string;
  file: FileMeta | null;
  recipientCount: number;
  senderEmail: string;
  createdAt: string;
}
