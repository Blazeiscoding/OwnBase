import {
  ACCESS_POLICIES,
  isAdministrator,
  workspaceNameSchema,
  type AccessPolicy,
  type ID,
  type MemberNotice,
  type ServerNotice,
  type User,
} from "@ownbase/protocol";
import type { ServerContext } from "../core/context.js";
import { secretToken } from "../ids.js";
import type { WorkspaceIcon } from "./workspaceIcon.js";

/** A change to the workspace itself, as `WorkspaceServer.onWorkspaceChange` reports it. */
export interface WorkspaceChange {
  workspaceName?: string;
  accessPolicy?: AccessPolicy;
  /** The icon's new version when it changed, or null when it was removed. */
  iconVersion?: string | null;
  /** The owner or admin who made the change, or null for the host. */
  by: ID | null;
}

export const isAccessPolicy = (value: unknown): value is AccessPolicy =>
  ACCESS_POLICIES.includes(value as AccessPolicy);

/** Refuses a start whose workspace options cannot work, before the database opens. */
export function checkWorkspaceOptions(opts: ServerContext["opts"]): void {
  if (opts.accessPolicy !== undefined && !isAccessPolicy(opts.accessPolicy))
    throw new TypeError(`accessPolicy must be one of ${ACCESS_POLICIES}`);
}

/**
 * The workspace itself: its name, who may join, its icon and whether
 * messages get link previews. Its host and its owner and admins change them
 * by the same rules, each change recorded and told to everyone signed in.
 */
