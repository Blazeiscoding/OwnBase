import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import type { WorkspaceState } from "@slackoss/client-core";
import type { ID } from "@slackoss/protocol";
import { PlatformContext, useClient, useWorkspace } from "../context.js";
import {
  readWorkspaceStorage,
  workspaceStorageKey,
  writeWorkspaceStorage,
} from "../lib/workspaceStorage.js";
import { buttonClass } from "./Button.js";
import { Icon } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";

interface Saved {
  /** A message of theirs was seen here once, so a reload need not find it again. */
  posted?: boolean;
  /** Put away, or Keep this account was chosen: it is not offered again. */
  closed?: boolean;
}

/**
 * Offers put away on this page. Saving that can fail, and the offer must not
 * then come back when the sidebar is drawn again, so the page remembers too.
 */
const closedHere = new Set<string>();

/**
 * Whether the replica holds a message this account wrote. Only the server's
 * copy of a message is in a timeline or a thread; one still sending, or one
 * that failed, waits in `pending` instead.
 */
function hasPosted(state: WorkspaceState, selfId: ID): boolean {
  for (const timeline of Object.values(state.timelines))
    if (timeline.items.some((message) => message.userId === selfId)) return true;
  for (const replies of Object.values(state.threads))
    if (replies.some((message) => message.userId === selfId)) return true;
  return false;
}

/**
 * UX-44: once a guest has posted, the sidebar offers to keep them as an
 * account, saying what they keep. Never before their first message reaches
 * the server, and once only: put away or taken up, it does not come back for
 * that account on this device. Gone as soon as they are a member.
 */
export function KeepAccountOffer(props: {
  /** Opens the same form as Create an account in the menus. */
  onKeep: () => void;
}) {
  const platform = useContext(PlatformContext);
  const client = useClient();
  const self = useWorkspace((s) => s.self);
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const guest = self?.role === "guest";
  const selfId = self?.id;
  const key = useMemo(() => {
    if (!guest) return null;
    const scoped = workspaceStorageKey(client.baseUrl, workspaceId, selfId, "keep-account-offer");
    return scoped && { key: scoped.key };
  }, [guest, client.baseUrl, workspaceId, selfId]);
  // What this device has for the account; "unreadable" when storage failed.
  const [saved, setSaved] = useState<{ key: string; value: Saved | "unreadable" } | null>(null);
  const current = key && saved?.key === key.key ? saved.value : null;
  const section = useRef<HTMLElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!key) return;
    let alive = true;
    const read = async (): Promise<Saved | "unreadable"> => {
      // Whether it was put away already cannot be told, so it is not offered:
      // the menus still have Create an account.
      if (!platform) return "unreadable";
      try {
        const value = await readWorkspaceStorage<Saved>(platform, key);
        return value && typeof value === "object" ? value : {};
      } catch {
        return "unreadable";
      }
    };
    void read().then((value) => {
      if (alive) setSaved({ key: key.key, value });
    });
    return () => {
      alive = false;
    };
  }, [platform, key]);

  const known = current !== null && current !== "unreadable" ? current : null;
  const open = !!key && !!known && !known.closed && !closedHere.has(key.key);
  // Looked for only until found: a message seen once is written down.
  const watching = open && !known?.posted;
  const postedNow = useWorkspace((s) => watching && selfId !== undefined && hasPosted(s, selfId));

  const save = (next: Saved) => {
    if (!key) return;
    setSaved({ key: key.key, value: next });
    // Losing this costs a reload the offer, or the record of a post; nothing to report.
    if (platform) writeWorkspaceStorage(platform, key, next).catch(() => {});
  };

  useEffect(() => {
    if (postedNow && known && !known.posted) save({ ...known, posted: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postedNow, known]);

  if (!open || !key || !known || !(known.posted || postedNow)) return null;

  /**
   * Puts the offer away. Focus held in it goes to the account button below,
   * where Create an account still is, rather than to the top of the page.
   */
  const close = () => {
    if (section.current?.contains(document.activeElement))
      section.current.parentElement
        ?.querySelector<HTMLElement>(".user-panel [aria-haspopup]")
        ?.focus({ preventScroll: true });
    closedHere.add(key.key);
    save({ ...known, closed: true });
  };

  return (
    // The sidebar is as wide as what it holds. Contained, the card takes the
    // width the rail and the list give it, rather than one line of its words.
    <section
      ref={section}
      aria-labelledby={titleId}
      className="card-warm mx-2 mb-2 shrink-0 animate-rise-in rounded-xl p-3 [contain:inline-size]"
    >
      <div className="flex items-start gap-2">
        <h2 id={titleId} className="min-w-0 flex-1 pt-0.5 text-[13px] font-semibold">
          You're a guest for a day
        </h2>
        <Tooltip label="Not now">
          <button
            type="button"
            onClick={close}
            aria-label="Not now"
            className="-mr-1 -mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink"
          >
            <Icon name="close" size={14} />
          </button>
        </Tooltip>
      </div>
      <p className="mt-1 text-[12.5px] leading-snug text-ink-dim">
        An account keeps your name and your messages, and gives you a place in private
        conversations.
      </p>
      <button
        type="button"
        onClick={() => {
          close();
          props.onKeep();
        }}
        className={buttonClass("primary", "mt-3 w-full")}
      >
        Keep this account
      </button>
    </section>
  );
}
