import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Api, ApiError, WorkspaceClient } from "@slackoss/client-core";
import type { Channel, ServerInfo, User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { HostDialog } from "../src/components/HostDialog.js";
import { WorkspaceIcon } from "../src/components/WorkspaceIcon.js";
import { WorkspaceSettings } from "../src/components/WorkspaceSettings.js";
import { JoinScreen } from "../src/screens/JoinScreen.js";
import { WorkspaceScreen } from "../src/screens/WorkspaceScreen.js";
import { useHostingStatus } from "../src/lib/hosting.js";
import { IconProblem } from "../src/lib/iconImage.js";
import { writeRoute } from "../src/lib/route.js";
import {
  cachedIconKey,
  forgetCachedIcon,
  useCachedWorkspaceIcons,
} from "../src/lib/workspaceIcon.js";
import type { HostedWorkspaces, HostingStatus, Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * The workspace's icon (UX-60): one part that shows it or the coloured
 * square, set in Workspace settings by the owner and admins, and shown in the
 * rail, on the join screen, in the saved workspaces and in hosting's lists.
 */

// jsdom has no canvas, so the picture's preparation is the browser's, stubbed here.
const prepared = vi.hoisted(() => ({ icon: vi.fn<(file: File) => Promise<Blob>>() }));
vi.mock("../src/lib/iconImage.js", async (original) => {
  const actual = await original<typeof import("../src/lib/iconImage.js")>();
  return { ...actual, prepareIcon: (file: File) => prepared.icon(file) };
});

const person = (id: string, displayName: string, role: User["role"]): User => ({
  id,
  handle: id.toLowerCase(),
  displayName,
  role,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});
const general: Channel = {
  id: "C_GENERAL",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
};

function storage(stored: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(stored));
  return {
    values,
    get: vi.fn(async (key: string) => (values.get(key) ?? null) as never),
    set: vi.fn(async (key: string, value: unknown) => void values.set(key, value)),
  };
}
const platformWith = (store = storage()): Platform => ({
  kind: "web",
  storage: store,
  notify: () => {},
});

const clients: WorkspaceClient[] = [];
let objectUrls = 0;
Element.prototype.scrollIntoView ??= () => {};
beforeEach(() => {
  // jsdom makes no object URLs; each fetched icon gets a name of its own.
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => `blob:icon-${++objectUrls}`),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(Api.prototype, "workspaceIcon").mockImplementation(
    async () => new Blob(["picture"], { type: "image/webp" }),
  );
});
afterEach(() => {
  // Unmount before the globals go: vitest runs these hooks in reverse.
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  prepared.icon.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function client(
  self: User,
  state: { workspaceIcon?: boolean; iconVersion?: string | null } = {},
  baseUrl = "http://127.0.0.1:9",
) {
  const workspace = new WorkspaceClient(baseUrl, "test-token-not-a-credential");
  clients.push(workspace);
  workspace.store.setState({
    self,
    users: { [self.id]: self },
    channels: { [general.id]: general },
    memberships: { [general.id]: 0 },
    status: "online",
    workspaceName: "Rocket Team",
    workspaceSettings: true,
    accessPolicy: "account_required",
    workspaceIcon: state.workspaceIcon ?? true,
    iconVersion: state.iconVersion ?? null,
  });
  return workspace;
}

/** Workspace settings on their own, for the owner, over stubbed calls. */
function settings(state: Parameters<typeof client>[1] = {}) {
  const workspace = client(person("U_SAM", "Sam Rivera", "owner"), state);
  const upload = vi
    .spyOn(workspace.api, "setWorkspaceIcon")
    .mockImplementation(async () => ({ iconVersion: "v-uploaded" }));
  const remove = vi
    .spyOn(workspace.api, "removeWorkspaceIcon")
    .mockImplementation(async () => ({ iconVersion: null }));
  render(
    <PlatformContext.Provider value={platformWith()}>
      <ClientContext.Provider value={workspace}>
        <ConfirmProvider>
          <WorkspaceSettings onClose={() => {}} />
        </ConfirmProvider>
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const dialog = screen.getByRole("dialog", { name: "Workspace settings" });
  const picker = within(dialog).queryByLabelText<HTMLInputElement>(
    "Choose a picture for the workspace icon",
  );
  return { client: workspace, dialog, picker, upload, remove, user: userEvent.setup() };
}

const picture = (type = "image/png", name = "logo.png") => new File(["a picture"], name, { type });

describe("WorkspaceIcon", () => {
  it("is the workspace's coloured square with its initial, hidden from screen readers, without an image", () => {
    const { container } = render(
      <>
        <WorkspaceIcon name="rocket team" size={36} className="rounded-xl" />
        <WorkspaceIcon name="Rocket Team" size={48} letters={2} />
      </>,
    );
    const [one, two] = [...container.children] as [HTMLElement, HTMLElement];
    expect(one).toHaveTextContent("R");
    expect(one).toHaveAttribute("aria-hidden", "true");
    expect(one).toHaveClass("rounded-xl");
    expect(one.style.width).toBe("36px");
    expect(one.style.background).toContain("linear-gradient");
    expect(two).toHaveTextContent("RT");
    expect(container.querySelector("img")).toBeNull();
  });

  it("is the image when there is one, and the square again if it will not load", () => {
    const { container } = render(
      <WorkspaceIcon name="Rocket Team" src="blob:icon" size={56} className="rounded-2xl" />,
    );
    const image = container.querySelector("img")!;
    expect(image).toHaveAttribute("src", "blob:icon");
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveAttribute("aria-hidden", "true");
    expect(image).toHaveClass("rounded-2xl");
    expect(image).toHaveAttribute("width", "56");
    fireEvent.error(image);
    expect(container.querySelector("img")).toBeNull();
    expect(container.firstElementChild).toHaveTextContent("R");
  });
});

describe("the icon in Workspace settings", () => {
  it("uploads a picture chosen from Upload icon, says Saved and shows it", async () => {
    const { dialog, picker, upload, client, user } = settings();
    expect(within(dialog).getByRole("heading", { name: "Workspace icon" })).toBeVisible();
    // No icon yet: the square, and nothing to remove.
    expect(within(dialog).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(await accessibilityProblems(dialog)).toEqual([]);

    // The button opens the system's picker, from the keyboard as from a touch.
    const opened = vi.spyOn(picker!, "click").mockImplementation(() => {});
    const button = within(dialog).getByRole("button", { name: "Upload icon" });
    button.focus();
    await user.keyboard("{Enter}");
    expect(opened).toHaveBeenCalledTimes(1);

    const made = new Blob(["square"], { type: "image/webp" });
    prepared.icon.mockResolvedValue(made);
    const chosen = picture();
    await user.upload(picker!, chosen);
    expect(prepared.icon).toHaveBeenCalledWith(chosen);
    expect(upload).toHaveBeenCalledWith(made);
    expect(await within(dialog).findByText("Saved")).toBeVisible();
    expect(client.state.iconVersion).toBe("v-uploaded");
    await waitFor(() =>
      expect(dialog.querySelector("section img")).toHaveAttribute(
        "src",
        expect.stringMatching(/^blob:icon-/),
      ),
    );
    expect(Api.prototype.workspaceIcon).toHaveBeenCalledWith("v-uploaded");
    expect(within(dialog).getByRole("button", { name: "Remove" })).toBeVisible();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("removes the icon without asking, and keeps focus on Upload icon", async () => {
    const { dialog, remove, client, user } = settings({ iconVersion: "v-old" });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await within(dialog).findByText("Saved")).toBeVisible();
    expect(client.state.iconVersion).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Upload icon" })).toHaveFocus();
  });

  it("says why a picture was refused beside the button, and keeps the icon it had", async () => {
    const { dialog, picker, upload, client, user } = settings({ iconVersion: "v-old" });
    const button = within(dialog).getByRole("button", { name: "Upload icon" });
    const cases: [() => void, string][] = [
      [
        () =>
          prepared.icon.mockRejectedValueOnce(
            new IconProblem("An SVG can't be an icon. Choose a PNG, JPEG or WebP picture."),
          ),
        "An SVG can't be an icon. Choose a PNG, JPEG or WebP picture.",
      ],
      [
        () => upload.mockRejectedValueOnce(new ApiError(415, "unsupported_icon_type")),
        "The server could not use that picture. Choose another PNG, JPEG or WebP.",
      ],
      [
        () => upload.mockRejectedValueOnce(new ApiError(413, "icon_too_large")),
        "That picture is too large for an icon. Choose a simpler one.",
      ],
      [
        () => upload.mockRejectedValueOnce(new ApiError(403, "admin_only")),
        "Only the workspace's owner and admins can change its icon.",
      ],
      [
        () => upload.mockRejectedValueOnce(new TypeError("Failed to fetch")),
        "The icon was not changed. Check your connection and try again.",
      ],
    ];
    for (const [fail, said] of cases) {
      prepared.icon.mockResolvedValue(new Blob(["square"], { type: "image/webp" }));
      fail();
      await user.upload(picker!, picture());
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(said);
      expect(button).toHaveAccessibleDescription(expect.stringContaining(said));
      expect(button).toHaveFocus();
      // Never left off: it can be pressed again at once.
      expect(button).not.toHaveAttribute("aria-disabled");
      expect(within(dialog).queryByText("Saved")).toBeNull();
    }
    expect(client.state.iconVersion).toBe("v-old");
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("is not offered by a server older than workspace icons", () => {
    const { dialog, picker } = settings({ workspaceIcon: false });
    expect(within(dialog).queryByRole("heading", { name: "Workspace icon" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Upload icon" })).toBeNull();
    expect(picker).toBeNull();
    // The name is still there to change.
    expect(within(dialog).getByLabelText("Workspace name")).toBeVisible();
  });
});

/** The whole workspace, as `role`, on a wide screen. */
async function workspaceAs(
  role: User["role"],
  state: Parameters<typeof client>[1] = {},
  store = storage(),
) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width"),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const workspace = client(person("U_SAM", "Sam Rivera", role), state);
  writeRoute(workspace.baseUrl, { channelId: general.id, threadRootId: null }, "replace");
  vi.spyOn(workspace, "loadTimeline").mockResolvedValue();
  vi.spyOn(workspace, "loadCommands").mockResolvedValue();
  const platform = platformWith(store);
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={workspace}>
        <ConfirmProvider>
          <WorkspaceScreen
            client={workspace}
            platform={platform}
            onLeaveWorkspace={() => {}}
            onSignedOut={() => {}}
          />
        </ConfirmProvider>
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  // The screen checks saved workspace access first.
  const trigger = await screen.findByRole(
    "button",
    { name: "Rocket Team, workspace menu" },
    { timeout: 3_000 },
  );
  return { client: workspace, trigger, user: userEvent.setup() };
}

describe("where the icon shows inside a workspace", () => {
  it("is in the rail beside the workspace's name, and changes when an admin changes it", async () => {
    const { client } = await workspaceAs("member", { iconVersion: "v-first" });
    const rail = screen.getByRole("group", { name: "Workspaces" });
    const current = within(rail).getByRole("button", { name: "Rocket Team" });
    await waitFor(() =>
      expect(current.querySelector("img")).toHaveAttribute(
        "src",
        expect.stringMatching(/^blob:icon-/),
      ),
    );
    const first = current.querySelector("img")!.getAttribute("src");
    // Another admin changes it: the event's version is fetched and shown.
    client.store.setState({ iconVersion: "v-second" });
    await waitFor(() => expect(current.querySelector("img")?.getAttribute("src")).not.toBe(first));
    // Removed: the coloured square with the initials.
    client.store.setState({ iconVersion: null });
    await waitFor(() => expect(current.querySelector("img")).toBeNull());
    expect(current).toHaveTextContent("RT");
  });

  it("is set only by the owner and admins: a member has no way to Workspace settings", async () => {
    const { trigger, user } = await workspaceAs("member");
    await user.click(trigger);
    const menu = screen.getByRole("menu", { name: "Workspace" });
    expect(within(menu).queryByRole("menuitem", { name: "Workspace settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upload icon" })).toBeNull();
    cleanup();

    const admin = await workspaceAs("admin");
    await admin.user.click(admin.trigger);
    await admin.user.click(screen.getByRole("menuitem", { name: "Workspace settings" }));
    expect(
      await screen.findByRole("button", { name: "Upload icon" }, { timeout: 3_000 }),
    ).toBeVisible();
  });

  it("forgets this device's copy once the workspace has none", async () => {
    const key = cachedIconKey("http://127.0.0.1:9");
    const store = storage({
      [key]: { version: 1, iconVersion: "v-gone", image: "data:image/webp;base64,AAAA" },
    });
    await workspaceAs("member", { iconVersion: null }, store);
    await waitFor(() => expect(store.set).toHaveBeenCalledWith(key, null));
  });
});

describe("where the icon shows before signing in", () => {
  const info: ServerInfo = {
    app: "slackoss",
    protocolVersion: 1,
    serverVersion: "0.0.0-test",
    workspaceName: "Rocket Team",
    userCount: 2,
    requiresInvite: false,
    requiresClaim: false,
  };

  async function joinCard(served: ServerInfo) {
    vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(served);
    render(
      <JoinScreen
        platform={platformWith()}
        savedServers={[]}
        autoProbe="http://127.0.0.1:18660"
        onConnected={() => {}}
        onForget={() => {}}
      />,
    );
    await screen.findByRole("tab", { name: "Sign in" });
    return screen.getByRole("heading", { name: "Rocket Team" }).parentElement!;
  }

  it("is on the join card, from the server, for anyone", async () => {
    const card = await joinCard({ ...info, iconVersion: "v-join" });
    await waitFor(() =>
      expect(card.querySelector("img")).toHaveAttribute(
        "src",
        expect.stringMatching(/^blob:icon-/),
      ),
    );
    expect(Api.prototype.workspaceIcon).toHaveBeenCalledWith("v-join");
  });

  it("is the coloured square on the card of a server with none, or one too old to say", async () => {
    for (const iconVersion of [null, undefined]) {
      const card = await joinCard({ ...info, iconVersion });
      expect(card.querySelector("img")).toBeNull();
      expect(card.querySelector('[aria-hidden="true"]')).toHaveTextContent("R");
      cleanup();
    }
    expect(Api.prototype.workspaceIcon).not.toHaveBeenCalled();
  });

  it("is in the saved workspaces as this device kept it, and the square where it kept none", () => {
    const saved = (url: string, workspaceName: string) => ({
      url,
      token: "test-token-not-a-credential",
      workspaceName,
      handle: "sam",
      lastUsedAt: 1,
    });
    render(
      <JoinScreen
        platform={{ ...platformWith(), kind: "desktop" }}
        savedServers={[
          saved("http://192.168.1.20:8543", "Rocket Team"),
          saved("http://192.168.1.30:8543", "Design Guild"),
        ]}
        savedIcons={{ "http://192.168.1.20:8543": "data:image/webp;base64,AAAA" }}
        onConnected={() => {}}
        onForget={() => {}}
      />,
    );
    const row = (name: string) => screen.getByText(name).closest("li")!;
    expect(row("Rocket Team").querySelector("img")).toHaveAttribute(
      "src",
      "data:image/webp;base64,AAAA",
    );
    expect(row("Design Guild").querySelector("img")).toBeNull();
    expect(row("Design Guild")).toHaveTextContent("D");
    // Kept on the device: nothing is asked of a server that may be off.
    expect(Api.prototype.workspaceIcon).not.toHaveBeenCalled();
  });

  it("is on a workspace found on the network, asked of its own address", async () => {
    render(
      <JoinScreen
        platform={{
          ...platformWith(),
          kind: "desktop",
          discoverLan: (listener) => {
            listener([
              {
                name: "Rocket Team",
                host: "192.168.1.20",
                port: 8543,
                serverVersion: "1.0.0",
                iconVersion: "0123456789abcdef",
              },
              // One that names no icon, or is too old to, keeps its square.
              { name: "Design Guild", host: "192.168.1.30", port: 8543, serverVersion: "1.0.0" },
            ]);
            return () => {};
          },
        }}
        savedServers={[]}
        onConnected={() => {}}
        onForget={() => {}}
      />,
    );
    const row = (name: string) => screen.getByText(name).closest("li")!;
    await waitFor(() =>
      expect(row("Rocket Team").querySelector("img")).toHaveAttribute(
        "src",
        expect.stringMatching(/^blob:icon-/),
      ),
    );
    const asked = vi.mocked(Api.prototype.workspaceIcon);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked).toHaveBeenCalledWith("0123456789abcdef");
    expect(asked.mock.contexts[0]).toMatchObject({ baseUrl: "http://192.168.1.20:8543" });
    expect(row("Design Guild").querySelector("img")).toBeNull();
    expect(row("Design Guild")).toHaveTextContent("D");
  });

  it("is read from this device for each saved workspace, and only as a picture it made", async () => {
    const store = storage({
      [cachedIconKey("http://a")]: {
        version: 1,
        iconVersion: "v1",
        image: "data:image/webp;base64,AAAA",
      },
      [cachedIconKey("http://b")]: {
        version: 1,
        iconVersion: "v1",
        image: "data:image/svg+xml;base64,PHN2Zz4=",
      },
      [cachedIconKey("http://c")]: { version: 2, image: "data:image/png;base64,AAAA" },
    });
    const platform = platformWith(store);
    const { result } = renderHook(() =>
      useCachedWorkspaceIcons(platform, ["http://a", "http://b", "http://c", "http://d"]),
    );
    await waitFor(() =>
      expect(result.current).toEqual({ "http://a": "data:image/webp;base64,AAAA" }),
    );
    await forgetCachedIcon(platform, "http://a");
    expect(store.set).toHaveBeenCalledWith(cachedIconKey("http://a"), null);
    await waitFor(() => expect(result.current).toEqual({}));
  });
});

describe("the icon of a workspace hosted on this computer", () => {
  type Hosting = NonNullable<Platform["hosting"]>;
  function Harness(props: { hosting: Hosting }) {
    const state = useHostingStatus(props.hosting);
    return (
      <HostDialog hosting={props.hosting} state={state} onClose={() => {}} onStarted={() => {}} />
    );
  }
  const entry = (folder: string, name: string, more: object) => ({
    folder,
    name,
    port: 8543,
    lastHostedAt: 1,
    lastBackupAt: null,
    running: false,
    missing: false,
    ...more,
  });

  it("shows a stopped one's icon from its own database, and the square for one without", async () => {
    const hosted: HostedWorkspaces = {
      workspaces: [
        entry("w-rocket", "Rocket Team", { iconVersion: "v-rocket" }),
        entry("w-design", "Design Guild", { iconVersion: null }),
        entry("w-gone", "Old Team", { missing: true, iconVersion: "v-gone" }),
      ],
      unreadable: [],
    };
    const hosting: Hosting = {
      status: vi.fn(async (): Promise<HostingStatus> => ({ running: false, phase: "stopped" })),
      start: vi.fn(),
      stop: vi.fn(),
      list: vi.fn(async () => hosted),
      icon: vi.fn(async () => "data:image/png;base64,AAAA"),
    };
    render(<Harness hosting={hosting} />);
    const list = await screen.findByRole("region", { name: "Hosted on this computer" });
    const row = (name: string) => within(list).getByText(name).closest("li")!;
    await waitFor(() =>
      expect(row("Rocket Team").querySelector("img")).toHaveAttribute(
        "src",
        "data:image/png;base64,AAAA",
      ),
    );
    expect(row("Design Guild").querySelector("img")).toBeNull();
    expect(row("Old Team").querySelector("img")).toBeNull();
    expect(hosting.icon).toHaveBeenCalledTimes(1);
    expect(hosting.icon).toHaveBeenCalledWith("w-rocket");
    // It was read, not started.
    expect(hosting.start).not.toHaveBeenCalled();
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);
  });

  it("shows the running one's icon beside its name, and refuses anything but a picture", async () => {
    const hosting: Hosting = {
      status: vi.fn(async (): Promise<HostingStatus> => ({
        running: true,
        phase: "running",
        workspaceName: "Rocket Team",
        folder: "w-rocket",
        port: 8543,
        lanUrls: ["192.168.1.20:8543"],
        iconVersion: "v-live",
      })),
      start: vi.fn(),
      stop: vi.fn(),
      icon: vi.fn(async () => "data:image/webp;base64,AAAA"),
    };
    render(<Harness hosting={hosting} />);
    const name = await screen.findByText("Rocket Team");
    await waitFor(() =>
      expect(name.parentElement!.querySelector("img")).toHaveAttribute(
        "src",
        "data:image/webp;base64,AAAA",
      ),
    );
    cleanup();

    vi.mocked(hosting.icon!).mockResolvedValue("javascript:alert(1)");
    vi.mocked(hosting.status).mockResolvedValue({
      running: true,
      phase: "running",
      workspaceName: "Rocket Team",
      folder: "w-rocket",
      port: 8543,
      iconVersion: "v-other",
    });
    render(<Harness hosting={hosting} />);
    const again = await screen.findByText("Rocket Team");
    await waitFor(() => expect(hosting.icon).toHaveBeenCalledTimes(2));
    expect(again.parentElement!.querySelector("img")).toBeNull();
  });
});
