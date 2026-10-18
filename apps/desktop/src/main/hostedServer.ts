import type { CallRelay, WorkspaceServer, createWorkspaceServer } from "@slackoss/server";
import type { HostedServer } from "./hosting.js";

/** What the app supplies to start a workspace's server. */
export interface HostedServerHost {
  createServer: typeof createWorkspaceServer;
  /** Where the web client the server hands out is kept. */
  webDistPath: string;
  savedRelay(): Promise<CallRelay | null>;
  /** Running workspaces that calls can be given a relay by, so a change reaches them at once. */
  relayServers: Set<WorkspaceServer>;
  /** Whether a stable public address is set for this computer. */
  publicAddressConfigured(): boolean;
}

/**
 * Starts a workspace's server and hands it to the hosting controller as the
 * controller knows one.
 *
 * The server is listening, and holds its folder, from the moment it is made,
 * which is before the controller has anything it could stop. So what is done
 * to it between then and handing it over must not lose it: when that fails the
 * server is stopped here and the failure is the start's. Left running, it
 * would go on answering with joining as open as it was found, while the app
 * said the workspace was stopped and could not start it again (Q12).
 */
export async function startHostedServer(
  request: { dataDir: string; port: number; workspaceName?: string; isolated?: boolean },
  host: HostedServerHost,
): Promise<HostedServer> {
  const { dataDir, port, workspaceName, isolated } = request;
  const server = await host.createServer({
    dataDir,
    port,
    workspaceName,
    // A restored copy being looked inside is reachable from this computer
    // only, sends nothing queued, calls no app, and is not announced.
    ...(isolated ? { isolated: true, host: "127.0.0.1" } : {}),
    mdns: !isolated,
    webDistPath: host.webDistPath,
    // A relay that cannot be read leaves calls on this network working;
    // the hosting window says why.
    relay: isolated ? null : await host.savedRelay().catch(() => null),
  });
  try {
    if (!isolated) host.relayServers.add(server);
    // An external carrier may already be forwarding this port, and an app-owned
    // connector may have survived an ungraceful exit. Never leave registration
    // open while any stable public address is configured. This is the one
    // start that changes who may join over what the workspace holds: it only
    // ever closes joining, and the record names the host as having done it.
    if (host.publicAddressConfigured()) server.setInviteOnly(true);
  } catch (error) {
    host.relayServers.delete(server);
    try {
      await server.stop();
    } catch (stopError) {
      throw new AggregateError(
        [error, stopError],
        "The workspace could not finish starting, and then could not be stopped. Quit Tandem and open it again before starting this workspace.",
      );
    }
    throw error;
  }
  return {
    port: server.port,
    instanceId: server.instanceId,
    workspaceId: () => server.store.getMeta("workspace_id") ?? null,
    workspaceName: () => server.workspaceName(),
    setWorkspaceName: (name) => server.setWorkspaceName(name),
    // An owner or admin renaming it, or changing who may join, in Workspace
    // settings: the hosting window and the list follow.
    onWorkspaceChange: (listener) => server.onWorkspaceChange(listener),
    reannounce: () => server.reannounce(),
    connectedPeople: () => server.connectedPeople(),
    onConnectedChange: (listener) => server.onConnectedChange(listener),
    stop: async () => {
      await server.stop();
      host.relayServers.delete(server);
    },
    setPublicUrl: (url) => server.setPublicUrl(url),
    // cloudflared reaches this embedded server from loopback. Believe its
    // visitor address only while the controller owns a live connector.
    setTrustLoopbackProxy: (enabled) => server.setTrustLoopbackProxy(enabled),
    setIceServers: (servers) => server.setIceServers(servers),
    inviteOnly: () => server.inviteOnly(),
    setInviteOnly: (value) => server.setInviteOnly(value),
    accessPolicy: () => server.accessPolicy(),
    setAccessPolicy: (policy) => server.setAccessPolicy(policy),
    accountCount: () => server.store.userCount(),
  };
}
