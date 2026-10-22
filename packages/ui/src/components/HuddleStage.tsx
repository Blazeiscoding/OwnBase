import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { HuddleState } from "@slackoss/client-core";
import type { ID, User } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { avatarColor } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { HuddleControls } from "./HuddleControls.js";
import { Icon, type IconName } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";
import { huddleHasVideo, type HuddleView } from "../lib/huddleView.js";
import { screenSoundKey, useCallVolumes, type PersonVolume as Volume } from "../lib/callVolumes.js";
import { PersonVolume } from "./PersonVolume.js";

export { huddleHasVideo, type HuddleView };

/** Where the huddle's video sits: above the chat, over it, or out of sight. */

/** Cameras send 16:9, so tiles keep that shape and nobody's head is cropped off. */
const ASPECT = 16 / 9;
const GAP = 12;
const MIN_PORTION = 0.2;
const MAX_PORTION = 0.8;

/**
 * The largest 16:9 tile that fits `count` of them into a width × height box,
 * and how many go in a row. Trying every column count is cheap at the sizes a
 * mesh call reaches, and it beats a fixed grid in both directions: two people
 * sit side by side in a wide box and stacked in a tall one.
 */
export function bestFit(
  count: number,
  width: number,
  height: number,
  gap = GAP,
  aspect = ASPECT,
): { columns: number; width: number } {
  let best = { columns: 1, width: 0 };
  for (let columns = 1; columns <= Math.max(1, count); columns++) {
    const rows = Math.ceil(count / columns);
    const byWidth = (width - gap * (columns - 1)) / columns;
    const byHeight = ((height - gap * (rows - 1)) / rows) * aspect;
    const tile = Math.min(byWidth, byHeight);
    if (tile > best.width) best = { columns, width: tile };
  }
  return { columns: best.columns, width: Math.max(0, Math.floor(best.width)) };
}

/** One thing on the stage: a person, on camera or not, or a shared screen. */
interface StageItem {
  key: string;
  kind: "person" | "screen";
  userId: ID | undefined;
  user: User | undefined;
  /** "You", a display name, "Your screen" or "Priya Shah's screen". */
  name: string;
  stream: MediaStream | null;
  self: boolean;
  speaking: boolean;
  muted: boolean;
  /** Muted by you, for you alone: their voice, or a shared screen's sound. */
  mutedForYou?: boolean;
  /** A shared screen that sends its sound too. */
  sound?: boolean;
  connecting: boolean;
  /** Connecting has taken long enough to know something is wrong. */
  stuck?: boolean;
}

/** Shares first, since they are what people came to look at, then everyone, you first. */
function stageItems(
  huddle: HuddleState,
  users: Record<ID, User>,
  selfId: ID | undefined,
  volumes: Record<ID, Volume> = {},
): StageItem[] {
  const nameOf = (id: ID) => users[id]?.displayName ?? "Someone";
  const me = selfId ? users[selfId] : undefined;
  const items: StageItem[] = [];
  for (const p of huddle.peers)
    if (p.screenStream)
      items.push({
        key: `screen:${p.userId}`,
        kind: "screen",
        userId: p.userId,
        user: users[p.userId],
        name: `${nameOf(p.userId)}'s screen`,
        stream: p.screenStream,
        self: false,
        speaking: false,
        muted: false,
        sound: !!p.screenSoundStream,
        mutedForYou: !!p.screenSoundStream && (volumes[screenSoundKey(p.userId)]?.muted ?? false),
        connecting: !p.connected,
      });
  if (huddle.localScreenStream)
    items.push({
      key: "screen:self",
      kind: "screen",
      userId: selfId,
      user: me,
      name: "Your screen",
      stream: huddle.localScreenStream,
      self: true,
      speaking: false,
      muted: false,
      sound: huddle.sharingScreenSound ?? false,
      connecting: false,
    });
  items.push({
    key: "self",
    kind: "person",
    userId: selfId,
    user: me,
    name: "You",
    stream: huddle.localCameraStream,
    self: true,
    speaking: huddle.speaking,
    muted: huddle.micMuted,
    connecting: false,
  });
  for (const p of huddle.peers)
    items.push({
      key: p.userId,
      kind: "person",
      userId: p.userId,
      user: users[p.userId],
      name: nameOf(p.userId),
      stream: p.cameraStream,
      self: false,
      speaking: p.speaking,
      muted: p.micMuted,
      mutedForYou: volumes[p.userId]?.muted ?? false,
      connecting: !p.connected,
      stuck: !p.connected && !!p.trouble,
    });
  return items;
}

