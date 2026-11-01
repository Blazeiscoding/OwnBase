import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@ownbase/client-core";
import type { Channel, ID } from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { Avatar } from "./Avatar.js";
import { Dialog, DialogScroll } from "./Dialog.js";
import { inputCls, TextField } from "./TextField.js";
import { buttonClass } from "./Button.js";
import { Icon } from "./Icon.js";
import { EmptyState } from "./EmptyState.js";
import { useTabs } from "../lib/useTabs.js";

export function NewChannelDialog(props: { onClose: () => void; onCreated: (ch: Channel) => void }) {
  const client = useClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const slug = name.trim().replace(/^#+/, "").toLowerCase().replaceAll(/\s+/g, "-");

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    // Say what is missing rather than refusing silently.
    if (!slug) {
      setError("Give the channel a name.");
      nameInput.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { channel } = await client.api.createChannel({
        type: isPrivate ? "private" : "public",
        name: slug,
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      props.onCreated(channel);
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof ApiError && err.code === "name_taken"
          ? `#${slug} already exists. Choose another name.`
          : "Couldn't create the channel. Check your connection and try again.",
      );
      nameInput.current?.focus();
    }
  }

  const choice = (value: boolean, icon: "hash" | "lock", title: string, hint: string) => (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-copper ${
        isPrivate === value ? "border-ink/30 bg-ink/[0.04]" : "border-edge hover:border-ink/20"
      }`}
    >
      <input
        type="radio"
        name="channel-visibility"
        checked={isPrivate === value}
        onChange={() => setIsPrivate(value)}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-edge text-ink-dim"
      >
        <Icon name={icon} size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="block text-[13px] text-ink-dim">{hint}</span>
      </span>
      <span
        aria-hidden="true"
        className={`mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border ${
          isPrivate === value ? "border-copper" : "border-edge"
        }`}
      >
        {isPrivate === value && <span className="size-2 rounded-full bg-copper" />}
      </span>
    </label>
  );

  return (
    <Dialog title="New channel" onClose={props.onClose}>
      <form onSubmit={create} noValidate className="space-y-4">
        <div>
          <label
            htmlFor="new-channel-name"
            className="mb-1.5 block text-[13px] font-medium text-ink-dim"
          >
            Name
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint">
              #
            </span>
            <input
              id="new-channel-name"
              ref={nameInput}
              autoFocus
              value={name}
              maxLength={80}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              placeholder="release-party"
              aria-invalid={!!error || undefined}
              aria-describedby="new-channel-name-hint"
              className={`${inputCls} pl-7`}
            />
          </div>
          <p id="new-channel-name-hint" className="mt-1.5 text-[12px] text-ink-faint">
            {slug && slug !== name.trim()
              ? `It will be #${slug}.`
              : "Short and lowercase works best, such as #design or #launch-week."}
          </p>
        </div>
        <div>
          <label
            htmlFor="new-channel-description"
            className="mb-1.5 block text-[13px] font-medium text-ink-dim"
          >
            What is it for? <span className="font-normal text-ink-faint">(optional)</span>
          </label>
          <input
            id="new-channel-description"
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Planning the launch party"
            className={inputCls}
          />
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-[13px] font-medium text-ink-dim">Who can see it</legend>
          {choice(
            false,
            "hash",
            "Public",
            "Everyone in the workspace is added, and anyone can leave.",
          )}
          {choice(true, "lock", "Private", "Only invited members can see it.")}
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} className={buttonClass("primary", "w-full")}>
          {busy ? "Creating…" : `Create ${slug ? `#${slug}` : "channel"}`}
        </button>
      </form>
    </Dialog>
  );
}

/**
 * A guest keeping who they are: a username and password turn this guest into
 * an ordinary account, with the same messages and channels. The guest session
 * ends, and the token given back replaces it.
 */
