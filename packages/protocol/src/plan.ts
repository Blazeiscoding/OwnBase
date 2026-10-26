import type { User } from "./entities.js";

/**
 * How many members the workspace's plan includes, when its host says (P5).
 * Past that, the owner and admins are offered a bigger plan. Nobody is locked
 * out and people keep joining: it is a notice, never a limit.
 */
export interface MemberNotice {
  /** Members the plan includes. The notice shows once there are more. */
  members: number;
  /** The plan's name, such as "Team", when the host gave one. */
  planName?: string;
  /** Where to choose a bigger plan, when the host gave one. */
  upgradeUrl?: string;
}

/**
 * The members a plan counts: people with an account who can sign in. Apps,
 * guests (who last a day) and deactivated accounts are not counted.
 */
export function planMembers(users: readonly User[]): number {
  return users.filter((user) => !user.isBot && !user.deactivated && user.role !== "guest").length;
}
