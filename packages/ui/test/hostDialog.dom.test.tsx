import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HostDialog } from "../src/components/HostDialog.js";
import { useHostingStatus } from "../src/lib/hosting.js";
import type {
  AutoBackup,
  HostedWorkspaces,
  HostingStart,
  HostingStatus,
  Platform,
  RestoreInventory,
} from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";
import type { AccessPolicy } from "@slackoss/protocol";

type Hosting = NonNullable<Platform["hosting"]>;

const stopped: HostingStatus = { running: false, phase: "stopped" };
const publicUrl = "https://rocket-team.trycloudflare.com";
const running: HostingStatus = {
  running: true,
  phase: "running",
  workspaceName: "Rocket Team",
  port: 8543,
  lanUrls: ["192.168.1.20:8543"],
  dataDir: "C:\\Users\\sam\\AppData\\Roaming\\Tandem\\hosted\\rocket-team",
  backgroundAvailable: true,
};

/** The desktop app's hosting bridge, with a status that can change underneath the dialog. */
function fakeHosting(
  initial: HostingStatus,
  hosted?: HostedWorkspaces,
  /** An app with guest access, which says who may join as a policy. */
  options: { guests?: boolean } = {},
) {
  let current = initial;
  const listeners = new Set<(status: HostingStatus) => void>();
  const hosting = {
    status: vi.fn(async () => current),
    start: vi.fn(async (request: HostingStart) => {
      const workspaceName =
        "folder" in request
          ? hosted!.workspaces.find((w) => w.folder === request.folder)!.name
          : request.workspaceName;
      current = { ...running, workspaceName };
      return current;
    }),
    ...(hosted
      ? {
          list: vi.fn(async () => hosted),
          forget: vi.fn(async (_folder: string) => {}),
          restore: vi.fn(
            async (): Promise<{
              folder: string;
              name: string;
              inventory?: RestoreInventory | null;
            } | null> => ({
              folder: "w-restored",
              name: "Rocket Team",
              inventory: {
                appAddresses: [{ origin: "https://bot.example", uses: ["events"] }],
                scheduled: { waiting: 1, earliestAt: null },
                undeliveredEvents: 0,
                sessions: 2,
              },
            }),
          ),
          backup: vi.fn(async (folder: string): Promise<{ path: string; at: number } | null> => ({
            path: `/backups/${folder}-2026-09-25T10-00-00`,
            at: Date.now(),
          })),
          rename: vi.fn(async (folder: string, name: string) => ({ folder, name: name.trim() })),
          openFolder: vi.fn(async (_folder: string) => {}),
          setPort: vi.fn(async (folder: string, port: number) => ({ folder, port })),
          setAutoBackup: vi.fn(
            async (
              _folder: string,
              schedule: { everyDays: 1 | 7; keep: number } | null,
              _chooseFolder: boolean,
            ): Promise<AutoBackup | null | undefined> =>
              schedule ? { destination: "D:\\Backups", ...schedule } : null,
          ),
          retryBackups: vi.fn(async () => {}),
        }
      : {}),
    stop: vi.fn(async () => {
      current = stopped;
    }),
    openToAll: vi.fn(
      async ({
        inviteOnly,
        accessPolicy,
      }: {
        inviteOnly: boolean;
        accessPolicy?: AccessPolicy;
      }) => {
        current = {
          ...current,
          openToAll: { phase: "open", url: publicUrl },
          tunnelAvailable: true,
          inviteOnly,
          ...(accessPolicy ? { accessPolicy } : {}),
        };
        return current;
      },
    ),
    ...(options.guests
      ? {
          setAccessPolicy: vi.fn(async (accessPolicy: AccessPolicy) => {
            current = { ...current, accessPolicy, inviteOnly: accessPolicy === "invite_only" };
            return current;
          }),
        }
      : {}),
    endOpenToAll: vi.fn(async () => {
      delete current.openToAll;
      current = { ...current, openToAllError: undefined };
      return current;
    }),
    setInviteOnly: vi.fn(async (inviteOnly: boolean) => {
      current = { ...current, inviteOnly };
      return current;
    }),
    // The main process validates and saves; here it simply takes what it is given.
    setPublicAddress: vi.fn(async (address: string) => {
      current = address
        ? {
            ...current,
            publicAddress: address,
            publicAddressSetting: address,
            inviteOnly: true,
            openToAllError: undefined,
          }
        : {
            ...current,
            publicAddress: undefined,
            publicAddressSetting: undefined,
            inviteOnly: true,
            openToAllError: undefined,
          };
      return current;
    }),
    subscribe: (listener: (status: HostingStatus) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  /** A change made somewhere else, such as the tray, arriving while the dialog is open. */
  const push = (next: HostingStatus) => {
    current = next;
    act(() => listeners.forEach((listener) => listener(next)));
  };
  return { hosting, push };
}

/** Opens one section of a running workspace's management. */
async function showSection(name: "Overview" | "Share on the internet" | "Backups" | "Advanced") {
  await userEvent.setup().click(await screen.findByRole("tab", { name }));
}

/** Holds the status the way the app does, above a dialog that may not be open yet. */
function Harness(props: {
  hosting: Hosting;
  open?: boolean;
  viewingHosted?: boolean;
  onStarted?: (status: HostingStatus) => void;
  onClose?: () => void;
  onInvite?: () => void;
}) {
  const state = useHostingStatus(props.hosting);
  return (
    <>
      <output>{state.status ? "status known" : "status unknown"}</output>
      {props.open !== false && (
        <HostDialog
          hosting={props.hosting}
          state={state}
          viewingHosted={props.viewingHosted}
          onInvite={props.onInvite}
          onClose={props.onClose ?? (() => {})}
          onStarted={props.onStarted ?? (() => {})}
        />
      )}
    </>
  );
}

describe("hosting a workspace from the host dialog", () => {
  it("asks for a name, and starts hosting under it", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped);
    const onStarted = vi.fn();
    render(<Harness hosting={hosting} onStarted={onStarted} />);

    const name = await screen.findByRole("textbox", { name: "Workspace name" });
    const start = screen.getByRole("button", { name: "Start hosting" });
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);
    // The button stays usable and says what is missing, rather than refusing silently.
    await user.click(start);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Name the workspace first, such as Rocket Team.",
    );
    expect(name).toHaveFocus();
    expect(hosting.start).not.toHaveBeenCalled();
    await user.type(name, "  Rocket Team ");
    await user.click(start);

    expect(hosting.start).toHaveBeenCalledWith({ workspaceName: "Rocket Team" });
    await waitFor(() =>
      expect(onStarted).toHaveBeenCalledWith(
        expect.objectContaining({ running: true, port: 8543 }),
      ),
    );
  });

  it("lists the workspaces hosted here, and starts one by its entry rather than its name", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped, {
      workspaces: [
        {
          folder: "w-2",
          name: "Team-A",
          port: 8544,
          lastHostedAt: 2,
          lastBackupAt: null,
          running: false,
          missing: false,
        },
        {
          folder: "team-a",
          name: "Team A",
          port: 8543,
          lastHostedAt: 1,
          lastBackupAt: null,
          running: false,
          missing: false,
        },
        {
          folder: "gone",
          name: "Old Club",
          port: 8545,
          lastHostedAt: 0,
          lastBackupAt: null,
          running: false,
          missing: true,
        },
      ],
      unreadable: ["broken"],
    });
    render(<Harness hosting={hosting} />);

    const list = await screen.findByRole("region", { name: "Hosted on this computer" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("Team-APort 8544"),
      expect.stringContaining("Team APort 8543"),
      expect.stringContaining("Old ClubIts folder is missing"),
    ]);
    expect(
      within(list).getByRole("button", { name: "Remove Old Club from the list" }),
    ).toBeEnabled();
    expect(list).toHaveTextContent("Could not read the workspace in the folder broken");
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);

    await user.click(within(list).getByRole("button", { name: "Start hosting Team A" }));
    expect(hosting.start).toHaveBeenCalledWith({ folder: "team-a" });
  });

  it("says a new workspace will be separate from one already hosted under that name", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped, {
      workspaces: [
        {
          folder: "team-a",
          name: "Team A",
          port: 8543,
          lastHostedAt: 1,
          lastBackupAt: null,
          running: false,
          missing: false,
        },
      ],
      unreadable: [],
    });
    render(<Harness hosting={hosting} />);

    const name = await screen.findByRole("textbox", { name: "Workspace name" });
    // Nothing is filled in for them: the field only ever makes a new workspace.
    expect(name).toHaveValue("");
    await user.type(name, " team a ");
    expect(screen.getByText(/Team A is already hosted here/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Start new workspace" }));
    expect(hosting.start).toHaveBeenCalledWith({ workspaceName: "team a" });
  });

  it("backs up a listed workspace, says where it went, and when it last was", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped, {
      workspaces: [
        {
          folder: "team-a",
          name: "Team A",
          port: 8543,
          lastHostedAt: 1,
          lastBackupAt: null,
          running: false,
          missing: false,
        },
      ],
      unreadable: [],
    });
    render(<Harness hosting={hosting} />);
    const list = await screen.findByRole("region", { name: "Hosted on this computer" });
    expect(list).toHaveTextContent("Port 8543 · Not backed up yet");

    hosting.list!.mockResolvedValueOnce({
      workspaces: [
        {
          folder: "team-a",
          name: "Team A",
          port: 8543,
          lastHostedAt: 1,
          lastBackupAt: Date.now(),
          running: false,
          missing: false,
        },
      ],
      unreadable: [],
    });
    await user.click(within(list).getByRole("button", { name: "Back up Team A" }));
    expect(hosting.backup).toHaveBeenCalledWith("team-a");
    expect(
      await screen.findByText("Backed up Team A to /backups/team-a-2026-09-25T10-00-00"),
    ).toHaveAttribute("role", "status");
    await waitFor(() => expect(list).toHaveTextContent(/Backed up today, /));
  });

  it("says why a backup did not finish, and nothing when no folder was chosen", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped, {
      workspaces: [
        {
          folder: "team-a",
          name: "Team A",
          port: 8543,
          lastHostedAt: 1,
          lastBackupAt: null,
          running: false,
          missing: false,
        },
      ],
      unreadable: [],
    });
    hosting.backup!.mockResolvedValueOnce(null);
    hosting.backup!.mockRejectedValueOnce(new Error("There is not enough free space there."));
    render(<Harness hosting={hosting} />);
    const button = await screen.findByRole("button", { name: "Back up Team A" });
    await user.click(button);
    expect(within(screen.getByRole("dialog")).queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The backup of Team A did not finish. There is not enough free space there.",
    );
  });

  it("backs up the running workspace from where it is managed", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(
      { ...running, folder: "team-a" },
      {
        workspaces: [
          {
            folder: "team-a",
            name: "Rocket Team",
            port: 8543,
            lastHostedAt: 1,
            lastBackupAt: null,
            running: true,
            missing: false,
          },
        ],
        unreadable: [],
      },
    );
    render(<Harness hosting={hosting} />);
    await showSection("Backups");
    expect(
      await screen.findByText("This workspace has not been backed up from this computer yet."),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Back up now" }));
    expect(hosting.backup).toHaveBeenCalledWith("team-a");
    expect(await screen.findByText(/^Backed up Rocket Team to \/backups\/team-a-/)).toHaveAttribute(
      "role",
      "status",
    );
  });

  it("takes a workspace whose folder is gone out of the list", async () => {
    const user = userEvent.setup();
    const gone = {
      folder: "gone",
      name: "Old Club",
      port: 8545,
      lastHostedAt: 0,
      lastBackupAt: null,
      running: false,
      missing: true,
    };
    const { hosting } = fakeHosting(stopped, { workspaces: [gone], unreadable: [] });
    render(<Harness hosting={hosting} />);
    const list = await screen.findByRole("region", { name: "Hosted on this computer" });
    expect(within(list).queryByRole("button", { name: "Start hosting Old Club" })).toBeNull();
    expect(within(list).queryByRole("button", { name: "Back up Old Club" })).toBeNull();

    hosting.list!.mockResolvedValueOnce({ workspaces: [], unreadable: [] });
    await user.click(within(list).getByRole("button", { name: "Remove Old Club from the list" }));
    expect(hosting.forget).toHaveBeenCalledWith("gone");
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Hosted on this computer" })).toBeNull(),
    );
  });

  it("restores a backup into the list without starting it, or says why it did not", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped, { workspaces: [], unreadable: [] });
    hosting.restore!.mockResolvedValueOnce(null);
    hosting.restore!.mockRejectedValueOnce(
      new Error(
        "Rocket Team is already hosted on this computer, so this backup was not restored over it.",
      ),
    );
    render(<Harness hosting={hosting} />);
    const restore = await screen.findByRole("button", { name: "Restore from a backup…" });

    // No folder chosen: nothing to say.
    await user.click(restore);
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).toBeNull();

    await user.click(restore);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The backup was not restored. Rocket Team is already hosted on this computer",
    );

    const listReads = hosting.list!.mock.calls.length;
    await user.click(restore);
    const note = await screen.findByText(/^Restored Rocket Team\. Until you put it back in use/);
    expect(note).toHaveAttribute("role", "status");
    expect(note).toHaveTextContent(
      "Put back in use, it brings 2 sign-ins it still accepts, 1 scheduled message waiting, 0 app events not yet delivered, apps it calls at https://bot.example.",
    );
    expect(hosting.start).not.toHaveBeenCalled();
    await waitFor(() => expect(hosting.list!.mock.calls.length).toBeGreaterThan(listReads));
  });

  it("says when the list of hosted workspaces cannot be read", async () => {
    const { hosting } = fakeHosting(stopped, { workspaces: [], unreadable: [] });
    hosting.list!.mockRejectedValueOnce(new Error("settings unreadable"));
    render(<Harness hosting={hosting} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Could not read the list of workspaces hosted on this computer/,
    );
  });

  it("explains an unsupported newer hosted-workspace registry without suggesting file repair", async () => {
    const { hosting } = fakeHosting(stopped, { workspaces: [], unreadable: [] });
    hosting.list!.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'hosting:list': Error: The hosted workspace list was saved by a newer version of Tandem. Update Tandem to open it; the list was not changed.",
      ),
    );
    render(<Harness hosting={hosting} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/newer version of Tandem/);
    expect(alert).toHaveTextContent(/Update Tandem/);
    expect(alert).not.toHaveTextContent(/settings file can be read/);
  });

  it("keeps the name, and says what went wrong, when hosting cannot start", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped);
    hosting.start.mockRejectedValueOnce(
      new Error(
        "Port 9000 is already in use on this computer. Choose another, or leave the port empty to use one that is free.",
      ),
    );
    const onStarted = vi.fn();
    render(<Harness hosting={hosting} onStarted={onStarted} />);

    const name = await screen.findByRole("textbox", { name: "Workspace name" });
    await user.type(name, "Rocket Team");
    await user.click(screen.getByRole("button", { name: "Start hosting" }));

    // The desktop app's own words, which say what to do about it.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Port 9000 is already in use on this computer. Choose another, or leave the port empty to use one that is free.",
    );
    expect(name).toHaveValue("Rocket Team");
    expect(screen.getByRole("button", { name: "Start hosting" })).toBeEnabled();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("says where teammates connect, and what closing the window does, while hosting", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(running);
    render(<Harness hosting={hosting} />);

    // It opens on the overview: the workspace, live, and where to reach it.
    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(within(dialog).getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(dialog).getByText("Rocket Team")).toBeVisible();
    expect(within(dialog).getByText("Live")).toBeVisible();
    expect(within(dialog).getByText("192.168.1.20:8543")).toBeVisible();
    // A phone's camera opens a whole address.
    expect(
      within(dialog).getByRole("img", { name: "QR code for http://192.168.1.20:8543" }),
    ).toBeVisible();
    expect(
      within(dialog).getByText(/keeps the workspace running in the system tray/),
    ).toBeVisible();
    expect(await accessibilityProblems(dialog)).toEqual([]);

    const copy = within(dialog).getByRole("button", { name: "Copy" });
    expect(copy).toHaveAccessibleDescription("192.168.1.20:8543");
    await user.click(copy);
    expect(await navigator.clipboard.readText()).toBe("192.168.1.20:8543");
    expect(within(dialog).getByRole("button", { name: "Copied" })).toBeVisible();

    // Its folder and port are kept for later.
    expect(within(dialog).queryByText(running.dataDir!)).toBeNull();
    await showSection("Advanced");
    expect(within(dialog).getByText("8543")).toBeVisible();
    expect(within(dialog).getByText(running.dataDir!)).toBeVisible();
    expect(await accessibilityProblems(dialog)).toEqual([]);
    // Stopping stays in sight from every section.
    expect(within(dialog).getByRole("button", { name: "Stop hosting" })).toBeEnabled();
  });

  it("puts a public address first on the overview, and in its code", async () => {
    const { hosting } = fakeHosting({
      ...running,
      tunnelAvailable: true,
      openToAll: { phase: "open", url: publicUrl },
    });
    render(<Harness hosting={hosting} />);
    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(within(dialog).getByText("Anyone can join at")).toBeVisible();
    expect(within(dialog).getByText("On this network")).toBeVisible();
    expect(within(dialog).getByRole("img", { name: `QR code for ${publicUrl}` })).toBeVisible();
    expect(within(dialog).getAllByRole("button", { name: "Copy" })).toHaveLength(2);
  });

  it("opens Invite people from the overview of the workspace on screen", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(running);
    const onInvite = vi.fn();
    const { rerender } = render(<Harness hosting={hosting} viewingHosted onInvite={onInvite} />);
    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    await user.click(within(dialog).getByRole("button", { name: "Invite people" }));
    expect(onInvite).toHaveBeenCalledOnce();

    // Another workspace on screen opens this one instead.
    rerender(<Harness hosting={hosting} onInvite={onInvite} />);
    expect(within(dialog).queryByRole("button", { name: "Invite people" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Open it" })).toBeEnabled();
  });

  it("moves between its sections with the arrow keys, as tabs", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(
      { ...running, folder: "team-a", tunnelAvailable: true },
      {
        workspaces: [
          {
            folder: "team-a",
            name: "Rocket Team",
            port: 8543,
            lastHostedAt: 1,
            lastBackupAt: null,
            running: true,
            missing: false,
          },
        ],
        unreadable: [],
      },
    );
    render(<Harness hosting={hosting} />);
    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    const list = within(dialog).getByRole("tablist", { name: "Hosting" });
    expect(
      within(list)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Overview", "Share on the internet", "Backups", "Advanced"]);
    within(list).getByRole("tab", { name: "Overview" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(within(list).getByRole("tab", { name: "Share on the internet" })).toHaveFocus();
    expect(within(dialog).getByRole("tabpanel")).toHaveAccessibleName("Share on the internet");
    expect(within(dialog).getByText("Let people outside your network join")).toBeVisible();
    await user.keyboard("{End}");
    expect(within(dialog).getByRole("tabpanel")).toHaveAccessibleName("Advanced");
  });

  it("offers only the sections this app can do", async () => {
    const { hosting } = fakeHosting(running);
    const bare = { ...hosting } as Partial<typeof hosting>;
    delete bare.openToAll;
    render(<Harness hosting={bare as typeof hosting} />);
    const list = await screen.findByRole("tablist", { name: "Hosting" });
    // No public link, no relay and nothing to back up with.
    expect(
      within(list)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Overview", "Advanced"]);
  });

  it("opens, copies, secures, and closes a public Cloudflare address", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting({ ...running, tunnelAvailable: true });
    render(<Harness hosting={hosting} />);
    await showSection("Share on the internet");

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    const inviteRequired = within(dialog).getByRole("checkbox", {
      name: /Require an invite link to create an account/,
    });
    expect(inviteRequired).toBeChecked();

    await user.click(within(dialog).getByRole("button", { name: "Open to all" }));
    expect(hosting.openToAll).toHaveBeenCalledWith({ inviteOnly: true });
    expect(await within(dialog).findByRole("link", { name: publicUrl })).toHaveAttribute(
      "href",
      publicUrl,
    );
    expect(within(dialog).getByText("Public")).toBeVisible();
    expect(within(dialog).getByText(/Workspace → Invite people/)).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "Copy address" }));
    expect(await navigator.clipboard.readText()).toBe(publicUrl);
    expect(within(dialog).getByRole("button", { name: "Copied" })).toBeVisible();

    await user.click(
      within(dialog).getByRole("checkbox", {
        name: /Require an invite link to create an account/,
      }),
    );
    expect(hosting.setInviteOnly).toHaveBeenCalledWith(false);
    await waitFor(() =>
      expect(
        within(dialog).getByRole("checkbox", {
          name: /Require an invite link to create an account/,
        }),
      ).not.toBeChecked(),
    );
    expect(
      within(dialog).getByText(/Anyone with this address can create an account/),
    ).toBeVisible();
    expect(await accessibilityProblems(dialog)).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Close public link" }));
    expect(hosting.endOpenToAll).toHaveBeenCalledOnce();
    expect(await within(dialog).findByRole("button", { name: "Open to all" })).toBeEnabled();
    expect(within(dialog).queryByRole("link", { name: publicUrl })).not.toBeInTheDocument();
  });

  it("lets visitors join as guests once an account is not required, and asks for one again", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(
      { ...running, tunnelAvailable: true, accessPolicy: "account_required", inviteOnly: false },
      undefined,
      { guests: true },
    );
    render(<Harness hosting={hosting} />);
    await showSection("Share on the internet");
    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    const account = () =>
      within(dialog).getByRole("checkbox", { name: "Require an account to join." });
    const invite = () => within(dialog).queryByRole("checkbox", { name: /Require an invite link/ });
    // Before opening, invites are asked for, and guests are a choice to make.
    expect(account()).toBeChecked();
    expect(invite()).toBeChecked();
    await user.click(account());
    expect(invite()).toBeNull();
    expect(
      within(dialog).getByText("Visitors can join as guests. Creating an account is optional."),
    ).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Open to all" }));
    expect(hosting.openToAll).toHaveBeenCalledWith({
      inviteOnly: false,
      accessPolicy: "guest_allowed",
    });
    await within(dialog).findByRole("link", { name: publicUrl });
    expect(account()).not.toBeChecked();
    expect(within(dialog).getByText(/join as a guest for a day/)).toBeVisible();
    expect(await accessibilityProblems(dialog)).toEqual([]);

    // Requiring an account again goes back to invites, and says so once the
    // workspace has taken it.
    await user.click(account());
    expect(hosting.setAccessPolicy).toHaveBeenCalledWith("invite_only");
    await waitFor(() => expect(account()).toBeChecked());
    expect(invite()).toBeChecked();
    await user.click(invite()!);
    expect(hosting.setAccessPolicy).toHaveBeenLastCalledWith("account_required");
    await waitFor(() => expect(invite()).not.toBeChecked());
    expect(hosting.setInviteOnly).not.toHaveBeenCalled();
  });

  it("explains when cloudflared is unavailable and can check again", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting({ ...running, tunnelAvailable: false });
    render(<Harness hosting={hosting} />);
    await showSection("Share on the internet");

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(within(dialog).getByText(/Install Cloudflare’s cloudflared tool/)).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Open to all" })).not.toBeInTheDocument();
    const callsBeforeCheck = hosting.status.mock.calls.length;
    await user.click(within(dialog).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(hosting.status).toHaveBeenCalledTimes(callsBeforeCheck + 1));
  });

  it("keeps hosting and reports an error when opening the public address fails", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting({ ...running, tunnelAvailable: true });
    hosting.openToAll.mockRejectedValueOnce(new Error("cloudflared could not reach the edge"));
    render(<Harness hosting={hosting} />);
    await showSection("Share on the internet");

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    await user.click(within(dialog).getByRole("button", { name: "Open to all" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      /public link could not be opened/,
    );
    expect(screen.getByRole("dialog", { name: "Workspace is live" })).toBe(dialog);
    expect(within(dialog).getByRole("button", { name: "Open to all" })).toBeEnabled();
    expect(hosting.stop).not.toHaveBeenCalled();
  });

  it("offers to open the hosted workspace only when it is not the one already on screen", async () => {
    const { hosting } = fakeHosting(running);
    const { rerender } = render(<Harness hosting={hosting} />);
    expect(await screen.findByRole("button", { name: "Open it" })).toBeEnabled();

    rerender(<Harness hosting={hosting} viewingHosted />);
    expect(screen.queryByRole("button", { name: "Open it" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop hosting" })).toBeInTheDocument();
  });

  it("stops at once, since the button already says what it does", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(running);
    render(<Harness hosting={hosting} />);

    await user.click(await screen.findByRole("button", { name: "Stop hosting" }));
    expect(hosting.stop).toHaveBeenCalledOnce();
    const stopped = await screen.findByRole("dialog", { name: "Host a workspace" });
    expect(screen.queryByText(/Teammates will be disconnected/)).not.toBeInTheDocument();
    // The button left with the running view. Focus must stay inside rather
    // than falling back to the page behind the modal.
    await waitFor(() => expect(stopped).toContainElement(document.activeElement as HTMLElement));
  });

  it("keeps showing what it knows while it checks the status again", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped);
    const { rerender } = render(<Harness hosting={hosting} open={false} />);
    await screen.findByText("status known");
    expect(hosting.status).toHaveBeenCalledTimes(1);

    // Opening the dialog checks again, and this time the answer is slow.
    let finishRefresh!: (status: HostingStatus) => void;
    hosting.status.mockReturnValueOnce(
      new Promise<HostingStatus>((resolve) => {
        finishRefresh = resolve;
      }),
    );
    rerender(<Harness hosting={hosting} />);
    expect(hosting.status).toHaveBeenCalledTimes(2);
    const name = screen.getByRole("textbox", { name: "Workspace name" });
    await user.type(name, "Rocket");
    expect(screen.queryByText("Checking hosting status…")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toBe(name);
    expect(name).toHaveValue("Rocket");

    await act(async () => finishRefresh(stopped));
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toBe(name);
    expect(name).toHaveValue("Rocket");
  });

  it("follows a change made elsewhere while it is open", async () => {
    const { hosting, push } = fakeHosting(stopped);
    render(<Harness hosting={hosting} />);
    await screen.findByRole("dialog", { name: "Host a workspace" });

    push(running);
    const dialog = screen.getByRole("dialog", { name: "Workspace is live" });
    push({ ...running, phase: "stopping" });
    expect(within(dialog).getByText("Stopping workspace…")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Stop hosting" })).toBeDisabled();
  });
});

describe("renaming a hosted workspace and opening its folder", () => {
  const teamA = {
    folder: "team-a",
    name: "Team A",
    port: 8543,
    lastHostedAt: 1,
    lastBackupAt: null,
    running: false,
    missing: false,
  };

  it("renames a listed workspace in place, and hands focus back to Rename", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped, { workspaces: [teamA], unreadable: [] });
    render(<Harness hosting={hosting} />);
    const list = await screen.findByRole("region", { name: "Hosted on this computer" });

    await user.click(within(list).getByRole("button", { name: "Rename Team A" }));
    let field = within(list).getByRole("textbox", { name: "New name for Team A" });
    expect(field).toHaveFocus();
    expect(field).toHaveValue("Team A");
    // Never off: saved with the name it has, there is nothing to save, so the form closes.
    let save = within(list).getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    expect(save).not.toHaveAttribute("aria-disabled");
    await user.click(save);
    expect(hosting.rename).not.toHaveBeenCalled();
    expect(within(list).queryByRole("textbox", { name: /New name for/ })).toBeNull();
    expect(within(list).getByRole("button", { name: "Rename Team A" })).toHaveFocus();

    // A name that is only spaces is none at all: it says so beside the field.
    await user.click(within(list).getByRole("button", { name: "Rename Team A" }));
    field = within(list).getByRole("textbox", { name: "New name for Team A" });
    save = within(list).getByRole("button", { name: "Save" });
    await user.clear(field);
    await user.type(field, "   ");
    await user.click(save);
    expect(hosting.rename).not.toHaveBeenCalled();
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("Give the workspace a name.");
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);

    hosting.list!.mockResolvedValue({
      workspaces: [{ ...teamA, name: "Blue Team" }],
      unreadable: [],
    });
    await user.clear(field);
    await user.type(field, " Blue Team {Enter}");
    expect(hosting.rename).toHaveBeenCalledWith("team-a", " Blue Team ");
    expect(await screen.findByText("Renamed Team A to Blue Team.")).toHaveAttribute(
      "role",
      "status",
    );
    const renamed = await within(list).findByRole("button", { name: "Rename Blue Team" });
    expect(renamed).toHaveFocus();
    // The folder stays what it was: starting it still names the folder.
    await user.click(within(list).getByRole("button", { name: "Start hosting Blue Team" }));
    expect(hosting.start).toHaveBeenCalledWith({ folder: "team-a" });
  });

  it("keeps the form open, saying why, when the name is refused", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped, { workspaces: [teamA], unreadable: [] });
    hosting.rename!.mockRejectedValueOnce(
      new Error("The folder for Team A holds a different workspace, so it was not renamed."),
    );
    render(<Harness hosting={hosting} />);
    await user.click(await screen.findByRole("button", { name: "Rename Team A" }));
    const field = screen.getByRole("textbox", { name: "New name for Team A" });
    await user.clear(field);
    await user.type(field, "Blue Team");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The folder for Team A holds a different workspace, so it was not renamed.",
    );
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(alert.textContent!);
    expect(field).toHaveFocus();
    // Changing the name clears what was wrong with the last one.
    await user.type(field, "s");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field).toHaveAttribute("aria-invalid", "false");
  });

  it("calls off a rename with Escape, without closing the dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { hosting } = fakeHosting(stopped, { workspaces: [teamA], unreadable: [] });
    render(<Harness hosting={hosting} onClose={onClose} />);
    await user.click(await screen.findByRole("button", { name: "Rename Team A" }));
    await user.type(screen.getByRole("textbox", { name: "New name for Team A" }), " changed");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("textbox", { name: /New name for/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Rename Team A" })).toHaveFocus();
    expect(hosting.rename).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // Once the form is gone, Escape closes the dialog as usual.
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renames the running workspace from where it is managed", async () => {
    const user = userEvent.setup();
    const { hosting, push } = fakeHosting(
      { ...running, folder: "team-a" },
      { workspaces: [{ ...teamA, name: "Rocket Team", running: true }], unreadable: [] },
    );
    render(<Harness hosting={hosting} />);
    await user.click(await screen.findByRole("button", { name: "Rename Rocket Team" }));
    const field = screen.getByRole("textbox", { name: "New name for Rocket Team" });
    await user.clear(field);
    await user.type(field, "Blue Team");
    const form = screen.getByRole("form", { name: "Rename Rocket Team" });
    await user.click(within(form).getByRole("button", { name: "Save" }));

    expect(hosting.rename).toHaveBeenCalledWith("team-a", "Blue Team");
    expect(await screen.findByText("Renamed Rocket Team to Blue Team.")).toBeVisible();
    // The main process tells every window of the new name.
    push({ ...running, folder: "team-a", workspaceName: "Blue Team" });
    expect(screen.getByRole("dialog")).toHaveTextContent("Blue Team");
    expect(screen.getByRole("button", { name: "Rename Blue Team" })).toHaveFocus();
  });

  it("opens a workspace's folder, and says when it could not", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped, { workspaces: [teamA], unreadable: [] });
    render(<Harness hosting={hosting} />);
    const open = await screen.findByRole("button", { name: "Open folder for Team A" });
    await user.click(open);
    expect(hosting.openFolder).toHaveBeenCalledWith("team-a");
    expect(screen.queryByRole("alert")).toBeNull();

    hosting.openFolder!.mockRejectedValueOnce(new Error("The folder that held Team A is missing."));
    await user.click(open);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The folder that held Team A is missing.",
    );
  });

  it("offers neither where the app cannot do them", async () => {
    const { hosting } = fakeHosting(stopped, { workspaces: [teamA], unreadable: [] });
    delete (hosting as Partial<typeof hosting>).rename;
    delete (hosting as Partial<typeof hosting>).openFolder;
    render(<Harness hosting={hosting} />);
    const list = await screen.findByRole("region", { name: "Hosted on this computer" });
    expect(within(list).queryByRole("button", { name: /^Rename/ })).toBeNull();
    expect(within(list).queryByRole("button", { name: /^Open folder/ })).toBeNull();
  });
});

