import { useEffect, useId, useRef, useState } from "react";
import {
  captureFailure,
  SCREEN_SHARE_QUALITY,
  type ScreenShareQuality,
} from "@slackoss/client-core";
import { useClient, usePlatform } from "../context.js";
import type { ShareableSource } from "../platform.js";
import { useTabs } from "../lib/useTabs.js";
import { Button } from "./Button.js";
import { Dialog, DialogScroll } from "./Dialog.js";
import { Icon } from "./Icon.js";

const TABS = ["windows", "screens"] as const;
type Tab = (typeof TABS)[number];

/** How long the pictures stay before they are taken again, while the picker is open. */
export const REFRESH_MS = 3000;
/** Where the last resolution and frame rate chosen are kept on this device. */
export const QUALITY_KEY = "screen-share-quality";
const RESOLUTIONS = [720, 1080] as const;
const FRAME_RATES = [15, 30, 60] as const;

/** A saved quality, each part that is not one on offer replaced by the default. */
function qualityOf(saved: unknown): ScreenShareQuality {
  const value = (saved ?? {}) as Record<string, unknown>;
  return {
    height: RESOLUTIONS.find((height) => height === value.height) ?? SCREEN_SHARE_QUALITY.height,
    frameRate:
      FRAME_RATES.find((rate) => rate === value.frameRate) ?? SCREEN_SHARE_QUALITY.frameRate,
  };
}

/**
 * The desktop app's screen picker, in the manner of Discord's: every window
 * and screen with a picture of it, kept fresh while open, and how sharp and
 * smooth to send it. Sharing names the choice to the main process, then asks
 * the huddle for a screen, which shares that one. A browser has no such list
 * to offer, and shows its own picker instead.
 */
