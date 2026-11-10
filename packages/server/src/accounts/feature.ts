import {
  endpoints,
  isAdministrator,
  PROTOCOL_VERSION,
  type ID,
  type ServerInfo,
  type User,
} from "@ownbase/protocol";
import { hashPassword, hashToken, newSessionToken, verifyPassword } from "../auth.js";
import { type Channels } from "../channels/feature.js";
import { type ServerContext } from "../core/context.js";
import { bearerToken } from "../core/network.js";
import { HttpError } from "../httpError.js";
import { secretToken } from "../ids.js";
import {
  checkCode,
  newRecoveryCodes,
  newTwoStepSecret,
  normalRecoveryCode,
  otpauthUri,
} from "../twoStep.js";
import { SERVER_BUILD, SERVER_VERSION } from "../version.js";

const TWO_STEP_CHALLENGE_MS = 5 * 60_000;
/** Wrong codes one sign-in may try before its password must be given again (E11). */
const TWO_STEP_TRIES = 5;
const TWO_STEP_SETUP_MS = 10 * 60_000;

/** A guest's session lasts a day from joining, however much it is used. */
export const GUEST_SESSION_TTL_MS = 24 * 3600_000;
/** How many guests may be signed in at once; joining past it waits. */
const MAX_GUEST_SESSIONS = 200;

/** Identifies an invite in the audit log without writing down the code itself. */
export const inviteFingerprint = (code: string) => hashToken(code).slice(0, 12);

