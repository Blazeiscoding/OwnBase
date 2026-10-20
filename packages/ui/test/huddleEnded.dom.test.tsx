import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { WorkspaceClient } from "@slackoss/client-core";
import { ClientContext } from "../src/context.js";
import { ToastProvider } from "../src/components/Toast.js";
import { useHuddleEndedNotice } from "../src/lib/huddleEnded.js";

/** A call that ended without the person leaving it says why, once. */
function Notice() {
  useHuddleEndedNotice();
  return null;
}

function show() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  render(
    <ClientContext.Provider value={client}>
      <ToastProvider>
        <Notice />
      </ToastProvider>
    </ClientContext.Provider>,
  );
  return client;
}

describe("a call that ended by itself", () => {
  it("says it moved to another device", () => {
    const client = show();
    expect(screen.queryByText(/another device/)).toBeNull();
    act(() =>
      client.store.setState({
        huddleEnded: {
          channelId: "C_GENERAL",
          message: "You joined this huddle on another device, so it ended here.",
          error: false,
          at: 1,
        },
      }),
    );
    const notice = screen.getByText("You joined this huddle on another device, so it ended here.");
    expect(notice).toBeVisible();
    // Told politely: nothing went wrong.
    expect(notice.closest("[aria-live]")).toHaveAttribute("aria-live", "polite");
  });

  it("says why it could not go on after the connection dropped, as an error", () => {
    const client = show();
    act(() =>
      client.store.setState({
        huddleEnded: {
          channelId: "C_GENERAL",
          message:
            "The huddle ended here after the connection dropped. You no longer have access to this conversation.",
          error: true,
          at: 2,
        },
      }),
    );
    const notice = screen.getByText(/^The huddle ended here after the connection dropped\./);
    expect(notice.closest("[aria-live]")).toHaveAttribute("aria-live", "assertive");
  });
});
