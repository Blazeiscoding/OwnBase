import { createServer, type Socket } from "node:net";

/** One message the sink took. */
export interface SunkMail {
  from: string;
  to: string[];
  /** The whole message as sent, headers and body. */
  raw: string;
  /** The text part, decoded. */
  text: string;
  subject: string;
  /** The username the client signed in with, if it did. */
  user: string | null;
}

/**
 * A mail server for tests (G10): it speaks enough SMTP to take a message
 * from nodemailer, signing in by AUTH PLAIN or LOGIN with any password, and
 * keeps what it was sent. No TLS: nothing it is told leaves the test.
 */
export async function startSmtpSink() {
  const mails: SunkMail[] = [];
  const waiting: (() => void)[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let buffer = "";
    let inData = false;
    let auth: "plain" | "login-user" | "login-pass" | null = null;
    let user: string | null = null;
    let envelope = { from: "", to: [] as string[] };
    const reply = (line: string) => socket.write(line + "\r\n");
    reply("220 sink.test ESMTP");

    const command = (line: string) => {
      if (auth === "plain") {
        user = plainUser(line);
        auth = null;
        return reply("235 Authenticated");
      }
      if (auth === "login-user") {
        user = Buffer.from(line, "base64").toString("utf8");
        auth = "login-pass";
        return reply("334 UGFzc3dvcmQ6");
      }
      if (auth === "login-pass") {
        auth = null;
        return reply("235 Authenticated");
      }
      const [verb = "", ...rest] = line.split(" ");
      switch (verb.toUpperCase()) {
        case "EHLO":
          return socket.write("250-sink.test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
        case "HELO":
          return reply("250 sink.test");
        case "AUTH": {
          const [kind = "", initial] = rest;
          if (kind.toUpperCase() === "PLAIN") {
            if (initial) {
              user = plainUser(initial);
              return reply("235 Authenticated");
            }
            auth = "plain";
            return reply("334 ");
          }
          auth = "login-user";
          return reply("334 VXNlcm5hbWU6");
        }
        case "MAIL":
          envelope = { from: address(line), to: [] };
          return reply("250 OK");
        case "RCPT":
          envelope.to.push(address(line));
          return reply("250 OK");
        case "DATA":
          inData = true;
          return reply("354 Go ahead");
        case "QUIT":
          reply("221 Bye");
          return socket.end();
        default:
          return reply("250 OK");
      }
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.startsWith(".\r\n") ? 0 : buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          const raw = buffer.slice(0, end).replace(/^\.\./gm, ".");
          buffer = buffer.slice(end === 0 ? 3 : end + 5);
          inData = false;
          mails.push({ ...envelope, raw, text: textOf(raw), subject: subjectOf(raw), user });
          reply("250 OK queued");
          for (const wake of waiting.splice(0)) wake();
          continue;
        }
        const newline = buffer.indexOf("\r\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        command(line);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    port,
    mails,
    /** The `n`th message, waiting for it to arrive. */
    async mail(n = 0, timeoutMs = 5000): Promise<SunkMail> {
      const deadline = Date.now() + timeoutMs;
      while (mails.length <= n) {
        if (Date.now() > deadline) throw new Error(`no mail ${n} after ${timeoutMs} ms`);
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          setTimeout(resolve, 50);
        });
      }
      return mails[n]!;
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type SmtpSink = Awaited<ReturnType<typeof startSmtpSink>>;

/** The first link in a mail's text that leads under `base`. */
export function linkIn(mail: SunkMail, base: string): string {
  const escaped = base.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const match = new RegExp(`${escaped}/#/[^\\s]+`).exec(mail.text);
  if (!match) throw new Error(`no link under ${base} in:\n${mail.text}`);
  return match[0];
}

const address = (line: string) => /<([^>]*)>/.exec(line)?.[1] ?? "";

function plainUser(encoded: string): string {
  const [, user = ""] = Buffer.from(encoded, "base64").toString("utf8").split("\0");
  return user;
}

function subjectOf(raw: string): string {
  return /^Subject: (.*(?:\r\n[ \t].*)*)/m.exec(raw)?.[1]?.replace(/\r\n[ \t]/g, " ") ?? "";
}

/** The text/plain part, with quoted-printable undone. */
function textOf(raw: string): string {
  const at = raw.search(/^Content-Type: text\/plain/im);
  if (at === -1) return "";
  const part = raw.slice(at);
  const headerEnd = part.indexOf("\r\n\r\n");
  const headers = part.slice(0, headerEnd);
  let body = part.slice(headerEnd + 4);
  const boundary = body.search(/^--/m);
  if (boundary !== -1) body = body.slice(0, boundary);
  if (/quoted-printable/i.test(headers))
    body = body
      .replace(/=\r\n/g, "")
      .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  else if (/base64/i.test(headers)) body = Buffer.from(body, "base64").toString("utf8");
  return body.replace(/\r\n/g, "\n");
}
