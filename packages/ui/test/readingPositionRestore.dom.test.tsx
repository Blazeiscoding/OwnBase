import { createRoot } from "react-dom/client";
import { screen, waitFor } from "@testing-library/react";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, User } from "@ownbase/protocol";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { MessageTimeline } from "../src/components/MessageTimeline.js";
import { ToastProvider } from "../src/components/Toast.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import { writeRoute } from "../src/lib/route.js";
import type { Platform } from "../src/platform.js";

/**
 * Back, Forward and a reload return to where a conversation was being read.
 * A conversation this client already holds can answer its history request
 * before React renders again, so that request's loading state ends where it
 * began and that render commits nothing: the place must still be put back.
 */
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
const general: Channel = {
  id: "C_GENERAL",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
  memberIds: [sam.id],
};
const message = (n: number): Message =>
  ({
    id: `M_${n}`,
    channelId: general.id,
    userId: sam.id,
    text: `Line ${n} of the log`,
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
const SERVER = "http://127.0.0.1:9";

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("returning to where a conversation was being read", () => {
  it("puts the reader back even when the history request answers before React renders", async () => {
    const client = new WorkspaceClient(SERVER, "test-token-not-a-credential");
    const items = Array.from({ length: 20 }, (_, i) => message(i + 1));
    client.store.setState({
      self: sam,
      users: { [sam.id]: sam },
      channels: { [general.id]: general },
      memberships: { [general.id]: 20 },
      timelines: { [general.id]: { items, hasMore: false, hasMoreNewer: false, loaded: true } },
      status: "online",
    });
    // Already held here: the request answers at once, and its frame comes at once too.
    vi.spyOn(client, "loadTimeline").mockResolvedValue(undefined);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((step) => {
      queueMicrotask(() => step(0));
      return 0;
    });
    writeRoute(SERVER, { channelId: general.id, threadRootId: null }, "replace");
    window.history.replaceState(
      {
        ownbase: {
          ...window.history.state.ownbase,
          scroll: { messageId: "M_8", offset: -15 },
        },
      },
      "",
    );
    // Rows 50 pixels apart; where the view is put is what is asked of it.
    const set: number[] = [];
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      const n = Number(this.dataset.mid?.slice(2) ?? 0);
      return n * 50;
    });
    vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (
      this: Element,
      value: number,
    ) {
      if (this.getAttribute("aria-label") === "Message history") set.push(value);
    });

    const platform: Platform = {
      kind: "web",
      storage: { get: async () => null, set: async () => {} },
      notify: () => {},
    };
    // Rendered as a browser renders, not inside act(), which would render
    // each state before the request could answer.
    const actEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    onTestFinished(() => {
      root.unmount();
      host.remove();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
        actEnvironment;
    });
    root.render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <ToastProvider>
            <ConfirmProvider>
              <MessageTimeline
                channelId={general.id}
                onOpenThread={() => {}}
                onChannelClick={() => {}}
                onOpenProfile={() => {}}
              />
            </ConfirmProvider>
          </ToastProvider>
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    await waitFor(() => expect(client.loadTimeline).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.getByText("Line 8 of the log")).toBeTruthy();
    // Row 8 starts 400 pixels down and sat 15 above the top of the view.
    expect(set).toContain(415);
  });
});
