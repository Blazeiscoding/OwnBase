import { useEffect, useRef, useState } from "react";
import type { ID, User } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { Icon } from "./Icon.js";
import { Popover } from "./Popover.js";
import { HuddleControls } from "./HuddleControls.js";
import { HuddleAudio } from "./HuddleAudio.js";
import { Tooltip } from "./Tooltip.js";
import { aloneLine, bigCallLine, ringingLine, type HuddleView } from "../lib/huddleView.js";
import { namesList } from "../lib/catchUp.js";
import { useCallPreferences } from "../lib/callPreferences.js";
import { useCallVolumes } from "../lib/callVolumes.js";
import { PersonVolume } from "./PersonVolume.js";

/** Someone in the call, as the bar and its roster need them. */
interface Person {
  key: string;
  /** Someone else in the call, whose volume is yours to set; absent for you. */
  peerId?: ID;
  user: User | undefined;
  /** "You" or a display name. */
  name: string;
  speaking: boolean;
  muted: boolean;
  /** Muted by you, for you alone. */
  mutedForYou?: boolean;
  connecting: boolean;
  /** Connecting has taken long enough to know something is wrong. */
  stuck: boolean;
  /** Sharing a screen with its sound, whose volume is yours to set as well. */
  screenSound?: boolean;
}

/** How many faces the bar shows before the rest are counted. */
const FACES = 4;

/** What is true of someone besides their name, for a label or the roster. */
function stateOf(p: Person): string | null {
  if (p.connecting) return p.stuck ? "can't connect" : "connecting…";
  // Before talking: it is why you cannot hear them.
  if (p.mutedForYou) return "muted for you";
  if (p.speaking) return "talking";
  if (p.muted) return "muted";
  return null;
}

/**
 * A face in the huddle bar. The ring is the answer to "who is talking?", which
 * in a call of more than three people is the only question anyone has.
 */
function HuddleFace({ person, size = 24 }: { person: Person; size?: number }) {
  const state = stateOf(person);
  return (
    <span
      title={state ? `${person.name} (${state})` : person.name}
      className={`relative flex shrink-0 rounded-full ring-2 transition-colors ${
        person.speaking ? "ring-online" : "ring-transparent"
      } ${person.connecting ? "opacity-40" : ""}`}
    >
      <Avatar user={person.user} size={size} />
      {person.mutedForYou ? (
        <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-raised p-0.5 text-alert">
          <Icon name="volumeOff" size={9} />
        </span>
      ) : (
        person.muted && (
          <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-raised p-0.5 text-ink-dim">
            <Icon name="micOff" size={9} />
          </span>
        )
      )}
    </span>
  );
}

/**
 * Everyone in the call, by name, with who is talking, muted or still
 * connecting, and how loud each of the others is to you. The faces in the bar
 * are too small to tell people apart by, so they open this.
 */
