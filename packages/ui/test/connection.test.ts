import { describe, expect, it } from "vitest";
import { ApiError } from "@ownbase/client-core";
import { PROTOCOL_VERSION, type ServerInfo } from "@ownbase/protocol";
import { connectionFailure, incompatibleWorkspace } from "../src/lib/connection.js";

const workspace = (patch: Partial<ServerInfo> = {}): ServerInfo => ({
  app: "ownbase",
  protocolVersion: PROTOCOL_VERSION,
  serverVersion: "0.1.0",
  workspaceName: "Rocket Team",
  userCount: 3,
  requiresInvite: false,
  requiresClaim: false,
  ...patch,
});

describe("connectionFailure", () => {
  it("names the credentials, not the address, when the workspace refuses them", () => {
    const message = connectionFailure({
      url: "http://192.168.1.5:8543",
      error: new ApiError(401, "unauthorized"),
      name: "Rocket Team",
    });
    expect(message).toMatch(/credentials/);
    expect(message).not.toMatch(/same network/);
  });

  it("explains that the browser, not the server, is blocking plain http", () => {
    const message = connectionFailure({
      url: "http://192.168.1.5:8543",
      error: new TypeError("Failed to fetch"),
      pageProtocol: "https:",
    });
    expect(message).toMatch(/https/);
    expect(message).toMatch(/desktop app/);
  });

  it("treats the same failure as unreachable when the page is not on https", () => {
    const message = connectionFailure({
      url: "http://192.168.1.5:8543",
      error: new TypeError("Failed to fetch"),
      pageProtocol: "http:",
    });
    expect(message).toMatch(/Could not reach/);
  });

  it("separates a timeout from a refusal", () => {
    expect(
      connectionFailure({
        url: "http://slow.example:8543",
        error: new DOMException("timed out", "TimeoutError"),
      }),
    ).toMatch(/did not answer in time/);
  });
});

describe("incompatibleWorkspace", () => {
  it("accepts a workspace speaking this protocol", () => {
    expect(incompatibleWorkspace("http://a:8543", workspace())).toBeNull();
  });

  it("tells the reader which side is behind", () => {
    expect(
      incompatibleWorkspace("http://a:8543", workspace({ protocolVersion: PROTOCOL_VERSION + 1 })),
    ).toMatch(/Update this app/);
    expect(
      incompatibleWorkspace("http://a:8543", workspace({ protocolVersion: PROTOCOL_VERSION - 1 })),
    ).toMatch(/update the server/);
  });

  it("does not call an unrelated web server a workspace", () => {
    expect(
      incompatibleWorkspace(
        "http://a:8543",
        workspace({ app: "something-else" as ServerInfo["app"] }),
      ),
    ).toMatch(/not a workspace/);
  });
});
