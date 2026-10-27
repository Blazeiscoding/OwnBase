import { useEffect, useMemo, useRef, useState } from "react";
import {
  OUTBOX_TOMBSTONES_KEPT,
  keepBothDrafts,
  outboxRevision,
  storedPending,
  type DraftChanges,
  type StoredOutbox,
  type StoredOutboxEntry,
} from "@ownbase/client-core";
import { useClient, useWorkspace } from "../context.js";
import type { Platform } from "../platform.js";
import {
  mergeWorkspaceDrafts,
  mergeWorkspaceDraftsAtOnce,
  mergeWorkspaceOutbox,
  readWorkspaceDrafts,
  readWorkspaceOutbox,
  readWorkspaceStorage,
  updateWorkspaceStorage,
  watchWorkspaceDrafts,
  watchWorkspaceOutbox,
  workspaceStorageKey,
  writeWorkspaceStorage,
} from "../lib/workspaceStorage.js";
import { readDraftTimes } from "../lib/drafts.js";
import { keepLocalWork, settleLocalWork, waitingLocalWork } from "../lib/localWork.js";

/** A send's words kept for a restart while the outbox could not store them. */
interface UnstoredSend {
  draftKey: string;
  text: string;
}

function validUnstored(value: unknown): value is Record<string, UnstoredSend> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (send: Partial<UnstoredSend> | null) =>
        !!send && typeof send.draftKey === "string" && typeof send.text === "string",
    )
  );
}

/** The composer a send came from, as `Composer` keys its draft. */
const composerOf = (send: Pick<StoredOutboxEntry, "channelId" | "threadRootId">) =>
  send.threadRootId ? `${send.channelId}:${send.threadRootId}` : send.channelId;

/**
 * What makes `base` into `drafts`: each draft that differs, alone, with the
 * text it is changed from, so a draft another window changed meanwhile is
 * kept beside this one rather than replaced (GL-03).
 */
function draftChanges(drafts: Record<string, string>, base: Record<string, string>): DraftChanges {
  const put: Record<string, string> = {};
  for (const [key, text] of Object.entries(drafts)) if (base[key] !== text) put[key] = text;
  const remove = Object.keys(base).filter((key) => !(key in drafts));
  const from: Record<string, string | null> = {};
  for (const key of [...Object.keys(put), ...remove]) from[key] = base[key] ?? null;
  return { put, remove, base: from };
}

/** The changes to the drafts `keep` accepts, and no others. */
function draftChangesTo(changes: DraftChanges, keep: (key: string) => boolean): DraftChanges {
  const only = <T,>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => keep(key)));
  return {
    put: only(changes.put),
    remove: changes.remove.filter(keep),
    base: only(changes.base ?? {}),
  };
}

/** How many times in a row a window writes its sends again after another's write left them out. */
const REPAIRS = 3;

/**
 * Keeps unsent work on this device, scoped to the authenticated workspace and
 * account.
 *
 * Every window open on the account shares one stored outbox. Each writes only
 * its own sends and the ones it saw delivered or discarded, merged in one step
 * by the platform (see `mergeWorkspaceOutbox`), and takes on what the others
 * wrote about the sends it holds: one taken out elsewhere goes here too, and a
 * refusal given elsewhere stops it here until its author chooses Retry.
 *
 * Drafts are shared the same way. A window writes only the drafts it changed
 * (see `mergeWorkspaceDrafts`), so one typed in one conversation is not lost
 * to another window's write about a different one, and a draft cleared or
 * sent elsewhere is not put back by a window that still showed it. A window
 * takes on the drafts the others change, except one it has its own change to
 * not yet written: that is written next, and the later edit is the draft.
 *
 * A send is kept on this device once the outbox write carrying it resolves;
 * from then a restart brings it back. Until then a draft already saved with
 * its words stays saved: a draft is written only after the outbox write
 * before it has succeeded, so a process that dies in between comes back with
 * the words in the composer rather than losing both. A write that fails says
 * so, keeps the draft as it was on disk, and is made again on Retry.
 *
 * A page that is hidden or closing writes at once, waiting for nothing, since
 * it may not live to: its outbox, and each draft it changed except one a send
 * not yet stored came from, which still waits for the outbox write (F01).
 *
 * When each draft last changed is kept beside them, for the Drafts list's
 * order: read on restoring, and written after each drafts write of this
 * window's own for the drafts it wrote. Only order rides on it, so a write
 * that fails, or that another window's at the same moment replaces, is let go.
 *
 * Words sent before their draft was first saved have no saved draft to fall
 * back on. While outbox writes fail, the sends the outbox has not stored are
 * kept by nonce under a key of their own, and a restart puts any the outbox
 * still does not hold back in their composer: their words come back once, as
 * a draft or as a send, never as both. An ordinary send writes nothing there.
 */
