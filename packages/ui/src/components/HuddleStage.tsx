import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { HuddleState } from "@slackoss/client-core";
import type { ID, User } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { avatarColor, channelTitle } from "../lib/format.js";
import { ringingLine } from "../lib/huddleView.js";
import { Avatar } from "./Avatar.js";
import { HuddleControls } from "./HuddleControls.js";
import { Icon, type IconName } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";
import { screenSoundKey, useCallVolumes, type PersonVolume as Volume } from "../lib/callVolumes.js";
import { PersonVolume } from "./PersonVolume.js";

/** Cameras send 16:9, so tiles keep that shape and nobody's head is cropped off. */
const ASPECT = 16 / 9;
const GAP = 12;

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
      {/* Dark on any picture and in either theme, so its red is Onyx's, which reads on it. */}
      <span
        aria-hidden="true"
        className="call-dark pointer-events-none absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-lg bg-black/55 px-2 py-1 text-xs font-medium text-white backdrop-blur-sm"
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
    item.kind === "screen" ? "bg-black" : "bg-[var(--call-tile)]"
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

/**
 * One thing large and everyone else in a row under it, as Discord shows a
 * stream. The row can be put away, and in full screen it starts put away, so
 * the share has the screen to itself.
 */
function Spotlight({
  main,
  others,
  width,
  height,
  pinned,
  onPin,
  onUnpin,
  strip,
  edge,
  onOpen,
}: {
  main: StageItem;
  others: StageItem[];
  width: number;
  height: number;
  pinned: boolean;
  onPin: (key: string) => void;
  onUnpin: () => void;
  /** Everyone else shows, in the row under the main view. */
  strip: boolean;
  /** In full screen: the main view out to the screen's edges, with no frame. */
  edge: boolean;
  /** Double-clicking the main view, into full screen and out again. */
  onOpen: () => void;
}) {
  const row = strip && others.length > 0;
  // Small enough to leave the share most of the height, big enough to tell faces apart.
  const thumbHeight = Math.round(Math.min(120, Math.max(60, height * 0.17)));
  const thumbWidth = Math.round(thumbHeight * ASPECT);
  const mainHeight = row ? height - thumbHeight - GAP : height;
  // The picture's own shape, once the video says what it is. A screen is
  // rarely 16:9, and a frame of the wrong shape showed it in wide black bars.
  const [screenAspect, setScreenAspect] = useState<number | null>(null);
  const presenting = main.kind === "screen" && main.self;
  const aspect = main.kind === "screen" ? (screenAspect ?? ASPECT) : ASPECT;
  const box = presenting ? null : bestFit(1, width, mainHeight, GAP, aspect);

  let body: ReactNode;
  if (presenting) {
    body = <Presenting item={main} width={width} height={mainHeight} />;
  } else {
    body = (
      <div
        role="group"
        aria-label={describe(main)}
        className={`group/tile ${tileFrame(main, edge ? "" : "rounded-2xl")}`}
        style={box ? { width: box.width, height: Math.floor(box.width / aspect) } : undefined}
        onDoubleClick={onOpen}
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
    <div className="flex size-full flex-col items-center" style={{ gap: GAP }}>
      <div className="flex min-h-0 w-full flex-1 items-center justify-center">{body}</div>
      {row && (
        <ul
          aria-label="Everyone else"
          className="flex max-w-full shrink-0 flex-row gap-2 overflow-x-auto"
          style={{ height: thumbHeight }}
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

/** A button in the call's header or along its bottom, in ink, so it reads in either theme. */
function StageButton(props: {
  label: string;
  /** What pressing it does now, when the name alone does not say. */
  hint?: string;
  icon: IconName;
  pressed?: boolean;
  /** Where its hint shows: under a button in the header, over one at the bottom. */
  side?: "top" | "bottom";
  onClick: () => void;
}) {
  return (
    <Tooltip label={props.hint ?? props.label} side={props.side ?? "bottom"}>
      <button
        aria-label={props.label}
        aria-pressed={props.pressed}
        onClick={props.onClick}
        className={`flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors ${
          props.pressed ? "bg-ink/15 text-ink" : "text-ink/70 hover:bg-ink/10 hover:text-ink"
        }`}
      >
        <Icon name={props.icon} size={18} />
      </button>
    </Tooltip>
  );
}

/**
 * The call, as Discord draws a voice channel: everyone as a tile, and the
 * controls centred along the bottom. Black in Onyx; in White, the window's
 * grey with a white tile for each person. It takes the conversation's column,
 * with the chat beside it where there is room for both and under it where
 * there is not. A share takes the main view by itself, with everyone else in
 * a row under it, and any tile can be pinned there instead.
 *
 * In full screen the share fills the screen, edge to edge, dark in either
 * theme (.call-dark). The header and the controls float over it and step
 * aside after a few seconds without movement; everyone else starts hidden,
 * and the same button brings them back.
 */
export function HuddleStage({
  chat,
  onHide,
  onShowCallLog,
  onOpenSettings,
}: {
  /** The chat beside the call, on a window with room for both; absent on a narrower one. */
  chat?: { shown: boolean; onToggle: () => void };
  /** Back to the chat; the huddle carries on. */
  onHide: () => void;
  /** Opens the call log, for someone who cannot connect to know why. */
  onShowCallLog?: () => void;
  /** Opens Voice & video settings, from the device menus. */
  onOpenSettings?: () => void;
}) {
  const huddle = useWorkspace((s) => s.huddle);
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const selfId = useWorkspace((s) => s.self?.id);
  const ring = useWorkspace((s) => (s.huddle ? s.rings?.[s.huddle.channelId] : undefined));
  const { volumes } = useCallVolumes();
  const stage = useRef<HTMLElement | null>(null);
  const [measure, area] = useElementSize();
  const [pinned, setPinned] = useState<string | null>(null);
  const [grid, setGrid] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  /** Whether everyone else shows under the spotlight, in the call and in full screen. */
  const [strip, setStrip] = useState({ call: true, fullscreen: false });

  useEffect(() => {
    const onChange = () =>
      setFullscreen(stage.current !== null && document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // In full screen the controls sit over the picture, so they step aside, with
  // the pointer, once nobody has moved for a few seconds. Any movement or key
  // brings them back, and keyboard focus inside them keeps them there.
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

  if (!huddle) return null;

  const items = stageItems(huddle, users, selfId, volumes);
  const pinnedItem = pinned ? items.find((i) => i.key === pinned) : undefined;
  const firstShare =
    items.find((i) => i.kind === "screen" && !i.self) ?? items.find((i) => i.kind === "screen");
  // Someone pinned who has left, or a grid with nothing left to spotlight, is
  // let go now, or it would come back unasked when they rejoin or share again.
  if (pinned !== null && !pinnedItem) setPinned(null);
  if (grid && !firstShare && !pinnedItem) setGrid(false);
  const main = grid ? undefined : (pinnedItem ?? firstShare);
  const others = main ? items.filter((i) => i.key !== main.key) : [];
  const showStrip = fullscreen ? strip.fullscreen : strip.call;
  // A phone's width has no room beside the controls, so these go up into the header.
  const compact = area.width > 0 && area.width < 600;

  const pin = (key: string) => {
    setPinned(key);
    setGrid(false);
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void stage.current?.requestFullscreen().catch(() => {});
  };
  // A browser leaves full screen on Escape by itself; the desktop app does not.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || document.fullscreenElement !== stage.current) return;
    e.preventDefault();
    void document.exitFullscreen().catch(() => {});
  };

  const channel = channels[huddle.channelId];
  const where = channel
    ? channel.name
      ? `#${channel.name}`
      : channelTitle(channel, users, selfId)
    : "Huddle";
  const stuck = huddle.peers.some((p) => !p.connected && p.trouble);
  const viewButtons = (side: "top" | "bottom") => (
    <>
      {main && others.length > 0 && (
        <StageButton
          label="Everyone else"
          hint={showStrip ? "Hide everyone else" : "Show everyone else"}
          icon="members"
          pressed={showStrip}
          side={side}
          onClick={() =>
            setStrip((s) =>
              fullscreen ? { ...s, fullscreen: !s.fullscreen } : { ...s, call: !s.call },
            )
          }
        />
      )}
      {document.fullscreenEnabled && (
        <StageButton
          label="Full screen"
          hint={fullscreen ? "Leave full screen" : "Full screen"}
          icon={fullscreen ? "fullscreenExit" : "fullscreen"}
          pressed={fullscreen}
          side={side}
          onClick={toggleFullscreen}
        />
      )}
    </>
  );
  const focusText = main
    ? main.kind === "screen"
      ? main.self
        ? "You're sharing your screen"
        : `${main.user?.displayName ?? "Someone"} is sharing their screen`
      : `${main.name} is pinned`
    : null;

  // Over the picture in full screen, shaded so they read on any share, and out
  // of the way while nobody moves. Keyboard focus keeps them; the focus a
  // click leaves on Full screen does not.
  const floating = (edge: "top" | "bottom") =>
    fullscreen
      ? `absolute inset-x-0 z-10 transition-opacity duration-300 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 ${
          edge === "top"
            ? "top-0 bg-linear-to-b from-black/75 to-transparent"
            : "bottom-0 bg-linear-to-t from-black/75 to-transparent"
        } ${idle ? "pointer-events-none opacity-0" : "opacity-100"}`
      : "";

  return (
    <section
      ref={stage}
      aria-label="Huddle call"
      onKeyDown={onKeyDown}
      className={`flex flex-col bg-[var(--call-ground)] text-ink ${fullscreen ? "call-dark" : ""} ${
        idle ? "cursor-none" : ""
      } ${chat?.shown ? "relative min-w-0 flex-1" : "absolute inset-0 z-20"}`}
    >
      <div className={`flex h-14 shrink-0 items-center gap-1 pl-4 pr-2 ${floating("top")}`}>
        {/* Where the call is, and who is on the main view at a glance: their
            face, the sentence, and a badge while it is a screen. On a phone
            the sentence has the room; the app's header already says where. */}
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Icon name="headphones" size={18} className="shrink-0 text-online" />
          <p
            className={`max-w-[40%] shrink-0 truncate text-[15px] font-semibold ${
              compact && main ? "sr-only" : ""
            }`}
          >
            {where}
          </p>
          {main && (
            <>
              {!compact && <span aria-hidden="true" className="h-4 w-px shrink-0 bg-ink/15" />}
              {main.user && <Avatar user={main.user} size={20} />}
              <p className="min-w-0 truncate text-sm text-ink-dim">{focusText}</p>
              {main.kind === "screen" && (
                <span
                  aria-hidden="true"
                  className="shrink-0 rounded-md bg-alert px-1.5 py-0.5 text-[11px] font-bold tracking-wide text-ground"
                >
                  LIVE
                </span>
              )}
            </>
          )}
          {!main && ringingLine(ring, users, selfId) && (
            <>
              <span aria-hidden="true" className="h-4 w-px shrink-0 bg-ink/15" />
              <p role="status" className="min-w-0 truncate text-sm text-ink-dim">
                {ringingLine(ring, users, selfId)}
              </p>
            </>
          )}
          {stuck && onShowCallLog && (
            <button
              type="button"
              onClick={onShowCallLog}
              className="shrink-0 text-xs text-copper underline decoration-copper/40 hover:decoration-copper"
            >
              Can't connect to someone? See the call log
            </button>
          )}
        </div>
        {compact && viewButtons("bottom")}
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
        {chat && !fullscreen && (
          <StageButton
            label="Chat"
            hint={chat.shown ? "Hide the chat" : "Show the chat beside the call"}
            icon="messages"
            pressed={chat.shown}
            onClick={chat.onToggle}
          />
        )}
        {!fullscreen && (
          <StageButton
            label="Hide call"
            hint="Back to the chat; the huddle carries on"
            icon="chevronDown"
            onClick={onHide}
          />
        )}
      </div>
      <div
        ref={measure}
        className={`min-h-0 flex-1 ${
          !fullscreen ? "px-3" : main ? (showStrip ? "pb-24" : "") : "px-4 py-16"
        }`}
      >
        {main ? (
          <Spotlight
            main={main}
            others={others}
            width={area.width - (fullscreen ? 0 : 24)}
            height={area.height - (fullscreen && showStrip ? 96 : 0)}
            pinned={main.key === pinned}
            onPin={pin}
            onUnpin={() => setPinned(null)}
            strip={showStrip}
            edge={fullscreen}
            onOpen={toggleFullscreen}
          />
        ) : (
          <Gallery
            items={items.filter((i) => i.kind === "person" || grid)}
            width={area.width - (fullscreen ? 32 : 24)}
            height={area.height - (fullscreen ? 128 : 0)}
            onPin={pin}
          />
        )}
      </div>
      <div
        className={`shrink-0 px-4 pb-4 pt-3 ${
          compact ? "flex justify-center" : "grid grid-cols-[1fr_auto_1fr] items-end gap-3"
        } ${floating("bottom")}`}
      >
        {!compact && <div />}
        <div className="flex min-w-0 flex-col items-center gap-2">
          <HuddleControls stage overlay={fullscreen} onOpenSettings={onOpenSettings} />
        </div>
        {!compact && (
          <div className="flex items-center justify-end gap-1">{viewButtons("top")}</div>
        )}
      </div>
    </section>
  );
}
