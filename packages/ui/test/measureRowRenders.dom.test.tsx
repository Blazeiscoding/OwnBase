import { version as reactVersion } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { WorkspaceClient, type WorkspaceState } from "@ownbase/client-core";
import type { Channel, ID, Message, User } from "@ownbase/protocol";
import { it } from "vitest";
import { ClientContext } from "../src/context.js";
import { MessageItem } from "../src/components/MessageItem.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";

/**
 * OPT-05's measurement: how long 300 message rows (the timeline's cap) take to
 * settle after one change to the replica. Skipped unless asked for, and meant
 * for React's production build, where `act` does not exist:
 *
 *   MEASURE_ROWS=1 NODE_ENV=production pnpm --filter @ownbase/ui exec vitest run test/measureRowRenders.dom.test.tsx
 *
 * jsdom does no layout or paint, so this compares React's work only.
 */
const ROWS = 300;
const SAMPLES = 40;

const person = (id: string): User => ({
  id,
  handle: id.toLowerCase(),
  displayName: `Person ${id}`,
  role: "member",
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

const message = (i: number): Message => ({
  id: `M${String(i).padStart(3, "0")}`,
  channelId: "C_GENERAL",
  userId: `U${(i % 5) + 1}`,
  text: `message ${i}${i % 7 === 0 ? " <@U6>" : ""}${i % 11 === 0 ? " <#C_DESIGN>" : ""}`,
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
});

const changes: [string, (s: WorkspaceState) => Partial<WorkspaceState>][] = [
  [
    "profile of someone no row shows",
    (s) => ({ users: { ...s.users, U30: { ...s.users.U30!, displayName: `${Math.random()}` } } }),
  ],
  [
    "someone joins another channel",
    (s) => ({
      channels: {
        ...s.channels,
        C_OTHER: { ...s.channels.C_OTHER!, memberIds: ["U0", `${Math.random()}`] },
      },
    }),
  ],
  ["your own status", (s) => ({ self: { ...s.self!, statusText: `${Math.random()}` } })],
  ["someone typing", () => ({ typing: { C_GENERAL: { U3: Date.now() + Math.random() } } })],
  [
    "save one message",
    (s) => ({ saved: s.saved.M005 ? ({} as Record<ID, true>) : { M005: true } }),
  ],
  [
    "rename the author of 60 rows",
    (s) => ({ users: { ...s.users, U1: { ...s.users.U1!, displayName: `${Math.random()}` } } }),
  ],
];

it.skipIf(!process.env.MEASURE_ROWS)("measures row renders per replica change", () => {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  const users: Record<ID, User> = {};
  for (let i = 0; i < 40; i++) users[`U${i}`] = person(`U${i}`);
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
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      <ToastProvider>
        <ConfirmProvider>
          <ClientContext.Provider value={client}>
            {Array.from({ length: ROWS }, (_, i) => (
              <MessageItem key={i} message={message(i)} compact={false} />
            ))}
          </ClientContext.Provider>
        </ConfirmProvider>
      </ToastProvider>,
    ),
  );
  const results = changes.map(([change, apply]) => {
    const samples: number[] = [];
    for (let i = 0; i < SAMPLES + 3; i++) {
      const started = performance.now();
      flushSync(() => client.store.setState(apply));
      if (i >= 3) samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const at = (q: number) => Number(samples[Math.floor(q * (SAMPLES - 1))]!.toFixed(2));
    return { change, p50: at(0.5), p95: at(0.95) };
  });
  console.log(
    JSON.stringify(
      {
        rows: ROWS,
        samples: SAMPLES,
        react: reactVersion,
        build: process.env.NODE_ENV,
        node: process.version,
        results,
      },
      null,
      2,
    ),
  );
  root.unmount();
});
