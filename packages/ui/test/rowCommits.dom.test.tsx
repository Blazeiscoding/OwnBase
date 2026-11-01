import { Profiler, type ProfilerOnRenderCallback } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { WorkspaceClient, type WorkspaceState } from "@ownbase/client-core";
import type { Channel, ID, Message, User } from "@ownbase/protocol";
import { describe, expect, it } from "vitest";
import { ClientContext } from "../src/context.js";
import { MessageItem } from "../src/components/MessageItem.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";

/**
 * Which message rows render again when the replica changes (OPT-05). Each row
 * sits in its own Profiler, so a commit names exactly the rows that rendered.
 * A change nothing on screen shows should render no row; a change a row shows
 * must still render that row, and only the rows that show it.
 */
const ROWS = 30;

const person = (id: string, displayName: string, role: User["role"] = "member"): User => ({
  id,
  handle: id.toLowerCase(),
  displayName,
  role,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});

const channel = (id: string, name: string): Channel => ({
  id,
  type: "public",
  name,
  topic: "",
  description: "",
  creatorId: "U0",
  archived: false,
  createdAt: 0,
  memberIds: ["U0"],
});

/**
 * Thirty messages from five authors. Every seventh names U6, every eleventh
 * links #design, and every thirteenth carries a reaction from U7.
 */
function messages(): Message[] {
  return Array.from({ length: ROWS }, (_, i) => {
    const words = [`message ${i}`];
    if (i % 7 === 0) words.push("<@U6>");
    if (i % 11 === 0) words.push("<#C_DESIGN>");
    return {
      id: `M${String(i).padStart(3, "0")}`,
      channelId: "C_GENERAL",
      userId: `U${(i % 5) + 1}`,
      text: words.join(" "),
      threadRootId: null,
      broadcast: false,
      seq: i + 1,
      createdAt: i * 60_000,
      editedAt: null,
      nonce: null,
      replyCount: 0,
      reactions: i % 13 === 0 ? [{ emoji: "👍", userIds: ["U7"] }] : [],
      files: [],
      pinned: false,
      actions: [],
    };
  });
}

function timeline() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  const users: Record<ID, User> = {};
  for (let i = 0; i < 40; i++) users[`U${i}`] = person(`U${i}`, `Person ${i}`);
  client.store.setState({
    self: users.U0!,
    users,
    channels: {
      C_GENERAL: channel("C_GENERAL", "general"),
      C_DESIGN: channel("C_DESIGN", "design"),
      C_OTHER: channel("C_OTHER", "other"),
    },
    status: "online",
  });
  const rendered = new Set<string>();
  const onRender: ProfilerOnRenderCallback = (id) => void rendered.add(id);
  const all = messages();
  render(
    <ToastProvider>
      <ConfirmProvider>
        <ClientContext.Provider value={client}>
          {all.map((message) => (
            <Profiler key={message.id} id={message.id} onRender={onRender}>
              <MessageItem message={message} compact={false} />
            </Profiler>
          ))}
        </ClientContext.Provider>
      </ConfirmProvider>
    </ToastProvider>,
  );
  expect(rendered.size).toBe(ROWS);
  /** The rows that render for one change to the replica. */
  const renderedBy = (change: (s: WorkspaceState) => Partial<WorkspaceState>) => {
    rendered.clear();
    act(() => client.store.setState(change));
    return [...rendered].sort();
  };
  const ids = (keep: (i: number) => boolean) => all.filter((_, i) => keep(i)).map((m) => m.id);
  return { client, renderedBy, ids };
}

const renamed = (s: WorkspaceState, id: ID, displayName: string) => ({
  users: { ...s.users, [id]: { ...s.users[id]!, displayName } },
});

describe("message rows and changes they do not show", () => {
  it("render no row when someone no row shows changes their profile", () => {
    const { renderedBy } = timeline();
    expect(renderedBy((s) => renamed(s, "U30", "Someone Else"))).toEqual([]);
  });

  it("render no row when someone joins another channel", () => {
    const { renderedBy } = timeline();
    expect(
      renderedBy((s) => ({
        channels: { ...s.channels, C_OTHER: { ...s.channels.C_OTHER!, memberIds: ["U0", "U9"] } },
      })),
    ).toEqual([]);
  });

  it("render no row when you set a status", () => {
    const { renderedBy } = timeline();
    expect(renderedBy((s) => ({ self: { ...s.self!, statusText: "In a meeting" } }))).toEqual([]);
  });

  it("render only the row saved", () => {
    const { renderedBy } = timeline();
    expect(renderedBy((s) => ({ saved: { ...s.saved, M005: true } }))).toEqual(["M005"]);
  });
});

describe("message rows and changes they do show", () => {
  it("render every row by an author who is renamed, and show the new name", () => {
    const { renderedBy, ids } = timeline();
    // U1 writes rows 0, 5, 10, …
    expect(renderedBy((s) => renamed(s, "U1", "Priya Shah"))).toEqual(ids((i) => i % 5 === 0));
    expect(screen.getAllByRole("button", { name: "Priya Shah" })).toHaveLength(ROWS / 5);
  });

  it("render every row that names someone who is renamed, and show the new name", () => {
    const { renderedBy, ids } = timeline();
    expect(renderedBy((s) => renamed(s, "U6", "Sam Rivera"))).toEqual(ids((i) => i % 7 === 0));
    expect(screen.getAllByText("@Sam Rivera")).toHaveLength(Math.ceil(ROWS / 7));
  });

  it("render every row a renamed reactor reacted on, with the new name in the reaction", () => {
    const { renderedBy, ids } = timeline();
    expect(renderedBy((s) => renamed(s, "U7", "Ana Ruiz"))).toEqual(ids((i) => i % 13 === 0));
    expect(screen.getAllByRole("button", { name: /from Ana Ruiz$/ })).toHaveLength(
      Math.ceil(ROWS / 13),
    );
  });

  it("render every row that links a renamed channel, and show the new name", () => {
    const { renderedBy, ids } = timeline();
    expect(
      renderedBy((s) => ({
        channels: { ...s.channels, C_DESIGN: { ...s.channels.C_DESIGN!, name: "product" } },
      })),
    ).toEqual(ids((i) => i % 11 === 0));
    expect(screen.getAllByText("#product")).toHaveLength(Math.ceil(ROWS / 11));
  });

  it("render every row when your role changes, since it decides who may delete", async () => {
    const { renderedBy } = timeline();
    // Delete sits in each row's More actions menu; what a row offers there is
    // decided when the row renders.
    const offersDelete = async () => {
      const triggers = screen.getAllByRole("button", { name: "More actions" });
      expect(triggers).toHaveLength(ROWS);
      fireEvent.click(triggers.at(-1)!);
      const menu = await screen.findByRole("menu", { name: "More actions" });
      const offered = within(menu)
        .getAllByRole("menuitem")
        .some((item) => item.textContent?.startsWith("Delete message"));
      fireEvent.keyDown(menu, { key: "Escape" });
      fireEvent.click(document.body);
      return offered;
    };
    expect(await offersDelete()).toBe(false);
    expect(renderedBy((s) => ({ self: { ...s.self!, role: "admin" } }))).toHaveLength(ROWS);
    // An admin may delete anyone's message, so every row offers it now.
    expect(await offersDelete()).toBe(true);
  });
});
