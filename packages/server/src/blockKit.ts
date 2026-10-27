import type { MessageAction, ModalField, ModalView } from "@ownbase/protocol";

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

interface InputElement {
  type?: string;
  action_id?: string;
  placeholder?: TextObject | string;
  initial_value?: string;
  multiline?: boolean;
  initial_option?: { value?: string };
  options?: { text?: TextObject | string; value?: string }[];
}

interface InputBlock extends Block {
  block_id?: string;
  label?: TextObject | string;
  hint?: TextObject | string;
  optional?: boolean;
  element?: InputElement;
}

/** Slack's ceilings for a view, so a form that works there works here. */
const MAX_FIELDS = 25;
const MAX_OPTIONS = 100;

/**
 * Slack's view object, reduced to what can actually be drawn and filled in.
 *
 * Only plain-text inputs and static selects are kept. A date picker or a
 * multi-select is dropped rather than shown as a control that does nothing,
 * and a view whose every field is dropped is refused outright — submitting a
 * form that silently lost half its questions is worse than not opening it.
 */
export function parseView(
  raw: unknown,
  id: string,
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
    const kind =
      element.type === "plain_text_input"
        ? element.multiline
          ? ("textarea" as const)
          : ("text" as const)
        : element.type === "static_select"
          ? ("select" as const)
          : null;
    if (!kind) {
      droppedFields++;
      continue;
    }
    if (fields.length >= MAX_FIELDS) {
      droppedFields++;
      continue;
    }
    const options = (element.options ?? [])
      .slice(0, MAX_OPTIONS)
      .map((o) => ({ text: textOf(o?.text).trim(), value: String(o?.value ?? "") }))
      .filter((o) => o.text && o.value);
    // A select with nothing to select is not a field, it is a dead end.
    if (kind === "select" && options.length === 0) {
      droppedFields++;
      continue;
    }
    fields.push({
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
      initialValue:
        kind === "select"
          ? (element.initial_option?.value ?? "")
          : typeof element.initial_value === "string"
            ? element.initial_value.slice(0, 3000)
            : "",
      options,
    });
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
