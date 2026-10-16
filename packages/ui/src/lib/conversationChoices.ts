import type { ChannelPrefs, ID } from "@slackoss/protocol";
import type { WorkspaceClient, WorkspaceState } from "@slackoss/client-core";
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
