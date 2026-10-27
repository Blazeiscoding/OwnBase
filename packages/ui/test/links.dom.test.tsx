import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Invite, ServerInfo, User } from "@ownbase/protocol";
import { ClientContext, OpenMessageContext } from "../src/context.js";
import { InviteDialog } from "../src/components/InviteDialog.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { Mrkdwn } from "../src/components/Mrkdwn.js";
import { ShareableServerProvider } from "../src/components/ShareableServer.js";
import { webPlatform, type HostingStatus, type Platform } from "../src/platform.js";
import { workspaceAddressTrustKey } from "../src/lib/workspaceAddressTrust.js";
import { accessibilityProblems } from "./accessibility.js";
import { copyBySelection, withoutClipboardApi } from "./clipboard.js";

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
  canInvite: true,
};

const design: Channel = {
  id: "C_DESIGN",
  type: "public",
  name: "design",
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
  memberIds: ["U_SAM"],
};

/** This computer hosting the workspace, answering on a virtual adapter as well as the office network. */
const hostingHere: HostingStatus = {
  running: true,
  phase: "running",
  workspaceName: "Rocket Team",
  port: 8543,
  lanUrls: ["172.28.64.1:8543", "192.168.1.20:8543"],
};

const madeInvite: Invite = {
  code: "ABCD1234",
  createdBy: "U_SAM",
  createdAt: 0,
  expiresAt: null,
  maxUses: null,
  uses: 0,
  status: "active",
};

const DAY = 24 * 3600_000;

/**
 * The invite dialog over a workspace client that never connects, below the
 * providers the workspace screen puts it under. It makes a code on opening.
 */
async function inviteWith(options: {
  baseUrl: string;
  publicUrl?: string;
  hosting?: HostingStatus;
  invites?: Invite[];
  createInvite?: () => Promise<{ invite: Invite }>;
}) {
  const client = new WorkspaceClient(options.baseUrl, "test-token-not-a-credential");
  client.store.setState({ self: owner, users: { U_SAM: owner }, status: "online" });
  const info: ServerInfo = {
    app: "ownbase",
    protocolVersion: 1,
    serverVersion: "0.0.0-test",
    workspaceName: "Rocket Team",
    userCount: 3,
    requiresInvite: true,
    requiresClaim: false,
    ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
  };
  const serverInfo = vi.spyOn(client.api, "serverInfo").mockResolvedValue(info);
  vi.spyOn(client.api, "listInvites").mockResolvedValue({ invites: options.invites ?? [] });
  const createInvite = vi
    .spyOn(client.api, "createInvite")
    .mockImplementation(options.createInvite ?? (async () => ({ invite: madeInvite })));
  const revokeInvite = vi.spyOn(client.api, "revokeInvite").mockResolvedValue({
    invite: { ...(options.invites?.[0] ?? madeInvite), status: "revoked" },
  });
  const hosting = options.hosting;
  const platform: Platform = {
    ...webPlatform(),
    kind: "desktop",
    ...(hosting ? { hosting: { status: async () => hosting, start: vi.fn(), stop: vi.fn() } } : {}),
  };
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <ConfirmProvider>
        <ClientContext.Provider value={client}>
          <ShareableServerProvider platform={platform}>
            <InviteDialog onClose={() => {}} />
          </ShareableServerProvider>
        </ClientContext.Provider>
      </ConfirmProvider>
    </ToastProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: "Invite people" });
  if (!options.createInvite) await within(dialog).findByText("ABCD1234");
  return {
    dialog: within(dialog),
    root: dialog,
    user,
    info,
    serverInfo,
    revokeInvite,
    createInvite,
  };
}

