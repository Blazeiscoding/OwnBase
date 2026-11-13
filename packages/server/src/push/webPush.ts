import {
  createECDH,
  createPrivateKey,
  createPublicKey,
  createCipheriv,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";

/**
 * Web push with nothing but node:crypto: the message encryption of RFC 8291
 * (`aes128gcm`, RFC 8188) and the server identification of RFC 8292 (VAPID).
 * A browser's push service passes the encrypted bytes on without being able
 * to read them; only the browser that subscribed holds the key.
 */

export const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
export const fromB64url = (text: string): Buffer => Buffer.from(text, "base64url");

/** The record size written in the header. One record holds the whole message. */
const RECORD_SIZE = 4096;
/** Header (86 bytes), the padding delimiter and the GCM tag, around the message itself. */
export const PUSH_OVERHEAD = 86 + 1 + 16;
/** The longest message one record carries. Push services take no more than 4096 bytes. */
export const MAX_PUSH_PLAINTEXT = RECORD_SIZE - PUSH_OVERHEAD;

/** The server's VAPID key pair: the public point (65 bytes) and the private scalar, base64url. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export function makeVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  return { publicKey: b64url(rawPublic(jwk.x!, jwk.y!)), privateKey: jwk.d! };
}

/** Whether `keys` is a usable pair; a damaged setting is replaced, not used. */
export function validVapidKeys(keys: VapidKeys): boolean {
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(fromB64url(keys.privateKey));
    return ecdh.getPublicKey().equals(fromB64url(keys.publicKey));
  } catch {
    return false;
  }
}

const rawPublic = (x: string, y: string) =>
  Buffer.concat([Buffer.from([4]), fromB64url(x), fromB64url(y)]);

/** A browser's subscription key (65 bytes, uncompressed P-256) and its 16-byte secret. */
export function validSubscriptionKeys(p256dh: string, auth: string): boolean {
  const point = fromB64url(p256dh);
  if (point.length !== 65 || point[0] !== 4 || fromB64url(auth).length !== 16) return false;
  try {
    const probe = createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(point);
    return true;
  } catch {
    return false;
  }
}

const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer =>
  Buffer.from(hkdfSync("sha256", ikm, salt, info, length));

/**
 * Encrypts one push message for one subscription (RFC 8291 section 3, with
 * the RFC 8188 header). A fresh salt and sender key are made for each message;
 * a test passes the RFC's own to check the bytes against its worked example.
 */
export function encryptPush(
  plaintext: Buffer,
  subscription: { p256dh: string; auth: string },
  fixed: { salt?: Buffer; senderPrivate?: Buffer } = {},
): Buffer {
  if (plaintext.length > MAX_PUSH_PLAINTEXT) throw new Error("push message too long");
  const uaPublic = fromB64url(subscription.p256dh);
  const authSecret = fromB64url(subscription.auth);
  const salt = fixed.salt ?? randomBytes(16);
  const sender = createECDH("prime256v1");
  if (fixed.senderPrivate) sender.setPrivateKey(fixed.senderPrivate);
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 marks the last (and only) record, with no padding after it.
  const sealed = Buffer.concat([
    cipher.update(plaintext),
    cipher.update(Buffer.from([2])),
    cipher.final(),
  ]);
  return Buffer.concat([header, asPublic, sealed, cipher.getAuthTag()]);
}

/** The signed part of a VAPID token (RFC 8292 section 2): header and claims, base64url. */
export function vapidSigningInput(audience: string, expires: number, subject: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: audience, exp: expires, sub: subject })));
  return `${header}.${claims}`;
}

/** Whether `signature` (raw r||s, base64url) signs `input` for the public point `publicKey`. */
export function vapidVerifies(input: string, signature: string, publicKey: string): boolean {
  const point = fromB64url(publicKey);
  const key = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: b64url(point.subarray(1, 33)),
      y: b64url(point.subarray(33)),
    },
    format: "jwk",
  });
  return verify(
    "sha256",
    Buffer.from(input),
    { key, dsaEncoding: "ieee-p1363" },
    fromB64url(signature),
  );
}

/** How long a token is good for. RFC 8292 allows at most 24 hours. */
const TOKEN_LIFETIME_S = 12 * 60 * 60;

/**
 * The Authorization header that identifies this server to the push service
 * at `endpoint` (RFC 8292 section 3): a token for that service's origin,
 * signed with the server's key, and the key itself.
 */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now = Date.now(),
): string {
  const input = vapidSigningInput(
    new URL(endpoint).origin,
    Math.floor(now / 1000) + TOKEN_LIFETIME_S,
    subject,
  );
  const point = fromB64url(keys.publicKey);
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: b64url(point.subarray(1, 33)),
      y: b64url(point.subarray(33)),
    },
    format: "jwk",
  });
  const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${input}.${b64url(signature)}, k=${keys.publicKey}`;
}
