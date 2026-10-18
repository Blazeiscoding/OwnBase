import { z } from "zod";
import type { AccessPolicy } from "./entities.js";

export const handleSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "lowercase letters, digits, . _ - only");

export const registerBody = z.object({
  handle: handleSchema,
  displayName: z.string().min(1).max(80),
  password: z.string().min(8).max(256),
  inviteCode: z.string().optional(),
  /** Proves the first account is being created by whoever runs the server. */
  claimCode: z.string().max(128).optional(),
});

/** Joining as a guest, where the workspace allows it: a name and nothing else. */
export const guestJoinBody = z.object({
  displayName: z.string().trim().min(1).max(80),
});

/** A guest choosing to keep their identity as an ordinary account. */
export const guestAccountBody = z.object({
  handle: handleSchema,
  password: z.string().min(8).max(256),
});

export const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
});

export const loginBody = z.object({
  handle: handleSchema,
  password: z.string().min(1).max(256),
});

export const updateMeBody = z.object({
  displayName: z.string().min(1).max(80).optional(),
  statusText: z.string().max(120).optional(),
  statusEmoji: z.string().max(32).optional(),
  /**
   * When the status clears itself, epoch ms; null to keep it until changed.
   * A status set without one keeps no earlier one's.
   */
  statusExpiresAt: z.number().int().positive().nullable().optional(),
  /** Snooze notifications until this epoch ms; null clears it. */
  dndUntil: z.number().int().nullable().optional(),
});

export const channelPrefsBody = z.object({
  notifyLevel: z.enum(["all", "mentions", "nothing"]).optional(),
  muted: z.boolean().optional(),
  /** A server before schema v40 drops this unread; see `ReadySnapshot.stars`. */
  starred: z.boolean().optional(),
});

export const savedMessagesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  // Save time plus message ID makes equal-timestamp saves deterministic.
  cursor: z
    .string()
    .regex(/^\d{1,15}:[0-9A-HJKMNP-TV-Z]{26}$/)
    .optional(),
});

export const pinnedMessagesQuery = savedMessagesQuery;
export const followedThreadsQuery = savedMessagesQuery.extend({
  unreadOnly: z.enum(["true", "false"]).default("false"),
});
export const threadFollowBody = z.object({ following: z.boolean() });
export const threadReadBody = z.object({ seq: z.number().int().nonnegative() });
/**
 * The message to leave unread. Everything from it onwards becomes unread, so
 * seq 0 has no meaning here — there is nothing before it to stay read.
 */
export const markUnreadBody = z.object({ seq: z.number().int().positive() });

export const createChannelBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("public"),
    name: z.string().trim().min(1).max(80),
    topic: z.string().max(250).optional(),
    description: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal("private"),
    name: z.string().trim().min(1).max(80),
    topic: z.string().max(250).optional(),
    description: z.string().max(500).optional(),
    memberIds: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("dm"),
    memberIds: z.array(z.string()).length(1),
  }),
  z.object({
    type: z.literal("group_dm"),
    memberIds: z.array(z.string()).min(2).max(8),
  }),
]);

export const updateChannelBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  topic: z.string().max(250).optional(),
  description: z.string().max(500).optional(),
  archived: z.boolean().optional(),
});

export const channelManagerBody = z.object({ manager: z.boolean() });

export const sendMessageBody = z
  .object({
    text: z.string().max(12000),
    threadRootId: z.string().optional(),
    nonce: z.string().max(64).optional(),
    /** Ids from POST /api/channels/:id/files, attached to this message. */
    fileIds: z.array(z.string()).max(10).optional(),
    /** For a reply: show it in the channel's own timeline as well. */
    alsoSendToChannel: z.boolean().optional(),
    /** The message this one answers in place, from the same conversation. */
    replyToId: z.string().max(64).optional(),
    /** Whether that message's author is notified, as Discord does by default. */
    replyPing: z.boolean().optional(),
  })
  // A message needs words, attachments, or both.
  .refine((b) => b.text.trim().length > 0 || (b.fileIds?.length ?? 0) > 0, {
    message: "message must have text or files",
  });

