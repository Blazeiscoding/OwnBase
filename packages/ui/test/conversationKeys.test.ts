import { describe, expect, it } from "vitest";
import type { Channel, User } from "@ownbase/protocol";
import { WorkspaceClient } from "@ownbase/client-core";
import { neighbourConversation, sidebarRows } from "../src/lib/sidebarLayout.js";
import { unreadSummary } from "../src/lib/readAll.js";

const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam",
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};
const maya: User = { ...sam, id: "U_MAYA", handle: "maya", displayName: "Maya" };

const room = (id: string, name: string): Channel => ({
  id,
  name,
  type: "public",
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
});

/**
 * A sidebar of Starred (#star), Channels (#design, #general, #random) and
 * Direct messages (Maya): #design and Maya have something unread.
 */
function workspace() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { U_SAM: sam, U_MAYA: maya },
    channels: {
      C_STAR: room("C_STAR", "star"),
      C_DESIGN: room("C_DESIGN", "design"),
      C_GENERAL: room("C_GENERAL", "general"),
      C_RANDOM: room("C_RANDOM", "random"),
      D_MAYA: { ...room("D_MAYA", ""), type: "dm", memberIds: ["U_SAM", "U_MAYA"] },
    },
    memberships: { C_STAR: 0, C_DESIGN: 0, C_GENERAL: 0, C_RANDOM: 0, D_MAYA: 0 },
    channelLastSeq: { C_DESIGN: 3, D_MAYA: 2 },
    prefs: {
      C_STAR: {
        notifyLevel: "all",
        notifyChosen: false,
        muted: false,
        starred: true,
        sectionId: null,
        hiddenSeq: null,
      },
    },
  });
  return client.state;
}

describe("Alt+Up and Alt+Down", () => {
  const s = workspace();
  const none = new Set<string>();

  it("walk the sidebar in the order it is drawn, stopping at either end", () => {
    expect(sidebarRows(s, none, null)).toEqual([
      "C_STAR",
      "C_DESIGN",
      "C_GENERAL",
      "C_RANDOM",
      "D_MAYA",
    ]);
    expect(neighbourConversation(s, none, "C_GENERAL", 1, false)).toBe("C_RANDOM");
    expect(neighbourConversation(s, none, "C_GENERAL", -1, false)).toBe("C_DESIGN");
    expect(neighbourConversation(s, none, "D_MAYA", 1, false)).toBeNull();
    expect(neighbourConversation(s, none, "C_STAR", -1, false)).toBeNull();
  });

  it("with Shift, go only to what is unread", () => {
    expect(neighbourConversation(s, none, "C_GENERAL", 1, true)).toBe("D_MAYA");
    expect(neighbourConversation(s, none, "C_GENERAL", -1, true)).toBe("C_DESIGN");
    expect(neighbourConversation(s, none, "D_MAYA", 1, true)).toBeNull();
  });

  it("start from an end when nothing listed is open", () => {
    expect(neighbourConversation(s, none, null, 1, false)).toBe("C_STAR");
    expect(neighbourConversation(s, none, "C_GONE", -1, true)).toBe("D_MAYA");
  });

  it("skip what a folded section hides, but not what waits in it or is open", () => {
    const folded = new Set(["channels"]);
    expect(sidebarRows(s, folded, "C_RANDOM")).toEqual([
      "C_STAR",
      "C_DESIGN",
      "C_RANDOM",
      "D_MAYA",
    ]);
    expect(neighbourConversation(s, folded, "C_STAR", 1, false)).toBe("C_DESIGN");
  });
});

describe("what Mark all read says", () => {
  const unread = (channels: number, threads: number, removals = 0) => ({
    channels: Array.from({ length: channels }, (_, i) => `C${i}`),
    threads: Array.from({ length: threads }, () => ({}) as never),
    removals: Array.from({ length: removals }, (_, i) => `R${i}`),
  });

  it("counts conversations, threads and removal notes in words", () => {
    expect(unreadSummary(unread(1, 0))).toBe("1 conversation");
    expect(unreadSummary(unread(3, 1))).toBe("3 conversations and 1 thread");
    expect(unreadSummary(unread(0, 2))).toBe("2 threads");
    expect(unreadSummary(unread(2, 1, 1))).toBe("2 conversations, 1 thread and 1 removal note");
  });
});
