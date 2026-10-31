import { useEffect, useMemo, useRef, useState } from "react";
import {
  MANY_ANSWER_FIELDS,
  type Channel,
  type ID,
  type ModalField,
  type ModalFieldType,
  type ModalView,
  type User,
} from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { Dialog, DialogScroll } from "./Dialog.js";
import { inputCls } from "./TextField.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { buttonClass } from "./Button.js";

/**
 * A form an app asked for. The answers go straight back to that app, so this
 * deliberately looks like part of the app's message rather than part of the
 * workspace: nothing here is stored, and closing it tells the app nothing.
 */
export function ViewModal() {
  const view = useWorkspace((s) => s.modal);
  const below = useWorkspace((s) => s.modalsBelow);
  /**
   * What was entered in each form of a stack, so going back to one finds it
   * as it was left. Kept only while the form is open.
   */
  const drafts = useRef(new Map<ID, Record<string, Answer>>());
  useEffect(() => {
    const open = new Set([...below, ...(view ? [view] : [])].map((v) => v.id));
    for (const id of drafts.current.keys()) if (!open.has(id)) drafts.current.delete(id);
  }, [view, below]);
  // A new form starts with its own answers and results; an updated one keeps its id.
  return view ? (
    <AppForm
      key={view.id}
      view={view}
      backTo={below.at(-1)?.title ?? null}
      draft={drafts.current.get(view.id)}
      onDraft={(values) => drafts.current.set(view.id, values)}
    />
  ) : null;
}

/** One answer, or several for the kinds that take a list. */
type Answer = string | string[];

/** Something a field offers to choose: what is sent, what is shown, and who, for a person. */
interface Choice {
  value: string;
  text: string;
  description?: string;
  person?: User;
}

/** The one-answer kinds that choose from a list, drawn as a select. */
const ONE_CHOICE: ReadonlySet<ModalFieldType> = new Set([
  "select",
  "user",
  "conversation",
  "channel",
]);

/** What a one-answer select says before anything is chosen, when the app gave no placeholder. */
const PROMPT: Partial<Record<ModalFieldType, string>> = {
  select: "Choose one…",
  user: "Choose someone…",
  conversation: "Choose a conversation…",
  channel: "Choose a channel…",
};

/** More choices than this, and a list picker gets a field to narrow it. */
const FILTER_FROM = 6;

const byText = (a: Choice, b: Choice) => a.text.localeCompare(b.text);

/**
 * What a field offers: the app's own options, or for a picker what this
 * account can see. The server checks every answer again, so a list drawn from
 * a stale copy of the workspace costs a refusal, not a wrong answer.
 */
function choicesFor(
  field: ModalField,
  users: Record<ID, User>,
  channels: Record<ID, Channel>,
  selfId: ID | undefined,
): Choice[] {
  switch (field.type) {
    case "select":
    case "multiselect":
    case "checkboxes":
    case "radio":
      return field.options;
    case "user":
    case "users":
      return Object.values(users)
        .filter((u) => !u.deactivated && !u.isBot)
        .map((u) => ({ value: u.id, text: u.displayName, person: u }))
        .sort(byText);
    case "conversation":
    case "conversations":
    case "channel":
    case "channels": {
      const kinds: readonly string[] | undefined =
        field.type === "channel" || field.type === "channels"
          ? ["public"]
          : field.conversationTypes;
      return Object.values(channels)
        .filter((c) => !c.archived && (!kinds || kinds.includes(c.type)))
        .map((c) => ({
          value: c.id,
          text:
            c.type === "public" || c.type === "private"
              ? `#${c.name}`
              : channelTitle(c, users, selfId),
        }))
        .sort(byText);
    }
    default:
      return [];
  }
}

