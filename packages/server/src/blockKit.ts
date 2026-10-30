import {
  MANY_ANSWER_FIELDS,
  type ChannelType,
  type MessageAction,
  type ModalField,
  type ModalFieldType,
  type ModalOption,
  type ModalView,
} from "@ownbase/protocol";

/**
 * Slack Block Kit is what most existing integrations send. Rather than
 * implement the whole renderer, flatten the blocks that actually carry text
 * into our mrkdwn, so a payload written for Slack reads sensibly here.
 *
 * Unknown block types are skipped rather than rejected — an integration
 * sending something exotic should still get its message through.
 */

interface TextObject {
  type?: string;
  text?: string;
}

interface Block {
  type?: string;
  block_id?: string;
  text?: TextObject | string;
  fields?: TextObject[];
  elements?: (TextObject | { type?: string; text?: TextObject | string })[];
}

interface ButtonElement {
  type?: string;
  action_id?: string;
  text?: TextObject | string;
  value?: string;
  style?: string;
  url?: string;
}

function textOf(value: TextObject | string | undefined): string {
  if (typeof value === "string") return value;
  return value?.text ?? "";
}

export function blocksToText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];

  for (const raw of blocks as Block[]) {
    if (!raw || typeof raw !== "object") continue;
    switch (raw.type) {
      case "header": {
        const t = textOf(raw.text).trim();
        // Headers have no mrkdwn equivalent; bold is the closest thing.
        if (t) parts.push(`*${t}*`);
        break;
      }
      case "section": {
        const t = textOf(raw.text).trim();
        if (t) parts.push(t);
        for (const field of raw.fields ?? []) {
          const f = textOf(field).trim();
          if (f) parts.push(f);
        }
        break;
      }
      case "context": {
        // Context elements are either text objects themselves or wrappers
        // around one; images carry no text and fall out as empty.
        const bits = (raw.elements ?? [])
          .map((el) => {
            if (typeof el === "string") return el;
            const inner = (el as { text?: TextObject | string }).text;
            return textOf(inner ?? (el as TextObject));
          })
          .map((t) => t.trim())
          .filter(Boolean);
        if (bits.length > 0) parts.push(bits.join(" "));
        break;
      }
      case "divider":
        parts.push("———");
        break;
      default:
        // Buttons, images, inputs and the rest carry no plain text worth showing.
        break;
    }
  }

  return parts.join("\n\n").trim();
}

/** Slack's own ceilings, so a payload that works there works here. */
const MAX_ACTIONS = 25;
const MAX_BUTTON_TEXT = 75;
const MAX_ACTION_VALUE = 2000;

/**
 * The buttons in a payload's `actions` blocks. Everything else an actions
 * block can hold — selects, date pickers, overflow menus — is dropped, since
 * drawing a button is the whole of what this can honour so far. Dropping is
 * deliberate: half a form is worse than a message with no form.
 */
export function blocksToActions(blocks: unknown): MessageAction[] {
  if (!Array.isArray(blocks)) return [];
  const actions: MessageAction[] = [];

  for (const [index, raw] of (blocks as Block[]).entries()) {
    if (!raw || typeof raw !== "object" || raw.type !== "actions") continue;
    const blockId = typeof raw.block_id === "string" ? raw.block_id.slice(0, 255) : `b${index}`;
    for (const [n, el] of ((raw.elements ?? []) as ButtonElement[]).entries()) {
      if (!el || typeof el !== "object" || el.type !== "button") continue;
      const text = textOf(el.text).trim().slice(0, MAX_BUTTON_TEXT);
      if (!text) continue;
      const style = el.style === "primary" || el.style === "danger" ? el.style : "default";
      actions.push({
        actionId:
          typeof el.action_id === "string" && el.action_id
            ? el.action_id.slice(0, 255)
            : `a${index}_${n}`,
        blockId,
        text,
        value: typeof el.value === "string" ? el.value.slice(0, MAX_ACTION_VALUE) : "",
        style,
        // Only http(s) links; a button is not a way to hand someone a
        // javascript: or file: URL to click.
        url:
          typeof el.url === "string" && /^https?:\/\//i.test(el.url) ? el.url.slice(0, 2000) : null,
      });
      if (actions.length >= MAX_ACTIONS) return actions;
    }
  }
  return actions;
}

/**
 * The text a Slack-shaped payload should become: `text` wins, blocks fill in
 * when it is absent, which is how Slack itself treats the pair.
 */
export function payloadToText(payload: { text?: unknown; blocks?: unknown }): string {
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (text) return text;
  return blocksToText(payload.blocks);
}

interface OptionObject {
  text?: TextObject | string;
  value?: string;
  description?: TextObject | string;
}

