import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Api, ApiError } from "@ownbase/client-core";
import type { ServerInfo, User } from "@ownbase/protocol";
import { JoinScreen } from "../src/screens/JoinScreen.js";
import { useLastHosted } from "../src/lib/hosting.js";
import { hostedButStopped, resumeTarget } from "../src/lib/resume.js";
import type {
  HostingStart,
  HostingStatus,
  LastHosted,
  Platform,
  SavedServer,
} from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

const saved: SavedServer = {
  url: "http://localhost:8543",
  token: "test-token-not-a-credential",
  workspaceName: "Rocket Team",
  handle: "sam",
  lastUsedAt: 1,
};

const info: ServerInfo = {
  app: "ownbase",
  protocolVersion: 1,
  serverVersion: "0.0.0-test",
  workspaceName: "Rocket Team",
  userCount: 3,
  requiresInvite: false,
  requiresClaim: false,
};

const owner: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "owner",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

const stopped: HostingStatus = { running: false, phase: "stopped" };
const running: HostingStatus = {
  running: true,
  phase: "running",
  workspaceName: "Rocket Team",
  port: 8543,
};
const remembered = { folder: "w-rocket", workspaceName: "Rocket Team", port: 8543 };

describe("finding the workspace to resume", () => {
  it("matches a saved sign-in by loopback address and port, not by name", () => {
    const target = resumeTarget([saved], stopped, remembered);
    expect(target).toEqual({ saved, workspaceName: "Rocket Team" });
    expect(
      resumeTarget([{ ...saved, url: "http://127.0.0.1:8543" }], stopped, remembered)?.saved.url,
    ).toBe("http://127.0.0.1:8543");
  });

  it("says no when hosting runs, nothing is remembered, or nobody saved it", () => {
    expect(resumeTarget([saved], running, remembered)).toBeNull();
    expect(resumeTarget([saved], { running: false, phase: "starting" }, remembered)).toBeNull();
    expect(resumeTarget([saved], stopped, null)).toBeNull();
    expect(resumeTarget([saved], null, remembered)).toBeNull();
    expect(resumeTarget([], stopped, remembered)).toBeNull();
    expect(
      resumeTarget([{ ...saved, url: "https://chat.example.dev" }], stopped, remembered),
    ).toBeNull();
    expect(
      resumeTarget([{ ...saved, url: "http://localhost:9000" }], stopped, remembered),
    ).toBeNull();
    expect(resumeTarget([{ ...saved, url: "not a url" }], stopped, remembered)).toBeNull();
  });

  it("never mistakes an unreadable bridge for a stopped workspace", async () => {
    await expect(hostedButStopped(saved, undefined)).resolves.toBe(false);
    await expect(
      hostedButStopped(saved, {
        status: async () => stopped,
        lastHosted: async () => {
          throw new Error("settings locked");
        },
      }),
    ).resolves.toBe(false);
    await expect(
      hostedButStopped(saved, {
        status: async () => stopped,
        lastHosted: async () => remembered,
      }),
    ).resolves.toBe(true);
  });
});

/** The join screen over a desktop platform whose hosting answers from stubs. */
function joinWith(options: {
  hostingStatus?: HostingStatus | null;
  lastHosted?: LastHosted | null;
  start?: (opts: HostingStart) => Promise<HostingStatus>;
}) {
  const start =
    options.start ??
    (async () => ({ running: true, phase: "running", workspaceName: "Rocket Team", port: 8543 }));
  const startSpy = vi.fn(start);
  const onConnected = vi.fn();
  const platform: Platform = {
    kind: "desktop",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
    hosting: {
      status: async () => options.hostingStatus ?? stopped,
      start: startSpy,
      stop: async () => {},
      lastHosted: async () => options.lastHosted ?? null,
    },
  };
  render(
    <JoinScreen
      platform={platform}
      savedServers={[saved]}
      onConnected={onConnected}
      onForget={() => {}}
      onHostClick={() => {}}
      hostingStatus={options.hostingStatus ?? stopped}
      lastHosted={options.lastHosted ?? null}
    />,
  );
  return { start: startSpy, onConnected, user: userEvent.setup() };
}

afterEach(() => vi.restoreAllMocks());

