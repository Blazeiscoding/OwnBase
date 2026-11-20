import type { ID } from "@ownbase/protocol";
import { hashToken, newSessionToken } from "../auth.js";

/** How long the address apps.connections.open gives stays good: long enough to connect. */
export const SOCKET_TICKET_TTL_MS = 30_000;

/** Tickets one app holds at once; past that its oldest goes. */
const TICKETS_PER_APP = 16;

const TICKET = /^[a-f0-9]{64}$/;

interface Ticket {
  appId: ID;
  /** The app-level token it was asked for with, so replacing that token voids it. */
  tokenHash: string;
  expiresAt: number;
}

/** Who a spent ticket lets in. */
export interface SocketTicketHolder {
  appId: ID;
  tokenHash: string;
}

/**
 * The single-use tickets in the addresses apps.connections.open hands out,
 * built like the download tickets: the token stays out of the socket's URL,
 * where proxies log it, and the copy that is logged is spent or stale within
 * seconds. Kept in memory; a restart costs an app one reconnect.
 */
export class SocketTickets {
  /** In the order issued; every ticket lives as long, so the oldest is first. */
  private readonly tickets = new Map<string, Ticket>();
  private readonly byApp = new Map<ID, string[]>();

  issue(appId: ID, tokenHash: string, now = Date.now()): string {
    for (const [hash, ticket] of this.tickets) {
      if (ticket.expiresAt > now) break;
      this.tickets.delete(hash);
    }
    const { token, tokenHash: ticketHash } = newSessionToken();
    this.tickets.set(ticketHash, { appId, tokenHash, expiresAt: now + SOCKET_TICKET_TTL_MS });
    const held = (this.byApp.get(appId) ?? []).filter((hash) => this.tickets.has(hash));
    held.push(ticketHash);
    while (held.length > TICKETS_PER_APP) this.tickets.delete(held.shift()!);
    this.byApp.set(appId, held);
    return token;
  }

  /** Spends `ticket`: who it lets in, or null. Spent whatever the answer. */
  spend(ticket: string, now = Date.now()): SocketTicketHolder | null {
    if (!TICKET.test(ticket)) return null;
    const hash = hashToken(ticket);
    const found = this.tickets.get(hash);
    this.tickets.delete(hash);
    if (!found || found.expiresAt <= now) return null;
    return { appId: found.appId, tokenHash: found.tokenHash };
  }

  /** Voids every ticket of an app, for a token replaced or revoked. */
  forget(appId: ID): void {
    for (const hash of this.byApp.get(appId) ?? []) this.tickets.delete(hash);
    this.byApp.delete(appId);
  }
}
