import { useId, useMemo, useState } from "react";
import type { ID, User } from "@ownbase/protocol";
import { useWorkspace } from "../context.js";
import { useListbox } from "../lib/useListbox.js";
import { isImeKey } from "../lib/textInput.js";
import { matchTier } from "../lib/switcherRank.js";
import { Avatar } from "./Avatar.js";
import { Icon } from "./Icon.js";
import { inputClass } from "./TextField.js";
import { useOptionalToast } from "./Toast.js";

/** How many matches show at once; the rest are found by typing more. */
export const SHOWN = 6;

/**
 * Finds someone by name or handle and adds them, one at a time: a box that
 * keeps focus, so several can be added in a row, and the arrow keys choose
 * among the matches. In place of a chip for every person in the workspace,
 * which stops being usable well before a hundred.
 */
export function AddPeople({
  candidates,
  where,
  disabled,
  autoFocus,
  onAdd,
}: {
  /** Who can be added: not already in, not deactivated, not an app. */
  candidates: readonly User[];
  /** What they are added to, for the notice: "#design". */
  where: string;
  disabled?: boolean;
  /** Takes focus as it appears, for a dialog opened to add people. */
  autoFocus?: boolean;
  /** Adds them; says whether it worked (a failure is reported by the caller). */
  onAdd: (userId: ID) => Promise<boolean>;
}) {
  const presence = useWorkspace((s) => s.presence);
  const [q, setQ] = useState("");
  const toast = useOptionalToast();
  const inputId = useId();
  const hintId = useId();

  const query = q.trim().toLowerCase().replace(/^@/, "");
  const matches = useMemo(() => {
    const ranked = candidates
      .map((u) => {
        const tiers = [matchTier(u.displayName, query), matchTier(u.handle, query)].filter(
          (tier) => tier >= 0,
        );
        return { u, tier: tiers.length ? Math.min(...tiers) : -1 };
      })
      .filter(({ tier }) => tier >= 0)
      .sort((a, b) => a.tier - b.tier || a.u.displayName.localeCompare(b.u.displayName));
    return ranked.map(({ u }) => u);
  }, [candidates, query]);
  const shown = matches.slice(0, SHOWN);
  const list = useListbox(shown.length);

  async function add(user: User) {
    if (disabled) return;
    if (await onAdd(user.id)) {
      setQ("");
      list.choose(0);
      toast?.({ message: `Added ${user.displayName} to ${where}.`, kind: "success" });
    }
  }

  return (
    <div>
      <label htmlFor={inputId} className="mb-1.5 block text-[13px] font-semibold text-ink">
        Add someone
      </label>
      <div className="relative">
        <Icon
          name="search"
          size={15}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
        />
        <input
          id={inputId}
          {...list.comboboxProps}
          aria-describedby={hintId}
          value={q}
          autoFocus={autoFocus}
          // Kept usable while one is added, so the next can be typed meanwhile.
          aria-disabled={disabled || undefined}
          autoComplete="off"
          placeholder="Name or @handle"
          onChange={(e) => {
            setQ(e.target.value);
            list.choose(0);
          }}
          onKeyDown={(e) => {
            if (isImeKey(e.nativeEvent)) return;
            if (list.move(e)) return;
            const chosen = shown[list.active];
            if (e.key === "Enter" && chosen) {
              e.preventDefault();
              void add(chosen);
            }
          }}
          className={inputClass("regular", "pl-8")}
        />
      </div>
      <p id={hintId} className="mt-1.5 text-[12px] text-ink-faint">
        {matches.length === 0
          ? query
            ? `No one else matches “${q.trim()}”.`
            : "Everyone in the workspace is already here."
          : matches.length > SHOWN
            ? `${matches.length} people match. Keep typing to narrow it down.`
            : "Enter adds the highlighted person."}
      </p>
      {shown.length > 0 && (
        <ul {...list.listProps} aria-label="People to add" className="mt-1 space-y-0.5">
          {shown.map((u, i) => (
            <li
              key={u.id}
              {...list.optionProps(i)}
              aria-label={`${u.displayName}, @${u.handle}`}
              onClick={() => void add(u)}
              className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm ${
                i === list.active ? "channel-row-active text-ink" : "text-ink-dim"
              } ${disabled ? "pointer-events-none opacity-60" : ""}`}
            >
              <span className="relative shrink-0">
                <Avatar user={u} size={24} />
                <span
                  aria-hidden="true"
                  className={`absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-raised ${
                    presence[u.id] === "online" ? "bg-online" : "bg-ink-faint/50"
                  }`}
                />
              </span>
              <span className="min-w-0 flex-1 truncate">
                {u.displayName} <span className="text-[12px] text-ink-faint">@{u.handle}</span>
              </span>
              <span aria-hidden="true" className="text-[12px] text-ink-faint">
                {i === list.active ? "Add ↵" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
