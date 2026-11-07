import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Api } from "@ownbase/client-core";
import type { ServerInfo } from "@ownbase/protocol";
import { JoinScreen } from "../src/screens/JoinScreen.js";
import type { Platform, SavedServer } from "../src/platform.js";

/**
 * In a browser, the workspace that served the page is offered as "This
 * workspace". Once this browser is signed in there it is one of "Your
 * workspaces", and listing it twice only makes the reader wonder which to pick.
 */
const info: ServerInfo = {
  app: "ownbase",
  protocolVersion: 2,
  serverVersion: "0.0.0-test",
  workspaceName: "Rocket Team",
  userCount: 4,
  requiresInvite: false,
  accessPolicy: "account_required",
  workspaceCopies: false,
  iconVersion: null,
  requiresClaim: false,
};
const platform: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};
const saved = (url: string, workspaceName: string): SavedServer => ({
  url,
  token: "test-token-not-a-credential",
  workspaceName,
  handle: "sam",
  lastUsedAt: 1,
});

afterEach(() => vi.restoreAllMocks());

describe("the workspace serving this page", () => {
  it("is listed once, under Your workspaces, when this browser is signed in there", async () => {
    vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(info);
    render(
      <JoinScreen
        platform={platform}
        savedServers={[saved(window.location.origin, "Rocket Team")]}
        onConnected={() => {}}
        onForget={() => {}}
      />,
    );
    expect(await screen.findByText("Your workspaces")).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("This workspace")).toBeNull();
    expect(screen.queryByText("serving this page")).toBeNull();
  });

  it("is offered on its own while the browser is signed in somewhere else", async () => {
    vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(info);
    render(
      <JoinScreen
        platform={platform}
        savedServers={[saved("http://design.test:8543", "Design Guild")]}
        onConnected={() => {}}
        onForget={() => {}}
      />,
    );
    expect(await screen.findByText("serving this page")).toBeVisible();
    expect(screen.getByText("Your workspaces")).toBeVisible();
  });
});
