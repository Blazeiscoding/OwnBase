import type { Access } from "./endpoint.js";
import { isRoom, type Channel, type Role, type User } from "./entities.js";

/** Owners and admins run the workspace; everything else about a role is a narrower rule. */
export function isAdministrator(role: Role | undefined | null): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Whether an account of `role` may call a route of `access`, as the server
 * decides it; `role` is undefined when nobody is signed in. A bot's routes
 * and an app's take an app's token, never a person's.
 */
export function roleMayCall(access: Access, role: Role | undefined | null): boolean {
  switch (access) {
    case "public":
      return true;
    case "guest":
      return !!role;
    case "member":
      return !!role && role !== "guest";
    case "admin":
      return isAdministrator(role);
    case "owner":
      return role === "owner";
    case "bot":
    case "app":
      return false;
  }
}

/** Visibility must be checked separately; administrators do not gain private-room access. */
export function channelPermissions(user: User | undefined, channel: Channel, isMember: boolean) {
  const room = isRoom(channel.type);
  const active = !!user && !user.deactivated && !user.isBot;
  const administrator = isAdministrator(user?.role);
  const manageManagers =
    active && room && (administrator || (isMember && channel.creatorId === user.id));
  const manage =
    manageManagers || (active && room && isMember && !!channel.managerIds?.includes(user.id));
  return {
    manage,
    manageManagers,
    invite: active && room && !channel.archived && (isMember || administrator),
  };
}

/** Removing a membership is not a ban: public rooms remain readable and joinable. */
export function canRemoveChannelMember(
  actor: User | undefined,
  target: User | undefined,
  channel: Channel,
  actorIsMember: boolean,
): boolean {
  if (!actor || !target || actor.id === target.id || target.role === "owner") return false;
  if (!channelPermissions(actor, channel, actorIsMember).manage) return false;
  if (target.role === "admin" && actor.role !== "owner") return false;
  if (
    (target.id === channel.creatorId || channel.managerIds?.includes(target.id)) &&
    !channelPermissions(actor, channel, actorIsMember).manageManagers
  )
    return false;
  return true;
}

export function canSetChannelManager(
  actor: User | undefined,
  target: User | undefined,
  channel: Channel,
  actorIsMember: boolean,
  manager = true,
): boolean {
  return (
    channelPermissions(actor, channel, actorIsMember).manageManagers &&
    !!target &&
    !target.isBot &&
    (manager
      ? !target.deactivated && target.role === "member"
      : target.role !== "owner" && (target.role !== "admin" || actor?.role === "owner")) &&
    target.id !== channel.creatorId
  );
}

/**
 * Adding a workspace emoji: any member, unless the workspace keeps that to
 * its owner and admins. Guests add none.
 */
export function mayAddEmoji(role: Role | undefined | null, adminsOnly: boolean): boolean {
  return !!role && role !== "guest" && (!adminsOnly || isAdministrator(role));
}

/** Removing a workspace emoji: whoever added it, or an admin. */
export function mayRemoveEmoji(
  user: Pick<User, "id" | "role"> | undefined | null,
  emoji: { createdBy: string },
): boolean {
  return (
    !!user && user.role !== "guest" && (emoji.createdBy === user.id || isAdministrator(user.role))
  );
}

/** Seeing and revoking an invite code: whoever made it, or an admin. */
export function mayManageInvite(
  user: Pick<User, "id" | "role"> | undefined | null,
  invite: { createdBy: string },
): boolean {
  return !!user && (invite.createdBy === user.id || isAdministrator(user.role));
}

/**
 * Why an admin may not change someone's role or account, or null when they
 * may: not their own, never the owner's, another admin's only as the owner.
 */
export function changePersonRefusal(
  actor: Pick<User, "id" | "role">,
  target: Pick<User, "id" | "role">,
): "self" | "owner" | "admin" | null {
  if (target.id === actor.id) return "self";
  if (target.role === "owner") return "owner";
  if (target.role === "admin" && actor.role !== "owner") return "admin";
  return null;
}
