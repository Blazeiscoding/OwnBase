import { useId, useState } from "react";
import { buttonClass } from "./Button.js";
import { linkAddress } from "./FormattingToolbar.js";
import { Icon } from "./Icon.js";

/** Asks for a link's address, in the window rather than a native prompt. */
export function LinkBox(props: {
  inline: boolean;
  onAdd: (url: string) => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const fieldId = useId();
  const problemId = useId();
  return (
    <form
      aria-label="Add a link"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const url = linkAddress(typed);
        if (!url) {
          setProblem(
            typed.trim()
              ? "That is not a web address. Try one such as ownbase.site/docs."
              : "Type or paste the address the link goes to.",
          );
          return;
        }
        props.onAdd(url);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          props.onCancel();
        }
      }}
      className={
        props.inline
          ? "surface-float absolute bottom-full left-2 z-20 mb-2 w-[320px] max-w-[calc(100vw-1rem)] origin-bottom-left animate-menu-in space-y-2 rounded-xl p-3"
          : "space-y-2 border-b border-edge/60 p-3"
      }
    >
      <label htmlFor={fieldId} className="block text-[13px] font-medium text-ink-dim">
        Link address
      </label>
      <input
        id={fieldId}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- opened by the Link button or its keys, the box is for typing the address
        autoFocus
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        value={typed}
        placeholder="https://"
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? problemId : undefined}
        onChange={(e) => {
          setTyped(e.target.value);
          setProblem(null);
        }}
        className="w-full rounded-lg border border-edge bg-ground px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-copper aria-invalid:border-alert"
      />
      {problem && (
        <p id={problemId} role="alert" className="flex items-start gap-1 text-[12px] text-alert">
          <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
          <span>{problem}</span>
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={props.onCancel} className={buttonClass("quiet")}>
          Cancel
        </button>
        <button type="submit" className={buttonClass("primary")}>
          Add link
        </button>
      </div>
    </form>
  );
}
