import type { CSSProperties } from "react";

/**
 * Most icons are one path. Six are drawn in named parts, after Its Hover's
 * (itshover.com, Apache-2.0), so that a part can move by itself: theme.css
 * plays their motion inside a control marked `icon-live` while it is pointed at.
 */
const paths = {
  activity: "M3 12h4l3-8 4 16 3-8h4",
  search: "m21 21-5-5M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0",
  menu: "M4 6h16M4 12h16M4 18h16",
  /** A bulleted list, and a numbered one: the formatting toolbar's list buttons. */
  bullets:
    "M9.5 6H20M9.5 12H20M9.5 18H20M4 6a1 1 0 1 0 2 0 1 1 0 1 0-2 0M4 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0M4 18a1 1 0 1 0 2 0 1 1 0 1 0-2 0",
  numbers:
    "M10 6h10M10 12h10M10 18h10M4 4.5 5.5 3.5v5M4 14.75a1.25 1.25 0 0 1 2.5 0c0 1.25-2.5 2-2.5 3.75h2.5",
  close: "m6 6 12 12M6 18 18 6",
  /** A flag: report a message to the admins (E12). */
  flag: "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7",
  /** A circle struck through: someone blocked (E12). */
  ban: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M4.9 4.9l14.2 14.2",
  hash: "m10 3-4 18M18 3l-4 18M4 9h17M3 15h17",
  friends:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  pin: "m16 3 5 5-4 1-4 5v4l-7-7h4l5-4zM9 15l-6 6",
  /** A five-pointed star: a conversation kept at the top of the sidebar. */
  star: "M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9z",
  bookmark: { ribbon: "M12 17l8.5 5V4A2.5 2.5 0 0 0 18 1.5H6A2.5 2.5 0 0 0 3.5 4v18z" },
  clock: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M12 6v6l4 2",
  attach: "m21 11-9 9a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8L15 6",
  send: "m22 2-7 20-4-9-9-4zM22 2 11 13",
  headphones: "M3 14v-3a9 9 0 0 1 18 0v3M3 13h4v8H3zM17 13h4v8h-4z",
  /** A handset crossed out: say no to a call (E10). */
  phoneOff:
    "M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91M22 2 2 22",
  /** A handset with a cross by it: a call nobody answered (E10). */
  phoneMissed:
    "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92zM22 2l-6 6M16 2l6 6",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  thread: {
    bubble:
      "M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719",
  },
  /** An arrow turning back: answering a message in place, beside it rather than in a thread. */
  reply: { arrow: "m9 14-4-4 4-4M5 10h11a4 4 0 1 1 0 8h-1" },
  /** An arrow passing a message on, for Forward. */
  forward: "m15 17 5-5-5-5M4 18v-2a4 4 0 0 1 4-4h12",
  /** Triangle with an exclamation mark, for failure states. */
  alert: "M12 3 2.5 20h19zM12 10v4M12 17.5h.01",
  /** A ringed i, for a heads-up that is neither good news nor a failure. */
  info: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M12 16v-4.5M12 8h.01",
  /** Three dots, each a ring so small that a stroke of 2 fills it. */
  dots: {
    top: "M11 5a1 1 0 1 0 2 0 1 1 0 1 0-2 0",
    middle: "M11 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0",
    bottom: "M11 19a1 1 0 1 0 2 0 1 1 0 1 0-2 0",
  },
  check: "m4 12 5 5L20 7",
  plus: "M12 5v14M5 12h14",
  /** A pencil. The line across it is hidden until the pencil moves. */
  edit: {
    line: "m15 4.5 4.5 4.5",
    pencil: "M7.875 20.625l-6 1.5 1.5-6L16.693 2.807a3.182 3.182 0 0 1 4.5 4.5z",
  },
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6",
  lock: "M6 11h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM8 11V7a4 4 0 0 1 8 0v4",
  at: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8",
  /** Its Hover draws no smile: this is its level-mouthed face with the mouth turned up. */
  smile: {
    face: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
    mouth: "M8 14s1.5 2 4 2 4-2 4-2",
    eyes: "M9 9h.01M15 9h.01",
  },
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0",
  /** Notifications paused: the pause control, and a muted channel. */
  bellOff:
    "M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7M10.3 21a1.94 1.94 0 0 0 3.4 0M2 2l20 20",
  /** A message with a dot on it: read from here on again. */
  markUnread:
    "M11.7 3H5a2 2 0 0 0-2 2v16l4-4h12a2 2 0 0 0 2-2v-2.7M21 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  fileText:
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
  fileCode:
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M10 12l-2 2.5 2 2.5M14 12l2 2.5-2 2.5",
  fileArchive:
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M10 6h1M10 9h1M10 12h1M9 15h3v3H9z",
  film: "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM7 3v18M17 3v18M3 12h18M3 7.5h4M3 16.5h4M17 7.5h4M17 16.5h4",
  music: "M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  mic: "M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zM19 10v1a7 7 0 0 1-14 0v-1M12 18v4",
  micOff:
    "M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.7M19 10v1a7 7 0 0 1-10.8 5.9M5 11a7 7 0 0 0 10 6.3M12 18v4M3 3l18 18",
  /** A speaker with sound coming out: how loud someone is to you. */
  volume: "M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14",
  /** A speaker crossed out: someone muted for you alone. */
  volumeOff: "M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6",
  camera:
    "M15 10l4.5-2.7a.6.6 0 0 1 .9.5v8.4a.6.6 0 0 1-.9.5L15 14M4 6h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z",
  screen: "M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9 21h6M12 16v5",
  leave: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  grid: "M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z",
  /** Bars of different lengths off an axis: a poll and how it is going. */
  poll: "M3 3v18h18M7 7h9M7 12h12M7 17h5",
  /** Arrows out to the corners: make this bigger. */
  expand: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  /** Arrows in from the corners: make this smaller again. */
  shrink: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
  fullscreen:
    "M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3",
  fullscreenExit:
    "M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3",
  chevronDown: "m6 9 6 6 6-6",
  chevronUp: "m18 15-6-6-6 6",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  members:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  compass: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M16.2 7.8l-2.1 6.3-6.3 2.1 2.1-6.3z",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  refresh: "M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5",
  userPlus:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M19 8v6M22 11h-6",
  keyboard:
    "M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10",
  help: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01",
  /** A dial: Diagnostics, how the app and its connection are doing. */
  gauge: "m12 14 4-4M3.34 19a10 10 0 1 1 17.32 0",
  /** A server: where a hosted workspace runs. */
  server:
    "M4 3h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM4 13h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zM7 7h.01M7 17h.01",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8",
  sparkle: "M12 3l1.9 5.6L19.5 10.5 13.9 12.4 12 18l-1.9-5.6L4.5 10.5l5.6-1.9zM19 3v4M21 5h-4",
  /** A house: the phone's bottom bar's way back to the conversations. */
  home: "M3 10.5 12 3l9 7.5M5 9v11a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9",
  /** Two speech bubbles: conversations with people rather than rooms. */
  messages:
    "M3 5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H8l-5 4zM18 8h1a2 2 0 0 1 2 2v11l-4-3h-6a2 2 0 0 1-2-2v-1",
} as const;

export type IconName = keyof typeof paths;

/** Small inline vectors: no icon font, network request, or runtime dependency. */
export function Icon({
  name,
  size = 18,
  style,
  className,
  strokeWidth = 1.7,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
  className?: string;
  strokeWidth?: number;
}) {
  const drawing: string | Record<string, string> = paths[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={"shrink-0" + (className ? ` ${className}` : "")}
      style={style}
      data-icon={typeof drawing === "string" ? undefined : name}
    >
      {typeof drawing === "string" ? (
        <path d={drawing} />
      ) : (
        // A length of 1 lets the stylesheet draw a part in, as a dash that grows.
        Object.entries(drawing).map(([part, d]) => (
          <path key={part} data-part={part} pathLength={1} d={d} />
        ))
      )}
    </svg>
  );
}

export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="40" height="40" rx="12" fill="currentColor" className="text-copper" />
      <path
        d="M20 11.5a6 6 0 1 1 0 12a6 6 0 1 1 0-12M12 28h16"
        stroke="var(--color-ground)"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
