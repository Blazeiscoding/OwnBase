import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { User } from "@ownbase/protocol";
import { CallAnnouncer, LEAVE_GRACE_MS } from "../src/components/CallAnnouncer.js";

const person = (id: string, displayName: string) => ({ id, displayName }) as User;
const users = { U_MAYA: person("U_MAYA", "Maya Chen"), U_LEE: person("U_LEE", "Lee Park") };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("who joins and leaves a huddle, for a screen reader", () => {
  it("says who joins and, after a moment, who leaves; not who was there already", () => {
    vi.useFakeTimers();
    const { rerender } = render(<CallAnnouncer peerIds={["U_MAYA"]} users={users} />);
    const log = screen.getByRole("log", { name: "Huddle arrivals" });
    // On the body, outside the workspace a dialog makes inert.
    expect(log.parentElement).toBe(document.body);
    expect(log).toBeEmptyDOMElement();

    rerender(<CallAnnouncer peerIds={["U_MAYA", "U_LEE"]} users={users} />);
    expect(log).toHaveTextContent("Lee Park joined the huddle.");

    rerender(<CallAnnouncer peerIds={["U_LEE"]} users={users} />);
    expect(log).not.toHaveTextContent("left");
    act(() => vi.advanceTimersByTime(LEAVE_GRACE_MS));
    expect(log).toHaveTextContent("Maya Chen left the huddle.");
  });

  it("says nothing for a connection made again within the moment", () => {
    vi.useFakeTimers();
    const { rerender } = render(<CallAnnouncer peerIds={["U_MAYA"]} users={users} />);
    const log = screen.getByRole("log", { name: "Huddle arrivals" });
    rerender(<CallAnnouncer peerIds={[]} users={users} />);
    rerender(<CallAnnouncer peerIds={["U_MAYA"]} users={users} />);
    act(() => vi.advanceTimersByTime(LEAVE_GRACE_MS * 2));
    expect(log).toBeEmptyDOMElement();
  });
});