function AppForm(props: {
  view: ModalView;
  /** The title of the form under this one, which closing it goes back to. */
  backTo: string | null;
  draft: Record<string, Answer> | undefined;
  onDraft: (values: Record<string, Answer>) => void;
}) {
  const { view, backTo, onDraft } = props;
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const selfId = useWorkspace((s) => s.self?.id);
  const [values, setValues] = useState<Record<string, Answer>>(props.draft ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set by a refused submission, so the first field the app refused takes focus. */
  const showError = useRef(false);
  const alive = useRef(true);
  const submitting = useRef(false);

  const choices = useMemo(
    () =>
      Object.fromEntries(
        view.fields.map((field) => [fieldId(field), choicesFor(field, users, channels, selfId)]),
      ),
    [view, users, channels, selfId],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!showError.current) return;
    showError.current = false;
    const refused = view.fields.find((field) => errors[field.blockId]);
    if (refused) document.getElementById(fieldId(refused))?.focus();
  }, [errors, view]);

  useEffect(() => {
    onDraft(values);
  }, [values, onDraft]);

  // The app changed this form: what it refused before may not apply now.
  // What was typed stays, as on Slack, in inputs that kept their ids.
  const shownHash = useRef(view.hash);
  useEffect(() => {
    if (shownHash.current === view.hash) return;
    shownHash.current = view.hash;
    setErrors({});
    setMessage(null);
  }, [view.hash]);

  /**
   * What a field holds: what was entered, or what the app started it with.
   * A starting choice this account cannot see is left out rather than sent
   * unseen. Keyed by block as well: an action id need only be unique within
   * its block, and two fields sharing one would otherwise share a value.
   */
  const answerOf = (field: ModalField): Answer => {
    const own = values[fieldId(field)];
    if (own !== undefined) return own;
    const offered = choices[fieldId(field)] ?? [];
    if (MANY_ANSWER_FIELDS.has(field.type)) {
      return (field.initialValues ?? []).filter((v) => offered.some((c) => c.value === v));
    }
    if (ONE_CHOICE.has(field.type) || field.type === "radio") {
      return offered.some((c) => c.value === field.initialValue) ? field.initialValue : "";
    }
    return field.initialValue;
  };
  const setAnswer = (field: ModalField, value: Answer) =>
    setValues((v) => ({ ...v, [fieldId(field)]: value }));

  /** Back to the form under this one, or closed when there is none. */
  function close() {
    alive.current = false;
    client.dismissModal(view.id);
  }

  /** The dialog's own close: every form in the stack. */
  function closeAll() {
    alive.current = false;
    client.dismissAllModals();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!alive.current || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setMessage(null);
    // Nested the way the app will read it back: block id, then action id.
    const payload: Record<string, Record<string, Answer>> = {};
    for (const field of view.fields) {
      payload[field.blockId] = { ...payload[field.blockId], [field.actionId]: answerOf(field) };
    }
    try {
      const result = await client.submitModal(payload, view.id);
      if (!alive.current) return;
      // Accepted and still open: the app changed it or stacked another on it.
      if (result.ok) {
        setErrors({});
      } else {
        showError.current = true;
        setErrors(result.errors ?? {});
        setMessage(result.message ?? null);
      }
    } catch {
      if (alive.current) setMessage("That did not go through.");
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return (
    <Dialog title={view.title} onClose={closeAll} width={520} ownScroll>
      {/* An app decides how many fields there are; the buttons stay in sight
          under however many that is. */}
      <form onSubmit={submit} className="flex min-h-0 flex-col">
        <DialogScroll>
          {view.text && (
            <div className="mb-4 text-sm text-ink-dim">
              <Mrkdwn text={view.text} users={users} channels={channels} />
            </div>
          )}

          <div className="space-y-3.5">
            {view.fields.map((field) => {
              const id = fieldId(field);
              const error = errors[field.blockId];
              // The error replaces the hint on screen, and so in what is read.
              const described = error ? `${id}-error` : field.hint ? `${id}-hint` : undefined;
              const label = (
                <>
                  {field.label}
                  {field.optional && (
                    <span className="ml-1.5 text-[11px] font-normal text-ink-faint">optional</span>
                  )}
                </>
              );
              const notes = (
                <>
                  {field.hint && !error && (
                    <p id={`${id}-hint`} className="mt-1 text-[11px] text-ink-faint">
                      {field.hint}
                    </p>
                  )}
                  {error && (
                    <p id={`${id}-error`} role="alert" className="mt-1 text-[11px] text-alert">
                      {error}
                    </p>
                  )}
                </>
              );
              const offered = choices[id] ?? [];
              const answer = answerOf(field);

              // Several controls answer together, so they are one group with
              // one name, and the hint or error is read on entering it.
              if (field.type === "radio" || MANY_ANSWER_FIELDS.has(field.type)) {
                return (
                  <fieldset
                    key={id}
                    role={field.type === "radio" ? "radiogroup" : undefined}
                    aria-required={field.type === "radio" ? !field.optional : undefined}
                    aria-describedby={described}
                  >
                    <legend className="mb-1 text-[13px] font-medium">{label}</legend>
                    {field.type === "radio" || field.type === "checkboxes" ? (
                      <ShortList
                        id={id}
                        field={field}
                        choices={offered}
                        answer={answer}
                        invalid={!!error}
                        onChange={(next) => setAnswer(field, next)}
                      />
                    ) : (
                      <PickList
                        id={id}
                        field={field}
                        choices={offered}
                        chosen={answer as string[]}
                        invalid={!!error}
                        onChange={(next) => setAnswer(field, next)}
                      />
                    )}
                    {notes}
                  </fieldset>
                );
              }

              const shared = {
                id,
                "aria-describedby": described,
                "aria-invalid": error ? true : undefined,
                "aria-required": !field.optional,
              };
              return (
                <div key={id}>
                  <label htmlFor={id} className="mb-1 block text-[13px] font-medium">
                    {label}
                  </label>

                  {ONE_CHOICE.has(field.type) ? (
                    <select
                      {...shared}
                      value={answer as string}
                      onChange={(e) => setAnswer(field, e.target.value)}
                      className={inputCls}
                    >
                      <option value="">{field.placeholder || PROMPT[field.type]}</option>
                      {offered.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.text}
                        </option>
                      ))}
                    </select>
                  ) : field.type === "textarea" ? (
                    <textarea
                      {...shared}
                      value={answer as string}
                      placeholder={field.placeholder}
                      rows={4}
                      onChange={(e) => setAnswer(field, e.target.value)}
                      className={`${inputCls} resize-y`}
                    />
                  ) : (
                    <input
                      {...shared}
                      // The browser's own pickers, which already know the
                      // person's calendar, clock and keyboard.
                      type={
                        field.type === "date" ? "date" : field.type === "time" ? "time" : "text"
                      }
                      value={answer as string}
                      placeholder={field.placeholder}
                      onChange={(e) => setAnswer(field, e.target.value)}
                      className={inputCls}
                    />
                  )}

                  {notes}
                </div>
              );
            })}
          </div>

          {message && (
            <p role="alert" className="mt-3 text-[12px] text-alert">
              {message}
            </p>
          )}
        </DialogScroll>
        <div className="dialog-foot flex justify-end gap-2">
          {/* On a stacked form this goes back, as on Slack; the dialog's own
              close shuts them all. */}
          <button
            type="button"
            onClick={close}
            aria-label={backTo ? backName(view.closeLabel, backTo) : undefined}
            className={buttonClass("secondary")}
          >
            {view.closeLabel}
          </button>
          {/* "Loading" or "Done": only shown, nothing to send. */}
          {view.submitLabel && (
            <button type="submit" disabled={busy} className={buttonClass("primary")}>
              {busy ? "Sending…" : view.submitLabel}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

const ROW =
  "flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-ink/[0.04] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-copper has-[:disabled]:cursor-default has-[:disabled]:opacity-50";
const MARK = "mt-0.5 size-4 shrink-0 accent-[var(--color-copper)]";

/**
 * Checkboxes or radio buttons, all in sight: Slack allows ten of either, few
 * enough to read at a glance. The first takes the field's id, so a refused
 * answer can bring focus here.
 */
function ShortList(props: {
  id: string;
  field: ModalField;
  choices: Choice[];
  answer: Answer;
  invalid: boolean;
  onChange: (answer: Answer) => void;
}) {
  const { id, field, choices, answer, invalid, onChange } = props;
  const radio = field.type === "radio";
  const chosen = Array.isArray(answer) ? answer : answer ? [answer] : [];
  return (
    <div className="-mx-2 space-y-0.5">
      {choices.map((choice, index) => {
        const on = chosen.includes(choice.value);
        return (
          <label key={choice.value} className={ROW}>
            <input
              id={index === 0 ? id : undefined}
              type={radio ? "radio" : "checkbox"}
              name={id}
              value={choice.value}
              checked={on}
              aria-invalid={invalid || undefined}
              onChange={(e) =>
                onChange(
                  radio
                    ? choice.value
                    : e.target.checked
                      ? [...chosen, choice.value]
                      : chosen.filter((v) => v !== choice.value),
                )
              }
              className={MARK}
            />
            <span className="min-w-0 text-sm">
              <span className="block">{choice.text}</span>
              {choice.description && (
                <span className="block text-[12px] text-ink-faint">{choice.description}</span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * Several from a list that can run long: the app's options, people, or
 * conversations. A field narrows it once there are more than a handful, and
 * what is chosen stays in sight whatever the field holds. At the app's limit
 * the rest wait until something is taken back.
 */
function PickList(props: {
  id: string;
  field: ModalField;
  choices: Choice[];
  chosen: string[];
  invalid: boolean;
  onChange: (chosen: string[]) => void;
}) {
  const { id, field, choices, chosen, invalid, onChange } = props;
  const [query, setQuery] = useState("");
  const filtered = choices.length > FILTER_FROM;
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle
    ? choices.filter(
        (c) =>
          chosen.includes(c.value) ||
          c.text.toLocaleLowerCase().includes(needle) ||
          c.person?.handle.toLocaleLowerCase().includes(needle),
      )
    : choices;
  const full = field.maxSelected !== undefined && chosen.length >= field.maxSelected;
  const count =
    field.maxSelected !== undefined
      ? `${chosen.length} of up to ${field.maxSelected} chosen`
      : `${chosen.length} chosen`;

  if (choices.length === 0) {
    return (
      <p id={id} tabIndex={-1} className="text-sm text-ink-faint">
        {field.type === "users" ? "There is no one to choose yet." : "There is nothing to choose."}
      </p>
    );
  }
  return (
    <div>
      {filtered && (
        <input
          id={id}
          type="search"
          value={query}
          aria-label={`Search ${field.label}`}
          aria-invalid={invalid || undefined}
          placeholder={field.placeholder || "Search"}
          onChange={(e) => setQuery(e.target.value)}
          className={`${inputCls} mb-1.5`}
        />
      )}
      <ul className="max-h-52 space-y-0.5 overflow-y-auto rounded-lg border border-edge p-1">
        {shown.map((choice, index) => {
          const on = chosen.includes(choice.value);
          return (
            <li key={choice.value}>
              <label className={`${ROW} items-center`}>
                <input
                  id={!filtered && index === 0 ? id : undefined}
                  type="checkbox"
                  checked={on}
                  disabled={!on && full}
                  aria-invalid={invalid || undefined}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...chosen, choice.value]
                        : chosen.filter((v) => v !== choice.value),
                    )
                  }
                  className="size-4 shrink-0 accent-[var(--color-copper)]"
                />
                {choice.person && <Avatar user={choice.person} size={20} />}
                <span className="min-w-0 truncate text-sm">{choice.text}</span>
              </label>
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="px-2 py-1.5 text-sm text-ink-faint">Nothing matches “{query.trim()}”.</li>
        )}
      </ul>
      {(chosen.length > 0 || field.maxSelected !== undefined) && (
        <p className="mt-1 text-[11px] text-ink-faint">{count}</p>
      )}
    </div>
  );
}

/**
 * What the close button of a stacked form is read as: where it goes, and the
 * words it shows, which a name read aloud must contain. An app that already
 * calls it Back is not echoed.
 */
function backName(label: string, backTo: string): string {
  return /^back\b/i.test(label) ? `${label} to ${backTo}` : `${label}, back to ${backTo}`;
}

/** A field's element id, and the key its value is kept under. */
function fieldId(field: ModalField) {
  return `${field.blockId}.${field.actionId}`;
}
