import { Suspense, lazy, useRef, useState, type KeyboardEvent } from "react";
import type { CallReaction } from "@ownbase/client-core";
import type { ID, User } from "@ownbase/protocol";
import { useClient } from "../context.js";
import { Avatar } from "./Avatar.js";
import { CustomEmojiImage, customEmojiFor, useCustomEmoji } from "./CustomEmoji.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { Icon } from "./Icon.js";

const ReactionPicker = lazy(() =>
  import("./ReactionPicker.js").then((module) => ({ default: module.ReactionPicker })),
);

/** Slack's huddle reactions, named for a screen reader, which reads an emoji's own name only now and then. */
export const QUICK_REACTIONS = [
  ["👍", "Thumbs up"],
  ["❤️", "Heart"],
  ["😂", "Laughing"],
  ["🎉", "Party"],
  ["👏", "Clapping"],
  ["😮", "Surprised"],
] as const;

/** Whether the person asked for less motion: then a reaction stands still on its tile. */
export const lessMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** An emoji as text, or a workspace's own `:name:` as its picture while it exists. */
function ReactionEmoji({ emoji }: { emoji: string }) {
  const known = customEmojiFor(useCustomEmoji(), emoji);
  return known ? <CustomEmojiImage emoji={known} /> : <>{emoji}</>;
}

/**
 * The quick reactions, in a row under the call's buttons, and the way to
 * every emoji. It stays open, so a 👏 can be pressed again and again.
 * In full screen the picker is left out, since a dialog opens out of sight.
 */
export function ReactionBar({
  inCall,
  overlay,
  onClose,
}: {
  inCall: boolean;
  overlay: boolean;
  onClose: () => void;
}) {
  const client = useClient();
  const [picking, setPicking] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const button = `flex size-10 shrink-0 items-center justify-center rounded-lg text-xl transition-[background-color,scale] active:scale-90 ${
    inCall ? "hover:bg-ink/[0.12]" : "hover:bg-ink/[0.06]"
  }`;
  // On the buttons rather than the row, so the picker's own Escape closes only it.
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose();
  };
  return (
    <div
      role="group"
      aria-label="Reactions"
      className={`flex basis-full flex-wrap items-center gap-0.5 ${
        inCall ? `justify-center ${overlay ? "rounded-xl bg-black/50 p-1" : ""}` : "justify-end"
      }`}
    >
      {QUICK_REACTIONS.map(([emoji, name]) => (
        <button
          key={emoji}
          type="button"
          aria-label={name}
          title={name}
          onClick={() => client.reactInHuddle(emoji)}
          onKeyDown={escape}
          className={button}
        >
          {emoji}
        </button>
      ))}
      {!overlay && (
        <button
          ref={more}
          type="button"
          aria-label="More emoji"
          title="More emoji"
          onClick={() => setPicking(true)}
          onKeyDown={escape}
          className={`${button} text-ink-dim`}
        >
          <Icon name="plus" size={18} />
        </button>
      )}
      {picking && (
        <ErrorBoundary fallback={null}>
          <Suspense fallback={null}>
            <ReactionPicker
              title="Send a reaction"
              anchor={more}
              onPick={(emoji) => client.reactInHuddle(emoji)}
              onClose={() => setPicking(false)}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
  );
}

/**
 * Reactions over their sender's tile: each rises `rise` pixels from near its
 * foot and fades over two seconds, or, for someone who asked for less
 * motion, the newest stands still in the corner opposite the name for as long.
 */
export function TileReactions({ reactions, rise }: { reactions: CallReaction[]; rise: number }) {
  if (reactions.length === 0) return null;
  if (lessMotion())
    return (
      <span
        aria-hidden="true"
        data-reaction="still"
        className="pointer-events-none absolute bottom-2 right-2 rounded-lg bg-black/65 px-1.5 py-0.5 text-xl"
      >
        <ReactionEmoji emoji={reactions.at(-1)!.emoji} />
      </span>
    );
  return (
    <>
      {reactions.map((reaction) => (
        <span
          key={reaction.id}
          aria-hidden="true"
          data-reaction="float"
          className="pointer-events-none absolute bottom-[18%] animate-call-react text-4xl drop-shadow"
          // Spread a little, so a quick run of them does not stack into one.
          style={{
            left: `${42 + ((reaction.id * 37) % 17) - 8}%`,
            ["--rise" as string]: `${rise}px`,
          }}
        >
          <ReactionEmoji emoji={reaction.emoji} />
        </span>
      ))}
    </>
  );
}

/**
 * The newest reaction beside the bar's faces, and in the dock over a
 * dialog, where there is no tile to rise from: the sender's face and the
 * emoji, for as long as it would float.
 */
export function ReactionTicker({
  reactions,
  users,
}: {
  reactions: readonly CallReaction[] | undefined;
  users: Record<ID, User>;
}) {
  const newest = reactions?.at(-1);
  if (!newest) return null;
  return (
    <span
      key={newest.id}
      aria-hidden="true"
      data-reaction="ticker"
      className="flex shrink-0 animate-badge-in items-center gap-1 rounded-full bg-ink/[0.06] py-0.5 pl-0.5 pr-1.5 text-base"
    >
      <Avatar user={users[newest.userId]} size={20} />
      <ReactionEmoji emoji={newest.emoji} />
    </span>
  );
}
