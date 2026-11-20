import type { Transporter } from "nodemailer";
import type { MailSettings } from "../config.js";
import { redactSmtpUrl } from "../redact.js";

/** One email: plain text, with a small HTML part beside it. */
export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Sends email through the host's SMTP account (G10), one connection per mail.
 * A mail is a link someone asked for a moment ago, so a server that does not
 * answer is given up on in seconds rather than Node's minutes.
 */
export class Mailer {
  /**
   * nodemailer is loaded at the first mail, not at start: most servers send
   * none, and the desktop app, which bundles this server, never does yet.
   */
  private transport: Promise<Transporter> | null = null;
  /** Where mail goes, without the password, for logs and the start-up lines. */
  readonly where: string;

  constructor(readonly settings: MailSettings) {
    this.where = redactSmtpUrl(settings.smtpUrl);
  }

  private open(): Promise<Transporter> {
    this.transport ??= import("nodemailer").then(({ createTransport }) =>
      createTransport(
        {
          url: this.settings.smtpUrl,
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 20_000,
        },
        // A mail is text this server wrote, never a file or address to fetch.
        { from: this.settings.from, disableFileAccess: true, disableUrlAccess: true },
      ),
    );
    return this.transport;
  }

  async send(mail: Mail): Promise<void> {
    const transport = await this.open();
    await transport.sendMail({
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  }

  close(): void {
    void this.transport?.then((transport) => transport.close());
  }
}
