import type { CreateInviteBody, ID, ReportResolution, User } from "@ownbase/protocol";
import type { Api } from "./api.js";

/**
 * Looking after the workspace: its people, reports, invites, history of
 * changes, health and copies, and the settings its extensions add. The
 * server refuses whoever may not; invites are the one list anyone may read,
 * their own.
 */
export class AdminActions {
  constructor(
    private readonly api: Api,
    /** Shows accounts the server just changed, before the socket's copy of the change. */
    private readonly keepUsers: (users: User[]) => void,
  ) {}

  /**
   * Everyone with an account, with when they were last seen, and whether they
   * have two-step sign-in (E11).
   */
  people() {
    return this.api.listAllUsers();
  }

  /** Changes someone's role, or takes their access away. */
  async changePerson(
    userId: ID,
    patch: { role?: "member" | "admin"; deactivated?: boolean; canInvite?: boolean },
  ) {
    const result = await this.api.updateUserAdmin(userId, patch);
    this.keepUsers([result.user]);
    return result;
  }

  resetPassword(userId: ID) {
    return this.api.resetPassword(userId);
  }

  /** Turns someone's two-step sign-in off, for one who lost their app and codes. */
  resetTwoStep(userId: ID) {
    return this.api.resetTwoStep(userId);
  }

  async transferOwnership(userId: ID) {
    const result = await this.api.transferOwnership(userId);
    this.keepUsers([result.owner, result.previousOwner]);
    return result;
  }

  /** The reported messages waiting for an admin (E12). */
  reports() {
    return this.api.listReports();
  }

  resolveReport(messageId: ID, action: ReportResolution) {
    return this.api.resolveReport(messageId, action);
  }

  /** Every invite for an administrator; one's own for everyone else. Newest first. */
  invites() {
    return this.api.listInvites();
  }

  createInvite(body: CreateInviteBody = {}) {
    return this.api.createInvite(body);
  }

  /** Already-revoked is not an error. */
  revokeInvite(code: string) {
    return this.api.revokeInvite(code);
  }

  /** A page of what administrators have changed, newest first. */
  audit(before?: string) {
    return this.api.listAudit(before);
  }

  /** Whether the server is keeping up: sizes, queues and timings, never what is in them (OPS-10). */
  workspaceStatus() {
    return this.api.workspaceStatus();
  }

  /** What happened in huddles lately. The server keeps it in memory only. */
  callLog() {
    return this.api.callLog();
  }

  /** The copy of the workspace its owner can download, if one is being made or kept. */
  workspaceCopy() {
    return this.api.workspaceCopy();
  }

  makeWorkspaceCopy() {
    return this.api.makeWorkspaceCopy();
  }

  /** An address that downloads the ready copy once, within a minute. */
  workspaceCopyUrl(id: string) {
    return this.api.workspaceCopyUrl(id);
  }

  /** The panels the server's extensions add to Workspace settings (P9). */
  extensionSettings() {
    return this.api.extensionSettings();
  }

  saveExtensionSettings(path: string, values: Record<string, string | boolean>) {
    return this.api.saveExtensionSettings(path, values);
  }
}