describe("starting with the computer", () => {
  const teamA = {
    folder: "team-a",
    name: "Rocket Team",
    port: 8543,
    lastHostedAt: 1,
    lastBackupAt: null,
    running: false,
    missing: false,
  };

  function withLaunch(initial: HostingStatus, atLogin: boolean | null = false) {
    const fake = fakeHosting(initial, {
      workspaces: [{ ...teamA, running: initial.running }],
      unreadable: [],
    });
    const hosting = fake.hosting as typeof fake.hosting & {
      setStartOnLaunch: ReturnType<typeof vi.fn>;
      openAtLogin: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
    };
    let login = atLogin;
    hosting.setStartOnLaunch = vi.fn(async (folder: string | null) => {
      fake.push({ ...initial, startsOnLaunch: folder === "team-a" });
    });
    hosting.openAtLogin = {
      get: vi.fn(async () => login),
      set: vi.fn(async (open: boolean) => (login = open)),
    };
    return { hosting, push: fake.push };
  }

  it("starts the running workspace with Tandem, and opens Tandem at sign-in, when asked", async () => {
    const user = userEvent.setup();
    const { hosting } = withLaunch({ ...running, folder: "team-a" });
    render(<Harness hosting={hosting} />);
    await showSection("Advanced");
    const group = await screen.findByRole("group", { name: "When this computer starts" });
    const start = within(group).getByRole("checkbox", {
      name: "Start hosting Rocket Team when Tandem opens",
    });
    const login = await within(group).findByRole("checkbox", {
      name: "Open Tandem when you sign in to this computer",
    });
    expect(start).not.toBeChecked();
    expect(login).not.toBeChecked();
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);

    await user.click(start);
    expect(hosting.setStartOnLaunch).toHaveBeenCalledWith("team-a");
    await waitFor(() => expect(start).toBeChecked());
    await user.click(login);
    expect(hosting.openAtLogin.set).toHaveBeenCalledWith(true);
    await waitFor(() => expect(login).toBeChecked());
    expect(group).toHaveTextContent(/With both on, Rocket Team is back for teammates/);

    await user.click(start);
    expect(hosting.setStartOnLaunch).toHaveBeenLastCalledWith(null);
    await waitFor(() => expect(start).not.toBeChecked());
  });

  it("reopens a stable address with the workspace only once it starts with Tandem", async () => {
    const user = userEvent.setup();
    const status = {
      ...running,
      folder: "team-a",
      publicAddress: "https://chat.example.org",
      startsOnLaunch: false,
    };
    const { hosting, push } = withLaunch(status);
    const withReopen = hosting as typeof hosting & {
      setReopenPublicOnLaunch: ReturnType<typeof vi.fn>;
    };
    withReopen.setReopenPublicOnLaunch = vi.fn(async (reopen: boolean) => {
      push({ ...status, startsOnLaunch: true, reopensPublicOnLaunch: reopen });
      return reopen;
    });
    render(<Harness hosting={withReopen} />);
    await showSection("Advanced");
    const group = await screen.findByRole("group", { name: "When this computer starts" });
    const reopen = within(group).getByRole("checkbox", {
      name: /Also reopen https:\/\/chat\.example\.org when Rocket Team starts with Tandem/,
    });
    expect(reopen).toBeDisabled();

    push({ ...status, startsOnLaunch: true });
    await waitFor(() => expect(reopen).toBeEnabled());
    await user.click(reopen);
    expect(withReopen.setReopenPublicOnLaunch).toHaveBeenCalledWith(true);
    await waitFor(() => expect(reopen).toBeChecked());
  });

  it("offers no reopening without a stable address", async () => {
    const { hosting } = withLaunch({ ...running, folder: "team-a" });
    (hosting as { setReopenPublicOnLaunch?: unknown }).setReopenPublicOnLaunch = vi.fn();
    render(<Harness hosting={hosting} />);
    await showSection("Advanced");
    const group = await screen.findByRole("group", { name: "When this computer starts" });
    expect(within(group).queryByRole("checkbox", { name: /Also reopen/ })).toBeNull();
  });

  it("offers only what this copy of the app can do", async () => {
    const { hosting } = withLaunch({ ...running, folder: "team-a" }, null);
    render(<Harness hosting={hosting} />);
    await showSection("Advanced");
    const group = await screen.findByRole("group", { name: "When this computer starts" });
    await waitFor(() => expect(hosting.openAtLogin.get).toHaveBeenCalled());
    expect(within(group).queryByRole("checkbox", { name: /sign in/ })).toBeNull();
    expect(group).toHaveTextContent("Rocket Team starts once Tandem is opened.");
  });

  it("says why a choice could not be saved", async () => {
    const user = userEvent.setup();
    const { hosting } = withLaunch({ ...running, folder: "team-a" });
    hosting.setStartOnLaunch.mockRejectedValueOnce(
      new Error(
        "Tandem could not save that choice. Check that its settings folder is writable, then try again.",
      ),
    );
    render(<Harness hosting={hosting} />);
    await showSection("Advanced");
    const start = await screen.findByRole("checkbox", {
      name: "Start hosting Rocket Team when Tandem opens",
    });
    await user.click(start);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Tandem could not save that choice. Check that its settings folder is writable, then try again.",
    );
    // Nothing was saved, so the box goes back to what is so.
    expect(start).not.toBeChecked();
  });

  it("says why the chosen workspace did not start, and marks it in the list", async () => {
    const fake = fakeHosting(
      {
        ...stopped,
        launchError:
          "Tandem did not start hosting Rocket Team when it opened. Its folder is missing.",
      },
      { workspaces: [{ ...teamA, startsOnLaunch: true }], unreadable: [] },
    );
    render(<Harness hosting={fake.hosting} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Tandem did not start hosting Rocket Team when it opened. Its folder is missing.",
    );
    const list = await screen.findByRole("region", { name: "Hosted on this computer" });
    expect(list).toHaveTextContent("Port 8543 · Starts with Tandem");
  });
});

