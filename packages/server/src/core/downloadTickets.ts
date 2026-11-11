import type { DownloadTicket, ID } from "@ownbase/protocol";
import { hashToken, newSessionToken } from "../auth.js";

/** How long a ticket lasts: long enough for the download it was asked for to start. */
export const DOWNLOAD_TICKET_TTL_MS = 60_000;

/** Tickets one account holds at once; past that its oldest goes. */
const TICKETS_PER_ACCOUNT = 64;

const TICKET = /^[a-f0-9]{64}$/;

interface Ticket {
  /** The one download it opens: the path it was issued for. */
  path: string;
  userId: ID;
  sessionHash: string;
  expiresAt: number;
}

/**
 * One-time tickets that stand in for the Authorization header a browser
 * cannot send on the navigation that saves a file. Without one, an auth-gated
 * download would have to be fetched whole into memory first; with one, it is
 * an ordinary navigation the browser streams straight to disk.
 *
 * A ticket opens one path, once, within a minute, for the session that asked
 * for it, so the copy in a URL is worth little for long. Whoever spends one
 * is signed in as that session and checked as its header would be. Kept in
 * memory: a restart costs at most a minute's unspent tickets.
 */
export class DownloadTickets {
  /** In the order issued; every ticket lives as long, so the oldest is first. */
  private readonly tickets = new Map<string, Ticket>();
  private readonly byAccount = new Map<ID, string[]>();

  issue(path: string, userId: ID, sessionHash: string, now = Date.now()): DownloadTicket {
    for (const [hash, ticket] of this.tickets) {
      if (ticket.expiresAt > now) break;
      this.tickets.delete(hash);
    }
    const { token, tokenHash } = newSessionToken();
    const expiresAt = now + DOWNLOAD_TICKET_TTL_MS;
    this.tickets.set(tokenHash, { path, userId, sessionHash, expiresAt });
    const held = (this.byAccount.get(userId) ?? []).filter((hash) => this.tickets.has(hash));
    held.push(tokenHash);
    while (held.length > TICKETS_PER_ACCOUNT) this.tickets.delete(held.shift()!);
    this.byAccount.set(userId, held);
    return { token, expiresAt };
  }

  /**
   * Spends `ticket` on `path`: the session it stands in for, or null. Spent
   * whatever the answer, so a ticket tried on the wrong path is not left to
   * be tried again.
   */
  spend(ticket: string, path: string, now = Date.now()): string | null {
    if (!TICKET.test(ticket)) return null;
    const hash = hashToken(ticket);
    const found = this.tickets.get(hash);
    this.tickets.delete(hash);
    if (!found || found.expiresAt <= now || found.path !== path) return null;
    return found.sessionHash;
  }
}
