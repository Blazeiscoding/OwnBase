import type { LastHosted, SavedServer } from "../platform.js";
import { isLoopbackUrl } from "./deeplink.js";

export type { LastHosted };

interface HostingState {
  running: boolean;
  phase?: string;
}

/**
 * A saved workspace this computer hosted last, while hosting is stopped —
 * the one that would otherwise just say it is reconnecting. Matches by loopback
 * address and port rather than by name, since names can repeat and addresses
 * move; the port is what the remembered workspace would answer on.
 */
export function resumeTarget(
  saved: SavedServer[],
  hosting: HostingState | null | undefined,
  lastHosted: LastHosted | null,
): { saved: SavedServer; workspaceName: string } | null {
  if (!lastHosted) return null;
  if (hosting && (hosting.running || hosting.phase === "starting" || hosting.phase === "stopping"))
    return null;
  if (!hosting) return null;
  const match = saved.find((server) => {
    let url: URL;
    try {
      url = new URL(server.url);
    } catch {
      return false;
    }
    if (!isLoopbackUrl(server.url)) return false;
    // An empty port is a default web port, never a hosted workspace.
    if (url.port === "") return false;
    return Number(url.port) === lastHosted.port;
  });
  return match ? { saved: match, workspaceName: lastHosted.workspaceName } : null;
}

/**
 * Whether opening this workspace would only ever reconnect: it is the one
 * this computer hosted last and hosting is stopped. Anything unreadable
 * answers no, keeping the previous behavior of trying to connect.
 */
export async function hostedButStopped(
  server: SavedServer,
  hosting:
    | {
        status: () => Promise<HostingState>;
        lastHosted: () => Promise<LastHosted | null>;
      }
    | undefined,
): Promise<boolean> {
  if (!hosting) return false;
  try {
    const [status, remembered] = await Promise.all([hosting.status(), hosting.lastHosted()]);
    return resumeTarget([server], status, remembered) !== null;
  } catch {
    return false;
  }
}
