import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isAdministrator, type ID, type User } from "@ownbase/protocol";
import { ApiError } from "@ownbase/client-core";
import { useClient, useWorkspace } from "../context.js";
import { Dialog } from "./Dialog.js";
import { inputCls, TextField } from "./TextField.js";
import { Swap } from "./Motion.js";
import { Menu, type MenuItem } from "./Menu.js";
import { Avatar } from "./Avatar.js";
import { accountError } from "../lib/account.js";
import { failureText } from "../lib/failure.js";
import { useCopy } from "../lib/useCopy.js";
import { AuditHistory } from "./AuditHistory.js";
import { buttonClass } from "./Button.js";
import { ListStatus } from "./ListStatus.js";
import { isImeKey } from "../lib/textInput.js";
import { useOptionalConfirm } from "./Confirm.js";
import { When } from "./When.js";

/** What an account change did, in a sentence that names the person. */
export function changeNotice(
  name: string,
  patch: { role?: "member" | "admin"; deactivated?: boolean; canInvite?: boolean },
): string {
  if (patch.deactivated === true) return `${name} is deactivated and signed out everywhere.`;
  if (patch.deactivated === false) return `${name} is active again and can sign in.`;
  if (patch.role === "admin") return `${name} is now an admin.`;
  if (patch.role === "member") return `${name} is now a member, no longer an admin.`;
  if (patch.canInvite === true) return `${name} can now invite people.`;
  if (patch.canInvite === false) return `${name} can no longer invite people.`;
  return `${name}'s account is updated.`;
}

/** Someone on the admin list: when last here, and whether they have two-step sign-in (E11). */
type Person = User & { lastSeenAt: number | null; twoStep?: boolean };
type Action = "reset" | "twoStep" | "transfer";

/**
 * Running the workspace: who has an account, what they can do, and taking that
 * away when someone leaves. Deactivating is the important one — until this
 * existed, a former colleague's token kept working forever.
 */
