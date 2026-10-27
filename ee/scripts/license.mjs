#!/usr/bin/env node
// Makes OwnBase license keys and issues licenses (P6), in the format
// ee/src/license.ts reads. Run with plain Node:
//
//   node ee/scripts/license.mjs keygen --private <file>
//   node ee/scripts/license.mjs issue --private <file> --licensee "Acme Ltd" \
//        --members 200 --days 365 [--plan enterprise] [--features sso,scim] \
//        [--id <id>] --out acme.license
//   node ee/scripts/license.mjs inspect <license file>
//
// The private key is the only thing that can make a license, so it belongs
// outside this repository and outside CI: in the keeper's own profile, backed
// up somewhere safe. keygen refuses to write inside the repository.
import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export const LICENSE_PREFIX = "OWNBASE-LICENSE-1";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/** A new key pair: the private key as PEM, the public key as keys.ts lists it. */
export function makeKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicRaw: publicKey.export({ format: "jwk" }).x,
  };
}

/** A license for `claims`, signed with the private key in `privatePem`. */
export function issueLicense(privatePem, claims) {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signed = `${LICENSE_PREFIX}.${payload}`;
  const signature = sign(null, Buffer.from(signed, "utf8"), createPrivateKey(privatePem));
  return `${signed}.${signature.toString("base64url")}`;
}

/** What a license claims, without checking who signed it; ee/src/license.ts does that. */
export function claimsOf(text) {
  const [prefix, payload] = text.trim().split(".");
  if (prefix !== LICENSE_PREFIX || !payload) throw new Error("This is not an OwnBase license.");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

/** Whether `path` is `folder` or in it. Another drive gives an absolute relative path. */
function inside(path, folder) {
  const rel = relative(folder, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function main(argv) {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      private: { type: "string" },
      licensee: { type: "string" },
      members: { type: "string" },
      days: { type: "string" },
      plan: { type: "string", default: "enterprise" },
      features: { type: "string", default: "" },
      id: { type: "string" },
      out: { type: "string" },
    },
  });
  if (command === "keygen") {
    if (!values.private) fail("keygen needs --private <file>, where the private key goes");
    const path = resolve(values.private);
    if (inside(path, repo))
      fail("The private key must not go inside the repository. Choose a folder in your profile.");
    if (existsSync(path)) fail(`${path} already exists; a key is never overwritten.`);
    const { privatePem, publicRaw } = makeKeyPair();
    writeFileSync(path, privatePem, { mode: 0o600, flag: "wx" });
    console.log(`
  Private key written to ${path}. Keep it there and back it up; it is the only
  thing that can issue a license. Add the public key to TRUSTED_LICENSE_KEYS in
  ee/src/keys.ts:

    "${publicRaw}",
`);
    return;
  }
  if (command === "issue") {
    for (const name of ["private", "licensee", "members", "days", "out"])
      if (!values[name]) fail(`issue needs --${name}`);
    const members = Number(values.members);
    const days = Number(values.days);
    if (!Number.isSafeInteger(members) || members < 1) fail("--members must be a whole number");
    if (!Number.isSafeInteger(days) || days < 1) fail("--days must be a whole number");
    const issuedAt = Date.now();
    const claims = {
      id: values.id ?? randomUUID(),
      licensee: values.licensee.trim(),
      plan: values.plan,
      members,
      features: values.features
        .split(",")
        .map((feature) => feature.trim())
        .filter(Boolean),
      issuedAt,
      expiresAt: issuedAt + days * DAY_MS,
    };
    const out = resolve(values.out);
    if (existsSync(out)) fail(`${out} already exists`);
    writeFileSync(out, `${issueLicense(readFileSync(resolve(values.private), "utf8"), claims)}\n`, {
      flag: "wx",
    });
    console.log(`\n  License ${claims.id} for ${claims.licensee} written to ${out}\n`);
    return;
  }
  if (command === "inspect") {
    if (!positionals[0]) fail("inspect needs the license file");
    const claims = claimsOf(readFileSync(resolve(positionals[0]), "utf8"));
    console.log(JSON.stringify(claims, null, 2));
    console.log(
      `\n  Ends ${new Date(claims.expiresAt).toISOString()}. Whether OwnBase accepts it is` +
        ` the server's check, against the keys in ee/src/keys.ts.\n`,
    );
    return;
  }
  fail("Say keygen, issue or inspect.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
