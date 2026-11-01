import { describe, expect, it } from "vitest";
import { neighbourConversation } from "../src/lib/conversationKeys.js";
import { unreadSummary } from "../src/lib/readAll.js";

/** A sidebar with rows in the order drawn; `*` marks one with something unread. */
function sidebar(...rows: string[]) {
  const nav = document.createElement("nav");
  nav.className = "workspace-sidebar";
  for (const row of rows) {
    const li = document.createElement("li");
    li.dataset.conversation = row.replace("*", "");
    if (row.endsWith("*")) li.dataset.unread = "true";
    nav.append(li);
  }
  const root = document.createElement("div");
  root.append(nav);
  return root;
}

describe("Alt+Up and Alt+Down", () => {
  const root = sidebar("C_STAR", "C_DESIGN*", "C_GENERAL", "C_RANDOM", "D_SAM*");

  it("walk the sidebar in the order it is drawn, stopping at either end", () => {
    expect(neighbourConversation("C_GENERAL", 1, false, root)).toBe("C_RANDOM");
    expect(neighbourConversation("C_GENERAL", -1, false, root)).toBe("C_DESIGN");
    expect(neighbourConversation("D_SAM", 1, false, root)).toBeNull();
    expect(neighbourConversation("C_STAR", -1, false, root)).toBeNull();
  });

  it("with Shift, go only to what is unread", () => {
    expect(neighbourConversation("C_GENERAL", 1, true, root)).toBe("D_SAM");
    expect(neighbourConversation("C_GENERAL", -1, true, root)).toBe("C_DESIGN");
    expect(neighbourConversation("D_SAM", 1, true, root)).toBeNull();
  });

  it("start from an end when nothing listed is open", () => {
    expect(neighbourConversation(null, 1, false, root)).toBe("C_STAR");
    expect(neighbourConversation("C_GONE", -1, true, root)).toBe("D_SAM");
  });
});

describe("what Mark all read says", () => {
  it("counts conversations and threads in words", () => {
    expect(unreadSummary(1, 0)).toBe("1 conversation");
    expect(unreadSummary(3, 1)).toBe("3 conversations and 1 thread");
    expect(unreadSummary(0, 2)).toBe("2 threads");
  });
});
