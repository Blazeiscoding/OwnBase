import { describe, expect, it } from "vitest";
import type { CallRelay } from "@ownbase/server";
import { decodeRelay, encodeRelay, resolveDraft, summarize } from "../src/main/callRelay.js";
import type { CredentialProtector } from "../src/main/credentials.js";

/**
 * The relay calls hosted here are given, kept in the settings file. Its API
 * token or password is a credential: it never reaches the file in plain text,
 * the hosting window, or an error.
 */
const TOKEN = "cf-turn-api-token-secret";
const cloudflare: CallRelay = { kind: "cloudflare", keyId: "4c1b5e7f9a", apiToken: TOKEN };
const custom: CallRelay = {
  kind: "custom",
  urls: ["turn:relay.example.org:3478", "turns:relay.example.org:5349"],
  username: "workspace",
  credential: "relay-password",
};

/** A key store whose "encryption" is reversible only with the same key. */
function keyStore(key = 7, available = true): CredentialProtector {
  return {
    isAvailable: () => available,
    encryptString: (value) =>
      Buffer.from([key, ...Buffer.from(value, "utf8").map((byte) => byte ^ key)]),
    decryptString: (value) => {
      if (value[0] !== key) throw new Error("wrong key");
      return Buffer.from(value.subarray(1).map((byte) => byte ^ key)).toString("utf8");
    },
  };
}

describe("keeping the relay", () => {
  it("keeps the secret encrypted and reads back the same relay", () => {
    for (const relay of [cloudflare, custom]) {
      const stored = encodeRelay(relay, keyStore());
      expect(JSON.stringify(stored)).not.toContain(
        relay.kind === "cloudflare" ? relay.apiToken : relay.credential,
      );
      expect(decodeRelay(JSON.parse(JSON.stringify(stored)), keyStore())).toEqual(relay);
    }
  });

  it("refuses to keep a secret without the OS key store, rather than in plain text", () => {
    expect(() => encodeRelay(cloudflare, keyStore(7, false))).toThrow(
      /credential protection is unavailable/,
    );
  });

  it("says when the saved relay cannot be read, without what it holds", () => {
    const stored = encodeRelay(cloudflare, keyStore(7));
    const failure = (() => {
      try {
        decodeRelay(stored, keyStore(9));
      } catch (error) {
        return error as Error;
      }
    })();
    expect(failure?.message).toMatch(/could not unlock/);
    expect(failure?.message).not.toContain(TOKEN);
    expect(() => decodeRelay({ kind: "something-else" }, keyStore())).toThrow(/unreadable/);
    expect(decodeRelay(null, keyStore())).toBeNull();
  });

  it("shows the hosting window everything but the secret", () => {
    expect(summarize(cloudflare)).toEqual({ kind: "cloudflare", keyId: "4c1b5e7f9a" });
    expect(summarize(custom)).toEqual({
      kind: "custom",
      urls: custom.urls,
      username: "workspace",
    });
    expect(summarize(null)).toEqual({ kind: "none" });
  });
});

describe("what the hosting window sends", () => {
  it("keeps the saved secret when the key or username is the same", () => {
    expect(resolveDraft({ kind: "cloudflare", keyId: " 4c1b5e7f9a " }, cloudflare)).toEqual(
      cloudflare,
    );
    expect(
      resolveDraft(
        { kind: "custom", urls: ["turn:relay.example.org:3478", " "], username: "workspace" },
        custom,
      ),
    ).toEqual({ ...custom, urls: ["turn:relay.example.org:3478"] });
  });

  it("asks for the secret again for another key or username", () => {
    expect(() => resolveDraft({ kind: "cloudflare", keyId: "another" }, cloudflare)).toThrow(
      "Enter the TURN key's API token.",
    );
    expect(() =>
      resolveDraft({ kind: "custom", urls: custom.urls, username: "someone" }, custom),
    ).toThrow("Enter the relay's password.");
  });

  it("says what to correct", () => {
    expect(() => resolveDraft({ kind: "cloudflare", keyId: "" }, null)).toThrow(
      "Enter the TURN key ID.",
    );
    expect(() =>
      resolveDraft({ kind: "cloudflare", keyId: "../../accounts", apiToken: TOKEN }, null),
    ).toThrow(/letters, digits, hyphens and underscores/);
    expect(() =>
      resolveDraft(
        { kind: "custom", urls: ["https://relay.example.org"], username: "u", credential: "p" },
        null,
      ),
    ).toThrow(/starts with turn: or turns:/);
    expect(() => resolveDraft({ kind: "custom", urls: [], username: "u" }, null)).toThrow(
      "Enter the relay's address.",
    );
    expect(() => resolveDraft({ kind: "mystery" }, null)).toThrow("Choose a kind of relay.");
    expect(resolveDraft({ kind: "none" }, cloudflare)).toBeNull();
  });
});
