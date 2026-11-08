import type { ID, SignInConnection, SignInMethod } from "@ownbase/protocol";
import { ApiError, type Api } from "./api.js";

/** Where the server may send a browser to link a way of signing in (P9). */
const LINK = /^\/api\/[A-Za-z0-9/_-]+(\?[A-Za-z0-9=&_-]*)?$/;

/**
 * The signed-in account's own settings: its devices, password, two-step
 * sign-in, linked ways of signing in, and the storage it uses. Nothing here
 * is kept in the workspace's store, so each answers as the server does.
 */
export class AccountActions {
  constructor(private readonly api: Api) {}

  sessions() {
    return this.api.listSessions();
  }

  signOutDevice(sessionId: ID) {
    return this.api.revokeSession(sessionId);
  }

  signOutOtherDevices() {
    return this.api.revokeOtherSessions();
  }

  changePassword(currentPassword: string, newPassword: string) {
    return this.api.changePassword(currentPassword, newPassword);
  }

  /**
   * Keeps a guest's identity as an account. Every guest session ends, this
   * one included; the token returned replaces it.
   */
  keepAsAccount(body: { handle: string; password: string }) {
    return this.api.createAccountFromGuest(body);
  }

  storageUsage(signal?: AbortSignal) {
    return this.api.storageUsage(signal);
  }

  /** Whether this account asks for a code at sign-in, and how many recovery codes it has left (E11). */
  twoStep() {
    return this.api.twoStep();
  }

  /**
   * Starts setting two-step sign-in up (E11): a new key, and the address an
   * authenticator app scans for it. Nothing changes until `enableTwoStep`.
   */
  startTwoStep(password: string) {
    return this.api.startTwoStep(password);
  }

  /** The recovery codes, shown once. */
  enableTwoStep(code: string) {
    return this.api.enableTwoStep(code);
  }

  newRecoveryCodes(password: string) {
    return this.api.newRecoveryCodes(password);
  }

  disableTwoStep(password: string) {
    return this.api.disableTwoStep(password);
  }

  /** The ways of signing in this account can link (P9), and whether each is linked. */
  async linkedSignIns(): Promise<{
    methods: SignInMethod[];
    links: Record<string, SignInConnection>;
  }> {
    const info = await this.api.serverInfo();
    const methods = (info.signIn?.methods ?? []).filter((m) => m.connect);
    const states = await Promise.all(
      methods.map(async (m) => [m.id, await this.api.signInConnection(m.connect!)] as const),
    );
    return { methods, links: Object.fromEntries(states) };
  }

  /** The address that links this account to `method`, to open in a browser. */
  async linkSignInUrl(method: SignInMethod): Promise<string> {
    const { url } = await this.api.connectSignIn(method.connect!);
    if (!LINK.test(url)) throw new ApiError(502, "invalid_response");
    return `${this.api.baseUrl}${url}`;
  }

  unlinkSignIn(method: SignInMethod) {
    return this.api.disconnectSignIn(method.connect!);
  }
}
