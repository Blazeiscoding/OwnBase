import type { ID, Message, User } from "./entities.js";
import { userMentionsIn } from "./format.js";
import { isAdministrator } from "./permissions.js";

/** Why a message cannot be edited by someone, as the server's refusal names it. */
export type EditRefusal = "not_your_message" | "poll_not_editable" | "call_not_editable";

/**
 * Why `userId` may not edit `message`, or null when they may: only their own,
 * and neither a poll, whose question people voted on as it was, nor a note
 * about a call, which says what happened rather than what its caller wrote.
 */
export function editRefusal(
  userId: ID | null | undefined,
  message: Pick<Message, "userId" | "poll" | "call">,
): EditRefusal | null {
  if (!userId || message.userId !== userId) return "not_your_message";
  if (message.poll) return "poll_not_editable";
  if (message.call) return "call_not_editable";
  return null;
}

/** Their own message, or anyone's for the workspace's owner or an admin. */
export function canDeleteMessage(
  actor: Pick<User, "id" | "role"> | null | undefined,
  message: Pick<Message, "userId">,
): boolean {
  return !!actor && (message.userId === actor.id || isAdministrator(actor.role));
}

/**
 * Whether a message names someone: a mention of them, or a reply that chose
 * to notify the author of what it answers, as Discord marks both.
 */
export function namesUser(message: Pick<Message, "text" | "replyTo">, userId: ID): boolean {
  return (
    userMentionsIn(message.text).has(userId) ||
    (message.replyTo?.ping === true && message.replyTo.userId === userId)
  );
}
