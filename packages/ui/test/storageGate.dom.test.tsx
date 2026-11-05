import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@ownbase/client-core";
import { WorkspaceStorageGate } from "../src/components/WorkspaceStorageGate.js";
import type { Platform } from "../src/platform.js";

/**
 * Before the workspace has answered once, the app waits here. The desktop app
 * opens with no network, or with the server down, and then waited under
 * "Connecting to the workspace…" for as long as it took, never saying why.
 */
const clients: WorkspaceClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
});

const platform: Platform = {
  kind: "desktop",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};

function gate() {
  const client = new WorkspaceClient("http://192.168.1.5:8543", "synthetic-test-token");
  clients.push(client);
  render(
    <WorkspaceStorageGate
      platform={platform}
      client={client}
      onLeaveWorkspace={() => {}}
      onSignedOut={() => {}}
    >
      <p>The workspace</p>
    </WorkspaceStorageGate>,
  );
  return client;
}

describe("waiting for the workspace's first answer", () => {
  it("says it is connecting while the first try is under way", () => {
    gate();
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to the workspace…");
  });

  it("names the address it cannot reach once a try has failed, and that it keeps trying", () => {
    const client = gate();
    act(() => client.store.setState({ status: "reconnecting" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Can't reach the workspace at 192.168.1.5:8543. OwnBase keeps trying, and opens it once it answers.",
    );
  });

  it("says the device is offline when it is", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    gate();
    expect(screen.getByRole("status")).toHaveTextContent(
      "This device is offline. The workspace opens once the network is back.",
    );
  });
});