export function DraftPersistence({ platform }: { platform: Platform }) {
  const client = useClient();
  const selfId = useWorkspace((s) => s.self?.id);
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const keys = useMemo(
    () => ({
      drafts: workspaceStorageKey(client.baseUrl, workspaceId, selfId, "drafts"),
      draftTimes: workspaceStorageKey(client.baseUrl, workspaceId, selfId, "draft-times"),
      outbox: workspaceStorageKey(client.baseUrl, workspaceId, selfId, "outbox"),
      unstored: workspaceStorageKey(client.baseUrl, workspaceId, selfId, "unstored-sends"),
    }),
    [client, workspaceId, selfId],
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const retry = useRef<(() => void) | null>(null);

  useEffect(() => {
    const draftKey = keys.drafts;
    const outboxKey = keys.outbox;
    const unstoredKey = keys.unstored;
    const timesKey = keys.draftTimes;
    const self = selfId;
    if (!draftKey || !outboxKey || !unstoredKey || !timesKey || !self) return;
    let disposed = false;
    let loaded = false;
    let loading = false;
    let restoring: Promise<void> | null = null;
    const writes = new Set<Promise<unknown>>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let currentDrafts = client.state.drafts;
    const editedDrafts = new Set<string>();
    // The drafts as this window last knew them stored. What differs from it
    // in memory is this window's own, not yet written; nothing else is.
    let baseDrafts: Record<string, string> = {};
    // Draft changes asked for and not yet answered, oldest first. A write
    // asked for at once does not wait for them, so it is made from what they
    // will have stored, and so is every write asked for while it is out.
    const unanswered: DraftChanges[] = [];
    const expectedDrafts = () => {
      const drafts = { ...baseDrafts };
      for (const changes of unanswered) {
        for (const key of changes.remove) delete drafts[key];
        Object.assign(drafts, changes.put);
      }
      return drafts;
    };
    const answered = (changes: DraftChanges | null) => {
      const at = changes ? unanswered.indexOf(changes) : -1;
      if (at >= 0) unanswered.splice(at, 1);
    };
    // This window's sends as it last wrote or took them on, and the ones it
    // saw leave. Every write carries all of them: the merge keeps the newest
    // of each, so writing one again changes nothing, and puts back one that
    // another window's write left out.
    const held = new Map<string, { entry: StoredOutboxEntry; json: string }>();
    const gone = new Map<string, number>();
    let revision = 0;
    let outboxChanged = false;
    let outboxWrite: Promise<unknown> = Promise.resolve();
    let repairs = 0;
    // Set while this window takes on what is stored, so the client's changes
    // along the way are not mistaken for its own new ones.
    let quiet = false;
    const versions = { drafts: 0, outbox: 0 };
    const failing = new Set<keyof typeof versions>();
    // Sends this window has seen stored: the outbox holds their words.
    const stored = new Set<string>();
    // For each send seen stored, the outbox's floor then (`compactedThrough`).
    const floorWhenStored = new Map<string, number>();
    // Words brought back from the unstored key, kept there until a drafts
    // write has them; and that key's content as last written, as JSON.
    let carried: Record<string, UnstoredSend> = {};
    let unstoredJson = "{}";
    // Whether the write of `unstoredJson` succeeded; pending while it is out.
    let unstoredWrite: Promise<boolean> = Promise.resolve(true);
    setError(null);
    // Sends wait for this to say their words are kept here (GL-02).
    const releaseKeeper = keepLocalWork(client);
    const acknowledge = () => {
      const pending = new Set(client.state.pending.map((p) => p.nonce));
      for (const nonce of waitingLocalWork(client))
        if (stored.has(nonce) || !pending.has(nonce)) settleLocalWork(client, nonce, "stored");
    };

    // While outbox writes fail, keeps the words of every send this window
    // holds that the outbox has not stored, and afterwards takes them out.
    const keepUnstored = () => {
      const want: Record<string, UnstoredSend> = { ...carried };
      if (failing.has("outbox")) {
        for (const [nonce, { entry }] of held) {
          if (!stored.has(nonce) && entry.text) {
            want[nonce] = { draftKey: composerOf(entry), text: entry.text };
          }
        }
      }
      const json = JSON.stringify(want);
      // A send whose words are written here is kept on this device too.
      const told = (outcome: "stored" | "unsaved") => {
        for (const nonce of waitingLocalWork(client))
          if (want[nonce]) settleLocalWork(client, nonce, outcome);
      };
      // The same words written already, or still being written: kept once
      // that write is, never before (GL-02).
      if (json !== unstoredJson) {
        unstoredJson = json;
        unstoredWrite = writeWorkspaceStorage(platform, unstoredKey, want).then(
          () => true,
          () => {
            // Unknown now: write it again next time.
            if (unstoredJson === json) unstoredJson = "";
            return false;
          },
        );
      }
      void unstoredWrite.then((saved) => told(saved ? "stored" : "unsaved"));
    };

    // The latest write of each part decides whether saving has failed.
    const save = (part: keyof typeof versions, write: Promise<unknown>) => {
      const version = ++versions[part];
      const settle = (saved: boolean) => {
        if (version !== versions[part]) return;
        if (saved) failing.delete(part);
        else failing.add(part);
        if (!disposed)
          setError(
            failing.size
              ? "Could not save drafts and queued messages on this device. Keep it open and retry."
              : null,
          );
        if (loaded) keepUnstored();
      };
      const completion = write.then(
        () => settle(true),
        () => settle(false),
      );
      writes.add(completion);
      void completion.then(() => writes.delete(completion));
      return completion;
    };

    const forget = (nonce: string, rev: number) => {
      held.delete(nonce);
      floorWhenStored.delete(nonce);
      gone.delete(nonce);
      gone.set(nonce, rev);
      if (gone.size > OUTBOX_TOMBSTONES_KEPT) gone.delete(gone.keys().next().value!);
    };

    // Gives each send whose stored form changed here a new revision, and each
    // one that left a tombstone. True when there is something to write.
    const observe = () => {
      const now = new Set<string>();
      let changed = false;
      for (const pending of client.outboxSnapshot()) {
        const entry = storedPending(pending);
        now.add(entry.nonce);
        const json = JSON.stringify(entry);
        if (held.get(entry.nonce)?.json === json) continue;
        revision = outboxRevision(revision);
        held.set(entry.nonce, { entry: { ...entry, rev: revision }, json });
        changed = true;
      }
      for (const nonce of [...held.keys()]) {
        if (now.has(nonce)) continue;
        revision = outboxRevision(revision);
        forget(nonce, revision);
        changed = true;
      }
      return changed;
    };

    // Revisions written from here on are newer than anything stored, the
    // floor included, so a new send is never taken for one let go.
    const seen = (record: StoredOutbox) => {
      for (const r of [...record.entries, ...record.removed]) revision = Math.max(revision, r.rev);
      revision = Math.max(revision, record.compactedThrough ?? 0);
    };

    // Takes on what other windows wrote about this window's sends. True when
    // something of this window's is missing from what is stored.
    const reconcile = (record: StoredOutbox | null): boolean => {
      if (!record) return held.size > 0 || gone.size > 0;
      seen(record);
      const inStore = new Map(record.entries.map((entry) => [entry.nonce, entry]));
      const removed = new Map(record.removed.map((r) => [r.nonce, r.rev]));
      const floor = record.compactedThrough ?? -1;
      const dropped: string[] = [];
      const refused: StoredOutboxEntry[] = [];
      let missing = false;
      for (const [nonce, mine] of held) {
        const theirs = inStore.get(nonce);
        if (theirs) floorWhenStored.set(nonce, floor);
        if (removed.has(nonce)) dropped.push(nonce);
        else if (!theirs && mine.entry.rev <= floor) {
          // The merge refuses it now. If the floor has risen since this window
          // last saw it stored, it was taken out and its tombstone let go
          // since. If not, whatever left it out was no removal (a tab writing
          // over another, or a send never stored), so it goes back newer.
          const was = floorWhenStored.get(nonce);
          if (was !== undefined && floor > was) {
            removed.set(nonce, floor);
            dropped.push(nonce);
          } else {
            revision = outboxRevision(revision);
            held.set(nonce, { entry: { ...mine.entry, rev: revision }, json: mine.json });
            missing = true;
          }
        } else if (!theirs || theirs.rev < mine.entry.rev) missing = true;
        else if (
          theirs.rev > mine.entry.rev &&
          theirs.refusal !== undefined &&
          mine.entry.refusal === undefined
        )
          refused.push(theirs);
      }
      for (const nonce of gone.keys()) if (inStore.has(nonce)) missing = true;
      for (const nonce of dropped) {
        forget(nonce, removed.get(nonce)!);
        client.discardSend(nonce);
      }
      for (const theirs of refused) {
        held.set(theirs.nonce, { entry: theirs, json: JSON.stringify(storedPending(theirs)) });
        client.adoptRefusal(theirs.nonce, theirs.refusal!);
      }
      return missing;
    };

    // Takes on what other windows stored: a draft changed there replaces this
    // window's, unless this window has its own change to it not yet written,
    // which its next write puts over it. `written` is what this window just
    // wrote, now known stored.
    const takeOnDrafts = (stored: Record<string, string>, written?: DraftChanges) => {
      const next = { ...currentDrafts };
      let changed = false;
      let conflicted = false;
      const mine = new Set<string>();
      if (written) {
        for (const key of written.remove) {
          delete baseDrafts[key];
          // Kept: another window wrote to it since, and that text comes back.
          if (stored[key] === undefined) mine.add(key);
          else conflicted = true;
        }
        for (const [key, text] of Object.entries(written.put)) {
          baseDrafts[key] = text;
          if (stored[key] === text) mine.add(key);
          else if (stored[key] !== undefined) {
            // Both windows changed it: the store kept both texts (GL-03). Typing
            // here since keeps its place beside them.
            conflicted = true;
            if (currentDrafts[key] !== text) {
              // The store holds this window's write beside the other's; the
              // typing since replaces that write, not joins it.
              const theirs = stored[key].startsWith(`${text}\n\n`)
                ? stored[key].slice(text.length + 2)
                : stored[key];
              next[key] = keepBothDrafts(currentDrafts[key] ?? "", theirs);
              baseDrafts[key] = stored[key];
              mine.add(key);
              changed = true;
            }
          }
        }
      }
      if (conflicted)
        setNotice("Another window changed this draft too, so both versions are kept in it.");
      for (const key of new Set([...Object.keys(stored), ...Object.keys(baseDrafts)])) {
        if (mine.has(key) || stored[key] === baseDrafts[key]) continue;
        // A change of this window's own not yet written keeps the text it was
        // changed from, so the write carrying it finds the other window's
        // text there and keeps both, rather than replacing it (GL-03).
        if (currentDrafts[key] !== baseDrafts[key]) continue;
        if (stored[key] === undefined) delete next[key];
        else next[key] = stored[key];
        changed = true;
        if (stored[key] === undefined) delete baseDrafts[key];
        else baseDrafts[key] = stored[key];
      }
      if (changed) quietly(() => client.hydrateDrafts(next));
    };

    // The times of the drafts this window just wrote, beside them; and none
    // for a draft no longer stored.
    const writeTimes = (changes: DraftChanges, stored: Record<string, string>) => {
      const times = client.state.draftTimes;
      void updateWorkspaceStorage(platform, timesKey, (current) => {
        const next = readDraftTimes(current);
        for (const key of Object.keys(changes.put))
          if (times[key] !== undefined) next[key] = times[key];
        for (const key of Object.keys(next)) if (!(key in stored)) delete next[key];
        return next;
      }).catch(() => {});
    };

    // What a drafts write that came back stored, taken on.
    const draftsWritten = (
      merged: { changes: DraftChanges; drafts: Record<string, string> } | null,
      bringing: Record<string, UnstoredSend>,
    ) => {
      if (merged) writeTimes(merged.changes, merged.drafts);
      if (merged && !disposed && loaded) takeOnDrafts(merged.drafts, merged.changes);
      else if (merged) {
        for (const key of merged.changes.remove) delete baseDrafts[key];
        Object.assign(baseDrafts, merged.changes.put);
      }
      // The drafts now hold what came back; the unstored key need not.
      if (carried === bringing && unanswered.length === 0) carried = {};
    };

    // Writes the drafts this window changed, and only those, once the outbox
    // write before it has finished.
    const saveDrafts = (drafts: () => Record<string, string> = () => currentDrafts) => {
      const bringing = carried;
      let asked: DraftChanges | null = null;
      return save(
        "drafts",
        outboxWrite
          .then(() =>
            mergeWorkspaceDrafts(platform, draftKey, () => {
              asked = draftChanges(drafts(), expectedDrafts());
              // None to make: nothing is written, nor waited for.
              if (Object.keys(asked.put).length || asked.remove.length) unanswered.push(asked);
              return asked;
            }),
          )
          .then(
            (merged) => {
              answered(asked);
              draftsWritten(merged, bringing);
            },
            (error: unknown) => {
              answered(asked);
              throw error;
            },
          ),
      );
    };

    // Writes the drafts this window changed now, waiting for no other write,
    // for a page that may be closing (F01). A draft a send not yet stored came
    // from is left to `saveDrafts`, after the outbox write: it may be the
    // only copy of the send's words.
    const saveDraftsAtOnce = () => {
      const waiting = new Set<string>();
      for (const [nonce, { entry }] of held) if (!stored.has(nonce)) waiting.add(composerOf(entry));
      const changes = draftChangesTo(
        draftChanges(currentDrafts, expectedDrafts()),
        (key) => !waiting.has(key),
      );
      if (Object.keys(changes.put).length === 0 && changes.remove.length === 0) return;
      const bringing = carried;
      unanswered.push(changes);
      void save(
        "drafts",
        mergeWorkspaceDraftsAtOnce(platform, draftKey, changes).then(
          (drafts) => {
            answered(changes);
            draftsWritten({ changes, drafts }, bringing);
          },
          (error: unknown) => {
            answered(changes);
            // Not stored after all: written again in turn, if this page lives.
            if (loaded && !disposed) void saveDrafts();
            throw error;
          },
        ),
      );
    };
    const saveOutbox = () => {
      const write = mergeWorkspaceOutbox(platform, outboxKey, {
        put: [...held.values()].map((h) => h.entry),
        remove: [...gone].map(([nonce, rev]) => ({ nonce, rev })),
      }).then((record) => {
        for (const entry of record.entries) if (held.has(entry.nonce)) stored.add(entry.nonce);
        for (const nonce of stored) if (!held.has(nonce)) stored.delete(nonce);
        acknowledge();
        if (!disposed && loaded) takeOn(record);
        // Drafts held back by a failed outbox write can go now.
        if (loaded && failing.has("drafts")) void saveDrafts();
      });
      outboxWrite = write;
      return save("outbox", write);
    };
    const quietly = <T,>(step: () => T): T => {
      quiet = true;
      try {
        return step();
      } finally {
        quiet = false;
      }
    };
    // Writing again when something is missing is bounded, so two windows that
    // disagree about what is stored cannot keep each other writing.
    const takeOn = (record: StoredOutbox | null) => {
      const missing = quietly(() => reconcile(record));
      if (observe()) void saveOutbox();
      else if (!missing) repairs = 0;
      else if (repairs++ < REPAIRS) void saveOutbox();
    };

    // The client and keys belong to this effect, including its final flush.
    // A new connection must never write its drafts into the previous scope.
    const flush = () => {
      clearTimeout(timer);
      if (!loaded) return;
      void saveOutbox();
      saveDraftsAtOnce();
      void saveDrafts();
    };
    const unsubscribe = client.store.subscribe((state, previous) => {
      if (state.drafts !== previous.drafts) {
        if (!loaded) {
          for (const key of new Set([
            ...Object.keys(previous.drafts),
            ...Object.keys(state.drafts),
          ])) {
            if (state.drafts[key] !== previous.drafts[key]) editedDrafts.add(key);
          }
        }
        currentDrafts = state.drafts;
        // What this window took on from another is already stored; only its
        // own changes wait for, and restart, the pause.
        if (!quiet) {
          clearTimeout(timer);
          if (loaded) timer = setTimeout(() => void saveDrafts(), 600);
        }
      }
      if (quiet || state.pending === previous.pending || !observe()) return;
      outboxChanged = true;
      // A send accepted, delivered or refused is written now, not after the
      // pause drafts wait for: a restart in between would lose it or resend it.
      if (loaded) void saveOutbox();
    });
    const unwatch = watchWorkspaceOutbox(platform, outboxKey, (record) => {
      if (loaded && !disposed) takeOn(record);
    });
    const unwatchDrafts = watchWorkspaceDrafts(platform, draftKey, (drafts) => {
      // One that cannot be read is left to this window's next write to replace.
      if (loaded && !disposed && drafts) takeOnDrafts(drafts);
    });

    // What was stored meets what this client already holds, which after a
    // change of address is more than nothing.
    const load = (record: StoredOutbox) => {
      seen(record);
      const pending = new Map(client.outboxSnapshot().map((p) => [p.nonce, storedPending(p)]));
      const refused: StoredOutboxEntry[] = [];
      for (const r of record.removed) {
        if (!pending.has(r.nonce)) continue;
        forget(r.nonce, r.rev);
        client.discardSend(r.nonce);
      }
      const restored: StoredOutboxEntry[] = [];
      for (const entry of record.entries) {
        if (entry.userId !== self || held.has(entry.nonce) || gone.has(entry.nonce)) continue;
        const json = JSON.stringify(storedPending(entry));
        const mine = pending.get(entry.nonce);
        if (!mine) restored.push(entry);
        else if (entry.refusal !== undefined && mine.refusal === undefined) refused.push(entry);
        // This client's own version differs and is newer: it gets a revision of its own.
        else if (JSON.stringify(mine) !== json) continue;
        held.set(entry.nonce, { entry, json });
        floorWhenStored.set(entry.nonce, record.compactedThrough ?? -1);
      }
      for (const entry of refused) client.adoptRefusal(entry.nonce, entry.refusal!);
      client.restoreOutbox(restored.map(storedPending));
    };

    const restore = () => {
      if (loading) return restoring!;
      loading = true;
      setError(null);
      restoring = Promise.all([
        readWorkspaceDrafts(platform, draftKey),
        readWorkspaceOutbox(platform, outboxKey),
        readWorkspaceStorage<unknown>(platform, unstoredKey),
        // Only order rides on it: unreadable, the drafts come back without.
        readWorkspaceStorage<unknown>(platform, timesKey).catch(() => null),
      ])
        .then(([storedDrafts, record, unstored, storedTimes]) => {
          baseDrafts = { ...storedDrafts };
          const drafts: Record<string, string> = { ...storedDrafts, ...currentDrafts };
          // Keep these edits across failed read retries as well as the first load.
          // An empty draft typed while storage was loading is an edit too.
          for (const key of editedDrafts) {
            if (!(key in currentDrafts)) delete drafts[key];
          }
          // Words of sends the outbox never stored go back to their composer.
          // One the outbox holds, or took out, comes back as a send or not at all.
          const owned = new Set([
            ...record.entries.map((e) => e.nonce),
            ...record.removed.map((r) => r.nonce),
          ]);
          const kept = validUnstored(unstored) ? unstored : {};
          const back: Record<string, UnstoredSend> = {};
          for (const [nonce, send] of Object.entries(kept)) {
            if (owned.has(nonce)) continue;
            back[nonce] = send;
            const draft = drafts[send.draftKey] ?? "";
            if (!draft.includes(send.text))
              drafts[send.draftKey] = draft ? `${draft}\n\n${send.text}` : send.text;
          }
          if (disposed) {
            // A quick switch may precede a desktop storage read. Finish saving
            // edits to the captured scope, without restoring or sending anything.
            if (outboxChanged) void saveOutbox();
            if (editedDrafts.size) void saveDrafts(() => drafts);
            return;
          }
          client.hydrateDrafts(drafts, readDraftTimes(storedTimes));
          quietly(() => load(record));
          observe();
          carried = back;
          unstoredJson = JSON.stringify(kept);
          loaded = true;
          flush();
          keepUnstored();
        })
        .catch(() => {
          if (!disposed)
            setError(
              "Could not restore drafts and queued messages on this device. Saved work is kept; retry before closing.",
            );
        })
        .finally(() => {
          loading = false;
        });
      return restoring;
    };
    // Once restored, memory is authoritative. Re-reading after a failed save
    // could resurrect cleared drafts or send a message the author discarded.
    const retryPersistence = () => (loaded ? flush() : restore());
    retry.current = retryPersistence;
    restore();

    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    const stopPreparing = platform.onPrepareClose?.("persist", async () => {
      if (!loaded) await restore();
      if (!loaded)
        throw new Error("Saved local work could not be read. Keep the window open and retry.");
      flush();
      // Completion can enqueue a recovery/draft write; keep following the owned work.
      while (writes.size) await Promise.all([...writes]);
      // A later no-op merge can settle after an earlier failed write. Compare
      // with confirmed storage as well, so that no-op cannot acknowledge lost words.
      const remaining = draftChanges(currentDrafts, baseDrafts);
      if (
        !(await unstoredWrite) ||
        failing.size ||
        Object.keys(remaining.put).length ||
        remaining.remove.length
      ) {
        setError(
          "Could not save drafts and queued messages on this device. Keep it open and retry.",
        );
        throw new Error("Local work could not be saved. Keep the window open and retry.");
      }
    });
    return () => {
      if (retry.current === retryPersistence) retry.current = null;
      releaseKeeper();
      unsubscribe();
      unwatch();
      unwatchDrafts();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      stopPreparing?.();
      disposed = true;
      flush();
    };
  }, [client, platform, keys, selfId]);

  if (error)
    return (
      <div
        role="alert"
        className="absolute inset-x-3 top-3 z-50 flex items-center gap-3 rounded-lg border border-alert/30 bg-raised p-3 text-sm text-alert shadow-lg"
      >
        <span className="flex-1">{error}</span>
        <button type="button" className="shrink-0 underline" onClick={() => retry.current?.()}>
          Retry
        </button>
      </div>
    );
  return notice ? (
    <div
      role="status"
      className="absolute inset-x-3 top-3 z-50 flex items-center gap-3 rounded-lg border border-edge bg-raised p-3 text-sm text-ink shadow-lg"
    >
      <span className="flex-1">{notice}</span>
      <button type="button" className="shrink-0 underline" onClick={() => setNotice(null)}>
        Dismiss
      </button>
    </div>
  ) : null;
}
