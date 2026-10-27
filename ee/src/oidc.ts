import {
  constants,
  createHash,
  createPublicKey,
  randomBytes,
  verify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

/**
 * An OpenID Connect client, as single sign-on (P9) needs one: the provider's
 * own description of itself, the authorization code flow with PKCE, and the
 * ID token checked here, with node:crypto, against the keys the provider
 * publishes. No dependency: what it uses of JOSE is small and fixed.
 */

/** Something the provider, or what it sent, would not do. Its message is for the owner or the person signing in. */
export class OidcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What a provider says about itself, the parts this client uses. */
export interface Provider {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** How the token endpoint wants the client to prove itself. */
  tokenAuth: "client_secret_basic" | "client_secret_post";
}

/** The claims of an ID token this client reads. */
export interface IdClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  azp?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
}

type Fetch = typeof fetch;

const TIMEOUT_MS = 10_000;
/** How far apart this server's clock and the provider's may be. */
export const CLOCK_SKEW_MS = 60_000;

/** 32 random bytes, as base64url: a state, a nonce, a PKCE verifier. */
export const randomToken = (): string => randomBytes(32).toString("base64url");

/** The S256 transform PKCE uses, and this server for other one-way values. */
export const s256 = (value: string): string =>
  createHash("sha256").update(value).digest("base64url");

const isLoopback = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

/** An address the provider gave: https, or http to this computer, where a test or local provider runs. */
function providerUrl(value: unknown, what: string): string {
  let url: URL | null = null;
  try {
    url = typeof value === "string" ? new URL(value) : null;
  } catch {
    url = null;
  }
  if (!url) throw new OidcError("discovery_invalid", `The provider gave no usable ${what}.`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))
    throw new OidcError(
      "discovery_invalid",
      `The provider's ${what} is not https: ${String(value)}`,
    );
  return value as string;
}

const why = (error: unknown) =>
  error instanceof Error
    ? error.name === "TimeoutError"
      ? "no answer in 10 seconds"
      : ((error.cause as Error | undefined)?.message ?? error.message)
    : String(error);

/**
 * The provider's description of itself, from its issuer address. The issuer
 * it names must be the one asked for: that is what its ID tokens will say.
 */
export async function discover(issuer: string, fetchFn: Fetch = fetch): Promise<Provider> {
  const base = providerUrl(issuer.trim(), "issuer").replace(/\/+$/, "");
  const where = `${base}/.well-known/openid-configuration`;
  let doc: Record<string, unknown>;
  try {
    const response = await fetchFn(where, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok)
      throw new OidcError("discovery_failed", `${where} answered ${response.status}.`);
    doc = (await response.json()) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof OidcError) throw error;
    throw new OidcError("discovery_failed", `${where} could not be read (${why(error)}).`);
  }
  if (typeof doc.issuer !== "string" || doc.issuer.replace(/\/+$/, "") !== base)
    throw new OidcError(
      "discovery_invalid",
      `${where} describes another issuer, ${String(doc.issuer)}.`,
    );
  const methods = Array.isArray(doc.token_endpoint_auth_methods_supported)
    ? doc.token_endpoint_auth_methods_supported
    : ["client_secret_basic"];
  return {
    issuer: doc.issuer,
    authorizationEndpoint: providerUrl(doc.authorization_endpoint, "authorization endpoint"),
    tokenEndpoint: providerUrl(doc.token_endpoint, "token endpoint"),
    jwksUri: providerUrl(doc.jwks_uri, "key set address"),
    // The default, unless the provider takes only the other.
    tokenAuth:
      !methods.includes("client_secret_basic") && methods.includes("client_secret_post")
        ? "client_secret_post"
        : "client_secret_basic",
  };
}

/** Where to send the person's browser to sign in: the authorization code flow with PKCE S256. */
export function authorizationUrl(
  provider: Provider,
  request: {
    clientId: string;
    redirectUri: string;
    state: string;
    nonce: string;
    codeVerifier: string;
  },
): string {
  const url = new URL(provider.authorizationEndpoint);
  const set = (name: string, value: string) => url.searchParams.set(name, value);
  set("response_type", "code");
  set("client_id", request.clientId);
  set("redirect_uri", request.redirectUri);
  set("scope", "openid email profile");
  set("state", request.state);
  set("nonce", request.nonce);
  set("code_challenge", s256(request.codeVerifier));
  set("code_challenge_method", "S256");
  return url.toString();
}

/** RFC 6749 2.3.1: the client's id and secret are form-encoded before they are joined. */
const formEncoded = (value: string) => new URLSearchParams([["", value]]).toString().slice(1);

/** The ID token the provider gives for the code it sent back. */
export async function exchangeCode(
  provider: Provider,
  request: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  },
  fetchFn: Fetch = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: request.code,
    redirect_uri: request.redirectUri,
    code_verifier: request.codeVerifier,
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (provider.tokenAuth === "client_secret_basic") {
    const pair = `${formEncoded(request.clientId)}:${formEncoded(request.clientSecret)}`;
    headers.authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
  } else {
    body.set("client_id", request.clientId);
    body.set("client_secret", request.clientSecret);
  }
  let response: Response;
  let data: Record<string, unknown>;
  try {
    response = await fetchFn(provider.tokenEndpoint, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  } catch (error) {
    throw new OidcError(
      "token_failed",
      `The sign-in service could not be reached (${why(error)}).`,
    );
  }
  if (!response.ok) {
    const said = [data.error, data.error_description].filter((x) => typeof x === "string");
    throw new OidcError(
      "token_refused",
      `The sign-in service refused the code${said.length ? `: ${said.join(", ")}` : ` (${response.status})`}.`,
    );
  }
  if (typeof data.id_token !== "string")
    throw new OidcError("token_invalid", "The sign-in service sent no ID token.");
  return data.id_token;
}

