import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, Message, User } from "@slackoss/protocol";
import { ClientContext } from "../src/context.js";
import { CountBadge, Swap } from "../src/components/Motion.js";
import { Modal } from "../src/components/Modal.js";
import { MessageTimeline } from "../src/components/MessageTimeline.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider, useToast } from "../src/components/Toast.js";
import { useTabs } from "../src/lib/useTabs.js";

/**
 * jsdom runs no animations, so the app moves nothing there. These tests give
 * it the two calls the app asks for before it animates, and check what is
 * asked of them: an animation for a change, none for what was there first.
 */
type Played = { animationName: string; finished: Promise<unknown> };
let playing: (element: Element) => Played[];
let animate: ReturnType<typeof vi.fn>;
const proto = Element.prototype as unknown as Record<string, unknown>;

beforeEach(() => {
  playing = () => [];
  animate = vi.fn();
  proto.getAnimations = function (this: Element) {
    return playing(this);
  };
  proto.animate = animate;
});
afterEach(() => {
  delete proto.getAnimations;
  delete proto.animate;
  document.querySelectorAll("[data-leaving]").forEach((copy) => copy.remove());
  vi.useRealTimers();
});

describe("a count in a badge", () => {
  it("is still when first drawn, pops in when it appears, and rolls its number when it changes", () => {
    const view = render(<CountBadge count={3} aria-label="Unread" />);
    const badge = () => screen.getByLabelText("Unread");
    expect(badge()).not.toHaveClass("animate-badge-in");
    expect(badge().querySelector(".animate-count-in")).toBeNull();

    view.rerender(<CountBadge count={4} aria-label="Unread" />);
    expect(badge()).toHaveTextContent("4");
    // Already there, so it does not pop again: only its number rolls.
    expect(badge()).not.toHaveClass("animate-badge-in");
    expect(badge().querySelector(".animate-count-in")).toHaveTextContent("4");

    view.rerender(<CountBadge count={0} aria-label="Unread" />);
    expect(screen.queryByLabelText("Unread")).toBeNull();
    view.rerender(<CountBadge count={1} aria-label="Unread" />);
    expect(badge()).toHaveClass("animate-badge-in");
  });

  it("can be a dot that says only that there is something", () => {
    render(<CountBadge count={2} dot aria-label="New" />);
    expect(screen.getByLabelText("New")).toBeEmptyDOMElement();
  });
});

describe("something that changes in place", () => {
  it("regrows an icon, or raises words, only once it changes", () => {
    const view = render(
      <Swap on={false}>
        <span>mic</span>
      </Swap>,
    );
    expect(screen.getByText("mic").parentElement).not.toHaveClass("animate-swap-in");
    view.rerender(
      <Swap on>
        <span>mic off</span>
      </Swap>,
    );
    expect(screen.getByText("mic off").parentElement).toHaveClass("animate-swap-in");

    const words = render(<Swap text>Copy code</Swap>);
    expect(words.getByText("Copy code")).not.toHaveClass("animate-text-in");
    words.rerender(<Swap text>Copied</Swap>);
    expect(words.getByText("Copied")).toHaveClass("animate-text-in");
  });
});

function Closable({ open, children }: { open: boolean; children: React.ReactNode }) {
  return open ? (
    <Modal title="Edit profile" onClose={() => {}} className="animate-pop-in">
      {children}
    </Modal>
  ) : null;
}

describe("a dialog on its way out", () => {
  it("leaves a copy that plays its way out, hidden and unreachable, with what was typed", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    playing = (element) =>
      element.hasAttribute("data-leaving") ? [{ animationName: "pop-out", finished }] : [];
    const view = render(
      <Closable open>
        <label htmlFor="name">Name</label>
        <input id="name" name="name" />
        <div role="list" />
      </Closable>,
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Maya" } });
    view.rerender(<Closable open={false}>{null}</Closable>);

    const copy = document.querySelector<HTMLElement>("[data-leaving]");
    expect(copy).not.toBeNull();
    expect(copy).toHaveAttribute("aria-hidden", "true");
    expect(copy!.inert).toBe(true);
    expect(copy!.hasAttribute("data-ownbase-modal")).toBe(false);
    // Nothing in it can be found by id, name or role while it goes.
    expect(copy!.querySelector("[id], [name], [role]")).toBeNull();
    expect(copy!.querySelector("input")!.value).toBe("Maya");
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => {
      finish();
      await finished;
    });
    expect(document.querySelector("[data-leaving]")).toBeNull();
  });

  it("leaves nothing when it closes while still opening, or when less motion is asked for", () => {
    playing = (element) =>
      element.hasAttribute("data-ownbase-modal")
        ? [{ animationName: "pop-in", finished: Promise.resolve() }]
        : [];
    const opening = render(<Closable open>text</Closable>);
    opening.rerender(<Closable open={false}>{null}</Closable>);
    expect(document.querySelector("[data-leaving]")).toBeNull();

    playing = () => [];
    const matchMedia = vi
      .spyOn(window, "matchMedia")
      .mockReturnValue({ matches: true } as MediaQueryList);
    const still = render(<Closable open>text</Closable>);
    still.rerender(<Closable open={false}>{null}</Closable>);
    expect(document.querySelector("[data-leaving]")).toBeNull();
    matchMedia.mockRestore();
  });
});

