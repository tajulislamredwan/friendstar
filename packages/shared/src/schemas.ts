import { z } from 'zod';

export const LIMITS = {
  messageBody: 4000,
  displayName: 40,
  bio: 140,
  attachmentBytes: 10 * 1024 * 1024,
  statusMediaBytes: 10 * 1024 * 1024,
  avatarBytes: 5 * 1024 * 1024,
} as const;

export const adminAnnouncementDraftSchema = z.object({
  title: z.string().trim().min(1, 'Add a title').max(100),
  body: z.string().trim().min(1, 'Write an update').max(1000),
  fileId: z.string().trim().min(1).max(100).nullable().optional(),
});
export const adminAnnouncementSendSchema = z.object({ previewId: z.string().trim().min(1).max(100) });

export const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export const VIDEO_MIME = ['video/mp4', 'video/webm'] as const;
export const STATUS_MEDIA_MIME = [...IMAGE_MIME, ...VIDEO_MIME] as const;
export const STATUS_MUSIC_MIME = ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/webm'] as const;
export const FILE_MIME = [
  ...IMAGE_MIME,
  'audio/webm',
  'audio/mp4',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,20}$/, 'Use 3–20 letters, numbers or underscores');

export const passwordSchema = z
  .string()
  .min(8, 'At least 8 characters')
  .max(72, 'At most 72 characters')
  .regex(/[A-Za-z]/, 'Include a letter')
  .regex(/[0-9]/, 'Include a number');

export const registerSchema = z.object({
  username: usernameSchema,
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(254),
  password: passwordSchema,
  displayName: z.string().trim().min(1, 'Required').max(LIMITS.displayName),
});

export const loginSchema = z.object({
  login: z.string().trim().min(1, 'Required').max(254),
  password: z.string().min(1, 'Required').max(72),
});

export const passwordResetRequestSchema = z.object({
  identifier: z.string().trim().min(1, 'Required').max(254),
});
export const passwordResetCompleteSchema = z.object({
  token: z.string().min(32).max(256),
  password: passwordSchema,
});
export const adminPasswordResetIssueSchema = z.object({ verified: z.literal(true) });

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(LIMITS.displayName).optional(),
  bio: z.string().trim().max(LIMITS.bio).optional(),
});

export const audienceSchema = z.enum(['everyone', 'contacts', 'nobody']);

export const privacySchema = z
  .object({
    lastSeen: audienceSchema,
    profilePhoto: audienceSchema,
    readReceipts: z.boolean(),
    whoCanMessage: z.enum(['everyone', 'contacts']),
    discoverable: z.boolean(),
  })
  .partial();

export const offlineReplySchema = z.object({
  enabled: z.boolean().optional(),
  message: z.string().trim().min(1, 'Write an away message').max(500).optional(),
}).refine((value) => value.enabled !== undefined || value.message !== undefined, 'Choose a setting to update');

export const createConversationSchema = z.object({ userId: z.string().min(1).max(64) });

export const sendTextSchema = z.object({
  clientId: z.string().min(8).max(64),
  kind: z.literal('text'),
  body: z.string().trim().min(1, 'Message is empty').max(LIMITS.messageBody),
});

export const sendFileFieldsSchema = z.object({
  clientId: z.string().min(8).max(64),
  body: z.string().trim().max(LIMITS.messageBody).optional().default(''),
});

export const listMessagesSchema = z.object({
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export const searchSchema = z.object({ q: z.string().trim().min(1).max(120) });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type PrivacyPatch = z.infer<typeof privacySchema>;

/* ---------- Groups ---------- */
const groupTitle = z.string().trim().min(1, 'Give your group a name').max(60);
const userIdList = z.array(z.string().min(1).max(64)).max(255);
export const createGroupSchema = z.object({ title: groupTitle, memberIds: userIdList.min(1, 'Pick at least one friend') });
export const updateGroupSchema = z.object({ title: groupTitle });
export const addMembersSchema = z.object({ userIds: userIdList.min(1) });
export const setRoleSchema = z.object({ role: z.enum(['admin', 'member']) });

/* ---------- Status ---------- */
export const statusBgSchema = z.enum(['violet', 'sunset', 'ocean', 'forest', 'midnight', 'rose']);
export const statusMusicTrackSchema = z.enum(['sunrise', 'starlight', 'journey', 'moonlight']);
export const statusDurationSchema = z.coerce.number().int().min(1).max(168).default(24);
export const createTextStatusSchema = z.object({
  body: z.string().trim().min(1, 'Write something').max(700),
  bg: statusBgSchema.default('violet'),
  musicTrackId: statusMusicTrackSchema.nullable().optional(),
  expiresInHours: statusDurationSchema,
});
export const statusMediaFieldsSchema = z.object({
  caption: z.string().trim().max(700).default(''),
  musicTrackId: statusMusicTrackSchema.nullable().optional(),
  expiresInHours: statusDurationSchema,
});
export const adminBotUpdateSchema = z.object({ displayName: z.string().trim().min(1).max(LIMITS.displayName) });
export const aiImagePromptSchema = z.object({ prompt: z.string().trim().min(2).max(2048) });
/** @deprecated Use statusMediaFieldsSchema; retained for source compatibility. */
export const imageStatusFieldsSchema = statusMediaFieldsSchema;