function HuddlePeople({ people }: { people: Person[] }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const extra = people.length - FACES;
  return (
    <>
      <Tooltip label="See everyone in the huddle">
        <button
          ref={anchor}
          type="button"
          aria-label={`Everyone in the huddle (${people.length})`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex h-10 shrink-0 items-center gap-1.5 rounded-full px-2 transition-colors hover:bg-ink/[0.05]"
        >
          {people.slice(0, FACES).map((p) => (
            <HuddleFace key={p.key} person={p} />
          ))}
          {extra > 0 && (
            <span className="tabular flex h-6 min-w-6 items-center justify-center rounded-full bg-ink/[0.08] px-1.5 text-[11px] font-semibold text-ink-dim">
              +{extra}
            </span>
          )}
        </button>
      </Tooltip>
      {open && (
        <Popover
          label="Everyone in the huddle"
          anchor={anchor}
          onClose={() => setOpen(false)}
          width={300}
        >
          <p className="px-4 pb-1 pt-3 text-xs font-semibold text-ink-faint">
            In the huddle · {people.length}
          </p>
          <ul aria-label="In the huddle" className="px-2 pb-2">
            {people.map((p) => {
              const state = stateOf(p);
              return (
                <li
                  key={p.key}
                  aria-label={state ? `${p.name}, ${state}` : p.name}
                  className="rounded-lg px-2 py-1.5"
                >
                  <div className="flex items-center gap-2.5">
                    <HuddleFace person={p} size={28} />
                    <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                    {state && (
                      <span
                        className={`shrink-0 text-xs ${
                          p.stuck || p.mutedForYou
                            ? "text-alert"
                            : p.speaking
                              ? "text-online"
                              : "text-ink-faint"
                        }`}
                      >
                        {state[0]!.toUpperCase() + state.slice(1)}
                      </span>
                    )}
                  </div>
                  {p.peerId && (
                    <div className="pl-7">
                      <PersonVolume userId={p.peerId} name={p.name} />
                      {p.screenSound && <PersonVolume userId={p.peerId} name={p.name} screen />}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Popover>
      )}
    </>
  );
}

/**
 * The bar shown in a huddle while the chat is on show: who is there, the
 * controls, and the way to the call. While the call shows instead, it has the
 * controls, and only the call's sound plays from here, in the same place, so
 * moving between the two never cuts it.
 */
export function HuddleBar({
  view = "chat",
  onViewChange,
  onShowCallLog,
  onOpenSettings,
}: {
  view?: HuddleView;
  onViewChange?: (view: HuddleView) => void;
  /** Opens the call log, for someone who cannot connect to know why. */
  onShowCallLog?: () => void;
  /** Opens Voice & video settings. */
  onOpenSettings?: () => void;
}) {
  const huddle = useWorkspace((s) => s.huddle);
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const selfId = useWorkspace((s) => s.self?.id);
  const ring = useWorkspace((s) => (s.huddle ? s.rings?.[s.huddle.channelId] : undefined));
  const ringNotice = useWorkspace((s) => s.ringNotice);
  const speakerId = useCallPreferences().devices.speakerId;
  const { volumes } = useCallVolumes();

  if (!huddle) return null;
  const channel = channels[huddle.channelId];
  const where = channel
    ? channel.name
      ? `#${channel.name}`
      : channelTitle(channel, users, selfId)
    : "huddle";

  const connecting = huddle.peers.some((p) => !p.connected);
  // Someone who has taken too long to connect: say so, and offer the reason.
  const stuck = huddle.peers.filter((p) => !p.connected && p.trouble);
  const people: Person[] = [
    {
      key: "self",
      user: selfId ? users[selfId] : undefined,
      name: "You",
      speaking: huddle.speaking,
      muted: huddle.micMuted,
      connecting: false,
      stuck: false,
    },
    ...huddle.peers.map((p) => ({
      key: p.userId,
      peerId: p.userId,
      user: users[p.userId],
      name: users[p.userId]?.displayName ?? "Someone",
      speaking: p.connected && p.speaking,
      muted: p.connected && p.micMuted,
      mutedForYou: volumes[p.userId]?.muted ?? false,
      connecting: !p.connected,
      stuck: !p.connected && !!p.trouble,
      screenSound: !!p.screenSoundStream,
    })),
  ];
  const sharer = huddle.peers.find((p) => p.screenStream);
  const sharing = sharer
    ? ` · ${users[sharer.userId]?.displayName ?? "Someone"} is sharing their screen`
    : huddle.sharingScreen
      ? " · You're sharing your screen"
      : "";
  // Everyone by name, so the line answers "who is here?" without a hover.
  const ringing = ringingLine(ring, users);
  const summary =
    huddle.peers.length === 0
      ? (aloneLine(ring, ringNotice, huddle.channelId, users) ?? "Waiting for someone to join…")
      : stuck.length > 0
        ? `Can't connect to ${stuck
            .map((p) => users[p.userId]?.displayName ?? "someone")
            .join(", ")} · Trying again`
        : `With ${namesList(huddle.peers.map((p) => users[p.userId]?.displayName ?? "someone"))}${
            connecting ? " · Connecting…" : ""
          }${sharing}${ringing ? ` · ${ringing}` : ""}`;
  // You and everyone else: more than a call was measured to hold up with.
  const big = bigCallLine(huddle.peers.length + 1);

  const calling = view === "call";
  return (
    <div
      role="region"
      aria-label="Active huddle"
      hidden={calling}
      className="huddle-live mx-4 mb-2 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-2.5"
    >
      <HuddleAudio peers={huddle.peers} speakerId={speakerId} volumes={volumes} />
      {!calling && (
        <>
          {/* The minimum width is what sends the controls to a line of their own on a phone. */}
          <div className="flex min-w-40 flex-1 items-center gap-2.5">
            <Icon name="headphones" className="text-online" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold" title={`Huddle in ${where}`}>
                Huddle in {where}
              </div>
              <div role="status" className="truncate text-xs text-ink-faint" title={summary}>
                {summary}
              </div>
              {big && (
                <div role="status" className="text-xs text-ink-dim">
                  {big}
                </div>
              )}
              {stuck.length > 0 && onShowCallLog && (
                <button
                  type="button"
                  onClick={onShowCallLog}
                  className="text-xs text-copper underline decoration-copper/40 hover:decoration-copper"
                >
                  Why? See the call log
                </button>
              )}
            </div>
          </div>

          <HuddlePeople people={people} />

          {onViewChange && (
            <button
              onClick={() => onViewChange("call")}
              className="flex h-11 items-center gap-2 rounded-xl border border-edge px-3 text-sm text-ink-dim transition-colors hover:border-ink-faint hover:text-ink"
            >
              <Icon name="expand" size={16} />
              Show call
            </button>
          )}

          <HuddleControls onOpenSettings={onOpenSettings} />
        </>
      )}
    </div>
  );
}

/** The header's control lives on its own, so the bar can load only for a call. */
export { HuddleButton } from "./HuddleButton.js";
