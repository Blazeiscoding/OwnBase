import type { ChannelPrefs, ID, SidebarSection } from "@ownbase/protocol";
import type { WorkspaceClient } from "@ownbase/client-core";
import { failureText } from "./failure.js";
import type { MenuItem } from "../components/Menu.js";
import type { ToastRequest } from "../components/Toast.js";

/** A conversation as its menus name it: a channel, or a conversation with people. */
export interface Conversation {
  id: ID;
  noun: "channel" | "conversation";
}

type Toast = (request: ToastRequest) => () => void;

/**
 * Saves one of this account's choices for a conversation. The choice shows
 * at once; a refusal puts back what the workspace has. The row or menu that
 * made it may be gone by then, a starred row having moved, so a notice
 * carries the news and the second attempt, as a refused pin's does.
 */
function choose(
  client: WorkspaceClient,
  toast: Toast,
  id: ID,
  patch: Partial<ChannelPrefs>,
  failure: string,
) {
  void client.setChannelPrefs(id, patch).then((error) => {
    if (error)
      toast({
        message: failureText(failure, error),
        action: { label: "Try again", run: () => choose(client, toast, id, patch, failure) },
      });
  });
}

/**
 * Star or Unstar, named by what choosing it does now, as Mute and Unmute are
 * (UX-20). Offer it only where a star is kept: a conversation this account is
 * in.
 */
export function starItem(
  client: WorkspaceClient,
  toast: Toast,
  conversation: Conversation,
  starred: boolean,
): MenuItem {
  const { id, noun } = conversation;
  return {
    id: "star",
    label: `${starred ? "Unstar" : "Star"} ${noun}`,
    icon: "star",
    onSelect: () =>
      choose(
        client,
        toast,
        id,
        { starred: !starred },
        `Could not ${starred ? "unstar" : "star"} that ${noun}.`,
      ),
  };
}

/**
 * Moves a conversation into one of this account's sidebar sections, or with
 * null back where it would be: out of Starred too, as one place each (E8).
 */
export function moveConversation(
  client: WorkspaceClient,
  toast: Toast,
  conversation: Conversation,
  sectionId: ID | null,
) {
  choose(
    client,
    toast,
    conversation.id,
    { sectionId, starred: false },
    `Could not move that ${conversation.noun}.`,
  );
}

/**
 * The "Move to" group of a conversation's menu (E8): each other section, a
 * new one, and out of the one it is in. `onMoved` is told where it goes.
 */
export function moveItems(
  client: WorkspaceClient,
  toast: Toast,
  conversation: Conversation,
  sections: SidebarSection[],
  current: ID | null,
  onNew: () => void,
  onMoved: (sectionId: ID | null) => void,
): MenuItem[] {
  const move = (sectionId: ID | null) => () => {
    onMoved(sectionId);
    moveConversation(client, toast, conversation, sectionId);
  };
  const into = sections.filter((section) => section.id !== current);
  const items: MenuItem[] = into.map((section) => ({
    id: `move:${section.id}`,
    label: section.name,
    ariaLabel: `Move to ${section.name}`,
    icon: "arrow",
    onSelect: move(section.id),
  }));
  items.push({ id: "move:new", label: "New section…", icon: "plus", onSelect: onNew });
  const from = sections.find((section) => section.id === current);
  if (from)
    items.push({
      id: "move:out",
      label: `Remove from ${from.name}`,
      icon: "close",
      onSelect: move(null),
    });
  items[0] = { ...items[0]!, section: "Move to" };
  return items;
}

/**
 * Whether this account closed a direct conversation (`ChannelPrefs.hiddenSeq`)
 * and nothing has been said in it since.
 */
export function isClosed(prefs: ChannelPrefs | undefined, lastSeq: number | undefined): boolean {
  const at = prefs?.hiddenSeq;
  return at !== null && at !== undefined && (lastSeq ?? 0) <= at;
}

/**
 * Close a direct conversation: out of the sidebar until someone writes in it,
 * or it is opened again, as Slack's does.
 */
export function closeItem(
  client: WorkspaceClient,
  toast: Toast,
  id: ID,
  lastSeq: number,
  name: string,
): MenuItem {
  return {
    id: "close",
    label: "Close conversation",
    icon: "close",
    onSelect: () => {
      choose(client, toast, id, { hiddenSeq: lastSeq }, "Could not close that conversation.");
      toast({
        message: `Closed your conversation with ${name}. It comes back when someone writes.`,
        kind: "success",
        action: {
          label: "Undo",
          run: () =>
            choose(
              client,
              toast,
              id,
              { hiddenSeq: null },
              "Could not bring that conversation back.",
            ),
        },
      });
    },
  };
}

/**
 * Mutes or unmutes a conversation, from its row's menu or its details. A
 * refusal says so, in the workspace's words, with a way to try again.
 */
export function setMuted(
  client: WorkspaceClient,
  toast: Toast,
  conversation: Conversation,
  muted: boolean,
): void {
  const { id, noun } = conversation;
  choose(client, toast, id, { muted }, `Could not ${muted ? "mute" : "unmute"} that ${noun}.`);
}

/** Mute or Unmute, named by what choosing it does now. */
export function muteItem(
  client: WorkspaceClient,
  toast: Toast,
  conversation: Conversation,
  muted: boolean,
): MenuItem {
  return {
    id: "mute",
    label: `${muted ? "Unmute" : "Mute"} ${conversation.noun}`,
    icon: muted ? "bell" : "bellOff",
    onSelect: () => setMuted(client, toast, conversation, !muted),
  };
}
