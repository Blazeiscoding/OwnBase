import type { ID, Invite } from "@ownbase/protocol";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** How long a new invite link works, as the invite dialog offers it. Null is for good. */
export const INVITE_EXPIRY_CHOICES: { label: string; hours: number | null }[] = [
  { label: "1 hour", hours: 1 },
  { label: "1 day", hours: 24 },
  { label: "7 days", hours: 24 * 7 },
  { label: "30 days", hours: 24 * 30 },
  { label: "Never", hours: null },
];

/** How many people a new invite link lets in. Null is no limit. */
export const INVITE_USE_CHOICES: (number | null)[] = [null, 1, 5, 10, 25, 100];

/** What a link made without choosing gets: a week, for anyone who has it. */
export const DEFAULT_INVITE = { hours: 24 * 7, maxUses: null } as const;

/**
 * An invite this person made that still works the way a default one would:
 * not revoked, expired or used up, with no limit on uses and at least a day
 * left. Opening the dialog shows it again rather than making one more code
 * each time (UX-43), as Discord does. The newest wins.
 */
export function reusableInvite(invites: Invite[], selfId: ID | undefined, now = Date.now()) {
  return (
    invites
      .filter(
        (invite) =>
          invite.createdBy === selfId &&
          (invite.status ?? "active") === "active" &&
          !invite.revokedAt &&
          invite.maxUses === null &&
          (invite.expiresAt === null || invite.expiresAt - now >= DAY),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  );
}

/** "Expires in 7 days", "Expires in 3 hours", "Never expires". */
export function describeExpiry(expiresAt: number | null, now = Date.now()): string {
  if (expiresAt === null) return "Never expires";
  const left = expiresAt - now;
  if (left <= 0) return "Expired";
  // Rounded up, so a link made for a day reads "1 day", not "24 hours".
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return `Expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.ceil(left / HOUR);
  if (hours < 24) return `Expires in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.ceil(left / DAY);
  return `Expires in ${days} ${days === 1 ? "day" : "days"}`;
}

/** "Any number of people", or "2 of 5 uses left". */
export function describeUses(maxUses: number | null, uses: number): string {
  if (maxUses === null) return "Any number of people";
  const left = Math.max(0, maxUses - uses);
  return `${left} of ${maxUses} ${maxUses === 1 ? "use" : "uses"} left`;
}

/**
 * Whether a link on this address opens only on its own network: a private,
 * link-local or carrier-grade NAT address (Tailscale's), or a .local name.
 * A phone on mobile data, or a friend at home, cannot reach it.
 */
export function onlyOnItsNetwork(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  if (host.endsWith(".local")) return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  // Unique local and link-local IPv6; only a literal has a colon in it.
  return host.includes(":") && /^(fc|fd|fe80:)/.test(host);
}
