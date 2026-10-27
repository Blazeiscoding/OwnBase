import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Api } from "@ownbase/client-core";
import type { ServerInfo } from "@ownbase/protocol";
import { JoinScreen } from "../src/screens/JoinScreen.js";
import type { DiscoveredServer, HostingStatus, Platform } from "../src/platform.js";

const info: ServerInfo = {
  app: "ownbase",
  protocolVersion: 1,
  serverVersion: "0.0.0-test",
  workspaceName: "Six Team",
  userCount: 1,
  requiresInvite: false,
  requiresClaim: false,
};

/** This computer hosts Rocket Team on the usual port; the network holds more. */
const hosting: HostingStatus = {
  running: true,
  phase: "running",
  workspaceName: "Rocket Team",
  port: 8543,
  instanceId: "instance-here",
};

function joinWith(found: DiscoveredServer[]) {
  const platform: Platform = {
    kind: "desktop",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
    discoverLan: (listener) => {
      listener(found);
      return () => {};
    },
  };
  render(
    <JoinScreen
      platform={platform}
      savedServers={[]}
      onConnected={() => {}}
      onForget={() => {}}
      hostingStatus={hosting}
      lastHosted={null}
    />,
  );
  return userEvent.setup();
}

afterEach(() => vi.restoreAllMocks());

describe("workspaces found on the network", () => {
  it("calls only this computer's own workspace hosted here, not another on the same port", () => {
    joinWith([
      {
        name: "Rocket Team",
        host: "192.168.1.20",
        port: 8543,
        serverVersion: "1.0.0",
        instanceId: "instance-here",
      },
      {
        name: "Design Guild",
        host: "192.168.1.30",
        port: 8543,
        serverVersion: "1.0.0",
        instanceId: "instance-elsewhere",
      },
      // An older server says nothing of its instance, so nothing is claimed.
      { name: "Old Team", host: "192.168.1.40", port: 8543, serverVersion: "0.9.0" },
    ]);
    const row = (name: string) => screen.getByText(name).closest("li")!;
    expect(row("Rocket Team")).toHaveTextContent("hosted here");
    expect(row("Design Guild")).not.toHaveTextContent("hosted here");
    expect(row("Design Guild")).toHaveTextContent("v1.0.0");
    expect(row("Old Team")).not.toHaveTextContent("hosted here");
  });

  it("writes an IPv6 address in brackets, and connects to it", async () => {
    const serverInfo = vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(info);
    const user = joinWith([
      { name: "Six Team", host: "2001:db8::7", port: 8543, serverVersion: "1.0.0" },
    ]);
    const row = screen.getByText("Six Team").closest("li")!;
    expect(row).toHaveTextContent("[2001:db8::7]:8543");

    await user.click(within(row).getByRole("button", { name: /Six Team/ }));
    expect(serverInfo).toHaveBeenCalled();
    expect(serverInfo.mock.contexts[0]).toMatchObject({ baseUrl: "http://[2001:db8::7]:8543" });
  });
});

describe("Direct connect", () => {
  it("says under the field what Connect needs, rather than waiting greyed out", async () => {
    const serverInfo = vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(info);
    const user = joinWith([]);
    const field = screen.getByRole("textbox", { name: "Server address" });
    const connect = screen.getByRole("button", { name: "Connect" });

    // Pressed with nothing typed, it asks for an address and puts focus there.
    expect(connect).toBeEnabled();
    await user.click(connect);
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(
      "Type the workspace's address, such as 192.168.1.42:8543.",
    );

    // One that cannot be an address is said there too, and nothing is asked.
    await user.type(field, "http://");
    expect(field).not.toHaveAttribute("aria-invalid");
    await user.keyboard("{Enter}");
    expect(field).toHaveAccessibleDescription("That doesn't look like a workspace address.");
    expect(serverInfo).not.toHaveBeenCalled();

    // A real one is looked up.
    await user.clear(field);
    await user.type(field, "192.168.1.42{Enter}");
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(serverInfo).toHaveBeenCalled();
    expect(serverInfo.mock.contexts[0]).toMatchObject({ baseUrl: "http://192.168.1.42:8543" });
  });
});