export function ScreenShareDialog({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const platform = usePlatform();
  const screenShare = platform.screenShare!;
  const [sources, setSources] = useState<ShareableSource[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [listing, setListing] = useState(0);
  const [tab, setTab] = useState<Tab>("windows");
  const [chosen, setChosen] = useState<Partial<Record<Tab, string>>>({});
  const [quality, setQuality] = useState(SCREEN_SHARE_QUALITY);
  const [starting, setStarting] = useState(false);
  /** Share was pressed with nothing chosen, so the list says what it needs. */
  const [asked, setAsked] = useState(false);
  /** Why the app would not share what was chosen: it has gone since it was listed. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** What went wrong that the choice does not explain. */
  const [error, setError] = useState<string | null>(null);
  const descriptionId = useId();
  const problemId = useId();
  const group = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const tabs = useTabs({
    label: "What to share",
    tabs: TABS,
    selected: tab,
    onSelect: (next) => {
      setTab(next);
      setAsked(false);
      setRefusal(null);
    },
  });

  useEffect(() => {
    let live = true;
    void platform.storage
      .get(QUALITY_KEY)
      .then((saved) => {
        if (live) setQuality(qualityOf(saved));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [platform]);

  // The last list comes at once, where there has been one, then a fresh one,
  // which can take seconds; then again every few seconds while open, so the
  // pictures move and windows opened or closed meanwhile come and go. Only a
  // first fresh list that fails with nothing shown says so; after that the
  // pictures shown stay.
  useEffect(() => {
    let live = true;
    let shown = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const list = async (quick: boolean) => {
      try {
        const listed = await screenShare.sources({ quick });
        if (!live) return;
        if (listed) {
          // Nothing but screens: start where there is something to choose.
          if (!shown && !listed.some((source) => source.kind === "window")) setTab("screens");
          shown = true;
          setSources(listed);
        }
      } catch {
        if (!live) return;
        if (!quick && !shown) {
          setListFailed(true);
          return;
        }
      }
      if (quick) void list(false);
      else timer = setTimeout(() => void list(false), REFRESH_MS);
    };
    setListFailed(false);
    void list(true);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [screenShare, listing]);

  const shown = (sources ?? []).filter((source) =>
    tab === "windows" ? source.kind === "window" : source.kind === "screen",
  );
  // The first screen is chosen to begin with, so Share works at once. A
  // window is picked by hand: the one on top is usually this app, and one
  // picked for you could be one you never meant anyone to see.
  const chosenId = chosen[tab] ?? (tab === "screens" ? shown[0]?.id : undefined);
  const selected = shown.find((source) => source.id === chosenId) ?? null;

  // What Share needs, said beside the list once it was pressed with nothing
  // chosen. It follows the list: one arriving, or a window closing, changes it.
  const problem =
    refusal ??
    (!asked || selected || listFailed
      ? null
      : !sources
        ? "Still finding windows and screens. Choose one once they appear."
        : shown.length === 0
          ? tab === "windows"
            ? "Open the window you want to share first, or share a screen."
            : "There is no screen to share."
          : chosen[tab]
            ? tab === "windows"
              ? "That window has closed. Choose another."
              : "That screen is no longer connected. Choose another."
            : tab === "windows"
              ? "Choose a window to share."
              : "Choose a screen to share.");

  /** Focus goes where the choice is made: the one chosen, else the first; Try again; or Screens. */
  const toTheList = () => {
    if (listFailed) return retryRef.current?.focus();
    const radios = listRef.current?.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    if (radios?.length) return ([...radios].find((radio) => radio.checked) ?? radios[0]!).focus();
    if (sources && tab === "windows") document.getElementById(tabs.tabProps("screens").id)?.focus();
  };

  const changeQuality = (patch: Partial<ScreenShareQuality>) => {
    const next = { ...quality, ...patch };
    setQuality(next);
    void platform.storage.set(QUALITY_KEY, next).catch(() => {});
  };

  // Share is never off for want of a choice: pressed without one, it says
  // what to choose beside the list and puts focus there.
  const share = async (source: ShareableSource | null) => {
    if (starting) return;
    setError(null);
    setRefusal(null);
    if (!source) {
      setAsked(true);
      toTheList();
      return;
    }
    setAsked(false);
    setStarting(true);
    try {
      await screenShare.choose(source.id);
    } catch (err) {
      setStarting(false);
      // The choice has gone since it was listed: said beside the list.
      setRefusal(err instanceof Error && err.message ? err.message : "Choose another to share.");
      toTheList();
      return;
    }
    try {
      await client.toggleScreenShare(quality);
    } catch (err) {
      setStarting(false);
      // Chosen here, a refusal is not a closed picker, so it always says something.
      setError(captureFailure("screen", err) ?? "Screen sharing could not start. Try again.");
      return;
    }
    onClose();
  };

  let body;
  if (listFailed) {
    body = (
      <div role="alert" className="flex flex-col items-center gap-3 py-16 text-center text-sm">
        <p className="text-ink-dim">
          The screens and windows on this computer could not be listed.
        </p>
        <Button
          ref={retryRef}
          type="button"
          onClick={() => {
            setAsked(false);
            setListing((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  } else if (!sources) {
    body = (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <p role="status" className="sr-only">
          Finding screens and windows…
        </p>
        {/* One row: the list that arrives is as tall or taller, so nothing jumps up. */}
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} aria-hidden="true" className="space-y-2 p-1.5">
            <div className="aspect-video animate-pulse rounded-lg bg-ink/[0.05]" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-ink/[0.05]" />
          </div>
        ))}
      </div>
    );
  } else if (shown.length === 0) {
    body = (
      <p className="py-16 text-center text-sm text-ink-dim">
        {tab === "windows"
          ? "There is no window to share. Open the one you want, or share a screen."
          : "This computer offered no screen to share. If your system asks whether Tandem may record the screen, allow it, then try again."}
      </p>
    );
  } else {
    body = (
      <div
        ref={listRef}
        role="radiogroup"
        aria-label={tab === "windows" ? "Windows" : "Screens"}
        aria-invalid={!!problem || undefined}
        aria-describedby={problem ? problemId : undefined}
        className="grid grid-cols-2 gap-3 sm:grid-cols-3"
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void share(selected);
          }
        }}
      >
        {shown.map((source) => (
          <SourceTile
            key={source.id}
            source={source}
            group={group}
            checked={source.id === selected?.id}
            onChoose={() => {
              setChosen((was) => ({ ...was, [tab]: source.id }));
              setAsked(false);
              setRefusal(null);
              setError(null);
            }}
            onShare={() => void share(source)}
          />
        ))}
      </div>
    );
  }

  return (
    <Dialog
      title="Share your screen"
      onClose={onClose}
      width={780}
      describedBy={descriptionId}
      ownScroll
    >
      <div className="mx-6 mb-3 flex shrink-0 items-center gap-4">
        <div
          {...tabs.listProps}
          className="flex gap-1 rounded-xl border border-edge bg-deep/40 p-1"
        >
          {TABS.map((value) => (
            <button
              key={value}
              {...tabs.tabProps(value)}
              className={`rounded-md px-4 py-1.5 text-[13px] font-medium transition-colors ${tab === value ? "bg-lifted text-ink shadow-[0_1px_2px_rgb(0_0_0/0.2)]" : "text-ink-faint hover:text-ink"}`}
            >
              {value === "windows" ? "Windows" : "Screens"}
            </button>
          ))}
        </div>
        <p id={descriptionId} className="text-xs text-ink-faint">
          Everyone in the huddle sees what you share.
        </p>
      </div>
      <div {...tabs.panelProps} className="flex min-h-0 flex-1 flex-col">
        {problem && (
          <p
            id={problemId}
            role="alert"
            className="mx-6 mb-3 flex shrink-0 items-start gap-1.5 text-[13px] text-alert"
          >
            <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
            <span>{problem}</span>
          </p>
        )}
        <DialogScroll>
          {/* A steady height, so switching tabs or a list arriving does not jump the dialog. */}
          <div className="sm:min-h-[300px]">{body}</div>
        </DialogScroll>
      </div>

      <div className="dialog-foot border-t border-edge pt-4">
        {error && (
          <p role="alert" className="mb-3 text-sm text-alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div className="flex flex-wrap gap-x-5 gap-y-3">
            <Segmented
              legend="Resolution"
              options={RESOLUTIONS.map((height) => ({ value: height, label: `${height}p` }))}
              value={quality.height}
              onChange={(height) => changeQuality({ height })}
            />
            <Segmented
              legend="Frame rate"
              options={FRAME_RATES.map((rate) => ({ value: rate, label: `${rate} fps` }))}
              value={quality.frameRate}
              onChange={(frameRate) => changeQuality({ frameRate })}
            />
          </div>
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              aria-disabled={starting || undefined}
              onClick={() => void share(selected)}
            >
              <Icon name="screen" size={16} />
              {starting ? "Starting…" : tab === "windows" ? "Share window" : "Share screen"}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * One window or screen: its picture, and under it the app's icon and its
 * name. Choosing it is a radio button's choice; a double click, or Enter,
 * shares it.
 */
function SourceTile({
  source,
  group,
  checked,
  onChoose,
  onShare,
}: {
  source: ShareableSource;
  group: string;
  checked: boolean;
  onChoose: () => void;
  onShare: () => void;
}) {
  return (
    <label
      onDoubleClick={onShare}
      className={`group flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl p-1.5 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-copper ${
        checked ? "bg-copper/[0.08]" : "hover:bg-ink/[0.04]"
      }`}
    >
      <input
        type="radio"
        name={group}
        value={source.id}
        checked={checked}
        onChange={onChoose}
        className="sr-only"
      />
      <span
        className={`flex aspect-video items-center justify-center overflow-hidden rounded-lg border bg-deep transition-[border-color,box-shadow] ${
          checked
            ? "border-copper shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-copper)_25%,transparent)]"
            : "border-edge group-hover:border-ink-faint/50"
        }`}
      >
        {source.thumbnail ? (
          <img
            src={source.thumbnail}
            alt=""
            draggable={false}
            className="size-full object-contain"
          />
        ) : source.icon ? (
          <img src={source.icon} alt="" draggable={false} className="size-10 opacity-80" />
        ) : (
          <Icon name="screen" size={28} className="text-ink-faint" />
        )}
      </span>
      <span className="flex min-w-0 items-center gap-2 px-0.5 text-[13px]">
        {source.icon ? (
          <img src={source.icon} alt="" draggable={false} className="size-4 shrink-0" />
        ) : (
          <Icon name="screen" size={14} className="shrink-0 text-ink-faint" />
        )}
        <span className={`truncate ${checked ? "text-ink" : "text-ink-dim"}`} title={source.name}>
          {source.name}
        </span>
      </span>
    </label>
  );
}

/** A choice of a few, side by side, as radio buttons drawn as one bar. */
function Segmented<T extends number>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-medium text-ink-dim">{legend}</legend>
      <div className="flex gap-1 rounded-xl border border-edge bg-deep/40 p-1">
        {options.map((option) => (
          <label
            key={option.value}
            className={`cursor-pointer rounded-md px-3 py-1 text-[13px] font-medium tabular-nums transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-copper ${
              option.value === value
                ? "bg-lifted text-ink shadow-[0_1px_2px_rgb(0_0_0/0.2)]"
                : "text-ink-faint hover:text-ink"
            }`}
          >
            <input
              type="radio"
              name={name}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
