import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Api, ApiError } from "@slackoss/client-core";
import type { ServerInfo, User } from "@slackoss/protocol";
import { JoinScreen } from "../src/screens/JoinScreen.js";
import type { HostingStatus, Platform, SavedServer } from "../src/platform.js";

/**
 * A sign-in the person gave up on must not finish for them later: its answer
 * can arrive after they cancelled, chose another workspace, or left the screen
 * altogether, and acting on it then takes them somewhere they no longer asked
 * to go (Q06).
 */
const rocket: SavedServer = {
  url: "http://rocket.test:8543",
  token: "test-token-not-a-credential",
  workspaceName: "Rocket Team",
  handle: "sam",
  lastUsedAt: 2,
};
const six: SavedServer = { ...rocket, url: "http://six.test:8543", workspaceName: "Six Team" };

const stopped: HostingStatus = { running: false, phase: "stopped" };
const platform: Platform = {
  kind: "desktop",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};

const sam = { id: "U_SAM", handle: "sam", displayName: "Sam Rivera" } as User;

/** Each saved sign-in is checked when the test says, in whatever order it chooses. */
function heldChecks() {
  const answers: (() => void)[] = [];
  vi.spyOn(Api.prototype, "me").mockImplementation(
    () => new Promise((resolve) => answers.push(() => resolve({ user: sam }))),
  );
  return answers;
}

function renderJoin(onConnected: (server: SavedServer) => void) {
  return render(
    <JoinScreen
      platform={platform}
      savedServers={[rocket, six]}
      onConnected={onConnected}
      onForget={() => {}}
      hostingStatus={stopped}
      lastHosted={null}
    />,
  );
}

const row = (name: string) => screen.getByRole("button", { name: new RegExp(`${name}.*@sam`) });
const settled = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

afterEach(() => vi.restoreAllMocks());

describe("a saved sign-in someone gave up on", () => {
  it("opens nothing when its answer comes after Cancel", async () => {
    const user = userEvent.setup();
    const answers = heldChecks();
    const onConnected = vi.fn();
    renderJoin(onConnected);

    await user.click(row("Rocket Team"));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    answers[0]!();
    await settled();

    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("opens nothing once the screen is gone", async () => {
    const user = userEvent.setup();
    const answers = heldChecks();
    const onConnected = vi.fn();
    const view = renderJoin(onConnected);

    await user.click(row("Rocket Team"));
    view.unmount();
    answers[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onConnected).not.toHaveBeenCalled();
  });

  it("still opens the workspace when nobody gave up on it", async () => {
    const user = userEvent.setup();
    const answers = heldChecks();
    const onConnected = vi.fn();
    renderJoin(onConnected);

    await user.click(row("Six Team"));
    answers[0]!();
    await settled();

    expect(onConnected).toHaveBeenCalledExactlyOnceWith(six);
  });
});

describe("a password someone was made to replace", () => {
  it("opens nothing when the screen is gone before the new one is saved", async () => {
    const user = userEvent.setup();
    const info: ServerInfo = {
      app: "slackoss",
      protocolVersion: 1,
      serverVersion: "0.0.0-test",
      workspaceName: "Rocket Team",
      userCount: 1,
      requiresInvite: false,
      requiresClaim: false,
    };
    // The saved sign-in has expired, so the workspace asks for the password again.
    vi.spyOn(Api.prototype, "me").mockRejectedValue(new ApiError(401, "unauthorized"));
    vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(info);
    vi.spyOn(Api.prototype, "login").mockResolvedValue({
      token: "test-token-not-a-credential",
      user: sam,
      mustChangePassword: true,
    } as Awaited<ReturnType<Api["login"]>>);
    let saved = () => {};
    vi.spyOn(Api.prototype, "changePassword").mockImplementation(
      () => new Promise((resolve) => (saved = () => resolve({ ok: true } as never))),
    );
    const onConnected = vi.fn();
    const view = renderJoin(onConnected);

    await user.click(row("Rocket Team"));
    await user.type(await screen.findByLabelText("Username"), "sam");
    await user.type(screen.getByLabelText("Password"), "given-by-the-host");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.type(await screen.findByLabelText("New password"), "my-own-password");
    await user.type(screen.getByLabelText("Confirm new password"), "my-own-password");
    await user.click(screen.getByRole("button", { name: "Set password and continue" }));

    view.unmount();
    saved();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onConnected).not.toHaveBeenCalled();
  });
});
