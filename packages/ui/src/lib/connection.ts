import { PROTOCOL_VERSION, type ServerInfo } from "@slackoss/protocol";
import { ApiError } from "@slackoss/client-core";

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
  if (opts.error instanceof ApiError) {
    if (opts.error.status === 401 || opts.error.status === 403) {
      return `${who} did not accept these credentials. Sign in again.`;
    }
    return `${who} answered with an error (${opts.error.status}).`;
  }
  // A page on https cannot open http; the browser stops it before the network.
  if (opts.pageProtocol === "https:" && opts.url.startsWith("http://")) {
    return `This page is on https, so the browser will not open ${host(opts.url)} over plain http. Use an https address, or open the desktop app.`;
  }
  if (opts.error instanceof DOMException && opts.error.name === "TimeoutError") {
    return `${who} did not answer in time. It may be asleep or behind a firewall.`;
  }
  return `Could not reach ${who}. Check that it is running and on the same network.`;
}

/**
 * Whether this build can talk to that workspace at all, and if not, which side
 * has to change. Told apart from unreachability because retrying never helps.
 */
export function incompatibleWorkspace(url: string, info: ServerInfo): string | null {
  if (info.app !== "slackoss") {
    return `Something is answering at ${host(url)}, but it is not a workspace.`;
  }
  if (info.protocolVersion > PROTOCOL_VERSION) {
    return `${info.workspaceName} runs a newer version of OwnBase (server v${info.serverVersion}). Update this app to join it.`;
  }
  if (info.protocolVersion < PROTOCOL_VERSION) {
    return `${info.workspaceName} runs an older version of OwnBase (server v${info.serverVersion}). Its host needs to update the server.`;
  }
  return null;
}
