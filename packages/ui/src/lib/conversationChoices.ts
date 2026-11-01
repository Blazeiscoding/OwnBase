import type { ChannelPrefs, ID, SidebarSection } from "@ownbase/protocol";
import type { WorkspaceClient, WorkspaceState } from "@ownbase/client-core";
import type { MenuItem } from "../components/Menu.js";
import type { ToastRequest } from "../components/Toast.js";

/** A conversation as its menus name it: a channel, or a conversation with people. */
export interface Conversation {
  id: ID;
  noun: "channel" | "conversation";
}

type Toast = ((request: ToastRequest) => () => void) | null;

/**
 * Saves one of this account's choices for a conversation, and settles true
 * once the workspace has it, or false once it refused. The choice shows at
 * once either way; a refusal puts back what the workspace has.
 */
function saved(client: WorkspaceClient, id: ID, patch: Partial<ChannelPrefs>): Promise<boolean> {
  client.setChannelPrefs(id, patch);
  const keys = Object.keys(patch);
  return new Promise((resolve) => {
    const settled = (s: WorkspaceState) => {
      const write = s.prefsWrites[id];
      if (write?.saving) return false;
      resolve(!write?.failed || !keys.some((key) => key in write.failed!));
      return true;
    };
    if (settled(client.state)) return;
    const stop = client.store.subscribe((s) => {
      if (settled(s)) stop();
    });
  });
}

/**
 * The row or menu that made a choice may be gone by the time a refusal
 * arrives, a starred row having moved, so a notice carries the news and the
 * second attempt, as a refused pin's does.
 */
function choose(
  client: WorkspaceClient,
  toast: Toast,
  id: ID,
  patch: Partial<ChannelPrefs>,
  failure: string,
) {
  void saved(client, id, patch).then((ok) => {
    if (!ok && toast)
      toast({
        message: failure,
        action: { label: "Try again", run: () => choose(client, toast, id, patch, failure) },
      });
  });
}

/**
 * Star or Unstar, named by what choosing it does now, as Mute and Unmute are
 * (UX-20). Offer it only where a star is kept: a conversation this account is
 * in, on a server that keeps stars (`WorkspaceState.stars`).
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
 * or it is opened again, as Slack's does. Offer it only where the server
 * keeps it, which says so by sending `hiddenSeq` at all.
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
      toast?.({
        message: `Closed your conversation with ${name}. It comes back when someone writes.`,
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

/** Mute or Unmute, which every server keeps. */
export function muteItem(
  client: WorkspaceClient,
  toast: Toast,
  conversation: Conversation,
  muted: boolean,
): MenuItem {
  const { id, noun } = conversation;
  return {
    id: "mute",
    label: `${muted ? "Unmute" : "Mute"} ${noun}`,
    icon: muted ? "bell" : "bellOff",
    onSelect: () =>
      choose(
        client,
        toast,
        id,
        { muted: !muted },
        `Could not ${muted ? "unmute" : "mute"} that ${noun}.`,
      ),
  };
}