export function GuestAccountDialog(props: {
  onClose: () => void;
  onCreated: (token: string, handle: string) => void;
}) {
  const client = useClient();
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  /** What is wrong with each field, said under it once the form is sent. */
  const [problems, setProblems] = useState<{ handle?: string; password?: string }>({});
  /** What went wrong that neither field explains. */
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const handleField = useRef<HTMLInputElement>(null);
  const passwordField = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  /** The same rules the server applies, checked first so each can be said beside its field. */
  function check(): { handle?: string; password?: string } {
    const name = handle.trim().toLowerCase();
    return {
      handle: !name
        ? "Choose a username."
        : !/^[a-z0-9][a-z0-9._-]{1,31}$/.test(name)
          ? "Usernames are 2 to 32 lowercase letters or numbers, and may use . _ or -."
          : undefined,
      password: !password
        ? "Choose a password."
        : password.length < 8
          ? "Use at least 8 characters for the password."
          : undefined,
    };
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const found = check();
    setProblems(found);
    if (found.handle || found.password) {
      (found.handle ? handleField : passwordField).current?.focus();
      return;
    }
    setBusy(true);
    try {
      const { token, user } = await client.api.createAccountFromGuest({
        handle: handle.trim().toLowerCase(),
        password,
      });
      // Even closed, the guest session it replaced has ended: carry on as the account.
      props.onCreated(token, user.handle);
    } catch (err) {
      if (!alive.current) return;
      setBusy(false);
      if (err instanceof ApiError && err.code === "handle_taken") {
        setProblems({ handle: "That username is taken. Choose another." });
        handleField.current?.focus();
        return;
      }
      setError(
        err instanceof ApiError && err.code === "invalid_request"
          ? "Usernames are lowercase letters and digits; passwords need 8+ characters."
          : err instanceof ApiError && err.code === "invite_required"
            ? "This workspace now needs an invite to create an account."
            : "Could not create the account. Try again.",
      );
    }
  }

  return (
    <Dialog title="Create an account" onClose={props.onClose} dismissible={!busy}>
      <p className="mb-3 text-sm text-ink-dim">
        You are here as a guest, for a day. An account keeps your name, messages and channels, and
        lets you sign in again from anywhere.
      </p>
      <form onSubmit={create} noValidate className="space-y-3">
        <TextField
          ref={handleField}
          label="Username"
          hint="Lowercase letters and numbers, such as maya or sam.r"
          error={problems.handle}
          autoFocus
          value={handle}
          onChange={(e) => {
            setHandle(e.target.value);
            setProblems((found) => ({ ...found, handle: undefined }));
          }}
          autoComplete="username"
          spellCheck={false}
          autoCapitalize="none"
        />
        <TextField
          ref={passwordField}
          label="Password"
          hint="At least 8 characters."
          error={problems.password}
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setProblems((found) => ({ ...found, password: undefined }));
          }}
          autoComplete="new-password"
        />
        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}
        {/* Never off until filled in: sent empty, the form says what is missing. */}
        <button
          type="submit"
          aria-disabled={busy || undefined}
          className={buttonClass("primary", "w-full")}
        >
          {busy ? "Creating…" : "Create account"}
        </button>
      </form>
    </Dialog>
  );
}

const BROWSE_TABS = ["active", "archived"] as const;