/** Accounts: joining, signing in and out, two-step sign-in, passwords, sessions, guests and invites. */
export function registerAccounts(
  ctx: ServerContext,
  {
    joinPublicChannels,
    iconVersion,
  }: { joinPublicChannels: Channels["joinPublicChannels"]; iconVersion: () => string | null },
) {
  const { opts, store, settings, gateway, route, requireUser, ration, mutate, network, limiter } =
    ctx;
  const extensions = opts.extensions ?? [];
  ctx.lifecycle.hourly(() =>
    ctx.background.maintain("sessions", () => store.accounts.pruneSessions()),
  );

  /**
   * Clears what a handle has spent on authentication. Called when a password
   * turns out to be right: only wrong guesses are worth counting, so someone
   * who knows their own password never meets this limit at all, however often
   * they sign in or change it.
   */
  const authSucceeded = (handle: string): void => {
    limiter?.forget("authByHandle", handle.toLowerCase());
  };

  // Bound simultaneous password derivations; each scrypt job uses substantial
  // memory. Do the expensive work off the event loop so calls/chat stay responsive.
  let authJobs = 0;
  const beginAuth = () => {
    if (authJobs >= 2)
      throw new HttpError(
        429,
        "auth_busy",
        "The workspace is handling other sign-ins. Try again in a moment.",
      );
    authJobs++;
  };

  /** Whether passwords are kept for the owner alone, an extension signing in everyone else (P9). */
  const singleSignOnRequired = () =>
    extensions.some((extension) => extension.requiresSingleSignOn?.() === true);
  const ssoRequired = (what: string) =>
    new HttpError(403, "sso_required", `This workspace ${what} through its single sign-on.`);

  /** Ways to sign in the extensions offer, and who may still use a password (P9). */
  const signInInfo = (): ServerInfo["signIn"] => {
    const methods = extensions.flatMap((extension) => extension.signInMethods?.() ?? []);
    const ownerOnly = singleSignOnRequired();
    return methods.length || ownerOnly
      ? { methods, passwords: ownerOnly ? "owner_only" : "everyone" }
      : undefined;
  };

  route(endpoints.register, async ({ req, body }) => {
    ration("authByAddress", network.callerAddress(req));
    ration("authByHandle", body.handle.toLowerCase());
    beginAuth();
    let credentials: Awaited<ReturnType<typeof hashPassword>>;
    try {
      credentials = await hashPassword(body.password);
    } finally {
      authJobs--;
    }
    // Everything after hashing is synchronous: concurrent registrations cannot
    // both become owner or consume the same final invitation use.
    const { token, user } = mutate((emit) => {
      const isFirstUser = store.people.count() === 0;

      if (store.people.authByHandle(body.handle)) {
        throw new HttpError(409, "handle_taken");
      }

      if (isFirstUser) {
        const expected = settings.get("claimCode");
        if (expected && !network.isLocalRequest(req) && body.claimCode !== expected) {
          throw new HttpError(
            403,
            "claim_required",
            "This workspace has no owner yet. Enter the claim code its host showed when it started.",
          );
        }
      }

      if (!isFirstUser && singleSignOnRequired()) throw ssoRequired("makes new accounts");

      if (!isFirstUser && settings.get("accessPolicy") === "invite_only") {
        if (!body.inviteCode || !store.accounts.consumeInvite(body.inviteCode)) {
          throw new HttpError(
            403,
            "invite_required",
            "This workspace needs a valid invite code to join.",
          );
        }
      }
      const { hash, salt } = credentials;
      const user = store.people.create({
        handle: body.handle,
        displayName: body.displayName,
        passwordHash: hash,
        salt,
        role: isFirstUser ? "owner" : "member",
      });

      if (isFirstUser) {
        // Single use: the workspace now has an owner and cannot be claimed again.
        settings.set("claimCode", null);
        const general = store.channels.create({
          type: "public",
          name: "general",
          description: "This channel is for workspace-wide communication.",
          creatorId: user.id,
          memberIds: [user.id],
        });
        emit({ type: "channel.created", channel: general });
      } else {
        emit({ type: "user.joined", user });
        joinPublicChannels(user.id, emit);
      }

      const { token, tokenHash } = newSessionToken();
      store.accounts.createSession(tokenHash, user.id, network.deviceName(req));
      return { token, user };
    });
    // A handle that is now yours was not a guess at someone else's, and a new
    // account mistyping its own password twice should not then be locked out.
    authSucceeded(body.handle);
    return { token, user };
  });

  route(endpoints.joinAsGuest, async ({ req, body }) => {
    ration("authByAddress", network.callerAddress(req));
    const { token, user } = mutate((emit) => {
      if (settings.get("accessPolicy") !== "guest_allowed")
        throw new HttpError(403, "guest_access_off", "This workspace needs an account to join.");
      // The first person here claims it as owner, which a guest never does.
      if (store.people.count() === 0)
        throw new HttpError(403, "workspace_unclaimed", "This workspace has no owner yet.");
      if (store.accounts.liveGuestSessions() >= MAX_GUEST_SESSIONS)
        throw new HttpError(429, "guests_full", "Too many guests are here now. Try again later.");
      let handle = "";
      do handle = `guest-${secretToken().slice(0, 10).toLowerCase()}`;
      while (store.people.authByHandle(handle));
      // No password can match these: a guest cannot sign in, only resume.
      const user = store.people.create({
        handle,
        displayName: body.displayName,
        passwordHash: "",
        salt: "",
        role: "guest",
      });
      emit({ type: "user.joined", user });
      joinPublicChannels(user.id, emit);
      const { token, tokenHash } = newSessionToken();
      store.accounts.createSession(
        tokenHash,
        user.id,
        network.deviceName(req),
        GUEST_SESSION_TTL_MS,
      );
      return { token, user };
    });
    return { token, user };
  });

  route(endpoints.createAccountFromGuest, async ({ req, user: me, body }) => {
    if (me.role !== "guest") throw new HttpError(400, "not_a_guest");
    ration("authByAddress", network.callerAddress(req));
    ration("authByHandle", body.handle.toLowerCase());
    beginAuth();
    let credentials: Awaited<ReturnType<typeof hashPassword>>;
    try {
      credentials = await hashPassword(body.password);
    } finally {
      authJobs--;
    }
    const { token, user, revoked } = mutate((emit) => {
      // Hashing yields: the guest may have been signed out meanwhile.
      const current = requireUser(req);
      if (current.id !== me.id || current.role !== "guest")
        throw new HttpError(409, "credentials_changed");
      if (settings.get("accessPolicy") === "invite_only")
        throw new HttpError(403, "invite_required", "This workspace needs an invite to join.");
      if (singleSignOnRequired()) throw ssoRequired("makes new accounts");
      if (store.people.authByHandle(body.handle)) throw new HttpError(409, "handle_taken");
      const user = store.accounts.convertGuest(
        me.id,
        body.handle,
        credentials.hash,
        credentials.salt,
      );
      const revoked = store.accounts.revokeSessions(me.id);
      const { token, tokenHash } = newSessionToken();
      store.accounts.createSession(tokenHash, me.id, network.deviceName(req));
      emit({ type: "user.updated", user });
      return { token, user, revoked };
    });
    for (const tokenHash of revoked) gateway.disconnectSession(tokenHash);
    authSucceeded(body.handle);
    return { token, user };
  });

  route(endpoints.login, async ({ req, body }) => {
    // Keyed on the handle as well as the address: an account is worth
    // protecting from many machines, and an address from many accounts.
    ration("authByAddress", network.callerAddress(req));
    ration("authByHandle", body.handle.toLowerCase());
    const auth = store.people.authByHandle(body.handle);
    beginAuth();
    let valid = false;
    try {
      valid =
        !!auth &&
        // A guest has no password: it resumes its session or joins again.
        auth.role !== "guest" &&
        (await verifyPassword(body.password, auth.salt, auth.passwordHash));
    } finally {
      authJobs--;
    }
    const latest = auth ? store.people.authByHandle(auth.handle) : null;
    if (
      !auth ||
      !valid ||
      !latest ||
      latest.passwordHash !== auth.passwordHash ||
      latest.salt !== auth.salt
    ) {
      throw new HttpError(401, "invalid_credentials");
    }
    // Said only to someone who knows the password, so it tells a stranger
    // nothing; the person themselves learns why, rather than doubting it.
    if (latest.deactivated)
      throw new HttpError(
        403,
        "account_deactivated",
        "This account is deactivated. Ask an admin of the workspace to reactivate it.",
      );
    // Asked only once the password is right, so it says nothing of who has an
    // account. The owner always may: the way back in (P9).
    if (latest.role !== "owner" && singleSignOnRequired()) throw ssoRequired("signs people in");
    // An account with two-step sign-in has a second step to pass first (E11).
    // What its handle has spent stays spent until then, so a right password
    // does not buy more guesses at the code.
    if (store.accounts.twoStep(auth.id).secret) {
      if (!body.twoStep)
        throw new HttpError(
          401,
          "two_step_required",
          "This account asks for a code from an authenticator app. Update OwnBase to sign in with it.",
        );
      const challenge = secretToken();
      const now = Date.now();
      for (const [key, held] of twoStepChallenges)
        if (held.expiresAt <= now) twoStepChallenges.delete(key);
      twoStepChallenges.set(hashToken(challenge), {
        userId: auth.id,
        passwordHash: latest.passwordHash,
        expiresAt: now + TWO_STEP_CHALLENGE_MS,
        tries: 0,
      });
      return { twoStep: { challenge, expiresAt: now + TWO_STEP_CHALLENGE_MS } };
    }
    authSucceeded(auth.handle);
    const { token, tokenHash } = newSessionToken();
    store.accounts.createSession(tokenHash, auth.id, network.deviceName(req));
    const { passwordHash: _p, salt: _s, ...user } = latest;
    return { token, user, mustChangePassword: store.accounts.mustChangePassword(auth.id) };
  });

  /**
   * Sign-ins waiting on their second step (E11), by their challenge's hash:
   * whose, with the password they gave, until when, and how many wrong codes
   * so far. In memory: a restart asks for the password again.
   */
  const twoStepChallenges = new Map<
    string,
    { userId: ID; passwordHash: string; expiresAt: number; tries: number }
  >();

  route(endpoints.signInSecondStep, async ({ req, body }) => {
    ration("authByAddress", network.callerAddress(req));
    const key = hashToken(body.challenge);
    const held = twoStepChallenges.get(key);
    const expired = () =>
      new HttpError(
        401,
        "two_step_expired",
        "That sign-in has expired. Enter your password again.",
      );
    if (!held || held.expiresAt <= Date.now()) {
      twoStepChallenges.delete(key);
      throw expired();
    }
    const account = store.people.get(held.userId);
    const auth = account ? store.people.authByHandle(account.handle) : null;
    if (!auth || auth.deactivated || auth.passwordHash !== held.passwordHash) {
      twoStepChallenges.delete(key);
      throw expired();
    }
    ration("authByHandle", auth.handle.toLowerCase());
    const second = store.accounts.twoStep(auth.id);
    let passed = second.secret === null; // Reset meanwhile: the password is enough again.
    if (!passed && body.code !== undefined) {
      const step = checkCode(second.secret!, body.code, Date.now(), second.step);
      if (step !== null) {
        store.accounts.useTwoStepStep(auth.id, step);
        passed = true;
      }
    } else if (!passed && body.recoveryCode !== undefined) {
      passed = store.accounts.useRecoveryCode(
        auth.id,
        hashToken(normalRecoveryCode(body.recoveryCode)),
      );
    }
    if (!passed) {
      held.tries++;
      if (held.tries >= TWO_STEP_TRIES) {
        twoStepChallenges.delete(key);
        throw new HttpError(
          401,
          "two_step_expired",
          "That was too many wrong codes. Enter your password again.",
        );
      }
      throw new HttpError(
        401,
        "invalid_two_step_code",
        body.code !== undefined
          ? "That code is not right. Enter the one your authenticator app shows now."
          : "That recovery code is not right, or has been used.",
      );
    }
    twoStepChallenges.delete(key);
    // Required since the first step (P9).
    if (auth.role !== "owner" && singleSignOnRequired()) throw ssoRequired("signs people in");
    authSucceeded(auth.handle);
    const { token, tokenHash } = newSessionToken();
    store.accounts.createSession(tokenHash, auth.id, network.deviceName(req));
    const { passwordHash: _p, salt: _s, ...user } = auth;
    return {
      token,
      user,
      mustChangePassword: store.accounts.mustChangePassword(auth.id),
      recoveryCodesLeft: store.accounts.twoStep(auth.id).codesLeft,
    };
  });

  route(endpoints.logout, async ({ req }) => {
    const token = bearerToken(req);
    if (token) {
      const tokenHash = hashToken(token);
      store.accounts.deleteSession(tokenHash);
      gateway.disconnectSession(tokenHash);
    }
    return { ok: true };
  });

  route(endpoints.changePassword, async ({ req, user: me, body }) => {
    // The current password is guessable here too, by whoever has the session.
    ration("authByHandle", me.handle.toLowerCase());
    const auth = store.people.authByHandle(me.handle);
    if (!auth) throw new HttpError(404, "user_not_found");
    beginAuth();
    let valid = false;
    try {
      valid = await verifyPassword(body.currentPassword, auth.salt, auth.passwordHash);
    } finally {
      authJobs--;
    }
    if (!valid)
      throw new HttpError(403, "invalid_credentials", "That is not your current password.");
    authSucceeded(me.handle);
    beginAuth();
    let credentials: Awaited<ReturnType<typeof hashPassword>>;
    try {
      credentials = await hashPassword(body.newPassword);
    } finally {
      authJobs--;
    }
    // Hashing yields: sign-out, deactivation, or another reset may have happened meanwhile.
    requireUser(req);
    const latest = store.people.authByHandle(me.handle);
    if (!latest || latest.passwordHash !== auth.passwordHash || latest.salt !== auth.salt) {
      throw new HttpError(
        409,
        "credentials_changed",
        "Your password changed while this request was running. Sign in again.",
      );
    }
    const keep = hashToken(bearerToken(req)!);
    const revokedSessions = store.transaction(() => {
      store.accounts.setPassword(me.id, credentials.hash, credentials.salt);
      return store.accounts.revokeSessions(me.id, { exceptTokenHash: keep });
    });
    for (const revoked of revokedSessions) {
      gateway.disconnectSession(revoked);
    }
    return { ok: true };
  });

  /**
   * Whether this is the password of the account signed in here, asked before
   * its two-step sign-in changes (E11), and guessable by whoever has the
   * session, so rationed as signing in is.
   */
  const confirmPassword = async (me: User, password: string): Promise<void> => {
    ration("authByHandle", me.handle.toLowerCase());
    const auth = store.people.authByHandle(me.handle);
    if (!auth) throw new HttpError(404, "user_not_found");
    beginAuth();
    let valid = false;
    try {
      valid = await verifyPassword(password, auth.salt, auth.passwordHash);
    } finally {
      authJobs--;
    }
    if (!valid) throw new HttpError(403, "invalid_credentials", "That is not your password.");
    authSucceeded(me.handle);
  };

  /** Keys being set up, waiting for their first code (E11), by account. In memory. */
  const twoStepSetups = new Map<ID, { secret: string; expiresAt: number }>();

  route(endpoints.twoStep, async ({ user: me }) => {
    const second = store.accounts.twoStep(me.id);
    return { enabled: second.secret !== null, recoveryCodesLeft: second.codesLeft };
  });

  route(endpoints.startTwoStep, async ({ user: me, body }) => {
    await confirmPassword(me, body.password);
    if (store.accounts.twoStep(me.id).secret)
      throw new HttpError(409, "two_step_on", "Two-step sign-in is already on.");
    const secret = newTwoStepSecret();
    twoStepSetups.set(me.id, { secret, expiresAt: Date.now() + TWO_STEP_SETUP_MS });
    return { secret, uri: otpauthUri(secret, settings.get("workspaceName"), me.handle) };
  });

  route(endpoints.enableTwoStep, async ({ user: me, body }) => {
    const setup = twoStepSetups.get(me.id);
    if (!setup || setup.expiresAt <= Date.now()) {
      twoStepSetups.delete(me.id);
      throw new HttpError(409, "two_step_setup_expired", "Setting up took too long. Start again.");
    }
    const step = checkCode(setup.secret, body.code, Date.now(), null);
    if (step === null)
      throw new HttpError(
        400,
        "invalid_two_step_code",
        "That code is not right. Enter the one your authenticator app shows now.",
      );
    const recoveryCodes = newRecoveryCodes();
    store.transaction(() =>
      store.accounts.enableTwoStep(
        me.id,
        setup.secret,
        step,
        recoveryCodes.map((code) => hashToken(normalRecoveryCode(code))),
      ),
    );
    twoStepSetups.delete(me.id);
    return { recoveryCodes };
  });

  route(endpoints.newRecoveryCodes, async ({ user: me, body }) => {
    await confirmPassword(me, body.password);
    if (!store.accounts.twoStep(me.id).secret)
      throw new HttpError(409, "two_step_off", "Two-step sign-in is off.");
    const recoveryCodes = newRecoveryCodes();
    store.transaction(() =>
      store.accounts.replaceRecoveryCodes(
        me.id,
        recoveryCodes.map((code) => hashToken(normalRecoveryCode(code))),
      ),
    );
    return { recoveryCodes };
  });

  route(endpoints.disableTwoStep, async ({ user: me, body }) => {
    await confirmPassword(me, body.password);
    store.transaction(() => store.accounts.disableTwoStep(me.id));
    return { ok: true };
  });

  route(endpoints.listSessions, async ({ req, user: me }) => {
    const current = hashToken(bearerToken(req)!);
    const currentId = store.accounts.sessionIdFor(current);
    return {
      sessions: store.accounts
        .listSessions(me.id)
        .map((session) => ({ ...session, current: session.id === currentId })),
    };
  });

  route(endpoints.revokeSession, async ({ user: me, params }) => {
    const revoked = store.accounts.revokeSessions(me.id, { id: params.id });
    if (revoked.length === 0) throw new HttpError(404, "session_not_found");
    for (const tokenHash of revoked) gateway.disconnectSession(tokenHash);
    return { ok: true };
  });

  route(endpoints.revokeOtherSessions, async ({ req, user: me }) => {
    const keep = hashToken(bearerToken(req)!);
    const revoked = store.accounts.revokeSessions(me.id, { exceptTokenHash: keep });
    for (const tokenHash of revoked) gateway.disconnectSession(tokenHash);
    return { revoked: revoked.length };
  });

  route(endpoints.createInvite, async ({ user: me, body }) => {
    // A code is a way into the workspace, so making one is something a member
    // is given. Owners and admins always may; see `canInvite` on the user.
    if (!me.canInvite) {
      throw new HttpError(
        403,
        "invite_permission_required",
        "Only people an administrator has allowed can create invite codes.",
      );
    }
    const invite = store.transaction(() => {
      const created = store.accounts.createInvite({
        createdBy: me.id,
        expiresAt: body.expiresInHours ? Date.now() + body.expiresInHours * 3600_000 : null,
        maxUses: body.maxUses ?? null,
      });
      store.audit.record({
        actorId: me.id,
        action: "invite.created",
        targetType: "invite",
        targetId: inviteFingerprint(created.code),
        details: { expiresAt: created.expiresAt, maxUses: created.maxUses },
      });
      return created;
    });
    return { invite };
  });

  route(endpoints.listInvites, async ({ user: me }) => {
    const admin = isAdministrator(me.role);
    return { invites: store.accounts.listInvites(admin ? {} : { createdBy: me.id }) };
  });

  route(endpoints.revokeInvite, async ({ req, user: me, params }) => {
    const admin = isAdministrator(me.role);
    const invite = store.accounts.getInvite(params.code);
    if (!invite || (!admin && invite.createdBy !== me.id)) {
      throw new HttpError(404, "invite_not_found");
    }
    const revoked = store.transaction(() => {
      if (!store.accounts.revokeInvite(invite.code, me.id)) return false;
      store.audit.record({
        actorId: me.id,
        action: "invite.revoked",
        targetType: "invite",
        targetId: inviteFingerprint(invite.code),
        details: { createdBy: invite.createdBy },
      });
      return true;
    });
    if (revoked) {
      // Without the code: the log is not somewhere a credential should end up.
      req.log.info({ createdBy: invite.createdBy, by: me.id }, "invite revoked");
    }
    return { invite: store.accounts.getInvite(invite.code)! };
  });

  /**
   * Runs one password derivation in a slot of the few there are, refusing
   * with auth_busy when they are all taken.
   */
  const hashing = async <T>(work: () => Promise<T>): Promise<T> => {
    beginAuth();
    try {
      return await work();
    } finally {
      authJobs--;
    }
  };

  route(endpoints.serverInfo, async ({ req }) => {
    const userCount = store.people.count();
    const signIn = signInInfo();
    return {
      app: "ownbase",
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: SERVER_VERSION,
      ...(SERVER_BUILD ? { build: SERVER_BUILD } : {}),
      workspaceName: settings.get("workspaceName"),
      userCount,
      requiresInvite: userCount > 0 && settings.get("accessPolicy") === "invite_only",
      accessPolicy: settings.get("accessPolicy"),
      requiresClaim: userCount === 0 && !!settings.get("claimCode") && !network.isLocalRequest(req),
      workspaceCopies: opts.dataDir !== ":memory:",
      ...(network.publicUrl() ? { publicUrl: network.publicUrl() } : {}),
      iconVersion: iconVersion(),
      ...(signIn ? { signIn } : {}),
    };
  });

  return { hashing, signInInfo, singleSignOnRequired, ssoRequired, authSucceeded, confirmPassword };
}