describe("what did not happen when Tandem opened, while hosting runs", () => {
  const launched: HostingStatus = {
    ...running,
    folder: "team-a",
    tunnelAvailable: true,
    publicAddress: "https://team.example.org",
    publicAddressManaged: true,
    launchError:
      "Rocket Team started on this network, but https://team.example.org was not reopened. The address did not reach this workspace.",
    launchErrorPart: "public-address",
    launchErrorFolder: "team-a",
  };

  it("says so beside the running workspace and offers to try again", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(launched);
    render(<Harness hosting={hosting} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/was not reopened/);
    // Hosting on this network is still what the dialog shows it doing.
    expect(screen.getByText("192.168.1.20:8543")).toBeInTheDocument();

    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(hosting.openToAll).toHaveBeenCalledWith({ inviteOnly: true });
  });

  it("offers to try again only for the workspace it is about", async () => {
    const { hosting } = fakeHosting({ ...launched, folder: "design-guild" });
    render(<Harness hosting={hosting} />);
    const alert = await screen.findByRole("alert");
    expect(within(alert).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("goes when the host dismisses it", async () => {
    const user = userEvent.setup();
    const fake = fakeHosting(launched);
    const hosting = fake.hosting as typeof fake.hosting & {
      dismissLaunchError: ReturnType<typeof vi.fn>;
    };
    hosting.dismissLaunchError = vi.fn(async () => {
      fake.push({ ...launched, launchError: undefined, launchErrorPart: undefined });
    });
    render(<Harness hosting={hosting} />);
    const alert = await screen.findByRole("alert");
    await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(hosting.dismissLaunchError).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText(/was not reopened/)).toBeNull());
  });
});

