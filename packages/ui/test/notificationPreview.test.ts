import { describe, expect, it } from "vitest";
import { notificationContent, previewAccount, previewFor } from "../src/lib/notificationPreview.js";

/** How much a message notification shows (IMP-03). */
describe("notification previews", () => {
  const message = { from: "Priya Shah", channelName: "design", body: "Launch moves to Friday" };

  it("shows the message, only who sent it, or nothing about it", () => {
    expect(notificationContent("full", message)).toEqual({
      title: "Priya Shah in #design",
      body: "Launch moves to Friday",
    });
    expect(notificationContent("sender", message)).toEqual({
      title: "Priya Shah in #design",
      body: "New message",
    });
    const none = notificationContent("none", message);
    expect(none).toEqual({ title: "New message", body: "Open OwnBase to read it." });
    expect(JSON.stringify(none)).not.toMatch(/Priya|design|Friday/);
  });

  it("leaves out the channel of a direct message", () => {
    expect(notificationContent("sender", { from: "Priya Shah", body: "hi" }).title).toBe(
      "Priya Shah",
    );
  });

  it("keeps a choice per account, whatever trailing slash the address has", () => {
    expect(previewAccount("http://10.0.0.5:8543/", "U1")).toBe(
      previewAccount("http://10.0.0.5:8543", "U1"),
    );
    expect(previewAccount("http://10.0.0.5:8543", "U1")).not.toBe(
      previewAccount("http://10.0.0.5:8543", "U2"),
    );
  });

  it("shows nothing until the choice is read, and when it cannot be", () => {
    const account = previewAccount("http://a:1", "U1");
    expect(previewFor({ loaded: false, unreadable: false, byAccount: {} }, account)).toBe("none");
    expect(previewFor({ loaded: true, unreadable: true, byAccount: {} }, account)).toBe("none");
    expect(previewFor({ loaded: true, unreadable: false, byAccount: {} }, account)).toBe("full");
    expect(
      previewFor({ loaded: true, unreadable: false, byAccount: { [account]: "sender" } }, account),
    ).toBe("sender");
  });
});
