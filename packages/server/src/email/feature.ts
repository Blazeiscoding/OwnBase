import { endpoints, pageLink, type User } from "@ownbase/protocol";
import { inviteFingerprint, passwordRules } from "../accounts/feature.js";
import { hashPassword, hashToken } from "../auth.js";
import type { ServerContext } from "../core/context.js";
import { HttpError } from "../httpError.js";
import { secretToken } from "../ids.js";
import { accountName, addressTakenMail, confirmMail, inviteMail, resetMail } from "./mails.js";
import { Mailer, type Mail } from "./mailer.js";

/** How long a link to set a new password works. */
export const RESET_LINK_MS = 30 * 60_000;
/** How long a link to confirm an address works. */
export const CONFIRM_LINK_MS = 24 * 3600_000;
/** How long an invite sent by email works. It works once. */
export const EMAILED_INVITE_MS = 7 * 24 * 3600_000;

/**
 * Email (G10), when the host gave the server an SMTP account: an address on
 * an account, confirmed by a mailed link; "Forgot password" by a mailed link;
 * and invites sent by email. Without one, every route here refuses and
 * `serverInfo` says the server sends no email.
 */
export function registerEmail(ctx: ServerContext) {
  const { opts, store, settings, gateway, route, ration, network, lifecycle, log } = ctx;
  const { mayUsePassword, ssoRequired, authSucceeded, confirmPassword } = passwordRules(ctx);
  const mailer = opts.mail ? new Mailer(opts.mail) : null;
  /** The links lead here, never to the Host a request named, which anyone can set. */
  const base = () => network.publicUrl() ?? null;
  const on = () => mailer !== null && base() !== null;

  const sending = new Set<Promise<void>>();
  lifecycle.onDrain(async () => {
    await Promise.allSettled([...sending]);
    mailer?.close();
  });
  lifecycle.hourly(() => ctx.background.maintain("email links", () => store.email.pruneLinks()));

  /**
   * Sends without the request waiting for it. Asking for a link answers the
   * same, as soon, whether or not a mail goes, so waiting on the mail server
   * would say which. A mail that fails is logged without its address.
   */
  const sendLater = (mail: Mail, what: string) => {
    const sent = mailer!.send(mail).catch((err: unknown) => {
      log.warn({ err, what, via: mailer!.where }, "could not send an email");
    });
    sending.add(sent);
    void sent.finally(() => sending.delete(sent));
  };

  const requireMail = () => {
    if (!on())
      throw new HttpError(
        403,
        "email_off",
        "This workspace does not send email. Ask an admin of the workspace instead.",
      );
  };
  const linkGone = () =>
    new HttpError(
      410,
      "email_link_gone",
      "This link no longer works. It may have been used already or be too old. Ask for a new one.",
    );
  const addressKey = (email: string) => email.trim().toLowerCase();

  route(endpoints.emailAddress, async ({ user: me }) => {
    requireMail();
    return store.email.addressOf(me.id);
  });

  /**
   * Keeps a new link to confirm `email` for `me`, in place of any earlier
   * one, and mails it. The link is kept even when another account has the
   * address, so this account's settings show it as waiting either way. Only
   * the mailbox is told.
   */
  const mailConfirmLink = (me: User, email: string) => {
    ration("mailByClient", `user:${me.id}`);
    ration("mailByAddress", addressKey(email));
    const workspace = settings.get("workspaceName");
    const owner = store.email.ownerOf(email);
    const token = secretToken();
    store.email.addLink(
      { tokenHash: hashToken(token), userId: me.id, purpose: "verify", email },
      CONFIRM_LINK_MS,
    );
    sendLater(
      owner
        ? addressTakenMail({ to: email, workspace })
        : confirmMail({
            to: email,
            workspace,
            who: accountName(me.displayName, me.handle),
            link: pageLink(base()!, { kind: "verifyEmail", token }),
          }),
      "confirm",
    );
  };

  route(endpoints.setEmailAddress, async ({ user: me, body }) => {
    requireMail();
    await confirmPassword(me, body.password);
    if (store.email.ownerOf(body.email)?.id === me.id) {
      ration("mailByClient", `user:${me.id}`);
      ration("mailByAddress", addressKey(body.email));
      store.email.dropLinks(me.id, "verify");
      return { ok: true };
    }
    mailConfirmLink(me, body.email);
    return { ok: true };
  });

  route(endpoints.resendEmailLink, async ({ user: me }) => {
    requireMail();
    const pending = store.email.addressOf(me.id).pending;
    if (!pending)
      throw new HttpError(
        409,
        "email_not_pending",
        "No address is waiting to be confirmed. Add one in Account settings, under Security.",
      );
    mailConfirmLink(me, pending);
    return { ok: true };
  });

  route(endpoints.removeEmailAddress, async ({ user: me }) => {
    requireMail();
    store.transaction(() => store.email.remove(me.id));
    return { ok: true };
  });

  route(endpoints.confirmEmail, async ({ req, body }) => {
    requireMail();
    ration("authByAddress", network.callerAddress(req));
    const email = store.transaction(() => {
      const link = store.email.takeLink(hashToken(body.token), "verify");
      if (!link) throw linkGone();
      const account = store.people.get(link.userId);
      if (!account || account.deactivated) throw linkGone();
      const owner = store.email.ownerOf(link.email);
      if (owner && owner.id !== link.userId)
        throw new HttpError(
          409,
          "email_taken",
          "That address already belongs to another account here. Remove it from that account first, then ask for a new link.",
        );
      store.email.confirm(link.userId, link.email);
      return link.email;
    });
    return { email };
  });

  route(endpoints.forgotPassword, async ({ req, body }) => {
    requireMail();
    // Spent before anything is looked up, so a refusal is the same for an
    // address nobody uses.
    ration("mailByClient", `address:${network.callerAddress(req)}`);
    ration("mailByAddress", addressKey(body.email));
    const owner = store.email.ownerOf(body.email);
    const may =
      owner &&
      !owner.deactivated &&
      !owner.isBot &&
      owner.role !== "guest" &&
      owner.hasPassword &&
      mayUsePassword(owner.role);
    if (may) {
      const token = secretToken();
      const email = store.email.addressOf(owner.id).email!;
      store.email.addLink(
        { tokenHash: hashToken(token), userId: owner.id, purpose: "reset", email },
        RESET_LINK_MS,
      );
      sendLater(
        resetMail({
          to: email,
          workspace: settings.get("workspaceName"),
          who: accountName(owner.displayName, owner.handle),
          link: pageLink(base()!, { kind: "reset", token }),
        }),
        "reset",
      );
    }
    return { ok: true };
  });

  /** The account a link to set a new password is for, while it may still use it. */
  const resetAccount = (link: { userId: string; email: string } | null): User => {
    if (!link) throw linkGone();
    const account = store.people.get(link.userId);
    const address = account ? store.email.addressOf(account.id).email : null;
    if (
      !account ||
      account.deactivated ||
      account.role === "guest" ||
      account.isBot ||
      address?.toLowerCase() !== link.email.toLowerCase()
    )
      throw linkGone();
    if (!mayUsePassword(account.role)) throw ssoRequired("signs people in");
    return account;
  };

  route(endpoints.checkResetLink, async ({ req, body }) => {
    requireMail();
    // A read the page makes as it opens, not an attempt: spending the sign-in
    // budget here would lock out an office behind one address. Tokens are far
    // too long to guess, so the loose budget for public reads is enough.
    ration("publicByAddress", network.callerAddress(req));
    resetAccount(store.email.peekLink(hashToken(body.token), "reset"));
    return { ok: true };
  });

  route(endpoints.resetPasswordWithLink, async ({ req, body }) => {
    requireMail();
    ration("authByAddress", network.callerAddress(req));
    const tokenHash = hashToken(body.token);
    if (!store.email.peekLink(tokenHash, "reset")) throw linkGone();
    const credentials = await hashPassword(body.password);
    // Hashing yields: the link is taken in the write that uses it, once.
    const { handle, revoked } = store.transaction(() => {
      const account = resetAccount(store.email.takeLink(tokenHash, "reset"));
      store.accounts.setPassword(account.id, credentials.hash, credentials.salt);
      const revoked = store.accounts.revokeSessions(account.id);
      store.audit.record({
        actorId: account.id,
        action: "user.password_reset_by_email",
        targetType: "user",
        targetId: account.id,
        details: { sessionsEnded: revoked.length },
      });
      return { handle: account.handle, revoked };
    });
    for (const session of revoked) gateway.disconnectSession(session);
    authSucceeded(handle);
    return { handle };
  });

  route(endpoints.emailInvite, async ({ user: me, body }) => {
    requireMail();
    if (!me.canInvite)
      throw new HttpError(
        403,
        "invite_permission_required",
        "Only people an administrator has allowed can send invites.",
      );
    ration("mailByClient", `user:${me.id}`);
    ration("mailByAddress", addressKey(body.email));
    // One of its own, used once: the link on screen may be for any number of
    // people, or forever, and a mail can be forwarded.
    const invite = store.accounts.createInvite({
      createdBy: me.id,
      expiresAt: Date.now() + EMAILED_INVITE_MS,
      maxUses: 1,
      email: body.email,
    });
    try {
      // Waited for: whoever sends it wants to know it went.
      await mailer!.send(
        inviteMail({
          to: body.email,
          workspace: settings.get("workspaceName"),
          inviter: me.displayName,
          link: pageLink(base()!, { kind: "join", code: invite.code }),
          expiresAt: invite.expiresAt!,
        }),
      );
    } catch (err) {
      store.accounts.dropUnusedInvite(invite.code);
      log.warn({ err, via: mailer!.where }, "could not send an invite by email");
      throw new HttpError(
        502,
        "mail_failed",
        "The workspace's mail server did not send it. Copy the link and send it another way, or try again later.",
      );
    }
    store.audit.record({
      actorId: me.id,
      action: "invite.emailed",
      targetType: "invite",
      targetId: inviteFingerprint(invite.code),
      details: { expiresAt: invite.expiresAt, maxUses: invite.maxUses },
    });
    return { invite };
  });

  return {
    on,
    /** Where mail goes, without the password, for the host's start-up lines. */
    where: mailer?.where ?? null,
    /** Resolves once every mail asked for so far was sent or given up. */
    settled: async () => {
      await Promise.allSettled([...sending]);
    },
  };
}

export type Email = ReturnType<typeof registerEmail>;
