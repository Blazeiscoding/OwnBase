import { createHmac } from "node:crypto";

/**
 * Signs an outbound request the way Slack does: HMAC-SHA256 over
 * `v0:<timestamp>:<body>` with the app's signing secret. Receivers compare
 * against the header and reject anything older than a few minutes, which stops
 * a captured request from being replayed at them later.
 *
 * The Slack-named headers are sent alongside ours so a library written against
 * Slack verifies our requests without changes.
 */
export function signatureHeaders(
  secret: string,
  body: string,
  now = Date.now(),
): Record<string, string> {
  const ts = String(Math.floor(now / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
  return {
    "x-ownbase-request-timestamp": ts,
    "x-ownbase-signature": signature,
    "x-slack-request-timestamp": ts,
    "x-slack-signature": signature,
  };
}