describe("resuming a hosted workspace", () => {
  it("offers to host it again, and reopens it without asking for the password", async () => {
    const me = vi.spyOn(Api.prototype, "me").mockResolvedValue({ user: owner });
    const { start, onConnected, user } = joinWith({ lastHosted: remembered });
    const card = screen.getByRole("region", { name: "Hosted on this computer" });
    expect(card).toHaveTextContent(/Rocket Team.*isn’t running/);
    expect(await accessibilityProblems(card)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Start hosting Rocket Team" }));
    // By its entry: a name could belong to another workspace hosted here.
    expect(start).toHaveBeenCalledWith({ folder: "w-rocket", port: 8543 });
    // Started on its remembered port, the saved sign-in still works there.
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(saved));
    expect(me.mock.contexts[0]).toMatchObject({ baseUrl: saved.url });
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("starts it by name on an app too old to name its entry", async () => {
    vi.spyOn(Api.prototype, "me").mockResolvedValue({ user: owner });
    const { start, user } = joinWith({
      lastHosted: { workspaceName: "Rocket Team", port: 8543 },
    });
    await user.click(screen.getByRole("button", { name: "Start hosting Rocket Team" }));
    expect(start).toHaveBeenCalledWith({ workspaceName: "Rocket Team", port: 8543 });
  });

  it("asks for the password only when the saved sign-in stopped working", async () => {
    vi.spyOn(Api.prototype, "me").mockRejectedValue(new ApiError(401, "unauthorized"));
    vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(info);
    const { onConnected, user } = joinWith({ lastHosted: remembered });
    await user.click(screen.getByRole("button", { name: "Start hosting Rocket Team" }));
    expect(await screen.findByRole("heading", { name: "Rocket Team" })).toBeVisible();
    expect(screen.getByLabelText("Password")).toBeVisible();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("says when starting fails, and how to start it on another port", async () => {
    const { onConnected, user } = joinWith({
      lastHosted: remembered,
      start: async () => {
        throw new Error("port taken");
      },
    });
    await user.click(screen.getByRole("button", { name: "Start hosting Rocket Team" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not start Rocket Team on port 8543.");
    expect(alert).toHaveTextContent(
      /choose Host a workspace on this computer and start it from the list/,
    );
    expect(screen.getByRole("button", { name: "Host a workspace on this computer" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Start hosting Rocket Team" })).toBeEnabled();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("stays quiet when hosting runs, nothing is remembered, or nobody saved it", async () => {
    for (const options of [
      { hostingStatus: running, lastHosted: remembered },
      { lastHosted: null },
    ] as const) {
      const { unmount } = render(
        <JoinScreen
          platform={{
            kind: "desktop",
            storage: { get: async () => null, set: async () => {} },
            notify: () => {},
          }}
          savedServers={[saved]}
          onConnected={() => {}}
          onForget={() => {}}
          hostingStatus={options.hostingStatus ?? stopped}
          lastHosted={options.lastHosted ?? null}
        />,
      );
      expect(screen.queryByRole("region", { name: "Hosted on this computer" })).toBeNull();
      unmount();
    }
  });
});

describe("what this computer hosted last", () => {
  it("is read again whenever hosting starts or stops", async () => {
    const lastHosted = vi
      .fn<() => Promise<{ workspaceName: string; port: number } | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ workspaceName: "Beta", port: 8544 });
    const hosting = { status: async () => stopped, start: vi.fn(), stop: vi.fn(), lastHosted };
    function Remembered({ status }: { status: HostingStatus | null }) {
      const value = useLastHosted(hosting, status);
      return <output>{value ? `${value.workspaceName} on ${value.port}` : "nothing"}</output>;
    }
    const betaRunning: HostingStatus = {
      running: true,
      phase: "running",
      workspaceName: "Beta",
      port: 8544,
    };

    const view = render(<Remembered status={stopped} />);
    await waitFor(() => expect(lastHosted).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent("nothing");

    // Hosting something else changes the answer.
    view.rerender(<Remembered status={betaRunning} />);
    expect(await screen.findByText("Beta on 8544")).toBeVisible();
    expect(lastHosted).toHaveBeenCalledTimes(2);

    // A status that says the same thing again asks nothing new; stopping does.
    view.rerender(<Remembered status={{ ...betaRunning }} />);
    view.rerender(<Remembered status={stopped} />);
    await waitFor(() => expect(lastHosted).toHaveBeenCalledTimes(3));
  });
});