interface InputElement {
  type?: string;
  action_id?: string;
  placeholder?: TextObject | string;
  initial_value?: string;
  multiline?: boolean;
  options?: OptionObject[];
  option_groups?: { options?: OptionObject[] }[];
  initial_option?: OptionObject;
  initial_options?: OptionObject[];
  initial_user?: string;
  initial_users?: string[];
  initial_conversation?: string;
  initial_conversations?: string[];
  initial_channel?: string;
  initial_channels?: string[];
  initial_date?: string;
  initial_time?: string;
  max_selected_items?: number;
  default_to_current_conversation?: boolean;
  filter?: { include?: unknown };
}

interface InputBlock extends Block {
  block_id?: string;
  label?: TextObject | string;
  hint?: TextObject | string;
  optional?: boolean;
  element?: InputElement;
}

/**
 * Each Slack input element this server can draw: the kind it is drawn as, and
 * the key its answer goes under in a submission's `state.values`.
 */
export const INPUT_ELEMENTS: Record<string, { kind: ModalFieldType; key: string }> = {
  plain_text_input: { kind: "text", key: "value" },
  static_select: { kind: "select", key: "selected_option" },
  multi_static_select: { kind: "multiselect", key: "selected_options" },
  checkboxes: { kind: "checkboxes", key: "selected_options" },
  radio_buttons: { kind: "radio", key: "selected_option" },
  users_select: { kind: "user", key: "selected_user" },
  multi_users_select: { kind: "users", key: "selected_users" },
  conversations_select: { kind: "conversation", key: "selected_conversation" },
  multi_conversations_select: { kind: "conversations", key: "selected_conversations" },
  channels_select: { kind: "channel", key: "selected_channel" },
  multi_channels_select: { kind: "channels", key: "selected_channels" },
  datepicker: { kind: "date", key: "selected_date" },
  timepicker: { kind: "time", key: "selected_time" },
};

/** The way back: which element a kind came from, to name it in a submission. */
const SUBMITTED = new Map<ModalFieldType, { element: string; key: string }>([
  ...Object.entries(INPUT_ELEMENTS).map(
    ([element, { kind, key }]) => [kind, { element, key }] as const,
  ),
  ["textarea", { element: "plain_text_input", key: "value" }],
]);

/** Slack's names for the kinds of conversation a picker can be limited to. */
const CONVERSATION_FILTER: Record<string, ChannelType> = {
  public: "public",
  private: "private",
  im: "dm",
  mpim: "group_dm",
};

/** The kinds that choose from options the app listed. */
const OPTION_KINDS: ReadonlySet<ModalFieldType> = new Set([
  "select",
  "multiselect",
  "checkboxes",
  "radio",
]);

/** Slack's ceilings for a view, so a form that works there works here. */
const MAX_FIELDS = 25;
const MAX_OPTIONS = 100;
/** Checkboxes and radio buttons are drawn all at once, which is why Slack stops at ten. */
const MAX_LISTED_OPTIONS = 10;
const MAX_ID = 255;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** `YYYY-MM-DD`, and a day the calendar has: no 31 April. */
export function isDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** `HH:mm` on a 24-hour clock, as Slack's time picker sends it. */
export function isTime(value: string): boolean {
  return TIME.test(value);
}

const idOf = (value: unknown): string =>
  typeof value === "string" && value.length <= MAX_ID ? value : "";

const idsOf = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.map(idOf).filter(Boolean))] : [];

/** A select's options, or its groups' options run together: groups are not drawn. */
function optionsOf(element: InputElement, kind: ModalFieldType): ModalOption[] {
  const listed = Array.isArray(element.options)
    ? element.options
    : Array.isArray(element.option_groups)
      ? element.option_groups.flatMap((group) =>
          Array.isArray(group?.options) ? group.options : [],
        )
      : [];
  const seen = new Set<string>();
  const options: ModalOption[] = [];
  for (const raw of listed) {
    const text = textOf(raw?.text).trim();
    const value = String(raw?.value ?? "");
    // Two options with one value could not be told apart in the answer.
    if (!text || !value || seen.has(value)) continue;
    seen.add(value);
    const description = textOf(raw?.description).trim();
    options.push(description ? { text, value, description } : { text, value });
  }
  const most = kind === "checkboxes" || kind === "radio" ? MAX_LISTED_OPTIONS : MAX_OPTIONS;
  return options.slice(0, most);
}