export function createWorkspace(ctx: ServerContext) {
  const { opts, store, settings, gateway, lifecycle, log } = ctx;

  // Before anyone owns the workspace, nobody in it could change its name or
  // who may join, so what it is started with decides both. Once it has an
  // owner they are its own, changed by its owner and admins, and a start
  // never puts back an older choice over theirs.
  const unowned = store.people.count() === 0;
  if (opts.workspaceName && (unowned || settings.stored("workspaceName") === null))
    settings.set("workspaceName", opts.workspaceName);
  if (settings.stored("workspaceName") === null)
    settings.set("workspaceName", settings.get("workspaceName"));
  settings.get("workspaceId");
  // Before guest access, invite_only alone said who could join: on, invited
  // accounts; off, any account. A workspace keeps that until someone chooses.
  if (settings.stored("accessPolicy") === null)
    settings.set(
      "accessPolicy",
      settings.get("inviteOnlyBefore") ? "invite_only" : "account_required",
    );

  const accessPolicy = (): AccessPolicy => settings.get("accessPolicy");
  /** Held here once read, since everyone who opens the workspace or finds it to join asks for it. */
  let icon: WorkspaceIcon | null = settings.get("icon");

  /**
   * Writes who may join, in one write with whatever `record` adds, and ends
   * every guest session when guests are no longer allowed. Returns the ended
   * sessions, whose sockets are the caller's to close.
   */
  const writeAccessPolicy = (policy: AccessPolicy, record?: () => void): string[] =>
    store.transaction(() => {
      settings.set("accessPolicy", policy);
      record?.();
      return policy === "guest_allowed" ? [] : store.accounts.revokeGuestSessions();
    });
  /** Off unless guests are allowed; off again keeps the other choice. */
  const withInvites = (on: boolean): AccessPolicy =>
    on ? "invite_only" : accessPolicy() === "invite_only" ? "account_required" : accessPolicy();
  if (unowned) {
    if (opts.accessPolicy !== undefined) writeAccessPolicy(opts.accessPolicy);
    else if (opts.inviteOnly !== undefined) writeAccessPolicy(withInvites(opts.inviteOnly));
  }

  /**
   * A workspace with no owner is up for grabs. Until one exists, the account
   * that becomes owner must come either from the machine running the server or
   * from someone holding the code it printed at startup — otherwise the first
   * stranger to find it on the network owns it. A host that hands out the
   * link to claim it gives the code instead (P7), and the one it gives last
   * is the one in force.
   */
  if (unowned) {
    if (opts.claimCode) settings.set("claimCode", opts.claimCode);
    else if (!settings.get("claimCode")) settings.set("claimCode", secretToken());
  }

  /** Whatever shows the workspace from outside it, such as a desktop host's window. */
  const listeners = new Set<(change: WorkspaceChange) => void>();
  const changed = (change: WorkspaceChange) => {
    for (const listener of [...listeners]) {
      try {
        listener(change);
      } catch (err) {
        // The change is made and told to everyone; one listener failing to
        // hear it must not undo that or keep it from the others.
        log.error({ err }, "a workspace change listener failed");
      }
    }
  };

  /** Renames the workspace. Everyone signed in is told at once, and the record says who did it. */
  const rename = (value: unknown, by: ID | null): string => {
    const parsed = workspaceNameSchema.safeParse(value);
    if (!parsed.success)
      throw new TypeError("A workspace name has 1 to 80 characters and no control characters.");
    if (lifecycle.closing) throw new Error("The workspace is stopping.");
    const name = parsed.data;
    const previous = settings.get("workspaceName");
    if (name === previous) return name;
    store.transaction(() => {
      settings.set("workspaceName", name);
      store.audit.record({
        actorId: by,
        action: "workspace.renamed",
        targetType: "workspace",
        targetId: null,
        details: { from: previous, to: name },
      });
    });
    gateway.tellEveryone({ type: "workspace.renamed", workspaceName: name });
    changed({ workspaceName: name, by });
    return name;
  };

  /**
   * Changes who may join. Turning guests off signs every guest out at once,
   * their sockets included, and everyone signed in is told what the
   * workspace now allows.
   */
  const changeAccessPolicy = (policy: AccessPolicy, by: ID | null): void => {
    const previous = accessPolicy();
    const ended = writeAccessPolicy(policy, () => {
      if (policy === previous) return;
      store.audit.record({
        actorId: by,
        action: "workspace.access_policy_changed",
        targetType: "workspace",
        targetId: null,
        details: { from: previous, to: policy },
      });
    });
    for (const tokenHash of ended) gateway.disconnectSession(tokenHash);
    if (policy === previous) return;
    gateway.tellEveryone({ type: "workspace.accessPolicy", accessPolicy: policy });
    changed({ accessPolicy: policy, by });
  };

  /**
   * Sets or removes the workspace's icon. The rows change in one write with
   * the record of who did it, which names the image's type and size but
   * never holds it.
   */
  const changeIcon = (next: WorkspaceIcon | null, by: ID | null): void => {
    if (lifecycle.closing) throw new Error("The workspace is stopping.");
    if ((icon?.version ?? null) === (next?.version ?? null)) return;
    store.transaction(() => {
      settings.set("icon", next);
      store.audit.record({
        actorId: by,
        action: "workspace.icon_changed",
        targetType: "workspace",
        targetId: null,
        details: next
          ? { change: "set", type: next.type, bytes: next.bytes.length }
          : { change: "removed" },
      });
    });
    icon = next;
    const iconVersion = next?.version ?? null;
    gateway.tellEveryone({ type: "workspace.icon", iconVersion });
    changed({ iconVersion, by });
  };

  const setLinkPreviews = (enabled: boolean, by: ID): void => {
    if (enabled === settings.get("linkPreviews")) return;
    store.transaction(() => {
      settings.set("linkPreviews", enabled);
      store.audit.record({
        actorId: by,
        action: "workspace.link_previews_changed",
        targetType: "workspace",
        targetId: null,
        details: { from: !enabled, to: enabled },
      });
    });
    gateway.tellEveryone({ type: "workspace.linkPreviews", enabled });
  };

  /** The plan's member notice and the extensions' notices, when there are any. */
  const notices = (): { memberNotice?: MemberNotice; notices?: ServerNotice[] } => {
    const notice = opts.memberNotice ?? null;
    const told = (opts.extensions ?? []).flatMap((extension) => {
      const said = extension.notice?.();
      return said ? [said] : [];
    });
    return {
      ...(notice ? { memberNotice: notice } : {}),
      ...(told.length > 0 ? { notices: told } : {}),
    };
  };

  const snapshot = (user: User) => ({
    accessPolicy: accessPolicy(),
    iconVersion: icon?.version ?? null,
    linkPreviews: settings.get("linkPreviews"),
    workspaceName: settings.get("workspaceName"),
    workspaceId: settings.get("workspaceId"),
    ...(isAdministrator(user.role) ? { openReports: store.reports.openCount(), ...notices() } : {}),
  });

  return {
    accessPolicy,
    icon: () => icon,
    rename,
    changeAccessPolicy,
    changeIcon,
    setLinkPreviews,
    snapshot,
    onChange(listener: (change: WorkspaceChange) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;