/** What a tile is called for a screen reader: who, and what is off. */
function describe(item: StageItem): string {
  const parts = [item.name];
  if (item.kind === "screen") {
    if (item.sound) parts.push(item.mutedForYou ? "sound muted for you" : "with sound");
    if (item.connecting) parts.push("connecting");
    return parts.join(", ");
  }
  if (!item.stream) parts.push("camera off");
  if (item.muted) parts.push("muted");
  if (item.mutedForYou) parts.push("muted for you");
  if (item.connecting) parts.push(item.stuck ? "can't connect" : "connecting");
  return parts.join(", ");
}

/** An element's size, followed as it changes. A callback ref, so a new element is measured too. */
function useElementSize() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, size] as const;
}

/**
 * A video surface. Muted is not optional: the audio arrives on its own
 * element, and playing it here as well would double every voice.
 */
function Video({
  stream,
  mirrored,
  fit,
  onAspect,
}: {
  stream: MediaStream;
  mirrored?: boolean;
  /** A face fills its tile; a shared screen has to be shown whole. */
  fit: "cover" | "contain";
  /** Told the picture's shape when it is known and whenever it changes, as a shared window is resized. */
  onAspect?: (aspect: number) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const report = useRef(onAspect);
  report.current = onAspect;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    void el.play()?.catch(() => {});
    const measure = () => {
      if (el.videoWidth > 0 && el.videoHeight > 0) report.current?.(el.videoWidth / el.videoHeight);
    };
    el.addEventListener("loadedmetadata", measure);
    el.addEventListener("resize", measure);
    measure();
    return () => {
      el.removeEventListener("loadedmetadata", measure);
      el.removeEventListener("resize", measure);
      el.srcObject = null;
    };
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={`size-full ${fit === "cover" ? "object-cover" : "object-contain"} ${
        mirrored ? "-scale-x-100" : ""
      }`}
    />
  );
}

