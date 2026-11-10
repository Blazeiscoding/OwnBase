import { useEffect, useId, useMemo, useRef, useState } from "react";
import { DEFAULT_WORKSPACE_NAME } from "@ownbase/protocol";
import { useToast } from "./Toast.js";
import { useClient, usePlatform, useWorkspace } from "../context.js";
import {
  readWorkspaceStorage,
  workspaceStorageKey,
  writeWorkspaceStorage,
} from "@ownbase/client-core";
import { Icon } from "./Icon.js";

interface Saved {
  dismissed?: boolean;
  /** A huddle leaves nothing behind to look at later, so taking part is noted. */
  huddleTried?: boolean;
  /** Every step listed rather than only the next, as a sidebar category stays open. */
  expanded?: boolean;
}

/**
 * Where the list's last known state is copied, outside the device store and
 * its "ownbase:" names: the store is read after the sidebar is drawn, and a
 * list that appeared only then pushed the channels down under the pointer.
 * The state itself stays in the store; the copy follows it.
 */
export const GETTING_STARTED_COPY_KEY = "ownbase-getting-started";

/** Only what is kept, so nothing else stored there is drawn from. */
function cleaned(value: unknown): Saved | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { dismissed, huddleTried, expanded } = value as Record<string, unknown>;
  return {
    ...(dismissed === true ? { dismissed } : {}),
    ...(huddleTried === true ? { huddleTried } : {}),
    ...(typeof expanded === "boolean" ? { expanded } : {}),
  };
}

function copies(): Record<string, unknown> {
  try {
    const all: unknown = JSON.parse(localStorage.getItem(GETTING_STARTED_COPY_KEY) ?? "null");
    return all && typeof all === "object" && !Array.isArray(all)
      ? (all as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function keepCopy(key: string, saved: Saved) {
  try {
    localStorage.setItem(
      GETTING_STARTED_COPY_KEY,
      JSON.stringify({ ...copies(), [key]: cleaned(saved) }),
    );
  } catch {
    // Without it the list is drawn once the store is read, as before.
  }
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
  /** Workspace settings, where it is named. */
  onNameWorkspace: () => void;
  activeChannelName: string | null;
  onTryHuddle: () => void;
}) {
  const platform = usePlatform();
  const client = useClient();
  const toast = useToast();
  const self = useWorkspace((s) => s.self);
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const channels = useWorkspace((s) => s.channels);
  const users = useWorkspace((s) => s.users);
  const workspaceName = useWorkspace((s) => s.workspaceName);
  const inHuddle = useWorkspace((s) => s.huddle !== null);
  const key = useMemo(() => {
    const scoped = workspaceStorageKey(client.baseUrl, workspaceId, self?.id, "getting-started");
    return scoped && { key: scoped.key };
  }, [client.baseUrl, workspaceId, self?.id]);
  // What is stored, with the key it is stored under.
  const [saved, setSaved] = useState<{ key: string; value: Saved } | null>(null);
  // Drawn from with the sidebar until the store is read. None on a device
  // that has never shown the list, which then appears once it is read.
  const copy = useMemo(() => (key ? cleaned(copies()[key.key]) : null), [key]);
  const loaded = key && saved?.key === key.key ? saved.value : null;
  const current = loaded ?? copy;
  // The key last pressed for: a press on the copy is newer than any read.
  const pressed = useRef<string | null>(null);
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
        if (!alive || pressed.current === key.key) return;
        const read = value && typeof value === "object" ? value : {};
        setSaved({ key: key.key, value: read });
        keepCopy(key.key, read);
      });
    return () => {
      alive = false;
    };
  }, [platform, key]);

  const save = (next: Saved) => {
    if (!key) return;
    pressed.current = key.key;
    setSaved({ key: key.key, value: next });
    keepCopy(key.key, next);
    // Losing this only shows the list again; nothing to report.
    writeWorkspaceStorage(platform, key, next).catch(() => {});
  };

  useEffect(() => {
    if (inHuddle && loaded && !loaded.huddleTried) save({ ...loaded, huddleTried: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inHuddle, loaded]);

  useEffect(() => {
    const again = () => recheck((n) => n + 1);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);

  if (self?.role !== "owner" || !current || current.dismissed) return null;
  const rooms = Object.values(channels).filter(
    (c) => (c.type === "public" || c.type === "private") && !c.archived,
  );
  const others = Object.values(users).filter((u) => u.id !== self.id && !u.isBot && !u.deactivated);
  // Asked only while it still has the name it started with: one started
  // with its own name, or since named, has nothing to tick off. First, as an
  // invite says the workspace's name.
  const naming =
    workspaceName === DEFAULT_WORKSPACE_NAME
      ? [
          {
            label: "Name your workspace",
            done: false,
            action: "Name it",
            onClick: props.onNameWorkspace,
          },
        ]
      : [];
  const steps = [
    ...naming,
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
      done: current.huddleTried === true || inHuddle,
      action: "Start",
      onClick: props.onTryHuddle,
    },
  ];
  const left = steps.filter((step) => !step.done).length;
  if (left === 0) return null;

  const done = steps.length - left;
  const expanded = current.expanded === true;
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
          onClick={() => {
            const before = current;
            save({ ...current, dismissed: true });
            // Nothing else brings the list back, so a hide by mistake can be undone.
            toast({
              message: "Getting started is hidden.",
              kind: "info",
              action: { label: "Undo", run: () => save({ ...before, dismissed: false }) },
            });
          }}
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
            save({ ...current, expanded: !expanded });
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