describe("a workspace restored from a backup", () => {
  const restored = {
    folder: "w-restored",
    name: "Rocket Team",
    port: 8543,
    lastHostedAt: 1,
    lastBackupAt: null,
    running: false,
    missing: false,
    restored: true,
  };

  it("is only looked inside until it is put back in use on purpose", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped, { workspaces: [restored], unreadable: [] });
    render(<Harness hosting={hosting} />);
    const list = await screen.findByRole("region", { name: "Hosted on this computer" });
    expect(list).toHaveTextContent("Restored, not in use yet · Port 8543");
    expect(within(list).queryByRole("button", { name: "Start hosting Rocket Team" })).toBeNull();

    await user.click(within(list).getByRole("button", { name: "Put Rocket Team back in use" }));
    const question = within(list).getByRole("region", { name: "Put Rocket Team back in use?" });
    expect(question).toHaveTextContent(/sends the messages it had waiting, calls its apps again/);
    await user.click(within(question).getByRole("button", { name: "Not yet" }));
    expect(within(list).queryByRole("region", { name: /back in use\?/ })).toBeNull();

    await user.click(within(list).getByRole("button", { name: "Put Rocket Team back in use" }));
    await user.click(within(list).getByRole("button", { name: /^Put back in use$/ }));
    expect(hosting.start).toHaveBeenLastCalledWith({ folder: "w-restored", activate: true });
  });

  it("starts only to be looked inside from its Look inside button", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped, { workspaces: [restored], unreadable: [] });
    render(<Harness hosting={hosting} />);
    await user.click(await screen.findByRole("button", { name: "Look inside Rocket Team" }));
    expect(hosting.start).toHaveBeenLastCalledWith({ folder: "w-restored" });
  });

  it("says it is being looked inside, and offers no public address meanwhile", async () => {
    const { hosting } = fakeHosting({ ...running, isolated: true, workspaceName: "Rocket Team" });
    render(<Harness hosting={hosting} />);
    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(within(dialog).getByText(/You are looking inside Rocket Team/)).toHaveAttribute(
      "role",
      "status",
    );
    expect(within(dialog).queryByRole("heading", { name: "Open to all" })).toBeNull();
    expect(within(dialog).queryByRole("tab", { name: "Share on the internet" })).toBeNull();
    // Only this computer reaches it, so it gives no address to share.
    expect(within(dialog).queryByText("192.168.1.20:8543")).toBeNull();
    expect(within(dialog).queryByRole("img", { name: /^QR code/ })).toBeNull();
    expect(within(dialog).getByText("Only on this computer")).toBeVisible();
  });

  const daily: AutoBackup = { destination: "D:\\Backups", everyDays: 1, keep: 7 };

  it("says in the list that its backup schedule waits until it is back in use", async () => {
    const { hosting } = fakeHosting(stopped, {
      workspaces: [{ ...restored, autoBackup: daily }],
      unreadable: [],
    });
    render(<Harness hosting={hosting} />);
    const list = await screen.findByRole("region", { name: "Hosted on this computer" });
    expect(list).toHaveTextContent(
      "Restored, not in use yet · Port 8543 · Backs up daily once back in use",
    );
  });

  it("says while looking inside that nothing is backed up or removed on its schedule", async () => {
    const { hosting } = fakeHosting(
      { ...running, isolated: true, folder: "w-restored" },
      { workspaces: [{ ...restored, running: true, autoBackup: daily }], unreadable: [] },
    );
    render(<Harness hosting={hosting} />);
    await showSection("Backups");
    const group = await screen.findByRole("group", { name: "Automatic backups" });
    expect(group).toHaveTextContent(
      "Rocket Team is not backed up by itself until it is back in use, and nothing already in D:\\Backups is removed. Then it is backed up every day, keeping the newest 7.",
    );
    expect(group).not.toHaveTextContent(/Rocket Team is backed up every day/);
  });

  it("offers no schedule to set up while looking inside", async () => {
    const { hosting } = fakeHosting(
      { ...running, isolated: true, folder: "w-restored" },
      { workspaces: [{ ...restored, running: true }], unreadable: [] },
    );
    render(<Harness hosting={hosting} />);
    await showSection("Backups");
    // Shown once the list has said which entry is running.
    await screen.findByText("This workspace has not been backed up from this computer yet.");
    expect(screen.queryByRole("group", { name: "Automatic backups" })).toBeNull();
  });
});

