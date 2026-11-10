import { useId, type ReactNode } from "react";
import type { AccessPolicy } from "@ownbase/protocol";

/** Who may join, each said plainly: what it lets in, and what it keeps out. */
export const JOIN_POLICIES: { id: AccessPolicy; title: string; hint: string }[] = [
  {
    id: "invite_only",
    title: "People with an invite",
    hint: "New people need an invite link or code to create an account. Owners and admins make invites, and so can members they allow.",
  },
  {
    id: "account_required",
    title: "Anyone who creates an account",
    hint: "Anyone with a link to the workspace, such as a public link, can create an account and join. No invite needed.",
  },
  {
    id: "guest_allowed",
    title: "Anyone, guests included",
    hint: "People can also join as a guest with only a name. A guest stays for a day and sees only public channels. Guests can still create an account.",
  },
];

/**
 * The one control for who may join, in Workspace settings and in Manage
 * hosting alike: the three rules as cards, each with what it lets in. What a
 * choice does, saving at once or waiting for Get a public link, is the caller's.
 */
export function JoinPolicyChoice(props: {
  value: AccessPolicy;
  onChange: (policy: AccessPolicy) => void;
  /** The group's name for a screen reader, where the screen shows it elsewhere. */
  legend: string;
  /** A line above the cards, read as the group's description. */
  hint?: ReactNode;
  disabled?: boolean;
  /** Smaller, for a section of a dialog rather than a page of settings. */
  compact?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const compact = !!props.compact;
  return (
    <fieldset aria-describedby={props.hint ? hintId : undefined} disabled={props.disabled}>
      <legend className="sr-only">{props.legend}</legend>
      {props.hint && (
        <p
          id={hintId}
          className={compact ? "mb-2 text-xs text-ink-dim" : "mb-3 text-sm text-ink-dim"}
        >
          {props.hint}
        </p>
      )}
      <div className={compact ? "space-y-1.5" : "space-y-2"}>
        {JOIN_POLICIES.map((policy) => {
          const chosen = props.value === policy.id;
          return (
            <label
              key={policy.id}
              className={`flex items-start gap-3 border transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-copper ${
                compact ? "rounded-lg px-3 py-2" : "rounded-xl px-3.5 py-3"
              } ${
                props.disabled
                  ? "cursor-default opacity-60"
                  : chosen
                    ? "cursor-pointer"
                    : "cursor-pointer hover:border-ink/20"
              } ${chosen ? "border-ink/30 bg-ink/[0.04]" : "border-edge"}`}
            >
              <input
                type="radio"
                name={id}
                value={policy.id}
                checked={chosen}
                onChange={() => props.onChange(policy.id)}
                className="sr-only"
              />
              <span className="min-w-0 flex-1">
                <span className={`block font-medium text-ink ${compact ? "text-xs" : "text-sm"}`}>
                  {policy.title}
                </span>
                <span className={`block text-ink-dim ${compact ? "text-xs" : "text-[13px]"}`}>
                  {policy.hint}
                </span>
              </span>
              <span
                aria-hidden="true"
                className={`${compact ? "mt-0.5" : "mt-1"} flex size-4 shrink-0 items-center justify-center rounded-full border ${
                  chosen ? "border-copper" : "border-edge"
                }`}
              >
                {chosen && <span className="fc-fill size-2 rounded-full bg-copper" />}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
