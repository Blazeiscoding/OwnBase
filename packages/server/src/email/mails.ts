import type { Mail } from "./mailer.js";

/**
 * The mail this server sends (G10). Each says which workspace, what to do,
 * the link, and who to ask if it was not you. Plain text first, with a small
 * HTML part for mail apps that show only that: no pictures, nothing loaded
 * from elsewhere, nothing that reports being opened.
 */

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** Paragraphs, with `{link}` where the link goes on a line of its own. */
function compose(to: string, subject: string, paragraphs: string[], link: string | null): Mail {
  const text = paragraphs.map((p) => (p === "{link}" ? link! : p)).join("\n\n") + "\n";
  const body = paragraphs
    .map((p) =>
      p === "{link}"
        ? `<p><a href="${escape(link!)}">${escape(link!)}</a></p>`
        : `<p>${escape(p)}</p>`,
    )
    .join("\n");
  const html = `<!doctype html>
<html><body style="font-family: system-ui, sans-serif; font-size: 15px; line-height: 1.5; color: #1f1f1f; max-width: 560px;">
${body}
</body></html>
`;
  return { to, subject, text, html };
}

export function resetMail(input: {
  to: string;
  workspace: string;
  handle: string;
  link: string;
}): Mail {
  return compose(
    input.to,
    `Set a new password for ${input.workspace}`,
    [
      `Someone asked to set a new password for your account @${input.handle} in ${input.workspace}.`,
      "To choose one, open this link within 30 minutes. It works once:",
      "{link}",
      "Setting a new password signs your account out everywhere. If you use two-step sign-in, it still asks for your code.",
      `If this was not you, ignore this email and your password stays as it is. If it keeps happening, tell an admin of ${input.workspace}.`,
    ],
    input.link,
  );
}

export function confirmMail(input: {
  to: string;
  workspace: string;
  handle: string;
  link: string;
}): Mail {
  return compose(
    input.to,
    `Confirm your email address for ${input.workspace}`,
    [
      `@${input.handle} asked to use this address for their account in ${input.workspace}. Once you confirm it, this is where a link to set a new password is sent.`,
      "To confirm it, open this link within 24 hours. It works once:",
      "{link}",
      `If this was not you, ignore this email and the address is not added. If it keeps happening, tell an admin of ${input.workspace}.`,
    ],
    input.link,
  );
}

/** For an address another account here already confirmed: said to the mailbox, not to whoever asked. */
export function addressTakenMail(input: { to: string; workspace: string }): Mail {
  return compose(
    input.to,
    `Your email address in ${input.workspace}`,
    [
      `Someone asked to use this address for an account in ${input.workspace}, but it already belongs to another account there. Nothing was changed.`,
      "If that was you, remove the address from your other account first, then add it again.",
      `If this was not you, ignore this email. If it keeps happening, tell an admin of ${input.workspace}.`,
    ],
    null,
  );
}

export function inviteMail(input: {
  to: string;
  workspace: string;
  inviter: string;
  link: string;
  /** When the invite stops working, as the sender's server tells it; null for never. */
  expiresAt: number | null;
}): Mail {
  const until =
    input.expiresAt === null
      ? ""
      : ` The invite works until ${new Date(input.expiresAt).toUTCString().replace(/:\d\d GMT$/, " UTC")}.`;
  return compose(
    input.to,
    `${input.inviter} invited you to ${input.workspace}`,
    [
      `${input.inviter} invited you to join ${input.workspace}, a workspace for chat and calls on OwnBase.`,
      `To join, open this link in your browser and create an account.${until}`,
      "{link}",
      `If you were not expecting this, ignore this email, or ask ${input.inviter} about it.`,
    ],
    input.link,
  );
}
