# OwnBase Enterprise edition

Everything in this directory is source-available under the
[OwnBase Enterprise License](LICENSE), a draft for legal review, not the MIT license
the rest of the repository is under. You may read it, change it, and run it to
develop and test; using it in production needs a license key.

The MIT core never imports anything here. The server has an extension point
(`packages/server/src/extensions.ts`), and the server bundle is built from
[`src/main.ts`](src/main.ts), which puts the Enterprise extension in and then runs
the server's own command line. Without a license that build is the free edition,
flag for flag.

## Running with a license

```sh
ownbase-server --data ./data --license ./acme.license
```

The license can also be named by `OWNBASE_LICENSE_FILE`, or given whole in
`OWNBASE_LICENSE`. It is checked on the server, offline, against the public keys in
[`src/keys.ts`](src/keys.ts). A license that is not one, or was changed, stops the
server with the reason, as any setting it cannot use does. One that has ended keeps
its features on for 14 days, with a notice to the owner and admins, and then turns
them off. Chat never depends on a license.

`GET /api/admin/license` tells the owner and admins where the license stands, and
the workspace status (Diagnostics) has a line for it.

## Keys and licenses

Licenses are Ed25519-signed lines of text. Only the private key can make one, so it
never comes near this repository or CI.

```sh
# Once: a key pair. The private key goes in your profile; back it up.
node ee/scripts/license.mjs keygen --private ~/.ownbase/license-signing-key.pem
# Then add the public key it prints to TRUSTED_LICENSE_KEYS in src/keys.ts.

# For each customer:
node ee/scripts/license.mjs issue --private ~/.ownbase/license-signing-key.pem \
  --licensee "Acme Ltd" --members 200 --days 365 --features sso,scim --out acme.license

node ee/scripts/license.mjs inspect acme.license
```

Until a public key is in `src/keys.ts`, this build accepts no license.

## Hosting workspaces: `cloud/`

[`cloud/`](cloud) is `ownbase-cloud`, the control plane for hosting many workspaces on
one machine, as OwnBase's Team plan is hosted: a list of workspaces, one
`ownbase-server` each on a loopback port, Caddy in front with a certificate per
address, and an operator API to create, pause, restart, copy and delete them. It is
its own package (`@ownbase/cloud`), under the same license. How to set one up is in
[DEPLOYMENT.md](../docs/DEPLOYMENT.md#hosting-workspaces-for-others).

```sh
pnpm --filter @ownbase/cloud build   # ee/cloud/dist/ownbase-cloud.js
pnpm --filter @ownbase/cloud test    # with real servers, and a stand-in for Caddy
```
