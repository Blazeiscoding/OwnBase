import type { CreateInviteBody, ID, ReportResolution, User } from "@ownbase/protocol";
import { serverPath, type Api } from "./api.js";
import { answerOf, doneOf } from "./answers.js";

/**
 * Looking after the workspace: its people, reports, invites, history of
 * changes, health and copies, and the settings its extensions add. The
 * server refuses whoever may not; invites are the one list anyone may read,
 * their own. Each answers what the server said, or the `ApiError` saying why
 * not.
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
    return answerOf(async () => (await this.api.listAllUsers()).users);
  }

  changePerson(
    userId: ID,
    patch: { role?: "member" | "admin"; deactivated?: boolean; canInvite?: boolean },
  ) {
    return doneOf(async () => {
      const { user } = await this.api.updateUserAdmin(userId, patch);
      this.keepUsers([user]);
    });
  }

  /** A password the person must replace when they next sign in. */
  resetPassword(userId: ID) {
    return answerOf(async () => (await this.api.resetPassword(userId)).temporaryPassword);
  }

  /** Turns someone's two-step sign-in off, for one who lost their app and codes. */
  resetTwoStep(userId: ID) {
    return doneOf(() => this.api.resetTwoStep(userId));
  }

  transferOwnership(userId: ID) {
    return doneOf(async () => {
      const { owner, previousOwner } = await this.api.transferOwnership(userId);
      this.keepUsers([owner, previousOwner]);
    });
  }

  /** The reported messages waiting for an admin (E12). */
  reports() {
    return answerOf(async () => (await this.api.listReports()).reports);
  }

  resolveReport(messageId: ID, action: ReportResolution) {
    return doneOf(() => this.api.resolveReport(messageId, action));
  }

  /** Every invite for an administrator; one's own for everyone else. Newest first. */
  invites() {
    return answerOf(async () => (await this.api.listInvites()).invites);
  }

  createInvite(body: CreateInviteBody = {}) {
    return answerOf(async () => (await this.api.createInvite(body)).invite);
  }

  /** Already-revoked is not an error. */
  revokeInvite(code: string) {
    return doneOf(() => this.api.revokeInvite(code));
  }

  /** A page of what administrators have changed, newest first. */
  audit(before?: string) {
    return answerOf(() => this.api.listAudit(before));
  }

  /** Whether the server is keeping up: sizes, queues and timings, never what is in them (OPS-10). */
  workspaceStatus() {
    return answerOf(() => this.api.workspaceStatus());
  }

  /** What happened in huddles lately. The server keeps it in memory only. */
  callLog() {
    return answerOf(async () => (await this.api.callLog()).entries);
  }

  /** The copy of the workspace its owner can download, if one is being made or kept. */
  workspaceCopy() {
    return answerOf(async () => (await this.api.workspaceCopy()).copy);
  }

  makeWorkspaceCopy() {
    return answerOf(async () => (await this.api.makeWorkspaceCopy()).copy);
  }

  /** An address that downloads the ready copy once, within a minute. */
  workspaceCopyUrl(id: string) {
    return answerOf(() => this.api.workspaceCopyUrl(id));
  }

  /** The panels the server's extensions add to Workspace settings (P9). */
  extensionSettings() {
    return answerOf(async () => (await this.api.extensionSettings()).panels);
  }

  saveExtensionSettings(path: string, values: Record<string, string | boolean>) {
    return doneOf(() => this.api.saveExtensionSettings(path, values));
  }

  /**
   * A settings panel's button, and what it answers, such as a token to show
   * once, or a download as the full address to save it from (P12).
   */
  runSettingsAction(path: string) {
    return answerOf(async () => {
      const answer = await this.api.runSettingsAction(path);
      if (answer.download === undefined) return answer;
      return {
        ...answer,
        download: `${this.api.baseUrl}${serverPath(answer.download, { query: true })}`,
      };
    });
  }
}
