import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";

/**
 * A SAML identity provider made in the test, as small as the checks allow:
 * a key and a self-signed certificate made now (node:crypto makes keys but
 * not certificates, so its DER is written here), the request read out of the
 * redirect, and answers signed or changed as each case needs.
 */

const der = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const n = body.length;
  const length =
    n < 0x80
      ? Buffer.from([n])
      : n < 0x100
        ? Buffer.from([0x81, n])
        : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
};
const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
const oid = (dotted: string) => {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const bytes = [a! * 40 + b!];
  for (const n of rest) {
    const groups = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) groups.unshift((v & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return der(0x06, Buffer.from(bytes));
};
const time = (at: Date) =>
  der(0x17, Buffer.from(at.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
const SHA256_WITH_RSA = sequence(oid("1.2.840.113549.1.1.11"), Buffer.from([0x05, 0x00]));

/** A self-signed certificate for `keys`, as PEM. */
export function selfSigned(
  keys: { publicKey: KeyObject; privateKey: KeyObject },
  commonName: string,
): string {
  const name = sequence(der(0x31, sequence(oid("2.5.4.3"), der(0x0c, Buffer.from(commonName)))));
  const now = Date.now();
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.concat([Buffer.from([0x01]), randomBytes(8)])),
    SHA256_WITH_RSA,
    name,
    sequence(time(new Date(now - 86_400_000)), time(new Date(now + 365 * 86_400_000))),
    name,
    keys.publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign("sha256", tbs, keys.privateKey);
  const certificate = sequence(
    tbs,
    SHA256_WITH_RSA,
    der(0x03, Buffer.from([0]), signature),
  ).toString("base64");
  return `-----BEGIN CERTIFICATE-----\n${certificate.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----`;
}

const iso = (at: number) => new Date(at).toISOString();
const xmlText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

const NS_PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
const NS_ASSERTION = "urn:oasis:names:tc:SAML:2.0:assertion";

export interface Answer {
  inResponseTo?: string;
  /** Where the answer goes: the service provider's ACS. */
  acs: string;
  audience: string;
  nameId: string;
  nameIdFormat?: string;
  attributes?: Record<string, string>;
  issuer?: string;
  /** The assertion's window, around the real clock as node-saml reads it. */
  notBefore?: number;
  notOnOrAfter?: number;
  /** What is signed: the assertion (Entra's way), the response, both (Okta's), or nothing. */
  sign?: "assertion" | "response" | "both" | "none";
  /** Signed by a key the service provider does not know. */
  forged?: boolean;
  assertionId?: string;
}

export class TestSamlProvider {
  entityId = "https://idp.example.test/saml/metadata";
  signInUrl = "http://127.0.0.1:9/sso";
  person = {
    nameId: "00u-maya",
    attributes: { email: "maya@acme.com", displayName: "Maya Lin" } as Record<string, string>,
  };
  private readonly keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  private readonly stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
  readonly certificate = selfSigned(this.keys, "Test identity provider");
  readonly strangerCertificate = selfSigned(this.stranger, "Someone else");

  /** The AuthnRequest in a redirect to the provider, and the RelayState with it. */
  request(location: string) {
    const url = new URL(location);
    const xml = inflateRawSync(
      Buffer.from(url.searchParams.get("SAMLRequest")!, "base64"),
    ).toString("utf8");
    return {
      xml,
      id: /\sID="([^"]+)"/.exec(xml)![1]!,
      acs: /AssertionConsumerServiceURL="([^"]+)"/.exec(xml)![1]!,
      issuer: /<saml:Issuer[^>]*>([^<]+)</.exec(xml)![1]!,
      relayState: url.searchParams.get("RelayState") ?? undefined,
      target: `${url.origin}${url.pathname}`,
    };
  }

  /** The assertion, unsigned. */
  assertion(answer: Answer): string {
    const now = Date.now();
    const id = answer.assertionId ?? `_a${randomBytes(16).toString("hex")}`;
    const notBefore = answer.notBefore ?? now - 60_000;
    const notOnOrAfter = answer.notOnOrAfter ?? now + 5 * 60_000;
    const attributes = Object.entries(answer.attributes ?? this.person.attributes)
      .map(
        ([name, value]) =>
          `<saml:Attribute Name="${xmlText(name)}"><saml:AttributeValue>${xmlText(value)}</saml:AttributeValue></saml:Attribute>`,
      )
      .join("");
    return (
      `<saml:Assertion xmlns:saml="${NS_ASSERTION}" ID="${id}" Version="2.0" IssueInstant="${iso(now)}">` +
      `<saml:Issuer>${xmlText(answer.issuer ?? this.entityId)}</saml:Issuer>` +
      `<saml:Subject><saml:NameID Format="${answer.nameIdFormat ?? "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified"}">${xmlText(answer.nameId)}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData` +
      `${answer.inResponseTo ? ` InResponseTo="${answer.inResponseTo}"` : ""} NotOnOrAfter="${iso(notOnOrAfter)}" Recipient="${xmlText(answer.acs)}"/></saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${iso(notBefore)}" NotOnOrAfter="${iso(notOnOrAfter)}"><saml:AudienceRestriction><saml:Audience>${xmlText(answer.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_s${randomBytes(8).toString("hex")}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
      (attributes ? `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>` : "") +
      `</saml:Assertion>`
    );
  }

  /** The response around `assertion`, unsigned. */
  wrap(answer: Pick<Answer, "inResponseTo" | "acs" | "issuer">, assertion: string): string {
    return (
      `<samlp:Response xmlns:samlp="${NS_PROTOCOL}" xmlns:saml="${NS_ASSERTION}" ID="_r${randomBytes(16).toString("hex")}" Version="2.0" IssueInstant="${iso(Date.now())}"` +
      ` Destination="${xmlText(answer.acs)}"${answer.inResponseTo ? ` InResponseTo="${answer.inResponseTo}"` : ""}>` +
      `<saml:Issuer>${xmlText(answer.issuer ?? this.entityId)}</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
      assertion +
      `</samlp:Response>`
    );
  }

  /** Signs the element `localName` names with the provider's key, its Signature after its Issuer. */
  signed(xml: string, localName: "Assertion" | "Response", forged = false): string {
    const signer = new SignedXml({
      privateKey: (forged ? this.stranger : this.keys).privateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
      canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
      signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    });
    signer.addReference({
      xpath: `//*[local-name(.)='${localName}']`,
      transforms: [
        "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
        "http://www.w3.org/2001/10/xml-exc-c14n#",
      ],
      digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    });
    signer.computeSignature(xml, {
      location: {
        reference: `//*[local-name(.)='${localName}']/*[local-name(.)='Issuer']`,
        action: "after",
      },
    });
    return signer.getSignedXml();
  }

  /** A whole answer, as the provider's page would post it, before base64. */
  response(answer: Answer): string {
    const how = answer.sign ?? "assertion";
    let assertion = this.assertion(answer);
    if (how === "assertion" || how === "both")
      assertion = this.signed(assertion, "Assertion", answer.forged);
    let response = this.wrap(answer, assertion);
    if (how === "response" || how === "both")
      response = this.signed(response, "Response", answer.forged);
    return response;
  }
}

export const base64 = (xml: string) => Buffer.from(xml, "utf8").toString("base64");
