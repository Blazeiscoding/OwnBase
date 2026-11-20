import { endpoints, isAdministrator, type User } from "@ownbase/protocol";
import { inviteFingerprint } from "../accounts/feature.js";
import { hashPassword, hashToken, verifyPassword } from "../auth.js";
import type { ServerContext } from "../core/context.js";
import { HttpError } from "../httpError.js";
import { secretToken } from "../ids.js";
import { addressTakenMail, confirmMail, inviteMail, resetMail } from "./mails.js";
import { Mailer, type Mail } from "./mailer.js";

/** How long a link to set a new password works. */
export const RESET_LINK_MS = 30 * 60_000;
/** How long a link to confirm an address works. */
export const CONFIRM_LINK_MS = 24 * 3600_000;

/**
 * Email (G10), when the host gave the server an SMTP account: an address on
 * an account, confirmed by a mailed link; "Forgot password" by a mailed link;
 * and invites sent by email. Without one, every route here refuses and
 * `serverInfo` says the server sends no email.
 */
export function registerEmail(ctx: ServerContext) {
  const { opts, store, settings, gateway, route, ration, network, limiter, lifecycle, log } = ctx;
  const extensions = opts.extensions ?? [];
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
  const singleSignOnRequired = () =>
    extensions.some((extension) => extension.requiresSingleSignOn?.() === true);
  const addressKey = (email: string) => email.trim().toLowerCase();

  /** The account's password, asked before its address changes: a stolen session cannot add one. */
  const confirmPassword = async (me: User, password: string): Promise<void> => {
    ration("authByHandle", me.handle.toLowerCase());
    const auth = store.people.authByHandle(me.handle);
    if (!auth || !(await verifyPassword(password, auth.salt, auth.passwordHash)))
      throw new HttpError(403, "invalid_credentials", "That is not your password.");
    limiter?.forget("authByHandle", me.handle.toLowerCase());
  };

  route(endpoints.emailAddress, async ({ user: me }) => {
    requireMail();
    return store.email.addressOf(me.id);
  });

  route(endpoints.setEmailAddress, async ({ user: me, body }) => {
    requireMail();
    await confirmPassword(me, body.password);
    const email = body.email;
    ration("mailByClient", `user:${me.id}`);
    ration("mailByAddress", addressKey(email));
    const workspace = settings.get("workspaceName");
    const owner = store.email.ownerOf(email);
    if (owner?.id === me.id) {
      store.email.dropLinks(me.id, "verify");
      return { ok: true };
    }
    // A link is kept either way, so this account's settings show the address
    // as waiting whether or not someone else has it. Only the mailbox is told.
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
            handle: me.handle,
            link: `${base()}/#/verify-email/${token}`,
          }),
      "confirm",
    );
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
      // Single sign-on keeps passwords for the owner alone (P9).
      (owner.role === "owner" || !singleSignOnRequired());
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
          handle: owner.handle,
          link: `${base()}/#/reset/${token}`,
        }),
        "reset",
      );
    }
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
      const link = store.email.takeLink(tokenHash, "reset");
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
      if (account.role !== "owner" && singleSignOnRequired())
        throw new HttpError(
          403,
          "sso_required",
          "This workspace signs people in through its single sign-on.",
        );
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
    limiter?.forget("authByHandle", handle.toLowerCase());
    return { handle };
  });

  route(endpoints.emailInvite, async ({ user: me, params, body }) => {
    requireMail();
    if (!me.canInvite)
      throw new HttpError(
        403,
        "invite_permission_required",
        "Only people an administrator has allowed can send invites.",
      );
    const invite = store.accounts.getInvite(params.code);
    if (!invite || (!isAdministrator(me.role) && invite.createdBy !== me.id))
      throw new HttpError(404, "invite_not_found");
    if (invite.status !== "active")
      throw new HttpError(
        409,
        "invite_inactive",
        "That invite no longer works. Make a new link and send that.",
      );
    ration("mailByClient", `user:${me.id}`);
    ration("mailByAddress", addressKey(body.email));
    try {
      // Waited for: whoever sends it wants to know it went.
      await mailer!.send(
        inviteMail({
          to: body.email,
          workspace: settings.get("workspaceName"),
          inviter: me.displayName,
          link: `${base()}/#/join/${encodeURIComponent(invite.code)}`,
          expiresAt: invite.expiresAt,
        }),
      );
    } catch (err) {
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
      details: {},
    });
    return { ok: true };
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