/** Everything inside a tile but its frame: the picture, the name, who is talking. */
function TileBody({
  item,
  height,
  onAspect,
}: {
  item: StageItem;
  height: number;
  onAspect?: (aspect: number) => void;
}) {
  // Scaled to the tile, so a face in a big tile is not a postage stamp.
  const avatar = Math.round(Math.min(112, Math.max(32, height * 0.34)));
  return (
    <>
      {item.stream ? (
        <Video
          stream={item.stream}
          mirrored={item.self && item.kind === "person"}
          fit={item.kind === "screen" ? "contain" : "cover"}
          onAspect={onAspect}
        />
      ) : (
        <div
          className="flex size-full items-center justify-center"
          style={
            item.userId
              ? {
                  background: `radial-gradient(circle at 50% 45%, ${avatarColor(item.userId, 0.45)}, transparent 70%)`,
                }
              : undefined
          }
        >
          <Avatar user={item.user} size={avatar} />
        </div>
      )}
      {item.connecting && (
        <span className="absolute inset-0 flex items-center justify-center gap-2 bg-black/50 text-xs text-white">
          <span
            className="size-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white"
            aria-hidden="true"
          />
          {item.stuck ? "Can't connect · trying again" : "Connecting…"}
        </span>
      )}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-lg bg-black/55 px-2 py-1 text-xs font-medium text-white backdrop-blur-sm"
      >
        {item.kind === "screen" && <Icon name="screen" size={13} />}
        {item.sound && !item.mutedForYou && <Icon name="volume" size={13} />}
        {item.muted && <Icon name="micOff" size={13} className="text-alert" />}
        {item.mutedForYou && <Icon name="volumeOff" size={13} className="text-alert" />}
        <span className="truncate">{item.name}</span>
      </span>
      {/* Drawn over the picture, since a border under the video would be hidden by it. */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 rounded-[inherit] ring-2 ring-inset transition-colors ${
          item.speaking ? "ring-online" : "ring-transparent"
        }`}
      />
    </>
  );
}

/** Someone else, on camera or not, or their screen with its sound: the volume is yours to set. */
const hasVolume = (item: StageItem): item is StageItem & { userId: ID } =>
  (item.kind === "person" || !!item.sound) && !item.self && item.userId !== undefined;

const tileFrame = (item: StageItem, radius = "rounded-2xl") =>
  `relative block size-full overflow-hidden ${radius} ${
    item.kind === "screen" ? "bg-black" : "bg-lifted"
  }`;

/** A small button over a tile's corner, shown on hover and keyboard focus, and always on touch. */
function TileButton(props: {
  label: string;
  icon: IconName;
  onClick: () => void;
  /** Shown all the time, in the accent: the tile is pinned, and this lets it go. */
  active?: boolean;
  /** In the corner, or beside the one there. */
  place?: "corner" | "beside";
  /** Whether what it opens is open; it stays in sight while it is. */
  expanded?: boolean;
}) {
  return (
    <Tooltip label={props.label}>
      <button
        aria-label={props.label}
        aria-expanded={props.expanded}
        onClick={props.onClick}
        className={`absolute ${props.place === "beside" ? "right-11" : "right-2"} top-2 flex size-8 items-center justify-center rounded-lg backdrop-blur-sm transition-opacity focus-visible:opacity-100 pointer-coarse:opacity-100 ${
          props.active
            ? "bg-copper text-ground hover:bg-copper-deep"
            : `bg-black/55 text-white hover:bg-black/75 group-hover/tile:opacity-100 ${
                props.expanded ? "opacity-100" : "opacity-0"
              }`
        }`}
      >
        <Icon name={props.icon} size={15} />
      </button>
    </Tooltip>
  );
}

/**
 * How loud someone, or the screen they share, is to you, from their tile. It
 * opens in the tile rather than as a popover, so it is there in full screen
 * too, where only the stage is shown.
 */
function TileVolume({ item }: { item: StageItem & { userId: ID } }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => {
      if (!(event.target instanceof Node) || !wrap.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);
  return (
    <div ref={wrap} className="contents">
      <TileButton
        label={`Volume for ${item.name}`}
        icon="volume"
        place="beside"
        expanded={open}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div
          className="surface-float absolute inset-x-2 top-1/2 mx-auto max-w-64 -translate-y-1/2 rounded-xl px-2 py-1"
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setOpen(false);
            wrap.current?.querySelector<HTMLElement>("button[aria-expanded]")?.focus();
          }}
        >
          {item.kind === "screen" ? (
            <PersonVolume userId={item.userId} name={item.user?.displayName ?? "Someone"} screen />
          ) : (
            <PersonVolume userId={item.userId} name={item.name} />
          )}
        </div>
      )}
    </div>
  );
}

/** Everyone the same size: the layout without a share or a pin. */
function Gallery({
  items,
  width,
  height,
  onPin,
}: {
  items: StageItem[];
  width: number;
  height: number;
  onPin: (key: string) => void;
}) {
  const fit = bestFit(items.length, width, height);
  const tileHeight = Math.floor(fit.width / ASPECT);
  return (
    <ul
      aria-label="Everyone in the huddle"
      className="mx-auto flex h-full flex-wrap content-center items-center justify-center"
      style={{ gap: GAP, maxWidth: fit.columns * fit.width + (fit.columns - 1) * GAP }}
    >
      {items.map((item) => (
        <li key={item.key} style={{ width: fit.width, height: tileHeight }}>
          <div
            role="group"
            aria-label={describe(item)}
            className={`group/tile ${tileFrame(item)}`}
            onDoubleClick={() => onPin(item.key)}
          >
            <TileBody item={item} height={tileHeight} />
            <TileButton label={`Pin ${item.name}`} icon="pin" onClick={() => onPin(item.key)} />
            {hasVolume(item) && <TileVolume item={item} />}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** What you see while you share: your own screen shown full size would only show itself. */
function Presenting({ item, width, height }: { item: StageItem; width: number; height: number }) {
  const client = useClient();
  // Tall enough: the preview above the words, as big as leaves room for them
  // and the button. Short but wide: beside them. Short and narrow, as on a
  // phone: the words and the button, no preview.
  const preview = Math.floor(Math.min(216, height - 200, (width - 40) / ASPECT));
  const layout = preview >= 96 ? "tall" : width >= 560 ? "wide" : "small";
  return (
    <div
      role="group"
      aria-label={describe(item)}
      className={`flex size-full items-center justify-center gap-4 rounded-2xl border border-edge bg-raised/50 p-5 ${
        layout === "wide" ? "flex-row text-left" : "flex-col text-center"
      }`}
    >
      {item.stream && layout !== "small" && (
        <div
          className={`shrink-0 overflow-hidden rounded-xl border border-edge bg-black shadow-lg ${
            layout === "wide" ? "aspect-video h-28" : ""
          }`}
          style={layout === "tall" ? { height: preview, width: preview * ASPECT } : undefined}
        >
          <Video stream={item.stream} fit="contain" />
        </div>
      )}
      <div className="min-w-0">
        <p className="font-semibold">You're sharing your screen</p>
        <p className="mt-1 text-sm text-ink-dim">
          {item.sound
            ? "Everyone in the huddle can see and hear it"
            : "Everyone in the huddle can see it"}
          {layout === "small" ? "." : ". This preview is only for you."}
        </p>
      </div>
      <button
        onClick={() => void client.toggleScreenShare()}
        className="flex shrink-0 items-center gap-2 rounded-xl bg-alert px-4 py-2 text-sm font-semibold text-ground transition-colors hover:bg-alert/85"
      >
        <Icon name="screen" size={16} />
        Stop sharing
      </button>
    </div>
  );
}

/** One thing large, everyone else in a strip beside it or below it. */
function Spotlight({
  main,
  others,
  width,
  height,
  pinned,
  onPin,
  onUnpin,
}: {
  main: StageItem;
  others: StageItem[];
  width: number;
  height: number;
  pinned: boolean;
  onPin: (key: string) => void;
  onUnpin: () => void;
}) {
  // Beside the main view when there is width to spare, under it otherwise, and
  // small enough for everyone to fit without scrolling while that stays legible.
  const side = width >= 640 && width >= height * 1.25;
  const fits = (space: number) => (space - 8 * (others.length - 1)) / Math.max(1, others.length);
  const thumbHeight = side
    ? Math.round(Math.min(135, Math.max(72, fits(height))))
    : Math.round(Math.min(135, height * 0.24, Math.max(63, fits(width) / ASPECT)));
  const thumbWidth = Math.round(thumbHeight * ASPECT);
  const mainWidth = side && others.length > 0 ? width - thumbWidth - GAP : width;
  const mainHeight = !side && others.length > 0 ? height - thumbHeight - GAP : height;
  // The picture's own shape, once the video says what it is. A screen is
  // rarely 16:9, and a frame of the wrong shape showed it in wide black bars.
  const [screenAspect, setScreenAspect] = useState<number | null>(null);
  const presenting = main.kind === "screen" && main.self;
  const aspect = main.kind === "screen" ? (screenAspect ?? ASPECT) : ASPECT;
  const box = presenting ? null : bestFit(1, mainWidth, mainHeight, GAP, aspect);

  let body: ReactNode;
  if (presenting) {
    body = <Presenting item={main} width={mainWidth} height={mainHeight} />;
  } else {
    body = (
      <div
        role="group"
        aria-label={describe(main)}
        className={`group/tile ${tileFrame(main)} ${main.kind === "screen" ? "shadow-2xl ring-1 ring-edge" : ""}`}
        style={box ? { width: box.width, height: Math.floor(box.width / aspect) } : undefined}
      >
        <TileBody
          item={main}
          height={box ? box.width / aspect : mainHeight}
          onAspect={main.kind === "screen" ? setScreenAspect : undefined}
        />
        {pinned && <TileButton label={`Unpin ${main.name}`} icon="pin" onClick={onUnpin} active />}
        {hasVolume(main) && <TileVolume item={main} />}
      </div>
    );
  }

  return (
    // The picture and the strip sit together in the middle, so the strip is
    // beside the share rather than out at the stage's far edge.
    <div
      className={`flex size-full items-center justify-center ${side ? "flex-row" : "flex-col"}`}
      style={{ gap: GAP }}
    >
      <div
        className={`flex min-h-0 min-w-0 items-center justify-center ${presenting ? "size-full flex-1" : ""}`}
      >
        {body}
      </div>
      {others.length > 0 && (
        <ul
          aria-label="Everyone else"
          className={`flex shrink-0 gap-2 ${
            side ? "max-h-full flex-col overflow-y-auto" : "max-w-full flex-row overflow-x-auto"
          }`}
          style={side ? { width: thumbWidth } : { height: thumbHeight }}
        >
          {others.map((item) => (
            <li
              key={item.key}
              className="shrink-0"
              style={{ width: thumbWidth, height: thumbHeight }}
            >
              <Tooltip label={`Show ${item.name} large`}>
                <button
                  aria-label={`Pin ${describe(item)}`}
                  onClick={() => onPin(item.key)}
                  className={`group/tile ${tileFrame(item, "rounded-xl")} text-left outline-offset-2`}
                >
                  <TileBody item={item} height={thumbHeight} />
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StageButton(props: {
  label: string;
  /** What pressing it does now, when the name alone does not say. */
  hint?: string;
  icon: IconName;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={props.hint ?? props.label} side="bottom">
      <button
        aria-label={props.label}
        aria-pressed={props.pressed}
        onClick={props.onClick}
        className={`flex size-8 items-center justify-center rounded-lg transition-colors ${
          props.pressed
            ? "bg-copper/15 text-copper"
            : "text-ink-dim hover:bg-ink/[0.05] hover:text-ink"
        }`}
      >
        <Icon name={props.icon} size={16} />
      </button>
    </Tooltip>
  );
}

/**
 * The huddle's video. Above the chat by default, at a height you can drag;
 * expanded, it covers the chat; in full screen it takes the screen, with the
 * call's controls on top. A share takes the main view by itself, with everyone
 * else in a strip, and any tile can be pinned there instead.
 *
 * It shows nothing in a call without video: the huddle bar already says who is
 * there and who is talking.
 */
export function HuddleStage({
  view,
  onViewChange,
}: {
  view: HuddleView;
  onViewChange: (view: HuddleView) => void;
}) {
  const huddle = useWorkspace((s) => s.huddle);
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const { volumes } = useCallVolumes();
  const stage = useRef<HTMLElement | null>(null);
  const [measure, area] = useElementSize();
  const [pinned, setPinned] = useState<string | null>(null);
  const [grid, setGrid] = useState(false);
  /** How much of the column the stage takes, once someone has resized it; null until then. */
  const [portion, setPortion] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () =>
      setFullscreen(stage.current !== null && document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // In full screen the controls sit over the picture, so they step aside, with
  // the pointer, once nobody has moved for a few seconds. Any movement or key
  // brings them back, and focus inside them keeps them there.
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    const el = stage.current;
    if (!fullscreen || !el) {
      setIdle(false);
      return;
    }
    let timer = setTimeout(() => setIdle(true), 3000);
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), 3000);
    };
    // A tap on a touch screen moves nothing, so pressing counts as well.
    const events = ["pointermove", "pointerdown", "keydown"] as const;
    for (const type of events) el.addEventListener(type, wake);
    return () => {
      clearTimeout(timer);
      for (const type of events) el.removeEventListener(type, wake);
    };
  }, [fullscreen]);

  // Someone starting to share is worth seeing, even with the video put away.
  const sharer = huddle?.peers.find((p) => p.screenStream)?.userId ?? null;
  const lastSharer = useRef<ID | null>(null);
  useEffect(() => {
    if (sharer && sharer !== lastSharer.current && view === "hidden") onViewChange("docked");
    lastSharer.current = sharer;
  }, [sharer, view, onViewChange]);

  if (!huddle || view === "hidden" || !huddleHasVideo(huddle)) return null;

  const items = stageItems(huddle, users, selfId, volumes);
  const pinnedItem = pinned ? items.find((i) => i.key === pinned) : undefined;
  const firstShare =
    items.find((i) => i.kind === "screen" && !i.self) ?? items.find((i) => i.kind === "screen");
  // Someone pinned who has left, or a grid with nothing left to spotlight, is
  // let go now, or it would come back unasked when they rejoin or share again.
  if (pinned !== null && !pinnedItem) setPinned(null);
  if (grid && !firstShare && !pinnedItem) setGrid(false);
  const main = grid ? undefined : (pinnedItem ?? firstShare);
  const expanded = view === "expanded";
  // A share is what people watch, so it starts taller than a row of faces.
  const current = portion ?? (firstShare ? 0.75 : 0.5);

  const pin = (key: string) => {
    setPinned(key);
    setGrid(false);
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void stage.current?.requestFullscreen().catch(() => {});
  };

  const resizeBy = (delta: number) =>
    setPortion(Math.min(MAX_PORTION, Math.max(MIN_PORTION, current + delta)));
  const onHandleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowUp: -0.05, ArrowDown: 0.05 }[e.key];
    if (step !== undefined) resizeBy(step);
    else if (e.key === "Home") setPortion(MIN_PORTION);
    else if (e.key === "End") setPortion(MAX_PORTION);
    else return;
    e.preventDefault();
  };
  const onHandleDown = (e: PointerEvent<HTMLDivElement>) => {
    const column = stage.current?.parentElement;
    if (!stage.current || !column) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture?.(e.pointerId);
    const total = column.getBoundingClientRect().height || 1;
    const startY = e.clientY;
    const startHeight = stage.current.getBoundingClientRect().height;
    const move = (ev: globalThis.PointerEvent) =>
      setPortion(
        Math.min(MAX_PORTION, Math.max(MIN_PORTION, (startHeight + ev.clientY - startY) / total)),
      );
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const focusText = main
    ? main.kind === "screen"
      ? main.self
        ? "You're sharing your screen"
        : `${main.user?.displayName ?? "Someone"} is sharing their screen`
      : `${main.name} is pinned`
    : "Huddle video";
  // Who is on the main view, at a glance: their face, the sentence, and a
  // badge while it is a screen.
  const focus = (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      {main?.user && <Avatar user={main.user} size={22} />}
      <p className={`min-w-0 truncate text-sm ${main ? "font-medium text-ink" : "text-ink-dim"}`}>
        {focusText}
      </p>
      {main?.kind === "screen" && (
        <span
          aria-hidden="true"
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-copper/15 px-2 py-0.5 text-[11px] font-semibold text-copper"
        >
          <span className="size-1.5 animate-pulse rounded-full bg-copper motion-reduce:animate-none" />
          Presenting
        </span>
      )}
    </div>
  );

  return (
    <section
      ref={stage}
      aria-label="Huddle video"
      className={`flex flex-col bg-deep ${idle ? "cursor-none" : ""} ${
        expanded
          ? "absolute inset-0 z-20"
          : "relative max-h-[calc(100%-7.5rem)] min-h-[200px] shrink-0 border-b border-edge"
      }`}
      style={expanded ? undefined : { height: `${current * 100}%` }}
    >
      <div className="flex h-12 shrink-0 items-center gap-1 pl-4 pr-2">
        {focus}
        {(firstShare || pinnedItem) && (
          <StageButton
            label="Grid view"
            hint={grid ? "Back to the spotlight" : "Show everyone the same size"}
            icon="grid"
            pressed={grid}
            onClick={() => {
              setGrid((on) => !on);
              setPinned(null);
            }}
          />
        )}
        {!fullscreen && (
          <StageButton
            label="Expand video"
            hint={expanded ? "Show the chat again" : "Expand the video over the chat"}
            icon={expanded ? "shrink" : "expand"}
            pressed={expanded}
            onClick={() => onViewChange(expanded ? "docked" : "expanded")}
          />
        )}
        {document.fullscreenEnabled && (
          <StageButton
            label="Full screen"
            hint={fullscreen ? "Leave full screen" : "Full screen"}
            icon={fullscreen ? "fullscreenExit" : "fullscreen"}
            pressed={fullscreen}
            onClick={toggleFullscreen}
          />
        )}
        {!fullscreen && (
          <StageButton
            label="Hide video"
            hint="Hide the video; the huddle carries on"
            icon="chevronDown"
            onClick={() => onViewChange("hidden")}
          />
        )}
      </div>
      <div ref={measure} className="min-h-0 flex-1 px-4 pb-4">
        {main ? (
          <Spotlight
            main={main}
            others={items.filter((i) => i.key !== main.key)}
            width={area.width - 32}
            height={area.height - 16}
            pinned={main.key === pinned}
            onPin={pin}
            onUnpin={() => setPinned(null)}
          />
        ) : (
          <Gallery
            items={items.filter((i) => i.kind === "person" || grid)}
            width={area.width - 32}
            height={area.height - 16}
            onPin={pin}
          />
        )}
      </div>
      {fullscreen && (
        <div
          className={`absolute bottom-6 left-1/2 -translate-x-1/2 transition-opacity duration-300 focus-within:pointer-events-auto focus-within:opacity-100 ${
            idle ? "pointer-events-none opacity-0" : "opacity-100"
          }`}
        >
          <HuddleControls overlay />
        </div>
      )}
      {!expanded && !fullscreen && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize huddle video"
          aria-valuemin={MIN_PORTION * 100}
          aria-valuemax={MAX_PORTION * 100}
          aria-valuenow={Math.round(current * 100)}
          tabIndex={0}
          onPointerDown={onHandleDown}
          onKeyDown={onHandleKey}
          className="group/handle absolute inset-x-0 -bottom-2 z-10 flex h-4 cursor-row-resize touch-none items-center justify-center outline-none"
        >
          <span className="h-1 w-12 rounded-full bg-edge transition-colors group-hover/handle:bg-ink-faint group-focus-visible/handle:bg-copper" />
        </div>
      )}
    </section>
  );
}
