# Security

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab and choose **Report a vulnerability**,
   or go straight to
   <https://github.com/Blazeiscoding/OwnBase/security/advisories/new>.
2. Sign in to GitHub if asked. Only you and the maintainer can see the report.

Do not open a public issue, discussion or pull request about it, and do not post
credentials, private workspace data or a working exploit anywhere public.

Include what you can of:

- what an attacker can do, and who they need to be (anyone on the internet, a
  workspace member, an admin, someone on the same network);
- the steps or a small proof of concept;
- the version: the `serverVersion` from `/api/server-info`, or the "Server"
  line from Diagnostics in the app's account menu;
- how the server runs (desktop app hosting, `ownbase-server`, Docker), and
  whether it sits behind a reverse proxy or a tunnel.

What happens next: OwnBase has one maintainer, so there is no fixed response
time. The report is read, confirmed or questioned in the report's own thread,
and fixed in a release. The advisory is published once the fix is out, crediting
you unless you ask not to be named. If a report goes unanswered for a long while,
add a comment to it.

There has been no formal security audit, and there is no support agreement.

## Hosting safely

This is early-stage software. Before exposing a workspace to the internet, create
its owner account over a trusted connection, require invites, and configure HTTPS.
The first registrant owns a fresh server; do not expose an unclaimed server publicly.

Accounts and friendships belong to a workspace. The host can read stored messages,
files, and account metadata. Chat storage is not end-to-end encrypted. WebRTC media
uses encrypted transport, but participants may record it. Use trusted STUN/TURN
services; their operators can observe connection metadata.

Keep Node, Electron, Docker base images, and dependencies updated. Preserve backups
before upgrades. See [deployment instructions](docs/DEPLOYMENT.md).
