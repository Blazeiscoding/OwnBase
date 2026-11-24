import {
  notificationContent,
  reminderContent,
  type Message,
  type NotificationPreview,
} from "@ownbase/protocol";
import { isDirect } from "@ownbase/protocol";
import {
  decideNotification,
  decideReminderNotification,
  isMessageRead,
  notificationBody,
  type WorkspaceClient,
} from "@ownbase/client-core";
import type { Platform } from "../platform.js";
import type { Heard } from "../components/MessageAnnouncer.js";
import { CatchUpSummary, namesList } from "./catchUp.js";
import { onScreenElsewhere } from "./focusedView.js";
import type { Navigation } from "./navigation.js";
import { catchUpContent } from "./notificationPreview.js";
import { preloadable } from "./preloadable.js";

// The app's notification sounds, fetched as the workspace opens (K10).
const sounds = preloadable(() => import("./sounds.js"));

export interface NotificationOptions {
  client: WorkspaceClient;
  navigation: Navigation;
  platform: Platform;
  /** How much of a message this account chose to show on this device, read as each arrives. */
  preview: () => NotificationPreview;
  /**
   * This account's tag. Each of its windows tags a message's notification the
   * same way, so the browser shows it once however many windows heard it.
   */
  account: () => string | null;
  /** Reads a message to a screen reader. */
  hear: (heard: Heard) => void;
}

/**
 * The workspace's notifications: a message that is not on screen, judged by
 * this account's choices (client-core's `decideNotification`), a reminder
 * come due, and what a reconnect caught up on, told once as a summary rather
 * than one interruption per missed message (IMP-03). Returns the way to stop.
 */
export function startNotifications(options: NotificationOptions): () => void {
  const { client, navigation, platform } = options;
  const from = (msg: Message) => client.state.users[msg.userId]?.displayName ?? "Someone";
  /** In view here, or in another window of this account that has focus. */
  const onScreen = (msg: Message) =>
    navigation.onScreen(msg) || onScreenElsewhere(msg, options.account());
  // A click opens the message it names, through the same jump that search
  // results, pins and links use.
  const open = (msg: Message) => () =>
    navigation.navigate({ to: "message", channelId: msg.channelId, messageId: msg.id });
  /**
   * Sounds a notification about `msg` as this device chose, and says whether
   * the app did, so the system's own sound stays quiet. Until the sounds have
   * arrived, the system's plays.
   */
  sounds.load().then(
    (loaded) => loaded.readSounds(platform),
    () => {},
  );
  const sound = (msg: Message, id: string): boolean => {
    const loaded = sounds.loaded();
    if (!loaded) {
      sounds.load().catch(() => undefined);
      return false;
    }
    const direct = isDirect(client.state.channels[msg.channelId]?.type);
    return loaded.soundNotification(platform, direct ? "direct" : "message", options.account(), id);
  };

  const tell = (msg: Message) => {
    const state = client.state;
    const { title, body } = notificationContent(options.preview(), {
      from: from(msg),
      channelName: state.channels[msg.channelId]?.name,
      body: notificationBody(state, msg),
    });
    platform.notify(title, body, open(msg), {
      tag: `${options.account()} ${msg.id}`,
      silent: sound(msg, msg.id),
    });
  };

  const catchUp = new CatchUpSummary({
    // Read elsewhere, muted, left or now in view since: not news any more.
    stillNews: (msg) =>
      !onScreen(msg) &&
      !isMessageRead(msg, client.state) &&
      decideNotification(client.state, msg, { live: false }).notify,
    show: (messages) => {
      const first = messages[0]!;
      if (messages.length === 1) return tell(first);
      const state = client.state;
      const conversations = new Set(messages.map((msg) => msg.channelId));
      const senders = [...new Set(messages.map(from))];
      const { title, body } = catchUpContent(options.preview(), {
        count: messages.length,
        conversations: conversations.size,
        channelName: state.channels[first.channelId]?.name,
        senders: namesList(senders),
      });
      // A click opens the earliest, where reading them starts. The tag is the
      // same in every window that caught up on the same messages.
      platform.notify(title, body, open(first), {
        tag: `${options.account()} catch-up ${first.id}`,
        silent: sound(first, `catch-up ${first.id}`),
      });
    },
  });

  const stops = [
    client.on("messageDeleted", (id) => catchUp.drop(id)),
    client.on("message", (msg, { live }) => {
      const state = client.state;
      const s = navigation.state;
      const openThread = s.panel.kind === "thread" ? s.panel.rootId : null;
      // Read to a screen reader what reaches the conversation on screen, but
      // not what a reconnect catches up on: that is history, not news.
      const inChannel = msg.channelId === s.channelId && (!msg.threadRootId || msg.broadcast);
      const inThread = msg.threadRootId !== null && msg.threadRootId === openThread;
      if (live && (inChannel || inThread))
        options.hear({ from: from(msg), text: notificationBody(state, msg), inThread: !inChannel });
      // A message you're already looking at needs no notification. One in a
      // thread that is not open is not in view just because its channel is.
      if (onScreen(msg)) return;
      if (!decideNotification(state, msg, { live }).notify) return;
      if (live) tell(msg);
      else catchUp.hold(msg);
    }),
    // A reminder come due says so wherever the person is looking: they asked.
    client.on("reminderDue", (reminder, message) => {
      const state = client.state;
      if (!decideReminderNotification(state).notify) return;
      const { title, body } = reminderContent(options.preview(), {
        from: from(message),
        channelName: state.channels[message.channelId]?.name,
        body: notificationBody(state, message),
      });
      platform.notify(title, body, open(message), {
        tag: `${options.account()} reminder ${reminder.id}`,
        silent: sound(message, `reminder ${reminder.id}`),
      });
    }),
    // Someone coming into or leaving the call this window is in.
    client.store.subscribe((state, before) => {
      const now = state.huddle;
      const was = before.huddle;
      if (!now || !was || now.channelId !== was.channelId || now.peers === was.peers) return;
      const ids = (peers: typeof now.peers) => new Set(peers.map((peer) => peer.userId));
      const [present, earlier] = [ids(now.peers), ids(was.peers)];
      const change = [...present].some((id) => !earlier.has(id))
        ? "join"
        : [...earlier].some((id) => !present.has(id))
          ? "leave"
          : null;
      if (change)
        void sounds.load().then(
          (loaded) => loaded.soundCall(platform, change),
          () => {},
        );
    }),
  ];
  return () => {
    catchUp.dispose();
    for (const stop of stops) stop();
  };
}
