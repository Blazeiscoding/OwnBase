import { Suspense, lazy, type ComponentProps } from "react";
import type { PendingPoll as PendingPollCard, PollCard as PollCardView } from "./PollCard.js";
import { preloadable } from "../lib/preloadable.js";

/**
 * Polls, kept out of the first download (it was at its 750 kB limit) and
 * fetched as the workspace opens, so a poll on screen draws directly almost
 * always. Before then it holds a card's place, so nothing below it jumps far.
 */
export const pollCards = preloadable(() => import("./PollCard.js"));

const LazyPollCard = lazy(() => pollCards.load().then((module) => ({ default: module.PollCard })));
const LazyPendingPoll = lazy(() =>
  pollCards.load().then((module) => ({ default: module.PendingPoll })),
);

function Placeholder() {
  return (
    <div
      aria-busy="true"
      className="mt-1 min-h-[132px] max-w-xl rounded-xl border border-edge bg-ink/[0.025]"
    />
  );
}

export function PollCard(props: ComponentProps<typeof PollCardView>) {
  const loaded = pollCards.loaded();
  if (loaded) return <loaded.PollCard {...props} />;
  return (
    <Suspense fallback={<Placeholder />}>
      <LazyPollCard {...props} />
    </Suspense>
  );
}

export function PendingPoll(props: ComponentProps<typeof PendingPollCard>) {
  const loaded = pollCards.loaded();
  if (loaded) return <loaded.PendingPoll {...props} />;
  return (
    <Suspense fallback={<Placeholder />}>
      <LazyPendingPoll {...props} />
    </Suspense>
  );
}
