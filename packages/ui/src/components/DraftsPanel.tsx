import { useMemo } from "react";
import { readableText } from "@ownbase/client-core";
import { useClient, useWorkspace } from "../context.js";
import { listDrafts, type DraftEntry, type DraftPlace } from "../lib/drafts.js";
import { channelTitle, formatFull, formatWhen } from "../lib/format.js";
import { usePanelFocus } from "../lib/usePanelFocus.js";
import { dropRepeatClick } from "../lib/repeatClick.js";
import { Icon } from "./Icon.js";
import { ListStatus } from "./ListStatus.js";
import { PanelLink } from "./MessageListPanel.js";
import { Tooltip } from "./Tooltip.js";
import { useToast } from "./Toast.js";

/**
 * Every draft this device keeps for the account (E5): a conversation's or a
 * thread's words not yet sent, and edits not yet saved, the newest first. A
 * row opens the draft where it was being written; Delete takes it away, with
 * Undo. The drafts live on this device, so the list is the same in every
 * window here and different on another device.
 */
export function DraftsPanel(props: {
  onClose: () => void;
  onOpen: (place: DraftPlace) => void;
  /** Its neighbour: messages queued to send later. */
  onScheduled?: () => void;
}) {
  const client = useClient();
  const toast = useToast();
  const { panel, heading } = usePanelFocus({ takeFocus: true });
  const drafts = useWorkspace((s) => s.drafts);
  const times = useWorkspace((s) => s.draftTimes);
  const channels = useWorkspace((s) => s.channels);
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const entries = useMemo(() => listDrafts(drafts, times, channels), [drafts, times, channels]);

  function remove(entry: DraftEntry) {
    const kept = client.state.drafts[entry.key];
    if (kept === undefined) return;
    client.setDraft(entry.key, "");
    toast({
      message: "Draft deleted.",
      kind: "success",
      action: {
        label: "Undo",
        // Back as it was, in its place in the list, unless written there since.
        run: () => {
          if (client.state.drafts[entry.key] === undefined)
            client.setDraft(entry.key, kept, entry.at);
        },
      },
    });
  }

  return (
    <aside
      ref={panel}
      aria-label="Drafts"
      className="flex w-[380px] max-w-full shrink-0 flex-col border-l border-edge"
    >
      <header className="flex h-12 shrink-0 items-center gap-1 pl-4 pr-2 shadow-[0_1px_0_var(--color-edge)]">
        <h2 ref={heading} tabIndex={-1} className="flex-1 text-[15px] font-semibold outline-none">
          Drafts
        </h2>
        {props.onScheduled && (
          <PanelLink icon="clock" label="Scheduled" onClick={props.onScheduled} />
        )}
        <button
          onClick={props.onClose}
          aria-label="Close drafts"
          className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <ListStatus
          // Drafts are on this device already: nothing to load.
          loadingLabel="Loading drafts…"
          empty={
            entries.length === 0
              ? "No drafts. Anything you start writing and leave unsent shows up here."
              : null
          }
          emptyIcon="edit"
        />
        {entries.length > 0 && (
          <ul aria-label="Drafts on this device" className="space-y-px">
            {entries.map((entry) => {
              const channel = channels[entry.place.channelId]!;
              const name =
                channel.type === "public" || channel.type === "private"
                  ? `#${channel.name}`
                  : channelTitle(channel, users, selfId);
              return (
                <DraftRow
                  key={entry.key}
                  where={whereLabel(entry.place, name)}
                  at={entry.at}
                  text={readableText(client.state, entry.text)}
                  onOpen={() => props.onOpen(entry.place)}
                  onDelete={() => remove(entry)}
                />
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

function whereLabel(place: DraftPlace, name: string): string {
  switch (place.kind) {
    case "conversation":
      return name;
    case "thread":
      return `Thread in ${name}`;
    case "edit":
      return `Editing a message in ${name}`;
    case "scheduled-edit":
      return `Editing a scheduled message in ${name}`;
  }
}

/**
 * One draft: where it is, when it last changed, and the start of its words.
 * Delete shows on hover or focus, and stays in sight where there is no hover,
 * as Activity's row actions do.
 */
function DraftRow(props: {
  where: string;
  at: number | undefined;
  text: string;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="group/row relative" onClickCapture={dropRepeatClick}>
      <button
        type="button"
        onClick={props.onOpen}
        className="flex w-full flex-col gap-0.5 rounded-lg py-2 pl-3 pr-2 text-left transition-colors hover:bg-ink/[0.035] focus-visible:bg-ink/[0.035] [@media(hover:none)]:pr-11"
      >
        <span className="flex w-full items-baseline gap-1.5 text-[13px]">
          <span className="truncate font-semibold">{props.where}</span>
          {props.at !== undefined && (
            <time
              dateTime={new Date(props.at).toISOString()}
              title={formatFull(props.at)}
              className="ml-auto shrink-0 text-[12px] text-ink-faint"
            >
              {formatWhen(props.at)}
            </time>
          )}
        </span>
        <span className="line-clamp-2 whitespace-pre-line text-[13px] text-ink-dim">
          {props.text}
        </span>
      </button>
      <span className="absolute right-1.5 top-1 flex rounded-lg bg-raised p-0.5 opacity-0 shadow-[0_1px_3px_rgb(0_0_0/0.18)] transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:top-2 [@media(hover:none)]:opacity-100">
        <Tooltip label="Delete draft">
          <button
            type="button"
            aria-label="Delete draft"
            className="flex size-7 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-alert"
            onClick={props.onDelete}
          >
            <Icon name="trash" size={14} />
          </button>
        </Tooltip>
      </span>
    </li>
  );
}
