import { describe, expect, it } from "vitest";
import {
  browserLink,
  desktopLink,
  isLoopbackUrl,
  parseDeepLink,
  serverAddress,
  shareableServer,
} from "../src/lib/deeplink.js";
import type { HostingStatus } from "../src/platform.js";

describe("parseDeepLink", () => {
  it("reads a join link with an invite code", () => {
    expect(parseDeepLink("ownbase://join?host=192.168.1.5:8543&code=ABCD1234")).toEqual({
      kind: "join",
      serverUrl: "http://192.168.1.5:8543",
      code: "ABCD1234",
    });
  });

  it("reads a message link", () => {
    expect(parseDeepLink("ownbase://message?host=192.168.1.5:8543&channel=C123&id=M456")).toEqual({
      kind: "message",
      serverUrl: "http://192.168.1.5:8543",
      channelId: "C123",
      messageId: "M456",
    });
  });

  it("refuses the same link under another app's scheme", () => {
    expect(parseDeepLink("otherapp://join?host=192.168.1.5:8543&code=ABCD1234")).toBeNull();
    expect(
      parseDeepLink("otherapp://message?host=192.168.1.5:8543&channel=C123&id=M456"),
    ).toBeNull();
  });

  it("reads a join link without a code", () => {
    const link = parseDeepLink("ownbase://join?host=chat.example.dev");
    expect(link).toEqual({
      kind: "join",
      serverUrl: "http://chat.example.dev:8543",
      code: null,
    });
  });

  it("reads a message permalink", () => {
    expect(parseDeepLink("ownbase://message?host=192.168.1.5:8543&channel=C123&id=M456")).toEqual({
      kind: "message",
      serverUrl: "http://192.168.1.5:8543",
      channelId: "C123",
      messageId: "M456",
    });
  });

  it("survives a url-encoded host", () => {
    const link = parseDeepLink("ownbase://join?host=192.168.1.5%3A8543");
    expect(link?.serverUrl).toBe("http://192.168.1.5:8543");
  });

  it("reads the browser form of both, from the address's fragment", () => {
    expect(parseDeepLink("https://chat.team.dev/#/join/ABCD1234")).toEqual({
      kind: "join",
      serverUrl: "https://chat.team.dev",
      code: "ABCD1234",
    });
    expect(parseDeepLink("http://192.168.1.5:8543/#/c/C123/m/M456")).toEqual({
      kind: "message",
      serverUrl: "http://192.168.1.5:8543",
      channelId: "C123",
      messageId: "M456",
    });
  });

  it("reads a link to claim a workspace nobody owns yet", () => {
    expect(parseDeepLink("https://acme.ownbase.chat/#/claim/claim-0123456789abcdef")).toEqual({
      kind: "claim",
      serverUrl: "https://acme.ownbase.chat",
      code: "claim-0123456789abcdef",
    });
    expect(parseDeepLink("https://acme.ownbase.chat/#/claim/")).toBeNull();
    expect(parseDeepLink("https://acme.ownbase.chat/#/claim/a/b")).toBeNull();
    expect(parseDeepLink("https://acme.ownbase.chat/#/claim/AB%2FCD")).toBeNull();
  });

  it("rejects anything malformed rather than throwing", () => {
    expect(parseDeepLink("not a url")).toBeNull();
    expect(parseDeepLink("https://example.com/join?host=x")).toBeNull();
    expect(parseDeepLink("ownbase://join")).toBeNull();
    expect(parseDeepLink("ownbase://message?host=h&channel=C1")).toBeNull();
    expect(parseDeepLink("ownbase://explode?host=h")).toBeNull();
    expect(parseDeepLink("https://chat.team.dev/")).toBeNull();
    expect(parseDeepLink("https://chat.team.dev/#/join/")).toBeNull();
    expect(parseDeepLink("https://chat.team.dev/#/join/AB%2FCD")).toBeNull();
    expect(parseDeepLink("https://chat.team.dev/#/c/C1/m/M1/extra")).toBeNull();
    expect(parseDeepLink("https://chat.team.dev/#/c/C1")).toBeNull();
    // Some other site's hash-routed page, rather than a workspace's root.
    expect(parseDeepLink("https://example.com/docs/#/c/C1/m/M1")).toBeNull();
    expect(parseDeepLink("https://example.com/?page=2#/join/ABCD1234")).toBeNull();
  });
});