describe("starting with the computer, while nothing is running", () => {
  const teamA = {
    folder: "team-a",
    name: "Rocket Team",
    port: 8543,
    lastHostedAt: 1,
    lastBackupAt: null,
    running: false,
    missing: false,
  };

  function stoppedWith(startsOnLaunch: boolean, launchError: string, atLogin: boolean) {
    const fake = fakeHosting(
      { ...stopped, launchError },
      { workspaces: [{ ...teamA, startsOnLaunch }], unreadable: [] },
    );
    const hosting = fake.hosting as typeof fake.hosting & {
      setStartOnLaunch: ReturnType<typeof vi.fn>;
      openAtLogin: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
    };
    let login = atLogin;
    hosting.setStartOnLaunch = vi.fn(async () => null);
    hosting.openAtLogin = {
      get: vi.fn(async () => login),
      set: vi.fn(async (open: boolean) => (login = open)),
    };
    return hosting;
  }

  it("takes a workspace that failed to start off starting with Tandem, and Tandem off sign-in", async () => {
    const user = userEvent.setup();
    const hosting = stoppedWith(
      true,
      "Tandem did not start hosting Rocket Team when it opened. Its database is unreadable.",
      true,
    );
    render(<Harness hosting={hosting} />);
    const section = await screen.findByRole("region", { name: "When this computer starts" });
    expect(section).toHaveTextContent("Rocket Team starts hosting when Tandem opens.");
    await user.click(
      within(section).getByRole("button", { name: "Don’t start Rocket Team with Tandem" }),
    );
    expect(hosting.setStartOnLaunch).toHaveBeenCalledWith(null);

    const login = await within(section).findByRole("checkbox", {
      name: "Open Tandem when you sign in to this computer",
    });
    expect(login).toBeChecked();
    await user.click(login);
    expect(hosting.openAtLogin.set).toHaveBeenCalledWith(false);
    await waitFor(() => expect(login).not.toBeChecked());
    // Still listed, and still startable.
    const list = screen.getByRole("region", { name: "Hosted on this computer" });
    expect(within(list).getByRole("button", { name: "Start hosting Rocket Team" })).toBeVisible();
  });

  it("clears a choice that could not be read", async () => {
    const user = userEvent.setup();
    const hosting = stoppedWith(
      false,
      "Tandem did not start hosting when it opened, because it could not read which workspace to start.",
      false,
    );
    render(<Harness hosting={hosting} />);
    const section = await screen.findByRole("region", { name: "When this computer starts" });
    await user.click(
      within(section).getByRole("button", { name: "Start nothing when Tandem opens" }),
    );
    expect(hosting.setStartOnLaunch).toHaveBeenCalledWith(null);
  });

  it("shows nothing when nothing starts with the computer", async () => {
    const hosting = stoppedWith(false, "", false);
    render(<Harness hosting={hosting} />);
    await screen.findByRole("region", { name: "Hosted on this computer" });
    await waitFor(() => expect(hosting.openAtLogin.get).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "When this computer starts" })).toBeNull();
  });
});

