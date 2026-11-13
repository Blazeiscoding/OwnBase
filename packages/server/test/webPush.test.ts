import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  b64url,
  encryptPush,
  fromB64url,
  makeVapidKeys,
  validSubscriptionKeys,
  validVapidKeys,
  vapidAuthorization,
  vapidSigningInput,
  vapidVerifies,
  MAX_PUSH_PLAINTEXT,
} from "../src/push/webPush.js";

/**
 * RFC 8291 section 5 and Appendix A: the worked example, as the RFC prints
 * it (whitespace removed). These are the RFC's published example values,
 * nobody's real keys.
 */
const rfc8291 = {
  words: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  senderScalar: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  senderPoint:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg" + "Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  receiverPoint:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx" + "aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  /** The subscription's 16 bytes the RFC calls auth_secret. */
  shared16: "BTBZMqHH6r4Tts7J_aSIgg",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/**
 * RFC 8292 section 2.4: the example token's claims, the signature it prints
 * and the public point ("k") that made it. No private value is published.
 */
const rfc8292 = {
  audience: "https://push.example.net",
  expires: 1453523768,
  subject: "mailto:push@example.com",
  signature:
    "i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA",
  point:
    "BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dR" + "uU_RCPCfA5aq9ojSwk5Y2EmClBPs",
};

/** What the browser does with a push: RFC 8291's decryption, for round trips. */
function decrypt(body: Buffer, receiver: ReturnType<typeof createECDH>, shared16: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const senderPoint = body.subarray(21, 21 + idLength);
  const sealed = body.subarray(21 + idLength);
  const ecdh = receiver.computeSecret(senderPoint);
  const info = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    receiver.getPublicKey(),
    senderPoint,
  ]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdh, shared16, info, 32));
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - 16)),
    decipher.final(),
  ]);
  expect(plain[plain.length - 1]).toBe(2);
  return plain.subarray(0, plain.length - 1);
}

describe("RFC 8291 message encryption", () => {
  it("produces the RFC's worked example byte for byte", () => {
    const body = encryptPush(
      fromB64url(rfc8291.words),
      { p256dh: rfc8291.receiverPoint, auth: rfc8291.shared16 },
      { salt: fromB64url(rfc8291.salt), senderPrivate: fromB64url(rfc8291.senderScalar) },
    );
    expect(b64url(body)).toBe(rfc8291.body);
    // The header names the sender's point, as the RFC prints it.
    expect(b64url(body.subarray(21, 86))).toBe(rfc8291.senderPoint);
    // The RFC's HTTP example says 145, but the body it prints is 144 bytes: 86 + 42 + 16.
    expect(body.length).toBe(144);
  });

  it("makes a fresh salt and sender key each time, which the receiver can still read", () => {
    const receiver = createECDH("prime256v1");
    receiver.generateKeys();
    const shared16 = randomBytes(16);
    const subscription = { p256dh: b64url(receiver.getPublicKey()), auth: b64url(shared16) };
    const words = Buffer.from(JSON.stringify({ title: "Priya in #design", body: "Friday" }));
    const one = encryptPush(words, subscription);
    const two = encryptPush(words, subscription);
    expect(one.subarray(0, 16).equals(two.subarray(0, 16))).toBe(false);
    expect(one.subarray(21, 86).equals(two.subarray(21, 86))).toBe(false);
    expect(decrypt(one, receiver, shared16).toString()).toBe(words.toString());
    expect(decrypt(two, receiver, shared16).toString()).toBe(words.toString());
  });

  it("fits one record, and refuses a message that would not", () => {
    const receiver = createECDH("prime256v1");
    receiver.generateKeys();
    const subscription = { p256dh: b64url(receiver.getPublicKey()), auth: b64url(randomBytes(16)) };
    expect(encryptPush(Buffer.alloc(MAX_PUSH_PLAINTEXT), subscription).length).toBe(4096);
    expect(() => encryptPush(Buffer.alloc(MAX_PUSH_PLAINTEXT + 1), subscription)).toThrow();
  });

  it("checks a subscription's key and secret", () => {
    expect(validSubscriptionKeys(rfc8291.receiverPoint, rfc8291.shared16)).toBe(true);
    expect(validSubscriptionKeys(rfc8291.receiverPoint, "c2hvcnQ")).toBe(false);
    expect(validSubscriptionKeys(b64url(Buffer.alloc(65, 4)), rfc8291.shared16)).toBe(false);
    expect(validSubscriptionKeys("", rfc8291.shared16)).toBe(false);
  });
});

describe("RFC 8292 VAPID", () => {
  it("encodes the RFC's claims to the bytes its signature covers", () => {
    const input = vapidSigningInput(rfc8292.audience, rfc8292.expires, rfc8292.subject);
    expect(vapidVerifies(input, rfc8292.signature, rfc8292.point)).toBe(true);
    // A claim changed by one second no longer matches what was signed.
    const other = vapidSigningInput(rfc8292.audience, rfc8292.expires + 1, rfc8292.subject);
    expect(vapidVerifies(other, rfc8292.signature, rfc8292.point)).toBe(false);
  });

  it("signs a token for the push service's origin that its key verifies", () => {
    const keys = makeVapidKeys();
    expect(validVapidKeys(keys)).toBe(true);
    expect(fromB64url(keys.publicKey)).toHaveLength(65);
    const now = 1_700_000_000_000;
    const header = vapidAuthorization(
      "https://fcm.googleapis.com/fcm/send/abc",
      keys,
      "https://chat.example.com",
      now,
    );
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(fromB64url(claims!).toString())).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: now / 1000 + 12 * 60 * 60,
      sub: "https://chat.example.com",
    });
    expect(vapidVerifies(`${head}.${claims}`, signature!, keys.publicKey)).toBe(true);
    expect(vapidVerifies(`${head}.${claims}`, signature!, makeVapidKeys().publicKey)).toBe(false);
  });

  it("finds a damaged key pair", () => {
    const keys = makeVapidKeys();
    expect(validVapidKeys({ ...keys, publicKey: makeVapidKeys().publicKey })).toBe(false);
    expect(validVapidKeys({ ...keys, privateKey: "" })).toBe(false);
  });
});