export const scheduleMessageBody = z
  .object({
    text: z.string().max(12000),
    /** Stable identity for retrying this exact scheduling request. */
    nonce: z.string().min(1).max(64).optional(),
    /** Epoch ms; must be in the future. */
    sendAt: z.number().int().positive(),
    threadRootId: z.string().optional(),
    /** A reply that is also to be shown in the channel. Ignored without a thread. */
    alsoSendToChannel: z.boolean().optional(),
    fileIds: z.array(z.string()).max(10).optional(),
  })
  .refine((b) => b.text.trim().length > 0 || (b.fileIds?.length ?? 0) > 0, {
    message: "message must have text or files",
  });

/** Moves a held or failed message back into the queue. A past time sends it now. */
export const rescheduleBody = z.object({
  sendAt: z.number().int().positive(),
});

export const editScheduledBody = z.object({
  text: z.string().max(12000),
  /** The text the author started editing; prevents overwriting another edit. */
  expectedText: z.string().max(12000),
});

export const createAppBody = z.object({
  name: z.string().min(1).max(60),
});

export const createWebhookBody = z.object({
  channelId: z.string(),
});

/**
 * An address the server itself will call. Only http(s), and never with inline
 * credentials — those would be handed to whatever the host resolves to.
 */
export const integrationUrl = z
  .string()
  .url()
  .max(500)
  .refine((u) => {
    try {
      const parsed = new URL(u);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        !parsed.username &&
        !parsed.password
      );
    } catch {
      return false;
    }
  }, "must be an http(s) URL without embedded credentials");

