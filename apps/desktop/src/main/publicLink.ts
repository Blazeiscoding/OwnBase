import { ACCESS_POLICIES, isAccessPolicy, type AccessPolicy } from "@ownbase/protocol";
import { DesktopError } from "../shared/desktopError.js";
import type { HostedServer, HostingSnapshot } from "./hosting.js";
import {
  stableAddress,
  TunnelCleanupError,
  type PublicAddressConfig,
  type StableAddress,
  type Tunnel,
} from "./tunnel.js";

/**
 * Calls through a tunnel still go directly between people, so each side has
 * to find its public address. Cloudflare already carries the tunnel, so its
 * STUN server adds nobody new.
 */
export const OPEN_TO_ALL_ICE_SERVERS = [{ urls: "stun:stun.cloudflare.com:3478" }];

/** What the hosting controller tells its public link about the run, read at each use. */
export interface PublicLinkRun {
  server: HostedServer | null;
  phase: HostingSnapshot["phase"];
  /** The running workspace is a restored copy started only to look inside. */
  isolated: boolean;
  stopFailed: boolean;
  /** Counts starts, so a step that waited can tell the run it began with from a later one. */
  runs: number;
  /** OwnBase is quitting. */
  quitting: boolean;
}

export type PublicLink = ReturnType<typeof createPublicLink>;

/**
 * The running workspace's public link: the tunnel that carries it, the
 * address links are built on, and who may join while it is open.
 */
