import { describe, expect, it } from "vitest";
import {
  desktopLink,
  isPageId,
  pageHash,
  pageLink,
  readConversationHash,
  readPageHash,
  type PageLink,
} from "../src/pageLinks.js";

describe("page links", () => {
  const links: [PageLink, string][] = [
    [{ kind: "join", code: "ABCD1234" }, "#/join/ABCD1234"],
    [{ kind: "claim", code: "c-l_aim" }, "#/claim/c-l_aim"],
    [{ kind: "sso", code: "code1" }, "#/sso/code1"],
    [{ kind: "reset", token: "t1" }, "#/reset/t1"],
    [{ kind: "verifyEmail", token: "t2" }, "#/verify-email/t2"],
    [{ kind: "message", channelId: "C1", messageId: "M1" }, "#/c/C1/m/M1"],
  ];

  it.each(links)("writes %o as %s and reads it back", (link, hash) => {
    expect(pageHash(link)).toBe(hash);
    expect(pageLink("https://chat.example", link)).toBe(`https://chat.example/${hash}`);
    expect(readPageHash(hash)).toEqual(link);
  });

  it("reads nothing it did not write", () => {
    for (const hash of [
      "",
      "#/",
      "#/join",
      "#/join/a/b",
      "#/join/a%2Fb",
      `#/join/${"a".repeat(65)}`,
      "#/c/C1",
      "#/c/C1/t/M1",
      "#/c/C1/m/",
      "#/leave/abc",
    ])
      expect(readPageHash(hash)).toBeNull();
  });

  it("reads a conversation's address and leaves the rest to the client", () => {
    expect(readConversationHash("#/c/C1/t/M1")).toEqual({ channelId: "C1", rest: ["t", "M1"] });
    expect(readConversationHash("#/c/C1")).toEqual({ channelId: "C1", rest: [] });
    expect(readConversationHash("#/c/../x")).toBeNull();
    expect(readConversationHash("#/join/C1")).toBeNull();
  });

  it("takes ids of letters, digits, - and _ only", () => {
    expect(isPageId("aZ09-_")).toBe(true);
    for (const bad of ["", "a b", "a/b", "a.b", 7, null, "a".repeat(65)])
      expect(isPageId(bad)).toBe(false);
  });

  it("writes the desktop form with the server's address left readable", () => {
    expect(desktopLink("https://chat.team.dev", { kind: "sso", code: "abc" })).toBe(
      "ownbase://sso?host=https://chat.team.dev&code=abc",
    );
    expect(
      desktopLink("192.168.1.5:8543", { kind: "message", channelId: "C1", messageId: "M1" }),
    ).toBe("ownbase://message?host=192.168.1.5:8543&channel=C1&id=M1");
  });
});