function Raiser() {
  const show = useToast();
  return (
    <button type="button" onClick={() => show({ message: "Link copied.", kind: "success" })}>
      Copy link
    </button>
  );
}

describe("a notice on its way out", () => {
  it("folds its row away before it goes", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Raiser />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    const notice = screen.getByText("Link copied.").closest<HTMLElement>("[data-toast]")!;
    expect(notice).toHaveClass("animate-toast-in");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(notice.parentElement).toHaveClass("is-leaving");
    expect(screen.getByText("Link copied.")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(250));
    expect(screen.queryByText("Link copied.")).toBeNull();
  });
});

const TABS = ["People", "Apps", "Invites"] as const;
function Tabs() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Apps");
  const tabs = useTabs({ label: "Manage", tabs: TABS, selected: tab, onSelect: setTab });
  return (
    <>
      <div {...tabs.listProps}>
        {TABS.map((t) => (
          <button key={t} {...tabs.tabProps(t)}>
            {t}
          </button>
        ))}
      </div>
      <div {...tabs.panelProps}>{tab}</div>
    </>
  );
}

describe("tabs", () => {
  it("bring the panel in from the side of the tab chosen", () => {
    render(<Tabs />);
    const panel = screen.getByRole("tabpanel");
    fireEvent.click(screen.getByRole("tab", { name: "Invites" }));
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(panel);
    expect(animate.mock.calls[0]![0][0]).toMatchObject({ translate: "8px 0" });

    fireEvent.click(screen.getByRole("tab", { name: "People" }));
    expect(animate.mock.calls[1]![0][0]).toMatchObject({ translate: "-8px 0" });
    // The tab already chosen moves nothing.
    fireEvent.click(screen.getByRole("tab", { name: "People" }));
    expect(animate).toHaveBeenCalledTimes(2);
  });
});

const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};
const ana: User = { ...sam, id: "U_ANA", handle: "ana", displayName: "Ana Lima" };
const general: Channel = {
  id: "C_GENERAL",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
};
const message = (n: number, userId = ana.id): Message =>
  ({
    id: `M_${String(n).padStart(3, "0")}`,
    channelId: general.id,
    userId,
    text: `Line ${n}`,
    seq: n,
    createdAt: n,
    editedAt: null,
    threadRootId: null,
    broadcast: false,
    replyCount: 0,
    reactions: [],
    files: [],
    pinned: false,
    actions: [],
  }) as unknown as Message;

describe("messages arriving", () => {
  it("rise in when they come live, yours brightens, and history already there is still", () => {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    const timeline = (items: Message[]) => ({
      timelines: { [general.id]: { items, hasMore: false, hasMoreNewer: false, loaded: true } },
    });
    client.store.setState({
      self: sam,
      users: { [sam.id]: sam, [ana.id]: ana },
      channels: { [general.id]: general },
      memberships: { [general.id]: 2 },
      status: "online",
      ...timeline([message(1), message(2)]),
    });
    vi.spyOn(client, "loadTimeline").mockResolvedValue(undefined);
    render(
      <ToastProvider>
        <ConfirmProvider>
          <ClientContext.Provider value={client}>
            <MessageTimeline
              channelId={general.id}
              onOpenThread={vi.fn()}
              onChannelClick={vi.fn()}
              onOpenProfile={vi.fn()}
            />
          </ClientContext.Provider>
        </ConfirmProvider>
      </ToastProvider>,
    );
    const row = (n: number) => document.querySelector(`[data-mid="${message(n).id}"]`)!;
    expect(row(2)).not.toHaveClass("animate-message-in");

    act(() => client.store.setState(timeline([message(1), message(2), message(3)])));
    expect(row(3)).toHaveClass("animate-message-in");
    expect(row(2)).not.toHaveClass("animate-message-in");

    act(() =>
      client.store.setState(timeline([message(1), message(2), message(3), message(4, sam.id)])),
    );
    expect(row(4)).toHaveClass("animate-sent");
    expect(row(3)).toHaveClass("animate-message-in");

    // A crowd caught up at once, as after being offline, comes in still.
    const caughtUp = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => message(n, n === 4 ? sam.id : ana.id));
    act(() => client.store.setState(timeline(caughtUp)));
    expect(row(8)).not.toHaveClass("animate-message-in");
  });
});