export const createCommandBody = z.object({
  /** With or without the leading slash; the server stores it without. */
  command: z
    .string()
    .min(1)
    .max(32)
    .transform((c) => c.replace(/^\//, "").toLowerCase())
    .refine((c) => /^[a-z0-9][a-z0-9_-]*$/.test(c), "letters, digits, _ and - only"),
  url: integrationUrl,
  description: z.string().max(160).optional(),
  usageHint: z.string().max(80).optional(),
});

export const createSubscriptionBody = z.object({
  url: integrationUrl,
  /** Native event type names; omit or leave empty for everything. */
  eventTypes: z.array(z.string().max(40)).max(20).optional(),
});

/** Empty clears it, which leaves the app's buttons inert. */
export const interactivityBody = z.object({
  url: z.union([integrationUrl, z.literal("")]),
});

/** Which button on a message was pressed. */
export const messageActionBody = z.object({
  actionId: z.string().min(1).max(255),
});

/**
 * What someone typed into a modal: block id -> action id -> value. Bounded
 * because it is echoed to the app, and an app should not be handed a megabyte
 * because a field had no maxlength.
 */
export const viewSubmitBody = z.object({
  values: z.record(z.string().max(255), z.record(z.string().max(255), z.string().max(3000))),
});

/** What an admin is changing about someone. Both are optional; at least one is required. */
export const adminUserBody = z
  .object({
    role: z.enum(["member", "admin"]).optional(),
    deactivated: z.boolean().optional(),
    /** Whether a member may create invite codes. Owners and admins always can. */
    canInvite: z.boolean().optional(),
  })
  .refine((b) => b.role !== undefined || b.deactivated !== undefined || b.canInvite !== undefined, {
    message: "nothing to change",
  });

export const runCommandBody = z.object({
  /** The whole line the user typed, leading slash included. */
  text: z.string().min(1).max(4000),
  threadRootId: z.string().optional(),
});

export const editMessageBody = z.object({
  text: z.string().min(1).max(12000),
  /**
   * The words the author is replacing, as their client last had them. A
   * message changed since is refused rather than overwritten. Left out, an
   * edit replaces whatever is there, as before this existed.
   */
  expectedText: z.string().max(12000).optional(),
});

export const markReadBody = z.object({
  seq: z.number().int().nonnegative(),
});

/** The longest a workspace's name may be, once trimmed. */
export const WORKSPACE_NAME_MAX = 80;

/**
 * A workspace's name: 1 to 80 characters once trimmed, and no control
 * characters anywhere in it. Its host and its admins are held to this one rule.
 */
export const workspaceNameSchema = z
  .string()
  .refine((value) => !/\p{Cc}/u.test(value), "no control characters")
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(WORKSPACE_NAME_MAX));

/** An owner or admin renaming the workspace. */
export const workspaceNameBody = z.object({ name: workspaceNameSchema });

/** An owner or admin changing who may join. */
export const accessPolicyBody = z.object({
  accessPolicy: z.enum([
    "invite_only",
    "account_required",
    "guest_allowed",
  ] as const satisfies readonly AccessPolicy[]),
});

/** A page of the administrative record. */
export const auditQuery = z.object({
  before: z.string().max(40).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export const createInviteBody = z.object({
  expiresInHours: z
    .number()
    .int()
    .positive()
    .max(24 * 365)
    .optional(),
  maxUses: z.number().int().positive().max(1000).optional(),
});

export const messageHistoryQuery = z.object({
  /** Return messages with id < before (exclusive), newest first. */
  before: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  threadRootId: z.string().optional(),
});

export const searchQuery = z.object({
  q: z.string().max(200).default(""),
  limit: z.coerce.number().int().positive().max(100).default(30),
  cursor: z.string().min(1).max(100).optional(),
  channelId: z.string().min(1).max(100).optional(),
  /**
   * The reader's IANA time zone, whose calendar days `before:` and `after:`
   * name. Without it the server's own zone is used, as older clients expect.
   */
  tz: z.string().min(1).max(64).optional(),
});

export const activityQuery = z.object({
  mode: z.enum(["unread", "mentions", "threads"]).default("unread"),
  cursor: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().positive().max(100).default(30),
});

export const threadHistoryQuery = z
  .object({
    before: z.string().min(1).optional(),
    after: z.string().min(1).optional(),
    around: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
  })
  .refine(
    (query) => [query.before, query.after, query.around].filter(Boolean).length <= 1,
    "Choose one history cursor",
  );

export type RegisterBody = z.infer<typeof registerBody>;
export type LoginBody = z.infer<typeof loginBody>;
export type GuestJoinBody = z.infer<typeof guestJoinBody>;
export type GuestAccountBody = z.infer<typeof guestAccountBody>;
export type UpdateMeBody = z.infer<typeof updateMeBody>;
export type CreateChannelBody = z.infer<typeof createChannelBody>;
export type UpdateChannelBody = z.infer<typeof updateChannelBody>;
export type SendMessageBody = z.infer<typeof sendMessageBody>;
export type EditMessageBody = z.infer<typeof editMessageBody>;
export type MarkReadBody = z.infer<typeof markReadBody>;
export type CreateInviteBody = z.infer<typeof createInviteBody>;
export type ChannelPrefsBody = z.infer<typeof channelPrefsBody>;
export type ScheduleMessageBody = z.infer<typeof scheduleMessageBody>;
export type RescheduleBody = z.infer<typeof rescheduleBody>;
export type EditScheduledBody = z.infer<typeof editScheduledBody>;
export type ChangePasswordBody = z.infer<typeof changePasswordBody>;
export type CreateAppBody = z.infer<typeof createAppBody>;
export type CreateWebhookBody = z.infer<typeof createWebhookBody>;
export type CreateCommandBody = z.infer<typeof createCommandBody>;
export type CreateSubscriptionBody = z.infer<typeof createSubscriptionBody>;
export type InteractivityBody = z.infer<typeof interactivityBody>;
export type MessageActionBody = z.infer<typeof messageActionBody>;
export type ViewSubmitBody = z.infer<typeof viewSubmitBody>;
export type AdminUserBody = z.infer<typeof adminUserBody>;
export type RunCommandBody = z.infer<typeof runCommandBody>;