describe("who is connected, and which port", () => {
  const teamA = {
    folder: "team-a",
    name: "Team A",
    port: 8543,
    lastHostedAt: 1,
    lastBackupAt: null,
    running: false,
    missing: false,
  };

  it("says how many people are connected, as that changes", async () => {
    const { hosting, push } = fakeHosting({ ...running, connected: 3 });
    render(<Harness hosting={hosting} />);
    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(dialog).toHaveTextContent("Connected now: 3 people");
    push({ ...running, connected: 1 });
    expect(dialog).toHaveTextContent("Connected now: 1 person");
    push({ ...running, connected: 0 });
    expect(dialog).toHaveTextContent("Connected now: nobody");
  });

  it("starts a new workspace on a port someone chose, and refuses one that is not a port", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped);
    render(<Harness hosting={hosting} />);
    await user.type(await screen.findByRole("textbox", { name: "Workspace name" }), "Rocket Team");
    await user.click(screen.getByText("Choose a port"));
    const port = screen.getByRole("textbox", { name: "Port" });
    expect(port).toHaveAccessibleDescription(/Leave it empty to use 8543/);
    await user.type(port, "70000");
    await user.click(screen.getByRole("button", { name: "Start hosting" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a port from 1 to 65535, or leave it empty for the usual one.",
    );
    expect(hosting.start).not.toHaveBeenCalled();

    await user.clear(port);
    await user.type(port, "9000");
    await user.click(screen.getByRole("button", { name: "Start hosting" }));
    expect(hosting.start).toHaveBeenCalledWith({ workspaceName: "Rocket Team", port: 9000 });
  });

  it("changes a listed workspace's port in place, and hands focus back", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting(stopped, { workspaces: [teamA], unreadable: [] });
    render(<Harness hosting={hosting} />);
    const list = await screen.findByRole("region", { name: "Hosted on this computer" });
    await user.click(within(list).getByRole("button", { name: "Change port for Team A" }));
    let field = within(list).getByRole("textbox", { name: "New port for Team A" });
    expect(field).toHaveFocus();
    expect(field).toHaveValue("8543");
    // Never off: saved with the port it has, there is nothing to save, so the form closes.
    const save = within(list).getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    await user.click(save);
    expect(hosting.setPort).not.toHaveBeenCalled();
    expect(within(list).queryByRole("textbox", { name: "New port for Team A" })).toBeNull();
    expect(within(list).getByRole("button", { name: "Change port for Team A" })).toHaveFocus();

    await user.click(within(list).getByRole("button", { name: "Change port for Team A" }));
    field = within(list).getByRole("textbox", { name: "New port for Team A" });
    await user.clear(field);
    await user.type(field, "port");
    await user.click(within(list).getByRole("button", { name: "Save" }));
    expect(within(list).getByRole("alert")).toHaveTextContent("Choose a port from 1 to 65535.");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveFocus();
    expect(hosting.setPort).not.toHaveBeenCalled();

    hosting.list!.mockResolvedValue({ workspaces: [{ ...teamA, port: 9100 }], unreadable: [] });
    await user.clear(field);
    await user.type(field, "9100{Enter}");
    expect(hosting.setPort).toHaveBeenCalledWith("team-a", 9100);
    expect(await screen.findByText("Team A will start on port 9100.")).toHaveAttribute(
      "role",
      "status",
    );
    await waitFor(() =>
      expect(within(list).getByRole("button", { name: "Change port for Team A" })).toHaveFocus(),
    );
    expect(list).toHaveTextContent("Port 9100");
  });

  it("calls off a port change with Escape, and says why the app refused one", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { hosting } = fakeHosting(stopped, { workspaces: [teamA], unreadable: [] });
    hosting.setPort!.mockRejectedValueOnce(
      new Error(
        "Tandem could not save the new port. Check that its settings folder is writable, then try again.",
      ),
    );
    render(<Harness hosting={hosting} onClose={onClose} />);
    const changePort = () => screen.getByRole("button", { name: "Change port for Team A" });
    await user.click(await screen.findByRole("button", { name: "Change port for Team A" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "New port for Team A" })).toBeNull();
    // The row is drawn again, so the button is a new one; it still gets focus.
    expect(changePort()).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(changePort());
    const field = screen.getByRole("textbox", { name: "New port for Team A" });
    await user.clear(field);
    await user.type(field, "9100{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Tandem could not save the new port. Check that its settings folder is writable, then try again.",
    );
    expect(field).toHaveValue("9100");
  });
});