describe("links", () => {
  const servers = [
    "http://192.168.1.5:8543",
    "https://chat.team.dev",
    "https://chat.team.dev:9443",
    // A plain proxy on port 80: dropping the scheme would add :8543.
    "http://chat.local",
    "http://[fd00::5]:8543",
  ];

  it.each(servers)("lead back to %s in both forms", (serverUrl) => {
    const join = { kind: "join", code: "ABCD1234" } as const;
    const message = { kind: "message", channelId: "C123", messageId: "M456" } as const;
    for (const build of [browserLink, desktopLink]) {
      expect(parseDeepLink(build(serverUrl, join))).toEqual({ ...join, serverUrl });
      expect(parseDeepLink(build(serverUrl, message))).toEqual({ ...message, serverUrl });
    }
  });

  it("write an address as briefly as reads back the same", () => {
    expect(serverAddress("http://192.168.1.5:8543")).toBe("192.168.1.5:8543");
    expect(serverAddress("https://chat.team.dev")).toBe("https://chat.team.dev");
    expect(serverAddress("http://chat.local")).toBe("http://chat.local");
    expect(desktopLink("https://chat.team.dev", { kind: "join", code: "ABCD1234" })).toBe(
      "ownbase://join?host=https://chat.team.dev&code=ABCD1234",
    );
    expect(browserLink("http://192.168.1.5:8543", { kind: "join", code: "ABCD1234" })).toBe(
      "http://192.168.1.5:8543/#/join/ABCD1234",
    );
  });

  it("know which addresses reach only this computer", () => {
    for (const local of [
      "http://localhost:8543",
      "http://127.0.0.1:8543",
      "http://127.4.0.1:8543",
      "http://[::1]:8543",
      "http://app.localhost:8543",
    ]) {
      expect(isLoopbackUrl(local)).toBe(true);
    }
    for (const remote of ["http://192.168.1.5:8543", "https://chat.team.dev", "http://10.0.0.2"]) {
      expect(isLoopbackUrl(remote)).toBe(false);
    }
  });
});

describe("shareableServer", () => {
  const hosting: HostingStatus = {
    running: true,
    phase: "running",
    port: 8543,
    lanUrls: ["172.28.64.1:8543", "100.101.2.3:8543", "192.168.1.20:8543"],
  };

  it("uses the address this app is connected to when others can reach it", () => {
    expect(shareableServer({ baseUrl: "http://192.168.1.20:8543", hosting })).toEqual({
      serverUrl: "http://192.168.1.20:8543",
      alternatives: [],
      localOnly: false,
    });
  });

  it("prefers the address the host published", () => {
    expect(
      shareableServer({ baseUrl: "http://localhost:8543", publicUrl: "https://chat.team.dev" }),
    ).toEqual({ serverUrl: "https://chat.team.dev", alternatives: [], localOnly: false });
    expect(
      shareableServer({
        baseUrl: "http://192.168.1.20:8543",
        publicUrl: "https://chat.team.dev",
      }),
    ).toEqual({ serverUrl: "https://chat.team.dev", alternatives: [], localOnly: false });
    // Clients reach servers at their root, so an address under a path is no use.
    expect(
      shareableServer({ baseUrl: "http://localhost:8543", publicUrl: "https://example.com/chat" }),
    ).toEqual({ serverUrl: "http://localhost:8543", alternatives: [], localOnly: true });
  });

  it("puts a network address in place of localhost when this app hosts the workspace", () => {
    expect(shareableServer({ baseUrl: "http://localhost:8543", hosting })).toEqual({
      serverUrl: "http://192.168.1.20:8543",
      alternatives: ["http://100.101.2.3:8543", "http://172.28.64.1:8543"],
      localOnly: false,
    });
  });

  it("uses only the live public address owned by this desktop host", () => {
    const open: HostingStatus = {
      ...hosting,
      tunnelAvailable: true,
      openToAll: { phase: "open", url: "https://fresh-link.trycloudflare.com" },
    };
    expect(
      shareableServer({
        baseUrl: "http://localhost:8543",
        publicUrl: "https://stale-link.trycloudflare.com",
        hosting: open,
      }),
    ).toEqual({
      serverUrl: "https://fresh-link.trycloudflare.com",
      alternatives: [],
      localOnly: false,
    });

    expect(
      shareableServer({
        baseUrl: "http://localhost:8543",
        publicUrl: "https://fresh-link.trycloudflare.com",
        hosting: { ...open, openToAll: undefined },
      }),
    ).toEqual({
      serverUrl: "http://192.168.1.20:8543",
      alternatives: ["http://100.101.2.3:8543", "http://172.28.64.1:8543"],
      localOnly: false,
    });
  });

  it("says so when the only address it knows reaches just this computer", () => {
    const elsewhere: HostingStatus = { ...hosting, port: 9000 };
    const stopped: HostingStatus = { ...hosting, running: false, phase: "stopped" };
    const noNetwork: HostingStatus = { ...hosting, lanUrls: [] };
    for (const status of [null, elsewhere, stopped, noNetwork]) {
      expect(shareableServer({ baseUrl: "http://localhost:8543", hosting: status })).toEqual({
        serverUrl: "http://localhost:8543",
        alternatives: [],
        localOnly: true,
      });
    }
  });
});