export function createPublicLink(deps: {
  /** Opens a tunnel to a port on this computer: to the stable address given, or a temporary one. */
  openTunnel(
    port: number,
    signal: AbortSignal,
    instanceId: string,
    address: StableAddress | null,
  ): Promise<Tunnel>;
  /** The stable public address configured for this computer, read for each use. */
  publicAddress(): { saved: string | null; config: PublicAddressConfig };
  /** Persists an address the host supplied, after the link makes the change safe. */
  savePublicAddress(address: string | null): Promise<void>;
  run(): PublicLinkRun;
  serialized<T>(operation: () => Promise<T>): Promise<T>;
  changed(): void;
  refuseWhileQuitting(): void;
  /** Waits for cleanup, up to the controller's deadline. */
  finishCleanup(work: Promise<void>, message: string): Promise<void>;
  /** The running workspace is public now, which a failed reopen of it was waiting for. */
  publicReopened(): void;
}) {
  const { serialized, changed, finishCleanup, publicReopened } = deps;
  let tunnel: Tunnel | null = null;
  /** A connector returned before cancellation/setup failed, not safe to publish or forget. */
  let cleanupTunnel: Tunnel | null = null;
  /** The current address is carried by a process outside this app's control. */
  let externalCarrier = false;
  /**
   * Who could join before the public link opened. Guests let in while it is
   * open leave with it; any other rule chosen then stays, as it always has.
   * An owner or admin choosing in Workspace settings meanwhile forgets it:
   * what they chose is the workspace's, and closing the link keeps it.
   */
  let policyBeforeOpen: AccessPolicy | undefined;
  /**
   * Counts who-may-join changes made inside the workspace by an owner or
   * admin. A step that read the rule before waiting puts back what it read
   * only if this has not moved meanwhile, so it never undoes their choice.
   */
  let workspacePolicyChanges = 0;
  /** Set while a tunnel is opening, so stopping or quitting need not wait for it. */
  let opening: AbortController | null = null;
  let openError: string | undefined;
  /** Invalidates public-open requests that were queued before a close or stop. */
  let publicRequest = 0;

  /** The stable address a public link would be opened at now, if one is configured and valid. */
  function stableUrl(): string | undefined {
    return stableAddress(deps.publicAddress().config)?.publicUrl;
  }

  /** The link's part of the hosting status. */
  function status(): Pick<HostingSnapshot, "openToAll" | "openToAllError"> {
    return {
      ...(opening
        ? { openToAll: { phase: "opening" as const } }
        : tunnel
          ? { openToAll: { phase: "open" as const, url: tunnel.url } }
          : {}),
      ...(openError ? { openToAllError: openError } : {}),
    };
  }

  /** Back to reachable only on this network: no public address, no STUN. */
  function closeReach(target: HostedServer): void {
    for (const clear of [
      () => target.setTrustLoopbackProxy(false),
      () => target.setPublicUrl(null),
      () => target.setIceServers([]),
    ]) {
      try {
        clear();
      } catch {
        // Keep clearing the other public state even if an implementation fails.
      }
    }
  }

  async function endTunnel(): Promise<void> {
    const current = tunnel ?? cleanupTunnel;
    if (!current) return;
    const server = deps.run().server;
    const openPolicy =
      tunnel === current && !externalCarrier && server ? server.accessPolicy() : undefined;
    const previousPolicy =
      openPolicy === "guest_allowed" && policyBeforeOpen && policyBeforeOpen !== "guest_allowed"
        ? policyBeforeOpen
        : openPolicy;
    policyBeforeOpen = undefined;
    const policyChanges = workspacePolicyChanges;
    // A close may reject or time out while its connector is still exiting.
    // Keep every public-access mutation gated until that same handle closes.
    cleanupTunnel = current;
    // Remove the public address from new links before asking the connector to
    // drain. Keep its handle/status until exit is confirmed so closing can be
    // retried if the child process refuses to stop.
    if (server) {
      closeReach(server);
      // Stopping our use of an external route cannot stop that route. Keep it
      // from becoming an open-registration endpoint if it is still running.
      if (externalCarrier || cleanupTunnel) server.setAccessPolicy("invite_only");
    }
    await finishCleanup(current.close(), "The public link did not finish closing in time.");
    if (tunnel === current) {
      tunnel = null;
      externalCarrier = false;
    }
    if (cleanupTunnel === current) {
      cleanupTunnel = null;
    }
    const closedOn = deps.run().server;
    // Chosen inside the workspace while the link closed, the rule stays theirs.
    if (previousPolicy !== undefined && closedOn && policyChanges === workspacePolicyChanges)
      closedOn.setAccessPolicy(previousPolicy);
  }

  function cancelPublicOpen(): void {
    publicRequest += 1;
    opening?.abort();
  }

  /**
   * Opens the running workspace to all: a tunnel gives it an https address
   * anyone can reach, links are built on that address, and calls look for a
   * route across networks. Who may join becomes `accessPolicy`, invited
   * accounts only unless it says otherwise.
   */
  function openToAll(value: unknown = {}): Promise<void> {
    const { accessPolicy } =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as { accessPolicy?: unknown })
        : {};
    if (accessPolicy !== undefined && !isAccessPolicy(accessPolicy))
      return Promise.reject(new Error(`Say who may join with one of ${ACCESS_POLICIES}.`));
    const request = publicRequest;
    // Asked for one run, it never opens another that started while it waited.
    const run = deps.run().runs;
    return serialized(async () => {
      const state = deps.run();
      if (state.quitting || request !== publicRequest || run !== state.runs)
        throw new Error("Getting a public link was cancelled.");
      const target = state.server;
      if (!target || state.phase !== "running")
        throw new Error("Start hosting the workspace before getting a public link.");
      if (state.isolated)
        throw new Error(
          "A restored copy you are looking inside cannot have a public link. Put it back in use first.",
        );
      if (state.stopFailed)
        throw new Error("Finish stopping the workspace before changing its public link.");
      if (cleanupTunnel)
        throw new Error(
          "Stop hosting to finish closing the previous public link, then get a new one.",
        );
      // A configured stable address that cannot be used has to be corrected.
      // Falling back would publish a temporary link nobody was given. An
      // already open link keeps working, so its policy can still be changed.
      const { config } = deps.publicAddress();
      if (!tunnel && config && "error" in config) throw new Error(config.error);
      const configured = stableAddress(config);
      const carriedElsewhere = configured?.carrier === "elsewhere";
      const setPolicy = target.setAccessPolicy;
      // Through a tunnel nothing counts as this computer's own, so the owner
      // would need the claim code to create their account. Theirs comes first.
      if (target.accountCount() === 0)
        throw new DesktopError(
          "owner-account-missing",
          "Create your own account in the workspace first, then get a public link.",
        );
      const previousPolicy = target.accessPolicy();
      const closedPolicy: AccessPolicy = carriedElsewhere ? "invite_only" : previousPolicy;
      if (!tunnel) policyBeforeOpen = previousPolicy;
      const policyChanges = workspacePolicyChanges;
      /**
       * Back to the rule from before, when the link did not open. One an owner
       * or admin chose meanwhile stays, unless something else may be carrying
       * the address, when joining closes whatever was chosen.
       */
      const putBackPolicy = () => {
        if (carriedElsewhere || policyChanges === workspacePolicyChanges) setPolicy(closedPolicy);
      };
      openError = undefined;
      setPolicy(accessPolicy ?? "invite_only");
      if (tunnel) {
        publicReopened();
        changed();
        return;
      }
      const attempt = new AbortController();
      opening = attempt;
      openError = undefined;
      changed();
      let opened: Tunnel;
      try {
        opened = await deps.openTunnel(target.port, attempt.signal, target.instanceId, configured);
      } catch (error) {
        if (error instanceof TunnelCleanupError) {
          cleanupTunnel = error.tunnel;
          setPolicy("invite_only");
          closeReach(target);
          openError =
            "The public link could not finish closing. Stop hosting to try closing it again, then get a new one.";
          if (opening === attempt) opening = null;
          changed();
          throw error;
        }
        try {
          putBackPolicy();
        } catch {
          // The original opening error remains the useful one to report.
        }
        // Called off by stopping, quitting or turning it off: nothing failed.
        if (!attempt.signal.aborted)
          openError = error instanceof Error ? error.message : String(error);
        if (opening === attempt) opening = null;
        changed();
        throw error;
      }
      cleanupTunnel = opened;
      if (opening === attempt) opening = null;
      if (attempt.signal.aborted || request !== publicRequest || deps.run().quitting) {
        setPolicy("invite_only");
        try {
          await endTunnel();
        } catch (error) {
          openError =
            "The cancelled public link could not finish closing. Stop hosting to try closing it again, then get a new one.";
          changed();
          throw error;
        }
        putBackPolicy();
        changed();
        throw new Error("Getting a public link was cancelled.");
      }
      try {
        // Only a connector OwnBase starts is known to replace Cloudflare's
        // client-address header. A generic local proxy may pass a forged one.
        if (!carriedElsewhere) target.setTrustLoopbackProxy(true);
        target.setPublicUrl(opened.url);
        target.setIceServers(OPEN_TO_ALL_ICE_SERVERS);
      } catch (error) {
        closeReach(target);
        setPolicy("invite_only");
        try {
          await endTunnel();
        } catch (cleanupError) {
          openError =
            "Setting up the public link failed, and the link could not finish closing. Stop hosting to try closing it again, then get a new one.";
          changed();
          throw cleanupError;
        }
        putBackPolicy();
        openError =
          "The workspace could not use its public link. Press Get a public link to try again.";
        changed();
        throw error;
      }
      tunnel = opened;
      cleanupTunnel = null;
      externalCarrier = carriedElsewhere;
      publicReopened();
      opened.onUnexpectedExit((reason) => {
        if (tunnel !== opened) return;
        tunnel = null;
        const wasExternal = externalCarrier;
        externalCarrier = false;
        closeReach(target);
        if (wasExternal) setPolicy("invite_only");
        openError = configured
          ? `The public link stopped working (${reason}). Fix its connection, then press Get a public link to open it at the same address.`
          : `The public link stopped working (${reason}). Press Get a public link for a new one.`;
        changed();
      });
      changed();
    });
  }

  /** Back to this network only. Links go back to its addresses. */
  function endOpenToAll(): Promise<void> {
    cancelPublicOpen();
    return serialized(async () => {
      openError = undefined;
      try {
        await endTunnel();
      } catch (error) {
        openError = "The public link could not finish closing. Try closing it again.";
        changed();
        throw error;
      }
      changed();
    });
  }

  /**
   * Changes the saved external address in the same queue as opening it. An
   * external carrier may already be live, so registration is secured before
   * persistence and remains secured if saving fails.
   */
  function setPublicAddress(value: string | null): Promise<void> {
    return serialized(async () => {
      deps.refuseWhileQuitting();
      if (tunnel || opening || cleanupTunnel)
        throw new Error("Stop using the current public address before changing it.");
      const { server, phase } = deps.run();
      if (server && phase === "running") server.setAccessPolicy("invite_only");
      await deps.savePublicAddress(value);
      openError = undefined;
      changed();
    });
  }

  return {
    stableUrl,
    status,
    /** A link that did not finish closing; nothing else may change who can reach the workspace until it does. */
    closeUnfinished: () => cleanupTunnel !== null,
    open: openToAll,
    end: endOpenToAll,
    /** Closes the link in the caller's turn, as stopping does. */
    endTunnel,
    cancel: cancelPublicOpen,
    setPublicAddress,
    /** Stopping forgets why the last link did not open. */
    clearError(): void {
      openError = undefined;
    },
    /**
     * An owner or admin chose who may join inside the workspace. What they
     * chose is the workspace's, so nothing here puts back an older rule.
     */
    workspaceChoseRule(): void {
      workspacePolicyChanges += 1;
      policyBeforeOpen = undefined;
    },
  };
}
