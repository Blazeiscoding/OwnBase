import type { ID, SignInConnection, SignInMethod } from "@ownbase/protocol";
import { ApiError, type Api } from "./api.js";
import { answerOf, doneOf } from "./answers.js";

/** Where the server may send a browser to link a way of signing in (P9). */
const LINK = /^\/api\/[A-Za-z0-9/_-]+(\?[A-Za-z0-9=&_-]*)?$/;

/**
 * The signed-in account's own settings: its devices, password, two-step
 * sign-in, linked ways of signing in, and the storage it uses. Nothing here
 * is kept in the workspace's store, so each answers as the server does: what
 * it said, or the `ApiError` saying why not.
 */
export class AccountActions {
  constructor(private readonly api: Api) {}

  sessions() {
    return answerOf(async () => (await this.api.listSessions()).sessions);
  }

  signOutDevice(sessionId: ID) {
    return doneOf(() => this.api.revokeSession(sessionId));
  }

  signOutOtherDevices() {
    return doneOf(() => this.api.revokeOtherSessions());
  }

  changePassword(currentPassword: string, newPassword: string) {
    return doneOf(() => this.api.changePassword(currentPassword, newPassword));
  }

  /**
   * Keeps a guest's identity as an account. Every guest session ends, this
   * one included; the token returned replaces it.
   */
  keepAsAccount(body: { handle: string; password: string }) {
    return answerOf(() => this.api.createAccountFromGuest(body));
  }

  storageUsage(signal?: AbortSignal) {
    return answerOf(() => this.api.storageUsage(signal));
  }

  /** Whether this account asks for a code at sign-in, and how many recovery codes it has left (E11). */
  twoStep() {
    return answerOf(() => this.api.twoStep());
  }

  /**
   * Starts setting two-step sign-in up (E11): a new key, and the address an
   * authenticator app scans for it. Nothing changes until `enableTwoStep`.
   */
  startTwoStep(password: string) {
    return answerOf(() => this.api.startTwoStep(password));
  }

  /** The recovery codes, shown once. */
  enableTwoStep(code: string) {
    return answerOf(async () => (await this.api.enableTwoStep(code)).recoveryCodes);
  }

  newRecoveryCodes(password: string) {
    return answerOf(async () => (await this.api.newRecoveryCodes(password)).recoveryCodes);
  }

  disableTwoStep(password: string) {
    return doneOf(() => this.api.disableTwoStep(password));
  }

  /** The ways of signing in this account can link (P9), and whether each is linked. */
  linkedSignIns() {
    return answerOf(async () => {
      const info = await this.api.serverInfo();
      const methods = (info.signIn?.methods ?? []).filter((m) => m.connect);
      const states = await Promise.all(
        methods.map(async (m) => [m.id, await this.api.signInConnection(m.connect!)] as const),
      );
      return {
        methods,
        links: Object.fromEntries(states) as Record<string, SignInConnection>,
      };
    });
  }

  /** The address that links this account to `method`, to open in a browser. */
  linkSignInUrl(method: SignInMethod) {
    return answerOf(async () => {
      const { url } = await this.api.connectSignIn(method.connect!);
      if (!LINK.test(url)) throw new ApiError(502, "invalid_response");
      return `${this.api.baseUrl}${url}`;
    });
  }

  /** Whether `method` is still linked, as the server now has it. */
  unlinkSignIn(method: SignInMethod) {
    return answerOf(() => this.api.disconnectSignIn(method.connect!));
  }
}
