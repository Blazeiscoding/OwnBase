import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ClientContext, useClient, useWorkspace } from "../context.js";
import type { Platform } from "../platform.js";
import { isLoopbackUrl, shareableServer, type ShareableServer } from "../lib/deeplink.js";
import { normalizeServerUrlSafe } from "../lib/deeplinkHelpers.js";
import { useHostingStatus } from "../lib/hosting.js";
import { trustedWorkspaceAddresses } from "../lib/workspaceAddressTrust.js";

const ShareableServerContext = createContext<ShareableServer | null>(null);
const WorkspaceAddressesContext = createContext<ReadonlySet<string> | null>(null);

/**
 * Works out, for the workspace on screen, which address the links people copy
 * should carry. Kept ready rather than fetched on copy: a clipboard write has
 * to follow the click that asked for it, not a request to the server. The
 * lightweight server-info read is repeated after reconnect, when the page
 * returns to the foreground, and occasionally while it stays open so a tunnel
 * opened or replaced elsewhere does not leave stale links behind.
 */
export function ShareableServerProvider(props: { platform: Platform; children: ReactNode }) {
  const client = useClient();
  const online = useWorkspace((s) => s.status === "online");
  const [publicUrl, setPublicUrl] = useState<string | null | undefined>(undefined);
  // Only a host looking at its own workspace through localhost needs to know
  // what else this computer answers on.
  const hosting = useHostingStatus(
    isLoopbackUrl(client.baseUrl) ? props.platform.hosting : undefined,
  );

  useEffect(() => {
    setPublicUrl(undefined);
    if (!online) return;
    let live = true;
    let revision = 0;
    let applied = 0;
    const refresh = () => {
      const request = ++revision;
      void client.api
        .serverInfo()
        .then((info) => {
          // A later successful read wins. If that later read fails, an older
          // successful response is still better than leaving the address unknown.
          if (live && request > applied) {
            applied = request;
            setPublicUrl(info.publicUrl ?? null);
          }
        })
        .catch(() => {});
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [client, online]);

  const computed = useMemo(
    () => shareableServer({ baseUrl: client.baseUrl, publicUrl, hosting: hosting.status }),
    [client.baseUrl, publicUrl, hosting.status],
  );
  // The hosting status changes with every connection and backup, which no
  // link carries. Keep the same value while it says the same thing, so every
  // message row reading it renders only when a link would change (REV-03).
  const sameLinks = [computed.serverUrl, computed.localOnly, ...computed.alternatives].join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo(() => computed, [sameLinks]);

  // Addresses this device has linked to the workspace, read once it is known.
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const selfId = useWorkspace((s) => s.self?.id);
  const [linked, setLinked] = useState<string[]>([]);
  useEffect(() => {
    setLinked([]);
    if (!workspaceId || !selfId) return;
    let live = true;
    void trustedWorkspaceAddresses(props.platform, workspaceId, selfId).then((addresses) => {
      if (live) setLinked(addresses);
    });
    return () => {
      live = false;
    };
  }, [props.platform, workspaceId, selfId]);

  const addresses = useMemo(() => {
    const known = [
      client.baseUrl,
      value.serverUrl,
      ...value.alternatives,
      ...(publicUrl ? [publicUrl] : []),
      ...linked,
    ];
    return new Set(known.flatMap((address) => normalizeServerUrlSafe(address) ?? []));
  }, [client.baseUrl, value, publicUrl, linked]);

  return (
    <ShareableServerContext.Provider value={value}>
      <WorkspaceAddressesContext.Provider value={addresses}>
        {props.children}
      </WorkspaceAddressesContext.Provider>
    </ShareableServerContext.Provider>
  );
}

/**
 * Every address this workspace is known by here: the one this app is
 * connected through, the one its host published, the ones this computer
 * answers on when it hosts it, and the ones this device has linked to it.
 * Another server holding the same ids, as a restored copy of this workspace
 * does, is none of these. Null outside a workspace.
 */
export function useWorkspaceAddresses(): ReadonlySet<string> | null {
  return useContext(WorkspaceAddressesContext);
}

/**
 * Whether an address is this workspace's, so that a link to one of its
 * messages opens it here and shows it under the message that links it.
 * Outside the provider, only the address this app is connected through is.
 */
export function useOwnAddress(): (serverUrl: string) => boolean {
  const known = useWorkspaceAddresses();
  const baseUrl = useContext(ClientContext)?.baseUrl;
  const connected = baseUrl ? normalizeServerUrlSafe(baseUrl) : null;
  return useCallback(
    (serverUrl: string) => (known ? known.has(serverUrl) : serverUrl === connected),
    [known, connected],
  );
}

/** The address to build shared links on, and whether it reaches only this computer. */
export function useShareableServer(): ShareableServer {
  const client = useClient();
  const shared = useContext(ShareableServerContext);
  return shared ?? shareableServer({ baseUrl: client.baseUrl });
}