/** The signatures accepted, by `alg`: never `none`, and never a shared secret. */
const ALGORITHMS: Record<string, { hash: string; kty: "RSA" | "EC"; pss?: true; crv?: string }> = {
  RS256: { hash: "sha256", kty: "RSA" },
  RS384: { hash: "sha384", kty: "RSA" },
  RS512: { hash: "sha512", kty: "RSA" },
  PS256: { hash: "sha256", kty: "RSA", pss: true },
  PS384: { hash: "sha384", kty: "RSA", pss: true },
  PS512: { hash: "sha512", kty: "RSA", pss: true },
  ES256: { hash: "sha256", kty: "EC", crv: "P-256" },
  ES384: { hash: "sha384", kty: "EC", crv: "P-384" },
  ES512: { hash: "sha512", kty: "EC", crv: "P-521" },
};

/** At most this often, a key not seen before sends this back to the provider for its keys. */
const REFRESH_AFTER_MS = 60_000;

/**
 * The provider's signing keys, read when first needed and again when a token
 * names one not seen before: providers roll their keys.
 */
export class KeySet {
  private keys: JsonWebKey[] = [];
  private fetchedAt = Number.NEGATIVE_INFINITY;

  constructor(
    readonly uri: string,
    private readonly fetchFn: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async key(kid: string | undefined, alg: string): Promise<KeyObject> {
    let jwk = this.find(kid, alg);
    if (!jwk && this.now() - this.fetchedAt >= REFRESH_AFTER_MS) {
      await this.refresh();
      jwk = this.find(kid, alg);
    }
    if (!jwk)
      throw new OidcError(
        "token_invalid",
        "The ID token is signed with a key the sign-in service does not publish.",
      );
    return createPublicKey({ key: jwk, format: "jwk" });
  }

  private find(kid: string | undefined, alg: string): JsonWebKey | undefined {
    const spec = ALGORITHMS[alg]!;
    const fits = this.keys.filter(
      (k) =>
        k.kty === spec.kty &&
        (spec.crv === undefined || k.crv === spec.crv) &&
        (k.use === undefined || k.use === "sig") &&
        (k.alg === undefined || k.alg === alg) &&
        (kid === undefined || k.kid === kid),
    );
    // Without a kid, only a key set with one such key says which it is.
    return kid === undefined && fits.length !== 1 ? undefined : fits[0];
  }

  private async refresh(): Promise<void> {
    this.fetchedAt = this.now();
    try {
      const response = await this.fetchFn(this.uri, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`answered ${response.status}`);
      const doc = (await response.json()) as { keys?: unknown };
      if (!Array.isArray(doc.keys)) throw new Error("no keys in it");
      this.keys = doc.keys.filter((k): k is JsonWebKey => !!k && typeof k === "object");
    } catch (error) {
      throw new OidcError(
        "keys_failed",
        `The sign-in service's keys could not be read from ${this.uri} (${why(error)}).`,
      );
    }
  }
}

function part(text: string, what: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // Said below.
  }
  throw new OidcError("token_invalid", `The ID token's ${what} could not be read.`);
}

const refused = (why: string) =>
  new OidcError("token_invalid", `The ID token was refused: ${why}.`);

/**
 * The ID token's claims, once its signature is the provider's and it was
 * issued by that provider, for this client, for this sign-in, and is still
 * current.
 */
export async function verifyIdToken(
  token: string,
  expected: {
    issuer: string;
    clientId: string;
    nonce: string;
    now: number;
    key: (kid: string | undefined, alg: string) => Promise<KeyObject>;
  },
): Promise<IdClaims> {
  const pieces = token.split(".");
  if (pieces.length !== 3) throw refused("it is not a signed token");
  const [head, body, signature] = pieces as [string, string, string];
  const header = part(head, "header");
  const alg = typeof header.alg === "string" ? header.alg : "";
  const spec = Object.hasOwn(ALGORITHMS, alg) ? ALGORITHMS[alg]! : undefined;
  if (!spec) throw refused(`it is signed with ${alg || "nothing"}, which is not accepted`);
  const key = await expected.key(typeof header.kid === "string" ? header.kid : undefined, alg);
  const signed = Buffer.from(`${head}.${body}`);
  const sig = Buffer.from(signature, "base64url");
  const matches = verify(
    spec.hash,
    signed,
    spec.kty === "EC"
      ? { key, dsaEncoding: "ieee-p1363" }
      : spec.pss
        ? {
            key,
            padding: constants.RSA_PKCS1_PSS_PADDING,
            saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
          }
        : key,
    sig,
  );
  if (!matches) throw refused("its signature does not match");
  const claims = part(body, "claims");
  if (claims.iss !== expected.issuer) throw refused(`it was issued by ${String(claims.iss)}`);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(expected.clientId)) throw refused("it is for another application");
  if (audience.length > 1 && claims.azp !== expected.clientId)
    throw refused("it is for another application");
  if (typeof claims.exp !== "number" || claims.exp * 1000 + CLOCK_SKEW_MS <= expected.now)
    throw refused("it has expired");
  if (typeof claims.iat !== "number" || claims.iat * 1000 - CLOCK_SKEW_MS > expected.now)
    throw refused("it was issued in the future; check the server's clock");
  if (claims.nonce !== expected.nonce) throw refused("it was not made for this sign-in");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255)
    throw refused("it names nobody");
  return claims as unknown as IdClaims;
}