/** What a one-answer field starts with. */
function initialOne(
  element: InputElement,
  kind: ModalFieldType,
  options: ModalOption[],
  context: { channelId?: string },
): string {
  switch (kind) {
    case "text":
    case "textarea":
      return typeof element.initial_value === "string" ? element.initial_value.slice(0, 3000) : "";
    case "select":
    case "radio": {
      const value = element.initial_option?.value;
      return options.some((o) => o.value === value) ? (value as string) : "";
    }
    case "user":
      return idOf(element.initial_user);
    case "conversation":
      return (
        idOf(element.initial_conversation) ||
        (element.default_to_current_conversation === true ? (context.channelId ?? "") : "")
      );
    case "channel":
      return idOf(element.initial_channel);
    case "date":
      return typeof element.initial_date === "string" && isDate(element.initial_date)
        ? element.initial_date
        : "";
    case "time":
      return typeof element.initial_time === "string" && isTime(element.initial_time)
        ? element.initial_time
        : "";
    default:
      return "";
  }
}

/** What a list field starts with chosen. */
function initialMany(
  element: InputElement,
  kind: ModalFieldType,
  options: ModalOption[],
  context: { channelId?: string },
): string[] {
  switch (kind) {
    case "multiselect":
    case "checkboxes": {
      const wanted = new Set(
        (Array.isArray(element.initial_options) ? element.initial_options : []).map((o) =>
          String(o?.value ?? ""),
        ),
      );
      return options.filter((o) => wanted.has(o.value)).map((o) => o.value);
    }
    case "users":
      return idsOf(element.initial_users);
    case "conversations": {
      const given = idsOf(element.initial_conversations);
      if (given.length > 0) return given;
      return element.default_to_current_conversation === true && context.channelId
        ? [context.channelId]
        : [];
    }
    case "channels":
      return idsOf(element.initial_channels);
    default:
      return [];
  }
}

/** The kinds of conversation a picker's `filter.include` allows, or undefined for all. */
function conversationTypesOf(filter: InputElement["filter"]): ChannelType[] | undefined {
  const include: unknown[] = Array.isArray(filter?.include) ? filter.include : [];
  const types = new Set<ChannelType>();
  for (const name of include) {
    if (typeof name === "string" && CONVERSATION_FILTER[name]) types.add(CONVERSATION_FILTER[name]);
  }
  return types.size > 0 ? [...types] : undefined;
}

/**
 * Slack's view object, reduced to what can actually be drawn and filled in.
 *
 * Text inputs, selects (one or several, from options, people, conversations or
 * channels), checkboxes, radio buttons and date and time pickers are kept.
 * Anything else is dropped rather than shown as a control that does nothing,
 * and a view whose every field is dropped is refused outright: submitting a
 * form that silently lost half its questions is worse than not opening it.
 *
 * `channelId` is where the view was asked for from, which is what Slack's
 * `default_to_current_conversation` starts a conversation picker on.
 */
export function parseView(
  raw: unknown,
  id: string,
  context: { channelId?: string } = {},
): Omit<ModalView, "id"> & { id: string; droppedFields: number } {
  const view = (raw ?? {}) as {
    title?: TextObject | string;
    submit?: TextObject | string;
    close?: TextObject | string;
    callback_id?: string;
    private_metadata?: string;
    blocks?: unknown;
  };
  const blocks: InputBlock[] = Array.isArray(view.blocks) ? (view.blocks as InputBlock[]) : [];

  const fields: ModalField[] = [];
  let droppedFields = 0;
  for (const [index, block] of blocks.entries()) {
    if (!block || typeof block !== "object" || block.type !== "input") continue;
    const element = block.element ?? {};
    const known = typeof element.type === "string" ? INPUT_ELEMENTS[element.type] : undefined;
    if (!known || fields.length >= MAX_FIELDS) {
      droppedFields++;
      continue;
    }
    const kind = known.kind === "text" && element.multiline ? "textarea" : known.kind;
    const options = OPTION_KINDS.has(kind) ? optionsOf(element, kind) : [];
    // A choice with nothing to choose is not a field, it is a dead end.
    if (OPTION_KINDS.has(kind) && options.length === 0) {
      droppedFields++;
      continue;
    }
    const many = MANY_ANSWER_FIELDS.has(kind);
    const field: ModalField = {
      blockId: typeof block.block_id === "string" && block.block_id ? block.block_id : `b${index}`,
      actionId:
        typeof element.action_id === "string" && element.action_id
          ? element.action_id
          : `a${index}`,
      label: textOf(block.label).trim().slice(0, 200) || `Field ${fields.length + 1}`,
      hint: textOf(block.hint).trim().slice(0, 300),
      optional: block.optional === true,
      type: kind,
      placeholder: textOf(element.placeholder).trim().slice(0, 150),
      initialValue: many ? "" : initialOne(element, kind, options, context),
      options,
    };
    if (many) field.initialValues = initialMany(element, kind, options, context);
    // Checkboxes have no limit in Slack; its multi-selects do.
    const max = element.max_selected_items;
    if (many && kind !== "checkboxes" && Number.isInteger(max) && (max as number) >= 1) {
      field.maxSelected = Math.min(max as number, MAX_OPTIONS);
    }
    if (kind === "conversation" || kind === "conversations") {
      const types = conversationTypesOf(element.filter);
      if (types) field.conversationTypes = types;
    }
    fields.push(field);
  }

  return {
    id,
    callbackId: typeof view.callback_id === "string" ? view.callback_id.slice(0, 255) : "",
    title: textOf(view.title).trim().slice(0, 100) || "Untitled",
    submitLabel: textOf(view.submit).trim().slice(0, 40) || "Submit",
    closeLabel: textOf(view.close).trim().slice(0, 40) || "Cancel",
    privateMetadata:
      typeof view.private_metadata === "string" ? view.private_metadata.slice(0, 3000) : "",
    // Sections and headers above the inputs still carry the explanation.
    text: blocksToText(blocks.filter((b) => b?.type !== "input")),
    fields,
    droppedFields,
  };
}

