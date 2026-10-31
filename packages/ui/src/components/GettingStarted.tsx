import { useEffect, useId, useMemo, useState } from "react";
import { useClient, usePlatform, useWorkspace } from "../context.js";
import {
  readWorkspaceStorage,
  workspaceStorageKey,
  writeWorkspaceStorage,
} from "../lib/workspaceStorage.js";
import { Icon } from "./Icon.js";

interface Saved {
  dismissed?: boolean;
  /** A huddle leaves nothing behind to look at later, so taking part is noted. */
  huddleTried?: boolean;
  /** Every step listed rather than only the next, as a sidebar category stays open. */
  expanded?: boolean;
}

/** What the browser allows, or whether the desktop app shows its own. */
function notificationsOn(kind: "web" | "desktop"): boolean {
  if (kind === "desktop") return true;
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

/**
 * A short list for whoever set the workspace up: make a channel, bring
 * someone in, turn notifications on, try a huddle. Each step ticks itself
 * off from what has actually happened, the list goes once all four have, and
 * it can be put away sooner. Kept per workspace and account on this device.
 *
 * It sits above the channels, so it shows only the next step: a header with
 * the count and Hide, the progress, and that one row, leaving six channels in
 * sight at 1280 by 720 (UX-20). "All steps" lists the rest, and stays open
 * once opened, as a sidebar category stays folded.
 */
export function GettingStarted(props: {
  onNewChannel: () => void;
  onInvite: () => void;
  onNotifications: () => void;
  activeChannelName: string | null;
  onTryHuddle: () => void;
}) {
  const platform = usePlatform();
  const client = useClient();
  const self = useWorkspace((s) => s.self);
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const channels = useWorkspace((s) => s.channels);
  const users = useWorkspace((s) => s.users);
  const inHuddle = useWorkspace((s) => s.huddle !== null);
  const key = useMemo(() => {
    const scoped = workspaceStorageKey(client.baseUrl, workspaceId, self?.id, "getting-started");
    return scoped && { key: scoped.key };
  }, [client.baseUrl, workspaceId, self?.id]);
  const [saved, setSaved] = useState<Saved | null>(null);
  // Notification permission changes outside the app, so look again on return.
  const [, recheck] = useState(0);
  // How often the whole list has been opened: its rows come in afresh each time.
  const [opened, setOpened] = useState(0);
  const listId = useId();

  useEffect(() => {
    if (!key) return;
    let alive = true;
    readWorkspaceStorage<Saved>(platform, key)
      .catch(() => null)
      .then((value) => {
        if (alive) setSaved(value && typeof value === "object" ? value : {});
      });
    return () => {
      alive = false;
    };
  }, [platform, key]);

  const save = (next: Saved) => {
    setSaved(next);
    // Losing this only shows the list again; nothing to report.
    if (key) writeWorkspaceStorage(platform, key, next).catch(() => {});
  };

  useEffect(() => {
    if (inHuddle && saved && !saved.huddleTried) save({ ...saved, huddleTried: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inHuddle, saved]);

  useEffect(() => {
    const again = () => recheck((n) => n + 1);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);

  if (self?.role !== "owner" || !saved || saved.dismissed) return null;
  const rooms = Object.values(channels).filter(
    (c) => (c.type === "public" || c.type === "private") && !c.archived,
  );
  const others = Object.values(users).filter((u) => u.id !== self.id && !u.isBot && !u.deactivated);
  const steps = [
    {
      label: "Create a channel",
      done: rooms.some((c) => c.name !== "general"),
      action: "New channel",
      onClick: props.onNewChannel,
    },
    {
      label: "Invite someone",
      done: others.length > 0,
      action: "Invite",
      onClick: props.onInvite,
    },
    {
      label: "Turn on notifications",
      done: notificationsOn(platform.kind),
      action: "Settings",
      onClick: props.onNotifications,
    },
    {
      label: props.activeChannelName
        ? `Try a huddle in ${props.activeChannelName}`
        : "Try a huddle",
      done: saved.huddleTried === true || inHuddle,
      action: "Start",
      onClick: props.onTryHuddle,
    },
  ];
  const left = steps.filter((step) => !step.done).length;
  if (left === 0) return null;

  const done = steps.length - left;
  const expanded = saved.expanded === true;
  // Folded, the list is the next step alone: the first one still to do.
  const shown = expanded ? steps : steps.filter((step) => !step.done).slice(0, 1);
  return (
    <section
      aria-labelledby="getting-started-title"
      className="card-warm mb-4 rounded-xl px-2.5 py-2"
    >
      <div className="flex h-6 items-center gap-2">
        <h2 id="getting-started-title" className="min-w-0 truncate text-[13px] font-semibold">
          Getting started
        </h2>
        <p className="tabular shrink-0 text-[11px] text-ink-faint">
          {left} of {steps.length} left
        </p>
        <button
          onClick={() => save({ ...saved, dismissed: true })}
          className="-mr-1.5 ml-auto h-6 shrink-0 rounded-md px-1.5 text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink"
        >
          Hide
        </button>
      </div>
      <div className="flex h-6 items-center gap-2">
        <div aria-hidden="true" className="h-1 flex-1 overflow-hidden rounded-full bg-ink/[0.08]">
          <div
            className="h-full origin-left rounded-full bg-copper transition-transform duration-500"
            style={{ transform: `scaleX(${done / steps.length})` }}
          />
        </div>
        {/* Named for what it shows; the chevron says which way it is. */}
        <button
          aria-label="Show all steps"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => {
            if (!expanded) setOpened((n) => n + 1);
            save({ ...saved, expanded: !expanded });
          }}
          className="-mr-1.5 flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink"
        >
          All steps
          <Icon
            name="chevronDown"
            size={12}
            className={`transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
          />
        </button>
      </div>
      {/* Opened again, its rows drop into place as a sidebar category's do. */}
      <ul key={opened} id={listId} className={`-mx-1.5 ${opened && expanded ? "rows-in" : ""}`}>
        {shown.map((step) => {
          const mark = (
            <span
              aria-hidden="true"
              className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${
                step.done ? "border-transparent bg-online/90 text-ground" : "border-ink-faint/50"
              }`}
            >
              {step.done && <Icon name="check" size={10} strokeWidth={3} />}
            </span>
          );
          return (
            <li key={step.label} className="text-[13px]">
              {step.done ? (
                <span className="flex h-7 items-center gap-2.5 px-1.5 text-ink-faint line-through decoration-ink-faint/50">
                  {mark}
                  <span className="min-w-0 truncate">
                    {step.label}
                    <span className="sr-only">, done</span>
                  </span>
                </span>
              ) : (
                // The whole row is the step: one target, named for what it does.
                <button
                  onClick={step.onClick}
                  aria-label={`${step.action}: ${step.label}`}
                  className="group flex h-7 w-full items-center gap-2.5 rounded-md px-1.5 text-left text-ink-dim transition-colors hover:bg-ink/[0.06] hover:text-ink"
                >
                  {mark}
                  <span className="min-w-0 flex-1 truncate">{step.label}</span>
                  <Icon
                    name="arrow"
                    size={12}
                    className="text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                  />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
