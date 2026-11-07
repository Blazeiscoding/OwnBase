import { PROTOCOL_VERSION, type ServerInfo } from "@ownbase/protocol";
import { ApiError } from "@ownbase/client-core";

/** An address without its scheme, for reading aloud in a sentence. */
export const host = (url: string) => url.replace(/^https?:\/\//, "");

/**
 * Why a workspace did not answer.
 *
 * Unreachable, refused credentials, and a browser blocking mixed content are
 * unrelated problems that need different actions from the reader. Collapsing
 * them into one message sends people to check the wrong thing — usually the
 * address, which is the one part that was right.
 *
 * `pageProtocol` is passed in rather than read from `window` so the rule can be
 * stated and tested without a browser.
 */
export function connectionFailure(opts: {
  url: string;
  error: unknown;
  /** The workspace's name, when it is already known. */
  name?: string;
  pageProtocol?: string;
}): string {
  const who = opts.name ?? `the workspace at ${host(opts.url)}`;
  // At the start of a sentence.
  const Who = who.charAt(0).toUpperCase() + who.slice(1);
  if (opts.error instanceof ApiError) {
    if (opts.error.status === 401 || opts.error.status === 403) {
      return `${Who} did not accept your sign-in. Sign in again.`;
    }
    return `${Who} sent back error ${opts.error.status}. Try again in a moment.`;
  }
  // A page on https cannot open http; the browser stops it before the network.
  if (opts.pageProtocol === "https:" && opts.url.startsWith("http://")) {
    return `This page uses https, so your browser will not open ${host(opts.url)}, which uses plain http. Use an https address, or use the desktop app.`;
  }
  if (opts.error instanceof DOMException && opts.error.name === "TimeoutError") {
    return `${Who} did not answer in time. The computer it runs on may be asleep, or a firewall may be blocking it.`;
  }
  return `Could not reach ${who}. Check that it is running and that you are on its network.`;
}

/**
 * Whether this build can talk to that workspace at all, and if not, which side
 * has to change. Told apart from unreachability because retrying never helps.
 */
export function incompatibleWorkspace(url: string, info: ServerInfo): string | null {
  if (info.app !== "ownbase") {
    return `Something answers at ${host(url)}, but it is not an OwnBase workspace. Check the address.`;
  }
  if (info.protocolVersion > PROTOCOL_VERSION) {
    return `${info.workspaceName} runs OwnBase server v${info.serverVersion}, which is newer than this app. Update this app to join it.`;
  }
  if (info.protocolVersion < PROTOCOL_VERSION) {
    return `${info.workspaceName} runs OwnBase server v${info.serverVersion}, which is older than this app. The person who runs it needs to update the server.`;
  }
  return null;
}

/**
 * What to say once a workspace refused this app's protocol: which side has to
 * update, from the version the server said it speaks (0: too old to say).
 */
export function protocolMismatch(serverVersion: number | null): { short: string; long: string } {
  if (serverVersion !== null && serverVersion > PROTOCOL_VERSION) {
    return {
      short: "Workspace is newer. Update this app.",
      long: "This workspace runs a newer version of OwnBase than this app. Update this app to connect.",
    };
  }
  return {
    short: "Workspace is out of date. Ask its host to update.",
    long: "This workspace runs an older version of OwnBase than this app. The person who runs it needs to update the server.",
  };
}