/** What a submission is checked against, for the person submitting it. */
export interface AnswerContext {
  /** Whether this account can be chosen: it exists and is not deactivated. */
  isPerson(id: string): boolean;
  /** The kind of a conversation this person can see, or null if none or archived. */
  conversationType(id: string): ChannelType | null;
}

const REQUIRED = "This is required.";

/** Slack's shape for a chosen option in `state.values`. */
function optionState(option: ModalOption) {
  return {
    text: { type: "plain_text", text: option.text },
    value: option.value,
    ...(option.description
      ? { description: { type: "plain_text", text: option.description } }
      : {}),
  };
}

/** Whether an id is one this picker offers. */
function offers(field: ModalField, id: string, context: AnswerContext): boolean {
  switch (field.type) {
    case "user":
    case "users":
      return context.isPerson(id);
    case "conversation":
    case "conversations": {
      const type = context.conversationType(id);
      return type !== null && (!field.conversationTypes || field.conversationTypes.includes(type));
    }
    case "channel":
    case "channels":
      return context.conversationType(id) === "public";
    default:
      return false;
  }
}

function refusal(kind: ModalFieldType): string {
  if (kind === "user" || kind === "users") return "Choose someone in this workspace.";
  if (kind === "channel" || kind === "channels") return "Choose a public channel.";
  return "Choose a conversation you can see.";
}

/**
 * One field's answer, checked against what the field offered and shaped as
 * Slack's `state.values` entry, or the message to show under the field.
 *
 * Nothing the form itself forbids reaches the app: it may trust that a choice
 * is one of its own options, and that a person or channel it is handed exists
 * and could have been chosen. A hand-written request, or an older client that
 * drew a picker as a text box, is checked the same way.
 */
export function readAnswer(
  field: ModalField,
  raw: string | string[] | undefined,
  context: AnswerContext,
): { state: Record<string, unknown> } | { error: string } {
  const { element, key } = SUBMITTED.get(field.type)!;
  const shaped = (answer: unknown) => ({ state: { type: element, [key]: answer } });

  if (MANY_ANSWER_FIELDS.has(field.type)) {
    const listed = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const chosen = [...new Set(listed.map((v) => v.trim()).filter(Boolean))];
    if (chosen.length === 0 && !field.optional) return { error: REQUIRED };
    if (field.maxSelected !== undefined && chosen.length > field.maxSelected) {
      return { error: `Choose at most ${field.maxSelected}.` };
    }
    if (OPTION_KINDS.has(field.type)) {
      const picked = chosen.map((value) => field.options.find((o) => o.value === value));
      if (picked.some((o) => !o)) return { error: "Choose from the options given." };
      return shaped(picked.map((o) => optionState(o!)));
    }
    if (chosen.some((id) => !offers(field, id, context))) return { error: refusal(field.type) };
    return shaped(chosen);
  }

  if (Array.isArray(raw)) return { error: "Choose only one." };
  const value = (raw ?? "").trim();
  if (!value) {
    if (!field.optional) return { error: REQUIRED };
    return shaped(field.type === "text" || field.type === "textarea" ? "" : null);
  }
  switch (field.type) {
    case "text":
    case "textarea":
      return shaped(value);
    case "select":
    case "radio": {
      const option = field.options.find((o) => o.value === value);
      return option ? shaped(optionState(option)) : { error: "Choose one of the options." };
    }
    case "date":
      return isDate(value) ? shaped(value) : { error: "Enter a date such as 2026-10-31." };
    case "time":
      return isTime(value) ? shaped(value) : { error: "Enter a time such as 14:30." };
    default:
      return offers(field, value, context) ? shaped(value) : { error: refusal(field.type) };
  }
}
