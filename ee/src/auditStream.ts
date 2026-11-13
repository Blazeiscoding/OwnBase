import { createHmac } from "node:crypto";
import { createSocket } from "node:dgram";
import { connect as netConnect, type Socket } from "node:net";
import { hostname as machineName } from "node:os";
import { connect as tlsConnect } from "node:tls";
import type { AuditEntry } from "@ownbase/protocol";

/**
 * Sending the administrative record somewhere else (P12): each entry to a
 * webhook, signed, or to a syslog server as one RFC 5424 message.
 */

/** An entry as it is sent: the record's own, with its time readable and its actor named. */
export interface SentEntry extends AuditEntry {
  /** `at` as an ISO 8601 time, in UTC. */
  time: string;
  /** The username of who did it, when someone signed in did. */
  actor: string | null;
}

/** A syslog server: UDP (RFC 5426), TCP (RFC 6587, octet counted) or TLS (RFC 5425). */
export interface SyslogAddress {
  protocol: "udp" | "tcp" | "tls";
  host: string;
  port: number;
}

/** `udp://host:514`, `tcp://host:514` or `tls://host:6514`; null for anything else. */
export function parseSyslog(address: string): SyslogAddress | null {
  const match = /^(udp|tcp|tls):\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(
    address.trim(),
  );
  if (!match) return null;
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return null;
  return {
    protocol: match[1] as SyslogAddress["protocol"],
    host: match[2]!.replace(/^\[|\]$/g, ""),
    port,
  };
}

/** Facility 13, log audit, at severity 6, informational (RFC 5424 6.2.1). */
const PRIORITY = 13 * 8 + 6;

/** RFC 5424's HOSTNAME: printable ASCII, no spaces, at most 255. */
export function syslogHost(publicUrl: string | undefined): string {
  let name = machineName();
  if (publicUrl) {
    try {
      name = new URL(publicUrl).hostname;
    } catch {
      // The machine's own name, then.
    }
  }
  const printable = name.replace(/[^\x21-\x7e]/g, "").slice(0, 255);
  return printable || "-";
}

/** One entry as an RFC 5424 message: its action as the MSGID and the entry as JSON. */
export function syslogMessage(entry: SentEntry, host: string): string {
  const msgId = entry.action.replace(/[^\x21-\x7e]/g, "").slice(0, 32) || "-";
  return `<${PRIORITY}>1 ${entry.time} ${host} ownbase - ${msgId} - ${JSON.stringify(entry)}`;
}

/**
 * The headers that sign a webhook's body, as OwnBase signs what it sends
 * apps: HMAC-SHA256 over `v0:<timestamp>:<body>`. A receiver checks it and
 * refuses a timestamp more than a few minutes old.
 */
export function signatureHeaders(
  secret: string,
  body: string,
  now: number,
): Record<string, string> {
  const ts = String(Math.floor(now / 1000));
  return {
    "x-ownbase-request-timestamp": ts,
    "x-ownbase-signature": `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`,
  };
}

/** How long one syslog delivery may take before it counts as failed. */
const SYSLOG_TIMEOUT_MS = 10_000;

/** Sends each message to the syslog server, all or an error. */
export async function sendSyslog(address: SyslogAddress, messages: string[]): Promise<void> {
  if (address.protocol === "udp") {
    const socket = createSocket(address.host.includes(":") ? "udp6" : "udp4");
    try {
      for (const message of messages)
        await new Promise<void>((resolve, reject) =>
          socket.send(Buffer.from(message), address.port, address.host, (error) =>
            error ? reject(error) : resolve(),
          ),
        );
    } finally {
      socket.close();
    }
    return;
  }
  // Octet counting (RFC 6587 3.4.1), which a message holding a line break survives.
  const framed = messages.map((message) => {
    const bytes = Buffer.from(message);
    return Buffer.concat([Buffer.from(`${bytes.length} `), bytes]);
  });
  await new Promise<void>((resolve, reject) => {
    const socket: Socket =
      address.protocol === "tls"
        ? tlsConnect({ host: address.host, port: address.port, servername: address.host })
        : netConnect({ host: address.host, port: address.port });
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(SYSLOG_TIMEOUT_MS, () => fail(new Error("the syslog server did not answer")));
    socket.once("error", fail);
    socket.once(address.protocol === "tls" ? "secureConnect" : "connect", () => {
      socket.end(Buffer.concat(framed), () => {
        socket.destroy();
        resolve();
      });
    });
  });
}