export function PeopleDialog({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const confirm = useOptionalConfirm();
  const self = useWorkspace((s) => s.self);
  // Every account, kept current by the socket: an admin's snapshot holds them
  // all, and joins and changes arrive as they happen, so there is no Refresh.
  const liveUsers = useWorkspace((s) => s.users);
  const presence = useWorkspace((s) => s.presence);
  /** The admin list, for when each account was last signed in, which the socket does not carry. */
  const [people, setPeople] = useState<Person[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  /** When someone stopped being here while the list was open. */
  const [leftAt, setLeftAt] = useState<Record<ID, number>>({});
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ID | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [action, setAction] = useState<{ kind: Action; person: Person } | null>(null);
  const [confirmation, setConfirmation] = useState("");
  /** Why Transfer did not go ahead, said under the username once it is pressed. */
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const confirmField = useRef<HTMLInputElement>(null);
  const [issued, setIssued] = useState<{ person: Person; password: string } | null>(null);
  const [reveal, setReveal] = useState(false);
  const alive = useRef(true);
  const actionPanel = useRef<HTMLDivElement>(null);
  const clipboard = useCopy();
  const isAdmin = isAdministrator(self?.role);

  const load = useCallback(async () => {
    setLoading(true);
    const people = await client.admin.people();
    if (!alive.current) return;
    setLoading(false);
    if (people instanceof ApiError) {
      setLoadError(true);
      return;
    }
    setPeople(people);
    setLoadError(false);
  }, [client]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);
  // Someone who goes while the list is open was last seen now, not when it opened.
  const presenceBefore = useRef(presence);
  useEffect(() => {
    const before = presenceBefore.current;
    presenceBefore.current = presence;
    const gone = Object.keys(before).filter(
      (id) => before[id] === "online" && presence[id] !== "online",
    );
    if (gone.length === 0) return;
    const now = Date.now();
    setLeftAt((previous) => ({ ...previous, ...Object.fromEntries(gone.map((id) => [id, now])) }));
  }, [presence]);
  useEffect(() => {
    if (action || issued) actionPanel.current?.focus();
  }, [action, issued]);

  async function change(
    person: Person,
    patch: { role?: "member" | "admin"; deactivated?: boolean; canInvite?: boolean },
  ) {
    if (busy) return;
    // Deactivating signs someone out everywhere: asked first, as a reset is.
    if (patch.deactivated === true && confirm) {
      const go = await confirm({
        title: `Deactivate ${person.displayName}?`,
        body: `@${person.handle} is signed out on every device and cannot sign back in until an admin reactivates them. Their messages stay.`,
        confirmLabel: "Deactivate",
        destructive: true,
      });
      if (!go) return;
    }
    setError(null);
    setNotice(null);
    setBusy(person.id);
    const failed = await client.admin.changePerson(person.id, patch);
    setBusy(null);
    if (failed) setError(changeError(failed, person.displayName));
    else setNotice(changeNotice(person.displayName, patch));
  }

  async function confirmAction(event: React.FormEvent) {
    event.preventDefault();
    if (!action || busy) return;
    if (action.kind === "transfer" && confirmation !== action.person.handle) {
      setConfirmError(
        confirmation.trim()
          ? `That isn't ${action.person.handle}. Type it exactly to confirm.`
          : `Type ${action.person.handle} to confirm.`,
      );
      confirmField.current?.focus();
      return;
    }
    setBusy(action.person.id);
    setError(null);
    setNotice(null);
    const { kind, person } = action;
    const answer =
      kind === "reset"
        ? await client.admin.resetPassword(person.id)
        : kind === "twoStep"
          ? await client.admin.resetTwoStep(person.id)
          : await client.admin.transferOwnership(person.id);
    if (!alive.current) return;
    setBusy(null);
    if (answer instanceof ApiError) {
      setError(accountError(answer));
      return;
    }
    if (kind === "reset") {
      setIssued({ person, password: answer! });
      setReveal(false);
    } else if (kind === "twoStep") {
      setPeople(
        (list) => list?.map((p) => (p.id === person.id ? { ...p, twoStep: false } : p)) ?? list,
      );
      setNotice(
        `${person.displayName}'s two-step sign-in is off. They can set it up again in Account settings.`,
      );
    } else {
      setNotice(`${person.displayName} now owns this workspace. You are an administrator.`);
    }
    setAction(null);
    setConfirmation("");
  }

  function beginAction(kind: Action, person: Person) {
    setAction({ kind, person });
    setConfirmation("");
    setConfirmError(null);
    setError(null);
    setNotice(null);
  }

  const isOwner = self?.role === "owner";
  const currentPeople = useMemo(() => {
    const byId = new Map<ID, Person>((people ?? []).map((person) => [person.id, person]));
    for (const user of Object.values(liveUsers)) {
      const listed = byId.get(user.id);
      byId.set(user.id, {
        ...user,
        lastSeenAt: listed?.lastSeenAt ?? null,
        ...(listed?.twoStep !== undefined ? { twoStep: listed.twoStep } : {}),
      });
    }
    return (
      [...byId.values()]
        .map((person) => {
          const left = leftAt[person.id];
          return left && left > (person.lastSeenAt ?? 0) ? { ...person, lastSeenAt: left } : person;
        })
        // By the name shown, as every other list of people is; the handle tells two of one name apart.
        .sort(
          (a, b) =>
            a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }) ||
            a.handle.localeCompare(b.handle),
        )
    );
  }, [people, liveUsers, leftAt]);
  // As the switcher matches people: a name or handle, without the @ written before one.
  const needle = query.trim().toLowerCase().replace(/^@/, "");
  const matching = needle
    ? currentPeople.filter(
        (p) =>
          p.handle.toLowerCase().includes(needle) || p.displayName.toLowerCase().includes(needle),
      )
    : currentPeople;
  const visible = matching.filter((p) => showInactive || !p.deactivated);
  const inactiveCount = matching.filter((p) => p.deactivated).length;
  const secondaryBtn =
    "rounded-lg border border-edge px-3 py-2 text-sm text-ink-dim hover:bg-ink/[0.05] hover:text-ink disabled:opacity-40";

  if (!isAdmin)
    return (
      <Dialog title="People" onClose={onClose}>
        <p className="text-sm text-ink-dim">
          Only workspace owners and administrators can manage accounts.
        </p>
      </Dialog>
    );

  return (
    // A temporary password is shown once: only Done puts it away, not a stray
    // Escape or a click beside the dialog.
    <Dialog title="People" onClose={onClose} width={680} dismissible={!busy && !issued}>
      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-alert/10 p-3 text-sm text-alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-4 rounded-lg bg-online/10 p-3 text-sm text-online">
          {notice}
        </p>
      )}

      {issued ? (
        <div ref={actionPanel} tabIndex={-1} className="outline-none">
          <h3 className="font-semibold">Password reset for {issued.person.displayName}</h3>
          <p className="mt-2 text-sm text-ink-dim">
            @{issued.person.handle} is signed out on every device. Send them this temporary password
            privately. Ask them to change it in Account settings after they sign in.
          </p>
          <label className="mt-4 block text-sm">
            Temporary password
            <input
              className={`${inputCls} mt-1 font-mono`}
              value={issued.password}
              readOnly
              type={reveal ? "text" : "password"}
              autoComplete="off"
              onFocus={(event) => event.target.select()}
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={secondaryBtn} onClick={() => setReveal((value) => !value)}>
              {reveal ? "Hide password" : "Show password"}
            </button>
            <button
              className={secondaryBtn}
              onClick={() => void clipboard.copy(issued.password, issued.password)}
            >
              <Swap text>
                {clipboard.label(
                  "Copy password",
                  "Copied",
                  "Copy failed. Select it and copy it yourself",
                  issued.password,
                )}
              </Swap>
            </button>
          </div>
          <p className="mt-3 text-xs text-ink-faint">
            You cannot see this password again after you press Done. OwnBase does not save it on
            this device.
          </p>
          <button
            className={buttonClass("primary", "mt-5")}
            disabled={!!busy}
            onClick={() => {
              setIssued(null);
              setReveal(false);
            }}
          >
            Done
          </button>
        </div>
      ) : action ? (
        <div ref={actionPanel} tabIndex={-1} className="outline-none">
          <h3 className="font-semibold">
            {action.kind === "reset"
              ? `Reset ${action.person.displayName}'s password?`
              : action.kind === "twoStep"
                ? `Turn off ${action.person.displayName}'s two-step sign-in?`
                : `Transfer ownership to ${action.person.displayName}?`}
          </h3>
          <p className="mt-2 text-sm text-ink-dim">
            {action.kind === "reset"
              ? `This replaces @${action.person.handle}'s password and signs out all their devices. A temporary password will appear here for you to share privately.`
              : action.kind === "twoStep"
                ? `Use this when someone has lost their phone and their recovery codes. @${action.person.handle} will sign in with only their password until they set up two-step sign-in again. Their devices stay signed in. Make sure the request really comes from them.`
                : `@${action.person.handle} will become the workspace owner. You will remain an administrator. Only the new owner will be able to transfer ownership again.`}
          </p>
          {/* Transfer always answers: without the username typed, it says so under the field. */}
          <form noValidate onSubmit={(event) => void confirmAction(event)}>
            {action.kind === "transfer" && (
              <TextField
                ref={confirmField}
                className="mt-4"
                label={`Type ${action.person.handle} to confirm`}
                error={confirmError}
                value={confirmation}
                onChange={(event) => {
                  setConfirmation(event.target.value);
                  setConfirmError(null);
                }}
                autoComplete="off"
                spellCheck={false}
                readOnly={!!busy}
                required
              />
            )}
            {busy && (
              <p role="status" className="mt-3 text-sm text-ink-dim">
                Saving the change. Keep this window open…
              </p>
            )}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                className={secondaryBtn}
                type="button"
                disabled={!!busy}
                onClick={() => {
                  setAction(null);
                  setError(null);
                }}
              >
                Cancel
              </button>
              <button
                className={buttonClass("primary")}
                type="submit"
                aria-disabled={!!busy || undefined}
              >
                {busy
                  ? "Saving…"
                  : action.kind === "reset"
                    ? "Reset password"
                    : action.kind === "twoStep"
                      ? "Turn off two-step sign-in"
                      : "Transfer ownership"}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <>
          <p className="mb-3 text-sm text-ink-dim">
            Change roles, deactivate accounts and reset passwords.
          </p>
          <label className="mb-3 block text-sm">
            <span className="sr-only">Find a person</span>
            <input
              type="search"
              autoFocus
              value={query}
              maxLength={80}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // Clears the search first; the next Escape closes the dialog.
                if (event.key !== "Escape" || !query || isImeKey(event.nativeEvent)) return;
                event.preventDefault();
                setQuery("");
              }}
              placeholder="Search by name or handle"
              className={inputCls}
            />
          </label>

          <ListStatus
            // The rows come from the socket, so only a retry after a failure is worth saying.
            loading={loading && loadError}
            loadingLabel="Loading when people were last here…"
            error={loadError ? "Could not load when people were last here." : null}
            retryLabel="Try again"
            onRetry={() => void load()}
            empty={
              visible.length === 0 && needle
                ? inactiveCount > 0
                  ? `No active account matches “${query.trim()}”.`
                  : `No one matches “${query.trim()}”.`
                : null
            }
          />
          <ul className="space-y-1">
            {visible.map((person) => {
              // The rules the server enforces, said out loud so the buttons that
              // would be refused are simply not offered.
              const protectedTarget =
                person.id === self?.id ||
                person.role === "owner" ||
                (person.role === "admin" && !isOwner);
              return (
                <li
                  key={person.id}
                  className={`flex flex-wrap items-center gap-3 rounded-lg px-2 py-2 ${
                    person.deactivated ? "opacity-50" : ""
                  }`}
                >
                  <Avatar user={person} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium">{person.displayName}</span>
                      <span className="truncate font-mono text-[11px] text-ink-faint">
                        @{person.handle}
                      </span>
                      {person.isBot && (
                        <span className="rounded-full bg-ink/[0.07] px-2 py-0.5 text-[11px] font-medium text-ink-dim">
                          app
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-ink-faint">
                      {person.deactivated
                        ? "Deactivated"
                        : person.role === "owner"
                          ? "Owner"
                          : person.role === "admin"
                            ? "Admin"
                            : person.role === "guest"
                              ? "Guest"
                              : person.canInvite && !person.isBot
                                ? "Member · can invite"
                                : "Member"}
                      {/* Someone here now is here now, not "last seen today". */}
                      {!person.deactivated &&
                        (presence[person.id] === "online" ? (
                          <> · active now</>
                        ) : (
                          person.lastSeenAt && (
                            <>
                              {" "}
                              · last seen <When at={person.lastSeenAt} />
                            </>
                          )
                        ))}
                    </div>
                  </div>

                  {!protectedTarget && (
                    <div className="ml-auto">
                      <PersonMenu
                        person={person}
                        isOwner={isOwner}
                        disabled={!!busy}
                        onChange={change}
                        onBeginAction={beginAction}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {inactiveCount > 0 && (
            <button
              onClick={() => setShowInactive((v) => !v)}
              className="mt-3 text-[12px] text-ink-faint underline transition-colors hover:text-ink"
            >
              {showInactive
                ? "Hide deactivated"
                : `Show ${inactiveCount} deactivated ${inactiveCount === 1 ? "account" : "accounts"}`}
            </button>
          )}

          <div>
            <AuditHistory />
          </div>

          <p className="mt-4 text-[11px] text-ink-faint">
            Deactivating someone signs them out everywhere and stops them from signing back in.
            Their messages stay, so conversations still make sense.
          </p>
        </>
      )}
    </Dialog>
  );
}

/**
 * One menu per person instead of five buttons squeezing the name down to
 * "Alex ...". Offers exactly what the buttons offered, under the same rules
 * the server enforces.
 */
function PersonMenu({
  person,
  isOwner,
  disabled,
  onChange,
  onBeginAction,
}: {
  person: Person;
  isOwner: boolean;
  disabled: boolean;
  onChange: (
    person: Person,
    patch: { role?: "member" | "admin"; deactivated?: boolean; canInvite?: boolean },
  ) => void;
  onBeginAction: (kind: Action, person: Person) => void;
}) {
  const items: MenuItem[] = [];
  // A guest has no password and becomes a member only by creating an account
  // itself; it can be removed like anyone else.
  const guest = person.role === "guest";
  if (!person.isBot && !person.deactivated && !guest) {
    items.push({
      id: "role",
      label: person.role === "admin" ? "Make member" : "Make admin",
      onSelect: () => onChange(person, { role: person.role === "admin" ? "member" : "admin" }),
    });
  }
  if (
    !person.isBot &&
    !person.deactivated &&
    person.role === "member" &&
    typeof person.canInvite === "boolean"
  ) {
    items.push({
      id: "invite",
      label: person.canInvite ? "Stop them inviting people" : "Let them invite people",
      onSelect: () => onChange(person, { canInvite: !person.canInvite }),
    });
  }
  items.push({
    id: "deactivated",
    label: person.deactivated ? "Reactivate" : "Deactivate",
    destructive: !person.deactivated,
    onSelect: () => onChange(person, { deactivated: !person.deactivated }),
  });
  if (!person.isBot && !person.deactivated && !guest) {
    items.push({
      id: "reset",
      label: "Reset password",
      onSelect: () => onBeginAction("reset", person),
    });
    // Only for someone who has it.
    if (person.twoStep) {
      items.push({
        id: "two-step",
        label: "Reset two-step sign-in",
        onSelect: () => onBeginAction("twoStep", person),
      });
    }
    if (isOwner) {
      items.push({
        id: "transfer",
        label: "Transfer ownership",
        onSelect: () => onBeginAction("transfer", person),
      });
    }
  }
  return <Menu label={`Actions for ${person.displayName}`} items={items} disabled={disabled} />;
}

/**
 * The server's error codes, in words someone running a workspace would use.
 * An ApiError's message falls back to the raw code, so anything unrecognised
 * is only worth showing when the server actually wrote a sentence.
 */
function changeError(error: ApiError, name: string): string {
  switch (error.code) {
    case "owner_is_protected":
      return "The owner's account cannot be changed here.";
    case "admins_are_equals":
      return "Only the owner can change another admin.";
    case "cannot_change_self":
      return "You cannot change your own account.";
    case "user_not_found":
      return "That account is no longer available.";
    case "bots_have_no_role":
      return "An app has no role to change.";
    case "bots_cannot_invite":
      return "An app cannot be allowed to invite people.";
    case "admins_can_always_invite":
      return "Admins can always invite people.";
    case "admin_only":
      return "You do not have permission to do that.";
    default:
      return failureText(`Could not change ${name}'s account.`, error, "Try again.");
  }
}