export function BrowseChannelsDialog(props: { onClose: () => void; onOpen: (id: ID) => void }) {
  const client = useClient();
  const channels = useWorkspace((s) => s.channels);
  const memberships = useWorkspace((s) => s.memberships);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<(typeof BROWSE_TABS)[number]>("active");
  const [joining, setJoining] = useState<ID | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Active and archived are two lists, not one with more in it, so they are
  // tabs as in Friends rather than a checkbox that quietly swaps the list.
  const tabs = useTabs({
    label: "Which channels",
    tabs: BROWSE_TABS,
    selected: tab,
    onSelect: (next) => {
      setTab(next);
      setError(null);
    },
  });

  const all = useMemo(
    () =>
      Object.values(channels)
        .filter((c) => c.type === "public" || c.type === "private")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [channels],
  );
  const archivedCount = all.filter((c) => c.archived).length;
  const needle = q.trim().toLowerCase();
  // A channel is found by what it is about as well as its name.
  const rooms = all.filter(
    (c) =>
      c.archived === (tab === "archived") &&
      (!needle ||
        c.name.includes(needle) ||
        c.description.toLowerCase().includes(needle) ||
        c.topic.toLowerCase().includes(needle)),
  );

  async function join(channel: Channel) {
    if (joining) return;
    setJoining(channel.id);
    setError(null);
    try {
      await client.api.joinChannel(channel.id);
      props.onOpen(channel.id);
    } catch {
      setError(`Could not join #${channel.name}. Check your connection and try again.`);
      setJoining(null);
    }
  }

  return (
    <Dialog title="All channels" onClose={props.onClose} width={480} ownScroll>
      <div
        {...tabs.listProps}
        className="mx-6 mb-3 flex shrink-0 gap-1 rounded-xl border border-edge bg-deep/40 p-1"
      >
        {BROWSE_TABS.map((value) => (
          <button
            key={value}
            {...tabs.tabProps(value)}
            className={`flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${tab === value ? "bg-lifted text-ink shadow-[0_1px_2px_rgb(0_0_0/0.2)]" : "text-ink-faint hover:text-ink"}`}
          >
            {value === "active"
              ? "Active"
              : `Archived${archivedCount ? ` (${archivedCount})` : ""}`}
          </button>
        ))}
      </div>
      {/* The filter stays over the channels it narrows, which are all that scrolls. */}
      <div {...tabs.panelProps} className="flex min-h-0 flex-col">
        <div className="shrink-0 px-6 pb-2">
          <input
            autoFocus
            aria-label="Filter channels"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by name or description"
            className={inputCls}
          />
        </div>
        <DialogScroll>
          {/* A steady height, so switching tabs or filtering does not jump the dialog. */}
          <div className="sm:min-h-[250px]">
            {error && (
              <p role="alert" className="mb-3 text-sm text-alert">
                {error}
              </p>
            )}
            {rooms.length > 0 ? (
              <ul className="space-y-1">
                {rooms.map((ch) => {
                  const joined = ch.id in memberships;
                  return (
                    <li
                      key={ch.id}
                      className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-ink/[0.05]"
                    >
                      <span className="flex size-4 shrink-0 justify-center text-ink-faint">
                        {ch.type === "private" ? (
                          <>
                            <Icon name="lock" size={14} />
                            <span className="sr-only">Private</span>
                          </>
                        ) : (
                          <Icon name="hash" size={14} />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="truncate font-medium">{ch.name}</span>
                          {joined && (
                            <span className="shrink-0 text-xs text-ink-faint">Joined</span>
                          )}
                        </div>
                        {(ch.description || ch.topic) && (
                          <div className="truncate text-xs text-ink-faint">
                            {ch.description || ch.topic}
                          </div>
                        )}
                      </div>
                      {joined || ch.archived ? (
                        <button
                          onClick={() => props.onOpen(ch.id)}
                          aria-label={`Open #${ch.name}`}
                          className="rounded-lg border border-edge px-3 py-1 text-sm font-medium text-ink-dim transition-colors hover:bg-ink/[0.05] hover:text-ink"
                        >
                          Open
                        </button>
                      ) : (
                        <button
                          // Not `disabled`, so focus stays put while it joins.
                          aria-disabled={joining !== null || undefined}
                          aria-label={`Join #${ch.name}`}
                          onClick={() => void join(ch)}
                          className="btn-shape bg-copper px-3 py-1 text-sm font-semibold text-ground transition-colors hover:bg-copper-deep aria-disabled:opacity-60"
                        >
                          {joining === ch.id ? "Joining…" : "Join"}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState>
                {needle
                  ? "No channels match."
                  : tab === "archived"
                    ? "No channels have been archived."
                    : "There are no channels yet."}
              </EmptyState>
            )}
          </div>
        </DialogScroll>
      </div>
    </Dialog>
  );
}

export function NewDmDialog(props: {
  onClose: () => void;
  onOpen: (id: ID) => void;
  initialMemberIds?: ID[];
}) {
  const client = useClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const presence = useWorkspace((s) => s.presence);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<ID[]>(() =>
    [...new Set(props.initialMemberIds ?? [])].filter((id) => id !== selfId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = Object.values(users)
    .filter((u) => u.id !== selfId && ((!u.deactivated && !u.isBot) || picked.includes(u.id)))
    .filter(
      (u) =>
        u.handle.includes(q.toLowerCase()) || u.displayName.toLowerCase().includes(q.toLowerCase()),
    )
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  async function start() {
    if (busy || picked.length < 1 || picked.length > 8) return;
    if (picked.some((id) => !users[id] || users[id]?.deactivated || users[id]?.isBot)) {
      setError("Remove unavailable accounts from the selection before continuing.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const channel = await client.openDm(picked);
      if (mounted.current) props.onOpen(channel.id);
    } catch (err) {
      // A refusal the server explained in words is said as it is; anything
      // else (a code, a network error) in plain words.
      setError(
        err instanceof ApiError && err.message && /\s/.test(err.message)
          ? err.message
          : "Could not open the conversation. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  const search = useRef<HTMLInputElement>(null);
  const toggle = (id: ID, on: boolean) => {
    setError(null);
    setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)));
  };

  return (
    <Dialog title="New message" onClose={props.onClose} ownScroll>
      <form
        noValidate
        className="flex min-h-0 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          // Say what is missing rather than refusing silently.
          if (picked.length === 0) {
            setError("Choose at least one person to message.");
            search.current?.focus();
            return;
          }
          void start();
        }}
      >
        <div className="shrink-0 px-6">
          {props.initialMemberIds && (
            <p className="mb-3 text-sm text-ink-dim">
              History stays in the current conversation. A conversation originally started for the
              selected people may reopen; otherwise a new one starts.
            </p>
          )}
          <label
            htmlFor="new-dm-search"
            className="mb-1.5 block text-[13px] font-medium text-ink-dim"
          >
            To
          </label>
          <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-edge bg-ground px-2 py-1.5 transition-colors focus-within:border-copper hover:border-ink-faint/40">
            {picked.map((id) => {
              const u = users[id];
              return (
                <span
                  key={id}
                  className="flex h-7 items-center gap-1.5 rounded-full bg-ink/[0.07] pl-1 pr-1 text-[13px] font-medium"
                >
                  {u && <Avatar user={u} size={20} />}
                  {u?.displayName ?? "Unknown"}
                  <button
                    type="button"
                    aria-label={`Remove ${u?.displayName ?? "this person"}`}
                    disabled={busy}
                    onClick={() => toggle(id, false)}
                    className="flex size-5 items-center justify-center rounded-full text-ink-faint hover:bg-ink/10 hover:text-ink"
                  >
                    <Icon name="close" size={12} />
                  </button>
                </span>
              );
            })}
            <input
              id="new-dm-search"
              ref={search}
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                // Backspace in an empty box takes back the last person chosen.
                if (e.key === "Backspace" && !q && picked.length > 0 && !busy)
                  toggle(picked[picked.length - 1]!, false);
              }}
              placeholder={picked.length === 0 ? "Search people" : "Add someone else"}
              aria-describedby="new-dm-count"
              className="h-7 min-w-[8rem] flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-ink-faint"
            />
          </div>
          <p id="new-dm-count" className="mb-1 mt-1.5 text-[12px] text-ink-faint">
            {picked.length === 0
              ? "Choose up to 8 people. You're included."
              : `${picked.length} of up to 8 chosen, plus you`}
          </p>
        </div>
        <DialogScroll>
          <ul aria-label="People" className="-mx-1 space-y-0.5">
            {candidates.map((u) => {
              const chosen = picked.includes(u.id);
              const online = presence[u.id] === "online";
              return (
                <li key={u.id}>
                  <label
                    className={`flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-copper ${
                      chosen ? "bg-ink/[0.06]" : "hover:bg-ink/[0.04]"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={chosen}
                      disabled={busy || (!chosen && picked.length >= 8)}
                      onChange={(e) => toggle(u.id, e.target.checked)}
                      className="sr-only"
                    />
                    <span className="relative shrink-0">
                      <Avatar user={u} size={28} />
                      <span
                        aria-hidden="true"
                        className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-raised ${
                          online ? "bg-online" : "bg-ink-faint/50"
                        }`}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink">
                        {u.displayName}
                        {u.deactivated && " (unavailable)"}
                      </span>
                      <span className="block truncate text-[12px] text-ink-faint">
                        @{u.handle}
                        {online ? " · Online" : ""}
                      </span>
                    </span>
                    <span
                      aria-hidden="true"
                      className={`flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
                        chosen ? "border-copper bg-copper text-ground" : "border-edge"
                      }`}
                    >
                      {chosen && <Icon name="check" size={12} />}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {/* After the list rather than in it, which holds only its people. */}
          {candidates.length === 0 && (
            <EmptyState>
              {Object.keys(users).length <= 1
                ? "You're the only one here so far. Invite people to start a conversation."
                : `No one matches “${q.trim()}”.`}
            </EmptyState>
          )}
        </DialogScroll>
        <div className="dialog-foot">
          {error && (
            <p role="alert" className="mb-3 text-sm text-alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy} className={buttonClass("primary", "w-full")}>
            {busy ? "Opening…" : "Start conversation"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