describe("inviting someone", () => {
  it("opens with a link ready to copy, made for a week and anyone (UX-43)", async () => {
    const { dialog, root, user, createInvite } = await inviteWith({
      baseUrl: "http://192.168.1.20:8543",
      createInvite: async () => ({
        invite: { ...madeInvite, createdAt: Date.now(), expiresAt: Date.now() + 7 * DAY },
      }),
    });
    expect(await dialog.findByText("http://192.168.1.20:8543/#/join/ABCD1234")).toBeVisible();
    // Nothing to press first: no generate step.
    expect(dialog.queryByRole("button", { name: /Generate/ })).toBeNull();
    expect(createInvite).toHaveBeenCalledTimes(1);
    expect(createInvite).toHaveBeenCalledWith({ expiresInHours: 24 * 7 });
    expect(dialog.getByText("Expires in 7 days · Any number of people")).toBeVisible();
    expect(dialog.getByRole("img", { name: "QR code for the invite link" })).toBeVisible();

    await user.click(dialog.getByRole("button", { name: "Copy link" }));
    expect(await navigator.clipboard.readText()).toBe("http://192.168.1.20:8543/#/join/ABCD1234");
    // Said politely, as a success: nothing went wrong.
    const copied = await screen.findByText("Invite link copied.");
    expect(copied.closest('[aria-live="polite"]')).not.toBeNull();
    expect(await accessibilityProblems(root)).toEqual([]);
  });

  it("shows again a link this person made that still works, rather than making another", async () => {
    const kept: Invite = {
      ...madeInvite,
      code: "KEPT5678",
      createdAt: 5,
      expiresAt: Date.now() + 5 * DAY,
      uses: 2,
    };
    const someoneElses: Invite = { ...madeInvite, code: "THEIRS99", createdBy: "U_ALEX" };
    const limited: Invite = { ...madeInvite, code: "LIMIT123", createdAt: 9, maxUses: 3 };
    const ending: Invite = {
      ...madeInvite,
      code: "ENDS0000",
      createdAt: 9,
      expiresAt: Date.now() + 3600_000,
    };
    const { dialog, createInvite } = await inviteWith({
      baseUrl: "http://192.168.1.20:8543",
      invites: [someoneElses, limited, ending, kept],
      createInvite: async () => ({ invite: madeInvite }),
    });
    expect(await dialog.findByText("http://192.168.1.20:8543/#/join/KEPT5678")).toBeVisible();
    expect(dialog.getByText("Expires in 5 days · Any number of people")).toBeVisible();
    expect(createInvite).not.toHaveBeenCalled();
  });

  it("makes a new link with the length and number of uses chosen", async () => {
    const { dialog, user, createInvite } = await inviteWith({
      baseUrl: "http://192.168.1.20:8543",
    });
    createInvite.mockResolvedValueOnce({
      invite: { ...madeInvite, code: "FIVE5555", expiresAt: Date.now() + DAY, maxUses: 5 },
    });
    const change = dialog.getByRole("button", { name: "Change" });
    await user.click(change);
    expect(change).toHaveAttribute("aria-expanded", "true");
    const form = dialog.getByRole("form", { name: "New invite link" });
    await user.selectOptions(within(form).getByLabelText("Expires after"), "1 day");
    await user.selectOptions(within(form).getByLabelText("Number of uses"), "5 uses");
    await user.click(within(form).getByRole("button", { name: "Make a new link" }));
    expect(createInvite).toHaveBeenLastCalledWith({ expiresInHours: 24, maxUses: 5 });
    expect(await dialog.findByText("http://192.168.1.20:8543/#/join/FIVE5555")).toBeVisible();
    expect(dialog.getByText("Expires in 1 day · 5 of 5 uses left")).toBeVisible();
    expect(dialog.queryByRole("form", { name: "New invite link" })).toBeNull();

    // And one for good, for anyone.
    createInvite.mockResolvedValueOnce({ invite: { ...madeInvite, code: "EVER0000" } });
    await user.click(dialog.getByRole("button", { name: "Change" }));
    const again = dialog.getByRole("form", { name: "New invite link" });
    await user.selectOptions(within(again).getByLabelText("Expires after"), "Never");
    await user.selectOptions(within(again).getByLabelText("Number of uses"), "No limit");
    await user.click(within(again).getByRole("button", { name: "Make a new link" }));
    expect(createInvite).toHaveBeenLastCalledWith({});
    expect(await dialog.findByText("Never expires · Any number of people")).toBeVisible();
  });

  it("says when a link could not be made, and makes one when asked", async () => {
    let fail = true;
    const { dialog, user } = await inviteWith({
      baseUrl: "http://192.168.1.20:8543",
      createInvite: async () => {
        if (fail) throw new TypeError("Failed to fetch");
        return { invite: madeInvite };
      },
    });
    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "Could not make an invite link. Check your connection and try again.",
    );
    fail = false;
    await user.click(dialog.getByRole("button", { name: "Make an invite link" }));
    expect(await dialog.findByText("http://192.168.1.20:8543/#/join/ABCD1234")).toBeVisible();
    expect(dialog.queryByRole("alert")).toBeNull();
  });

  it("builds links on a network address when this computer hosts the workspace it shows", async () => {
    const { dialog, root, user } = await inviteWith({
      baseUrl: "http://localhost:8543",
      hosting: hostingHere,
    });
    const address = await dialog.findByRole("combobox", { name: "Address used in links" });
    expect(address).toHaveDisplayValue("192.168.1.20:8543");
    expect(dialog.getByText("http://192.168.1.20:8543/#/join/ABCD1234")).toBeVisible();
    expect(dialog.getByText("ownbase://join?host=192.168.1.20:8543&code=ABCD1234")).toBeVisible();
    expect(dialog.queryByText(/reaches only this computer/)).toBeNull();

    // The other address is there for whoever is on that network.
    await user.selectOptions(address, "172.28.64.1:8543");
    expect(dialog.getByText("http://172.28.64.1:8543/#/join/ABCD1234")).toBeVisible();

    await user.click(dialog.getByRole("button", { name: "Copy link" }));
    expect(await navigator.clipboard.readText()).toBe("http://172.28.64.1:8543/#/join/ABCD1234");
    expect(await accessibilityProblems(root)).toEqual([]);
  });

  it("refreshes the address the host published, whatever this app is connected through", async () => {
    const { dialog, info, serverInfo } = await inviteWith({
      baseUrl: "http://192.168.1.20:8543",
      publicUrl: "https://chat.team.dev",
    });
    expect(await dialog.findByText("https://chat.team.dev/#/join/ABCD1234")).toBeVisible();
    expect(
      dialog.getByText("ownbase://join?host=https://chat.team.dev&code=ABCD1234"),
    ).toBeVisible();

    serverInfo.mockResolvedValue({ ...info, publicUrl: undefined });
    fireEvent.focus(window);
    expect(await dialog.findByText("http://192.168.1.20:8543/#/join/ABCD1234")).toBeVisible();

    serverInfo.mockResolvedValue({ ...info, publicUrl: "https://new-link.trycloudflare.com" });
    fireEvent.focus(window);
    expect(
      await dialog.findByText("https://new-link.trycloudflare.com/#/join/ABCD1234"),
    ).toBeVisible();
  });

  it("builds browser and desktop invites on the host's live Cloudflare address", async () => {
    const { dialog } = await inviteWith({
      baseUrl: "http://localhost:8543",
      hosting: {
        ...hostingHere,
        tunnelAvailable: true,
        openToAll: { phase: "open", url: "https://rocket-team.trycloudflare.com" },
      },
    });
    expect(
      await dialog.findByText("https://rocket-team.trycloudflare.com/#/join/ABCD1234"),
    ).toBeVisible();
    expect(
      dialog.getByText("ownbase://join?host=https://rocket-team.trycloudflare.com&code=ABCD1234"),
    ).toBeVisible();
  });

  it("keeps a workspace on https on https, in the desktop app's link too", async () => {
    const { dialog } = await inviteWith({ baseUrl: "https://rocket.example.dev" });
    expect(dialog.getByText("https://rocket.example.dev/#/join/ABCD1234")).toBeVisible();
    expect(
      dialog.getByText("ownbase://join?host=https://rocket.example.dev&code=ABCD1234"),
    ).toBeVisible();
    expect(dialog.queryByText(/reaches only this computer/)).toBeNull();
  });

  it("copies from inside the dialog on a page given no Clipboard API", async () => {
    // A browser that reached the workspace over plain http on the network.
    const { dialog, root, user } = await inviteWith({ baseUrl: "http://192.168.1.20:8543" });
    const restoreApi = withoutClipboardApi();
    const selection = copyBySelection();
    try {
      const copyLink = dialog.getByRole("button", { name: "Copy link" });
      await user.click(copyLink);
      // The dialog keeps focus to itself, so this copy only works from inside it.
      expect(selection.copied).toEqual(["http://192.168.1.20:8543/#/join/ABCD1234"]);
      expect(copyLink).toHaveTextContent("Copied");
      expect(copyLink).toHaveFocus();
      expect(root.querySelector("textarea")).toBeNull();

      await user.click(dialog.getByRole("button", { name: "Copy address" }));
      expect(selection.copied.at(-1)).toBe("192.168.1.20:8543");
    } finally {
      selection.restore();
      restoreApi();
    }
  });

  it("revokes an invite only after the shared confirmation is accepted", async () => {
    // Limited to three people, so it is listed but not the link shown.
    const oldInvite: Invite = { ...madeInvite, code: "OLD-CODE", uses: 1, maxUses: 3 };
    const { dialog, user, revokeInvite } = await inviteWith({
      baseUrl: "http://192.168.1.20:8543",
      invites: [oldInvite],
    });
    const revoke = await dialog.findByRole("button", { name: "Revoke invite OLD-CODE" });
    await user.click(revoke);

    const question = screen.getByRole("dialog", { name: "Revoke this invite?" });
    expect(revokeInvite).not.toHaveBeenCalled();
    await user.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(revokeInvite).not.toHaveBeenCalled();

    await user.click(revoke);
    await user.click(
      within(screen.getByRole("dialog", { name: "Revoke this invite?" })).getByRole("button", {
        name: "Revoke",
      }),
    );
    expect(revokeInvite).toHaveBeenCalledWith("OLD-CODE");
  });

  it("tells someone who cannot create invite codes what joining takes", async () => {
    const member: User = {
      ...owner,
      id: "U_ALEX",
      handle: "alex",
      role: "member",
      canInvite: false,
    };
    const client = new WorkspaceClient("http://192.168.1.20:8543", "test-token-not-a-credential");
    client.store.setState({ self: member, users: { U_ALEX: member }, status: "online" });
    vi.spyOn(client.api, "listInvites").mockResolvedValue({ invites: [] });
    render(
      <ConfirmProvider>
        <ClientContext.Provider value={client}>
          <InviteDialog onClose={() => {}} />
        </ClientContext.Provider>
      </ConfirmProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Invite people" });
    expect(dialog).toHaveTextContent(
      "Anyone joining needs this workspace's address, and an invite code as well if the workspace is invite-only.",
    );
    expect(dialog).not.toHaveTextContent(/Send someone an invite link/);
    expect(within(dialog).getByText("192.168.1.20:8543")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Copy address" })).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Make an invite link" })).toBeNull();
    expect(within(dialog).queryByText(/\/#\/join\//)).toBeNull();
    await waitFor(() => expect(client.api.listInvites).toHaveBeenCalled());
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("says so when the only address it has works on this computer alone", async () => {
    const { dialog } = await inviteWith({ baseUrl: "http://127.0.0.1:8543" });
    expect(dialog.getByText(/reaches only this computer/)).toBeVisible();
    expect(dialog.getByText("http://127.0.0.1:8543/#/join/ABCD1234")).toBeVisible();
    // A phone could not open it, so there is no code to scan.
    expect(dialog.queryByRole("img", { name: /QR code/ })).toBeNull();
  });
});

describe("a link to a message, written in a message", () => {
  // Addresses linked to the workspace are kept on the device; each case starts without.
  afterEach(() => localStorage.clear());

  /**
   * A message's text in a workspace open on the office network, whose host
   * published a public address, as the workspace screen shows it. `linked`
   * are addresses this device has linked to the workspace.
   */
  async function renderText(text: string, linked: string[] = []) {
    const openMessage = vi.fn();
    const client = new WorkspaceClient("http://192.168.1.20:8543", "test-token-not-a-credential");
    client.store.setState({
      self: owner,
      users: { U_SAM: owner },
      workspaceId: "W1",
      status: "online",
    });
    vi.spyOn(client.api, "serverInfo").mockResolvedValue({
      app: "ownbase",
      protocolVersion: 1,
      serverVersion: "0.0.0-test",
      workspaceName: "Rocket Team",
      userCount: 3,
      requiresInvite: true,
      requiresClaim: false,
      publicUrl: "https://rocket.example.dev",
    });
    const platform = webPlatform();
    if (linked.length)
      await platform.storage.set(workspaceAddressTrustKey("W1", "U_SAM"), {
        version: 1,
        addresses: linked,
      });
    render(
      <ClientContext.Provider value={client}>
        <ShareableServerProvider platform={platform}>
          <OpenMessageContext.Provider value={openMessage}>
            <Mrkdwn text={text} users={{ U_SAM: owner }} channels={{ C_DESIGN: design }} />
          </OpenMessageContext.Provider>
        </ShareableServerProvider>
      </ClientContext.Provider>,
    );
    // The published address is fetched from the server once the workspace is open.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    return openMessage;
  }

  it("opens the message here when it is in this workspace, whatever address the link carries", async () => {
    // One person copied it on the office network, another through the public
    // address; both lead to the same message.
    const openMessage = await renderText(
      "The plan http://192.168.1.20:8543/#/c/C_DESIGN/m/M_PLAN and from outside https://rocket.example.dev/#/c/C_DESIGN/m/M_PLAN",
    );
    const [onNetwork, outside] = screen.getAllByRole("link");
    // fireEvent reports false when the click's default was prevented.
    expect(fireEvent.click(onNetwork!)).toBe(false);
    expect(fireEvent.click(outside!)).toBe(false);
    expect(openMessage.mock.calls).toEqual([
      ["C_DESIGN", "M_PLAN"],
      ["C_DESIGN", "M_PLAN"],
    ]);
  });

  it("leaves a link to another server holding the same ids to go where it says", async () => {
    // A restored copy of this workspace, somewhere else: same channel and message ids.
    const openMessage = await renderText(
      "https://restored.example.org/#/c/C_DESIGN/m/M_PLAN http://10.0.0.9:8543/#/c/C_DESIGN/m/M_PLAN",
      ["http://10.0.0.9:8543"],
    );
    const noWindows = (event: Event) => event.preventDefault();
    document.addEventListener("click", noWindows);
    try {
      const [restored, linkedHere] = screen.getAllByRole("link");
      fireEvent.click(restored!);
      expect(openMessage).not.toHaveBeenCalled();
      // An address this device linked to this workspace is its own.
      fireEvent.click(linkedHere!);
      expect(openMessage.mock.calls).toEqual([["C_DESIGN", "M_PLAN"]]);
    } finally {
      document.removeEventListener("click", noWindows);
    }
  });

  it("leaves a click asking for a new tab, and any other link, to the browser", async () => {
    const openMessage = await renderText(
      "http://192.168.1.20:8543/#/c/C_DESIGN/m/M_PLAN http://192.168.1.20:8543/#/c/C_ELSEWHERE/m/M_2 https://example.com/docs",
    );
    // Stops jsdom trying to open the windows a browser would.
    const noWindows = (event: Event) => event.preventDefault();
    document.addEventListener("click", noWindows);
    try {
      const [here, notHere, otherSite] = screen.getAllByRole("link");
      for (const modifier of ["ctrlKey", "metaKey", "shiftKey"]) {
        fireEvent.click(here!, { [modifier]: true });
      }
      fireEvent.click(here!, { button: 1 });
      fireEvent.click(notHere!);
      fireEvent.click(otherSite!);
      expect(openMessage).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("click", noWindows);
    }
  });
});

describe("a browser opened at a link", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("hands the app the link once, and takes it out of the address", async () => {
    window.history.replaceState(null, "", "/#/join/ABCD1234");
    const links = webPlatform().deepLinks!;
    expect(await links.consumePending()).toBe(`${location.origin}/#/join/ABCD1234`);
    // A reload must not act on it again, and the code should not sit in history.
    expect(location.href).toBe(`${location.origin}/`);
    expect(await links.consumePending()).toBeNull();
  });

  it("hands over a link pasted into the address of a page already open", async () => {
    const received = vi.fn();
    const unsubscribe = webPlatform().deepLinks!.subscribe(received);
    try {
      location.hash = "#/c/C_DESIGN/m/M_PLAN";
      await waitFor(() =>
        expect(received).toHaveBeenCalledWith(`${location.origin}/#/c/C_DESIGN/m/M_PLAN`),
      );
      expect(location.hash).toBe("");

      // A fragment that is not a link is left for whatever put it there.
      location.hash = "#notes";
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received).toHaveBeenCalledTimes(1);
      expect(location.hash).toBe("#notes");
    } finally {
      unsubscribe();
    }
  });
});
