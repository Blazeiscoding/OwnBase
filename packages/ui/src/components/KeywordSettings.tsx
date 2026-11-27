import { useId, useState, type FormEvent } from "react";
import { keywordKey, KEYWORD_LENGTH_MAX, KEYWORDS_MAX } from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { settingMark } from "../lib/accountSections.js";
import { failureText } from "../lib/failure.js";
import { useSaved } from "../lib/savedNote.js";
import { buttonClass } from "./Button.js";
import { Icon } from "./Icon.js";
import { inputClass } from "./TextField.js";

/**
 * Account settings, Notifications: "My keywords" (K11), the words or short
 * phrases that notify as a mention does. Several typed with commas between
 * are added together. Each change saves at once, as the page's other choices
 * do, for every device of the account.
 */
export function KeywordSettings() {
  const client = useClient();
  const keywords = useWorkspace((s) => s.keywords);
  const saved = useSaved();
  const id = useId();
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(next: string[], failure: string): Promise<boolean> {
    setSaving(true);
    setFailed(null);
    const error = await client.setKeywords(next);
    setSaving(false);
    if (error) {
      setFailed(failureText(failure, error, "Try again."));
      return false;
    }
    saved();
    return true;
  }

  /** What is wrong with the words typed, or the keywords they add. */
  function read(typed: string[]): string | string[] {
    if (typed.length === 0) return "Type a word or a short phrase first.";
    const keys = new Set(keywords.map(keywordKey));
    const fresh: string[] = [];
    for (const keyword of typed) {
      const key = keywordKey(keyword);
      if (!key) return `“${keyword}” has no letters or numbers, so no message could match it.`;
      if (keyword.length > KEYWORD_LENGTH_MAX)
        return `“${keyword.slice(0, 20)}…” is too long. Keep a keyword to ${KEYWORD_LENGTH_MAX} characters.`;
      if (keys.has(key)) continue;
      keys.add(key);
      fresh.push(keyword);
    }
    if (fresh.length === 0)
      return typed.length === 1
        ? "That keyword is on your list already."
        : "Those keywords are on your list already.";
    if (keywords.length + fresh.length > KEYWORDS_MAX)
      return `You can have up to ${KEYWORDS_MAX} keywords. Remove one to add another.`;
    return fresh;
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const typed = draft
      .split(",")
      .map((keyword) => keyword.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    const fresh = read(typed);
    if (typeof fresh === "string") return setProblem(fresh);
    setProblem(null);
    if (await save([...keywords, ...fresh], "Your keywords were not saved.")) setDraft("");
  }

  return (
    <section
      {...settingMark("keywords")}
      aria-labelledby="account-keywords-title"
      className="mt-6 border-t border-edge pt-5"
    >
      <h3 id="account-keywords-title" className="font-semibold">
        My keywords
      </h3>
      <p className="mt-1 text-sm text-ink-dim">
        A message with one of these words or phrases notifies you as a mention would and shows in
        Activity under Mentions. Conversations and threads you muted stay quiet. Activity lists
        messages sent after you added the keyword.
      </p>
      <form className="mt-3" onSubmit={(event) => void add(event)} noValidate>
        <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium text-ink-dim">
          Add keywords
        </label>
        <div className="flex gap-2">
          <input
            id={id}
            className={inputClass("regular", "min-w-0 flex-1")}
            value={draft}
            autoComplete="off"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `${id}-error ${id}-hint` : `${id}-hint`}
            onChange={(event) => {
              setDraft(event.target.value);
              setProblem(null);
            }}
          />
          <button type="submit" className={buttonClass("secondary")} disabled={saving}>
            Add
          </button>
        </div>
        {problem && (
          <p id={`${id}-error`} role="alert" className="mt-1.5 text-[12px] text-alert">
            {problem}
          </p>
        )}
        <p id={`${id}-hint`} className="mt-1.5 text-[12px] text-ink-faint">
          Up to {KEYWORDS_MAX}, the same on all your devices. Add several at once with commas
          between them.
        </p>
      </form>
      {keywords.length === 0 ? (
        <p className="mt-3 text-sm text-ink-faint">You have no keywords yet.</p>
      ) : (
        <ul aria-label="Your keywords" className="mt-3 flex flex-wrap gap-1.5">
          {keywords.map((keyword) => (
            <li
              key={keyword}
              className="flex items-center gap-0.5 rounded-full border border-edge bg-raised py-0.5 pe-0.5 ps-2.5 text-sm"
            >
              <span className="break-all">{keyword}</span>
              <button
                type="button"
                aria-label={`Remove ${keyword}`}
                className="grid size-6 shrink-0 place-items-center rounded-full text-ink-faint hover:bg-ink/[0.07] hover:text-ink disabled:opacity-50"
                disabled={saving}
                onClick={() =>
                  void save(
                    keywords.filter((kept) => kept !== keyword),
                    "The keyword was not removed.",
                  )
                }
              >
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {failed && (
        <p role="alert" className="mt-2 text-sm text-alert">
          {failed}
        </p>
      )}
    </section>
  );
}
