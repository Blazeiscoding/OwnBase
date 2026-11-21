import { describe, expect, it } from "vitest";
import { previewAccount, previewFor } from "../src/lib/notificationPreview.js";

/** How much a message notification shows (IMP-03). */
describe("notification previews", () => {
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