describe("automatic backups", () => {
  const rocket = {
    folder: "team-a",
    name: "Rocket Team",
    port: 8543,
    lastHostedAt: 1,
    lastBackupAt: null,
    running: true,
    missing: false,
  };

  function scheduled(autoBackup: AutoBackup | null, autoBackupError: string | null = null) {
    return fakeHosting(
      { ...running, folder: "team-a" },
      { workspaces: [{ ...rocket, autoBackup, autoBackupError }], unreadable: [] },
    );
  }

  it("turns them on in a folder the system asks for, and says where", async () => {
    const user = userEvent.setup();
    const { hosting } = scheduled(null);
    render(<Harness hosting={hosting} />);
    await showSection("Backups");
    const group = await screen.findByRole("group", { name: "Automatic backups" });
    expect(group).toHaveTextContent(/Back Rocket Team up by itself every day/);
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);

    hosting.list!.mockResolvedValue({
      workspaces: [
        { ...rocket, autoBackup: { destination: "D:\\Backups", everyDays: 1, keep: 7 } },
      ],
      unreadable: [],
    });
    await user.click(within(group).getByRole("button", { name: "Back up automatically…" }));
    expect(hosting.setAutoBackup).toHaveBeenCalledWith("team-a", { everyDays: 1, keep: 7 }, true);
    expect(
      await screen.findByText("Rocket Team will be backed up every day into D:\\Backups."),
    ).toHaveAttribute("role", "status");
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Automatic backups" })).toHaveTextContent(
        "Rocket Team is backed up every day, keeping the newest 7, into D:\\Backups",
      ),
    );
  });

  it("says nothing and changes nothing when no folder is chosen", async () => {
    const user = userEvent.setup();
    const { hosting } = scheduled(null);
    hosting.setAutoBackup!.mockResolvedValueOnce(undefined);
    render(<Harness hosting={hosting} />);
    await showSection("Backups");
    await user.click(await screen.findByRole("button", { name: "Back up automatically…" }));
    expect(hosting.setAutoBackup).toHaveBeenCalledOnce();
    expect(screen.queryByText(/will be backed up/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Back up automatically…" })).toBeVisible();
  });

  it("changes how often, how many, and where, and turns them off", async () => {
    const user = userEvent.setup();
    const { hosting } = scheduled({ destination: "D:\\Backups", everyDays: 1, keep: 7 });
    render(<Harness hosting={hosting} />);
    await showSection("Backups");
    const group = await screen.findByRole("group", { name: "Automatic backups" });

    await user.selectOptions(within(group).getByRole("combobox", { name: "How often" }), "7");
    expect(hosting.setAutoBackup).toHaveBeenLastCalledWith(
      "team-a",
      { everyDays: 7, keep: 7 },
      false,
    );
    expect(await screen.findByText("Rocket Team will be backed up every week.")).toBeVisible();

    await user.selectOptions(within(group).getByRole("combobox", { name: "Keep" }), "14");
    expect(hosting.setAutoBackup).toHaveBeenLastCalledWith(
      "team-a",
      { everyDays: 1, keep: 14 },
      false,
    );

    await user.click(within(group).getByRole("button", { name: "Choose another folder" }));
    expect(hosting.setAutoBackup).toHaveBeenLastCalledWith(
      "team-a",
      { everyDays: 1, keep: 7 },
      true,
    );

    await user.click(within(group).getByRole("button", { name: "Turn off" }));
    expect(hosting.setAutoBackup).toHaveBeenLastCalledWith("team-a", null, false);
    expect(
      await screen.findByText(
        "Rocket Team will no longer be backed up by itself. Backups already made stay where they are.",
      ),
    ).toBeVisible();
  });

  it("says why the last one did not finish, and why a change was refused", async () => {
    const user = userEvent.setup();
    const { hosting } = scheduled(
      { destination: "D:\\Backups", everyDays: 1, keep: 7 },
      "The scheduled backup of Rocket Team did not finish. There is not enough free space there.",
    );
    hosting.setAutoBackup!.mockRejectedValueOnce(
      new Error("That folder is not there any more. Choose another."),
    );
    render(<Harness hosting={hosting} />);
    await showSection("Backups");
    const group = await screen.findByRole("group", { name: "Automatic backups" });
    expect(within(group).getByRole("alert")).toHaveTextContent(
      "The scheduled backup of Rocket Team did not finish. There is not enough free space there.",
    );
    await user.selectOptions(within(group).getByRole("combobox", { name: "Keep" }), "3");
    expect(
      await screen.findByText("That folder is not there any more. Choose another."),
    ).toHaveAttribute("role", "alert");
  });

  it("tries a failed backup again on Try again, and shows how it went (OPS-02)", async () => {
    const user = userEvent.setup();
    const failing = { destination: "D:\\Backups", everyDays: 1 as const, keep: 7 };
    const { hosting } = scheduled(
      { ...failing, failure: { kind: "destination" } },
      "The scheduled backup of Rocket Team did not finish. The folder D:\\Backups cannot be reached.",
    );
    const done = Date.now();
    hosting.retryBackups!.mockImplementationOnce(async () => {
      hosting.list!.mockResolvedValue({
        workspaces: [
          { ...rocket, autoBackup: { ...failing, lastAt: done }, autoBackupError: null },
        ],
        unreadable: [],
      });
    });
    render(<Harness hosting={hosting} />);
    await showSection("Backups");
    const group = await screen.findByRole("group", { name: "Automatic backups" });
    expect(within(group).queryByText(/Last backed up there/)).toBeNull();
    await user.click(within(group).getByRole("button", { name: "Try again" }));
    expect(hosting.retryBackups).toHaveBeenCalledOnce();
    await waitFor(() => expect(within(group).queryByRole("alert")).toBeNull());
    expect(within(group).getByText(/^Last backed up there today, /)).toBeVisible();
    expect(within(group).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("offers no Try again when the backup was made and only removing older ones failed", async () => {
    const { hosting } = scheduled(
      { destination: "D:\\Backups", everyDays: 1, keep: 7, failure: { kind: "cleanup" } },
      "The scheduled backup of Rocket Team was made, but older ones there could not be removed.",
    );
    render(<Harness hosting={hosting} />);
    await showSection("Backups");
    const group = await screen.findByRole("group", { name: "Automatic backups" });
    expect(within(group).getByRole("alert")).toHaveTextContent("was made, but older ones");
    expect(within(group).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("says a stopped workspace's scheduled backup did not finish, in the list", async () => {
    const { hosting } = fakeHosting(stopped, {
      workspaces: [
        {
          ...rocket,
          running: false,
          autoBackup: {
            destination: "D:\\Backups",
            everyDays: 1,
            keep: 7,
            failure: { kind: "space" },
          },
          autoBackupError:
            "The scheduled backup of Rocket Team did not finish. There is not enough free space there.",
        },
      ],
      unreadable: [],
    });
    render(<Harness hosting={hosting} />);
    expect(
      await screen.findByRole("region", { name: "Hosted on this computer" }),
    ).toHaveTextContent(
      "The scheduled backup of Rocket Team did not finish. There is not enough free space there.",
    );
  });

  it("notes a schedule in the list of stopped workspaces", async () => {
    const { hosting } = fakeHosting(stopped, {
      workspaces: [
        {
          ...rocket,
          running: false,
          autoBackup: { destination: "D:\\Backups", everyDays: 7, keep: 7 },
        },
      ],
      unreadable: [],
    });
    render(<Harness hosting={hosting} />);
    expect(
      await screen.findByRole("region", { name: "Hosted on this computer" }),
    ).toHaveTextContent("Port 8543 · Backs up weekly");
  });
});

describe("a stable public address configured for the desktop app", () => {
  const configured = "https://chat.example.org";

  it("offers the configured address, and where to route it, instead of a temporary one", async () => {
    const { hosting } = fakeHosting({
      ...running,
      tunnelAvailable: true,
      publicAddress: configured,
    });
    render(<Harness hosting={hosting} />);
    await showSection("Share on the internet");

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(within(dialog).getByText(configured)).toBeVisible();
    expect(within(dialog).getByText("http://127.0.0.1:8543")).toBeVisible();
    expect(within(dialog).queryByText(/Create a temporary HTTPS address/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Open to all" })).toBeEnabled();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("explains that a blank override keeps the configured Cloudflare address", async () => {
    const { hosting } = fakeHosting({
      ...running,
      tunnelAvailable: true,
      publicAddress: configured,
      publicAddressManaged: true,
    });
    render(<Harness hosting={hosting} />);
    await showSection("Share on the internet");

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(
      within(dialog).getByText(/empty to use the configured Cloudflare address/),
    ).toBeVisible();
    expect(
      within(dialog).queryByText(/empty to create a temporary address/),
    ).not.toBeInTheDocument();
  });

  it("says the open address will be the same one next time", async () => {
    const open: HostingStatus = {
      ...running,
      tunnelAvailable: true,
      publicAddress: configured,
      openToAll: { phase: "open", url: configured },
    };
    const { hosting } = fakeHosting(open);
    render(<Harness hosting={hosting} />);
    await showSection("Share on the internet");

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(await within(dialog).findByRole("link", { name: configured })).toHaveAttribute(
      "href",
      configured,
    );
    expect(within(dialog).getByText(/stays the same when you reopen it/)).toBeVisible();
    expect(within(dialog).queryByText(/This temporary address/)).not.toBeInTheDocument();
    expect(
      within(dialog).getByText(/only you can stop its external tunnel or proxy/),
    ).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Stop using address" })).toBeEnabled();
  });

  it("says what to correct, and opens nothing, while the configuration is unusable", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting({
      ...running,
      tunnelAvailable: true,
      publicAddressError: "Set both TANDEM_TUNNEL_URL and TANDEM_TUNNEL_TOKEN_FILE.",
    });
    render(<Harness hosting={hosting} />);
    await showSection("Share on the internet");

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/Set both TANDEM_TUNNEL_URL/);
    const open = within(dialog).getByRole("button", { name: "Open to all" });
    expect(open).toBeDisabled();

    await user.click(open);
    expect(hosting.openToAll).not.toHaveBeenCalled();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });
});

describe("an address the host already has", () => {
  const funnel = "https://box.tail1234.ts.net";

  it("takes one, trims it, and publishes it as the workspace's own", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting({ ...running, tunnelAvailable: true });
    render(<Harness hosting={hosting} />);
    await showSection("Share on the internet");

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    const address = within(dialog).getByLabelText("Your own address");
    const save = within(dialog).getByRole("button", { name: "Save" });
    // Never off: sent empty with none saved, it asks for one beside the field.
    expect(save).toBeEnabled();
    await user.click(save);
    expect(hosting.setPublicAddress).not.toHaveBeenCalled();
    expect(address).toHaveFocus();
    expect(address).toHaveAttribute("aria-invalid", "true");
    expect(address).toHaveAccessibleDescription(/Enter the address, such as/);

    await user.type(address, `  ${funnel}  {Enter}`);

    expect(hosting.setPublicAddress).toHaveBeenCalledWith(funnel);
    expect(await within(dialog).findByText(funnel)).toBeVisible();
    // Nothing here is Cloudflare's, so it must not tell them to route it there.
    expect(within(dialog).getByText(/Send this address to/)).toBeVisible();
    expect(within(dialog).queryByText(/In Cloudflare, route/)).not.toBeInTheDocument();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("repeats what the app says about an address it will not take", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting({ ...running, tunnelAvailable: true });
    hosting.setPublicAddress.mockRejectedValueOnce(
      new Error("Use a public HTTPS hostname without a path, credentials, query, or fragment."),
    );
    render(<Harness hosting={hosting} />);
    await showSection("Share on the internet");

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    await user.type(within(dialog).getByLabelText("Your own address"), "http://localhost:8543");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/public HTTPS hostname/);
    const address = within(dialog).getByLabelText("Your own address");
    expect(address).toHaveValue("http://localhost:8543");
    expect(address).toHaveAttribute("aria-invalid", "true");
    expect(address).toHaveAttribute("aria-errormessage", "public-address-error");
    expect(address).toHaveAccessibleDescription(/public HTTPS hostname/);
  });

  it("warns that an external carrier can already expose the workspace", async () => {
    const { hosting } = fakeHosting({
      ...running,
      tunnelAvailable: true,
      publicAddress: funnel,
      publicAddressSetting: funnel,
      inviteOnly: true,
    });
    render(<Harness hosting={hosting} />);
    await showSection("Share on the internet");

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(within(dialog).getByText(/may already make this workspace reachable/)).toBeVisible();
    expect(within(dialog).getByText(/stop the carrier separately/)).toBeVisible();
    expect(within(dialog).getByRole("checkbox", { name: /Require an invite/ })).toBeChecked();
  });

  it("says there is nothing to save rather than saving the same address again", async () => {
    const user = userEvent.setup();
    const { hosting } = fakeHosting({
      ...running,
      tunnelAvailable: true,
      publicAddress: funnel,
      publicAddressSetting: funnel,
    });
    render(<Harness hosting={hosting} />);
    await showSection("Share on the internet");

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    const address = within(dialog).getByLabelText("Your own address");
    // Saving it would also turn invites back on, so the same address is not sent again.
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(hosting.setPublicAddress).not.toHaveBeenCalled();
    expect(
      within(dialog).getByText("Nothing to save: that is the address already saved."),
    ).toHaveAttribute("role", "status");
    expect(address).not.toHaveAttribute("aria-invalid", "true");

    // Emptied, it is a change: the saved address goes.
    await user.clear(address);
    expect(within(dialog).queryByText(/Nothing to save/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(hosting.setPublicAddress).toHaveBeenCalledWith("");
  });

  it("shows an address the environment fixed without offering to change it", async () => {
    const { hosting } = fakeHosting({
      ...running,
      tunnelAvailable: true,
      publicAddress: funnel,
      publicAddressSetting: funnel,
      publicAddressLocked: true,
    });
    render(<Harness hosting={hosting} />);
    await showSection("Share on the internet");

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    expect(within(dialog).getByLabelText("Your own address")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(dialog).getByText(/comes from an environment variable/)).toBeVisible();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });
});

describe("a relay for calls from other networks", () => {
  it("is offered beside the running workspace, where the public link is", async () => {
    const { hosting } = fakeHosting({ ...running, tunnelAvailable: true });
    const relay = {
      get: vi.fn(async () => ({ kind: "none" as const })),
      set: vi.fn(),
      test: vi.fn(),
    };
    render(<Harness hosting={{ ...hosting, relay }} />);
    await showSection("Share on the internet");

    const dialog = await screen.findByRole("dialog", { name: "Workspace is live" });
    const card = await within(dialog).findByRole("region", { name: "Calls from other networks" });
    expect(await within(card).findByRole("radio", { name: "No relay" })).toBeChecked();
    expect(relay.get).toHaveBeenCalledTimes(1);
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });
});
