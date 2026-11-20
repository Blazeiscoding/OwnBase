import { useState } from "react";
import { useCopy } from "../lib/useCopy.js";
import { useTabs } from "../lib/useTabs.js";
import {
  APP_TEMPLATES,
  CI_SECRET,
  CI_TEST_MESSAGE,
  TEMPLATE_TITLES,
  WEBHOOK_EXAMPLE,
  ciExample,
  commandExample,
  commandName,
  curlExample,
  suggestedAppName,
  type AppTemplate,
} from "../lib/appTemplates.js";
import { type Channel, type ID, type SlashCommand } from "@ownbase/protocol";
import { ApiError, type AppDetail } from "@ownbase/client-core";
import { useClient } from "../context.js";
import { failureText } from "../lib/failure.js";
import { TextField } from "./TextField.js";
import { Select } from "./Select.js";
import { Swap } from "./Motion.js";
import { buttonClass } from "./Button.js";
import { useToast } from "./Toast.js";
import { SecretRow } from "./appParts.js";

/** A field's share of a template's row: it grows, and wraps to a line of its own when narrow. */
const rowField = "min-w-0 flex-1 basis-40";

/** What each template's choices come to, shared so that one made in a template is ready in the next. */
interface TemplateChoice {
  /** The app chosen to post as, or null for a new one. */
  app: AppDetail | null;
  newName: string;
  channel: Channel | null;
  /** The chosen app, made first when it is to be a new one. */
  ensureApp: () => Promise<AppDetail | ApiError>;
  /** The Post as field, with the new app's name beside it when there is one to name. */
  postAs: React.ReactNode;
  channelField: (label: string) => React.ReactNode;
}

/**
 * Where Apps and integrations starts (UX-63): the three things most people
 * come here for, each set up in a click or two, with an example to copy and a
 * test that goes the whole way, so nobody has to read how this differs from
 * Slack before something posts. The app and channel chosen are shared between
 * them, so a webhook made in one is ready in another.
 */
export function AppTemplates(props: {
  apps: AppDetail[];
  rooms: Channel[];
  hookUrls: Record<ID, string>;
  /** Makes an app and shows it below with its one-time token. */
  makeApp: (name: string) => Promise<AppDetail | ApiError>;
  makeWebhook: (appId: ID, channelId: ID) => Promise<string | ApiError>;
  onChanged: () => void;
}) {
  const [template, setTemplate] = useState<AppTemplate>("webhook");
  const tabs = useTabs({
    label: "Templates",
    tabs: APP_TEMPLATES,
    selected: template,
    onSelect: setTemplate,
  });
  const [appId, setAppId] = useState<ID>("");
  const [typedName, setTypedName] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<ID>("");
  const [command, setCommand] = useState("/deploy");
  const rooms = [...props.rooms].sort((a, b) => a.name.localeCompare(b.name));
  // An app deleted below, or a channel archived, falls back rather than vanishing.
  const app = props.apps.find((a) => a.id === appId) ?? null;
  const channel =
    rooms.find((c) => c.id === channelId) ??
    rooms.find((c) => c.name === "general") ??
    rooms[0] ??
    null;
  const newName = typedName ?? suggestedAppName(template, commandName(command));

  const choice: TemplateChoice = {
    app,
    newName,
    channel,
    ensureApp: async () => {
      if (app) return app;
      const made = await props.makeApp(newName.trim());
      if (!(made instanceof ApiError)) setAppId(made.id);
      return made;
    },
    postAs: (
      <>
        <Select
          size="small"
          label="Post as"
          value={app?.id ?? ""}
          onChange={(e) => setAppId(e.target.value)}
          className={rowField}
        >
          <option value="">A new app</option>
          {props.apps.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        {!app && (
          <TextField
            size="small"
            label="New app name"
            value={newName}
            onChange={(e) => setTypedName(e.target.value)}
            className={rowField}
          />
        )}
      </>
    ),
    channelField: (label) => (
      <Select
        size="small"
        label={label}
        value={channel?.id ?? ""}
        onChange={(e) => setChannelId(e.target.value)}
        className={rowField}
      >
        {rooms.map((c) => (
          <option key={c.id} value={c.id}>
            #{c.name}
          </option>
        ))}
      </Select>
    ),
  };

  return (
    <>
      <div {...tabs.listProps} className="mb-3 flex gap-1 rounded-lg bg-ground p-1">
        {APP_TEMPLATES.map((t) => (
          <button
            key={t}
            {...tabs.tabProps(t)}
            className={`flex-1 rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors ${
              template === t ? "bg-lifted text-ink" : "text-ink-dim hover:text-ink"
            }`}
          >
            {TEMPLATE_TITLES[t]}
          </button>
        ))}
      </div>
      <div {...tabs.panelProps} className="rounded-xl border border-edge p-3">
        {template === "command" ? (
          <CommandTemplate
            choice={choice}
            command={command}
            onCommand={setCommand}
            onChanged={props.onChanged}
          />
        ) : (
          <WebhookTemplate
            // The two keep nothing of each other's beyond the shared choice.
            key={template}
            ci={template === "ci"}
            choice={choice}
            hookUrls={props.hookUrls}
            makeWebhook={props.makeWebhook}
          />
        )}
      </div>
    </>
  );
}

/** Why a test post to a webhook did not arrive, said as what to do about it. */
function webhookTestError(err: ApiError, channelName: string): string {
  if (err.code === "network_error") {
    return "Could not reach the workspace at this URL. Check your connection and try again.";
  }
  if (err.code === "invalid_webhook") {
    return "This URL no longer works because it was replaced or removed. Create the webhook again.";
  }
  if (err.code === "channel_not_found")
    return `#${channelName} was deleted or archived. Choose another channel.`;
  if (err.code === "not_in_channel") {
    return `The app is no longer in #${channelName}. Add it back, then try again.`;
  }
  if (err.code === "too_many_requests") return "Too many posts to this webhook. Try again shortly.";
  return `The workspace refused the test. Error code: ${err.code}.`;
}

/**
 * Incoming webhook and Post CI results: both are a webhook in a channel, with
 * a different example. The test posts what the example would, to the URL
 * itself, the way the tool will.
 */
function WebhookTemplate({
  ci,
  choice,
  hookUrls,
  makeWebhook,
}: {
  ci: boolean;
  choice: TemplateChoice;
  hookUrls: Record<ID, string>;
  makeWebhook: (appId: ID, channelId: ID) => Promise<string | ApiError>;
}) {
  const client = useClient();
  const { app, channel } = choice;
  /** The one made here, until the app list that includes it comes back. */
  const [made, setMade] = useState<{ appId: ID; channelId: ID; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ url: string; ok: boolean; text: string } | null>(null);
  // A webhook URL is shown once, so only one made in this session can be filled in.
  const known = app?.webhooks.find((w) => w.channelId === channel?.id && hookUrls[w.id]);
  const url = known
    ? hookUrls[known.id]!
    : made && made.appId === app?.id && made.channelId === channel?.id
      ? made.url
      : null;
  const shownResult = result && result.url === url ? result : null;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!channel) {
      setError("A webhook needs a channel to post to. Create a channel first.");
      return;
    }
    if (!app && !choice.newName.trim()) {
      setError("Name the new app first.");
      return;
    }
    setBusy(true);
    setError(null);
    const target = await choice.ensureApp();
    const madeUrl = target instanceof ApiError ? target : await makeWebhook(target.id, channel.id);
    setBusy(false);
    if (madeUrl instanceof ApiError)
      setError(failureText("Could not create the webhook.", madeUrl, "Try again."));
    else if (!(target instanceof ApiError))
      setMade({ appId: target.id, channelId: channel.id, url: madeUrl });
  }

  async function send() {
    if (!url || !channel || sending) return;
    setSending(true);
    const failed = await client.apps.postToWebhook(url, ci ? CI_TEST_MESSAGE : WEBHOOK_EXAMPLE);
    setResult(
      failed
        ? { url, ok: false, text: webhookTestError(failed, channel.name) }
        : { url, ok: true, text: `Posted to #${channel.name}.` },
    );
    setSending(false);
  }

  return (
    <>
      <p className="mb-3 text-[13px] text-ink-dim">
        {ci
          ? "Tell a channel how each build went. Add the step below to the end of a GitHub Actions job."
          : "A webhook is a private web address. Anything that sends a request to it posts a message in the channel, such as a script, a scheduled job or another tool."}
      </p>
      <form onSubmit={(e) => void create(e)} noValidate className="flex flex-wrap items-end gap-2">
        {choice.channelField("Channel")}
        {choice.postAs}
        {!url && (
          <button
            type="submit"
            aria-disabled={busy || undefined}
            className={buttonClass("primary", "h-8 shrink-0 px-3 text-[13px]")}
          >
            {busy ? "Creating…" : "Create webhook"}
          </button>
        )}
      </form>
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-alert">
          {error}
        </p>
      )}
      {ci && url && (
        <>
          <SecretRow label="Webhook URL" value={url} once />
          <p className="mt-1 text-[12px] text-ink-faint">
            Save it in the repository&rsquo;s secrets as{" "}
            <code className="font-mono text-ink-dim">{CI_SECRET}</code>.
          </p>
        </>
      )}
      <Example
        label={ci ? "GitHub Actions step" : "Example with curl"}
        code={ci ? ciExample() : curlExample(url ?? `${client.baseUrl}/hooks/…`)}
      />
      {url ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <button
            type="button"
            onClick={() => void send()}
            aria-disabled={sending || undefined}
            className={buttonClass("secondary", "h-8 shrink-0 px-3 text-[13px]")}
          >
            {sending ? "Sending…" : "Send test message"}
          </button>
          <p
            role="status"
            className={`min-w-0 text-[12px] ${shownResult && !shownResult.ok ? "text-alert" : "text-ink-dim"}`}
          >
            {shownResult?.text}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-[12px] text-ink-faint">
          {ci
            ? "Create the webhook to get the URL the step posts to."
            : "Create the webhook to fill in its URL in the example."}
        </p>
      )}
    </>
  );
}

/**
 * A slash command answered by the admin's own service. The test runs the
 * command for real in a channel, so it goes through the same signed request
 * and the same reply as when anyone types it.
 */
function CommandTemplate({
  choice,
  command,
  onCommand,
  onChanged,
}: {
  choice: TemplateChoice;
  command: string;
  onCommand: (typed: string) => void;
  onChanged: () => void;
}) {
  const client = useClient();
  const { app, channel } = choice;
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The one added here, until the app list that includes it comes back. */
  const [made, setMade] = useState<SlashCommand | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ key: string; ok: boolean; text: string } | null>(null);
  const name = commandName(command);
  const ready =
    app?.commands.find((c) => c.command === name) ??
    (made && made.appId === app?.id && made.command === name ? made : null);
  const runKey = ready && channel ? `${ready.id}:${channel.id}` : null;
  const shownResult = result && result.key === runKey ? result : null;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const missing = !name
      ? "Name the command, such as /deploy."
      : !url.trim()
        ? "Give the address your service answers on, such as https://bot.example.com."
        : !app && !choice.newName.trim()
          ? "Name the new app first."
          : null;
    if (missing) {
      setError(missing);
      return;
    }
    setBusy(true);
    setError(null);
    const target = await choice.ensureApp();
    const added =
      target instanceof ApiError
        ? target
        : await client.apps.createCommand(target.id, { command: name, url: url.trim() });
    setBusy(false);
    if (added instanceof ApiError) {
      setError(
        added.code === "network_error"
          ? "Could not add the command. Check your connection and try again."
          : added.code === "invalid_request"
            ? "Use letters, digits, - and _ in the command, and an http or https address."
            : added.message,
      );
      return;
    }
    setMade(added);
    onChanged();
  }

  async function run() {
    if (!ready || !channel || !runKey || running) return;
    const typed = `/${ready.command} test`;
    setRunning(true);
    const answer = await client.apps.runCommand(channel.id, typed);
    setResult(
      answer instanceof ApiError
        ? {
            key: runKey,
            ok: false,
            text: `Could not run ${typed}: ${answer.code === "network_error" ? "the workspace did not answer" : answer.message}.`,
          }
        : {
            key: runKey,
            ok: answer.ok,
            text: answer.ok
              ? `Your service answered ${typed}. Its reply, if it sent one, is in #${channel.name}.`
              : answer.message
                ? `${typed} failed: ${answer.message}.`
                : `${typed} failed. #${channel.name} says why.`,
          },
    );
    setRunning(false);
  }

  return (
    <>
      <p className="mb-3 text-[13px] text-ink-dim">
        A slash command, such as /deploy, runs your own service when someone types it. Start the
        example service below on a computer the workspace can reach. Then add the command with the
        service&rsquo;s web address.
      </p>
      <form onSubmit={(e) => void add(e)} noValidate className="flex flex-wrap items-end gap-2">
        <TextField
          size="small"
          label="Command"
          value={command}
          onChange={(e) => onCommand(e.target.value)}
          className="w-28 shrink-0"
        />
        <TextField
          size="small"
          label="Request URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://bot.example.com"
          className={rowField}
        />
        {choice.postAs}
        <button
          type="submit"
          aria-disabled={busy || undefined}
          className={buttonClass(ready ? "secondary" : "primary", "h-8 shrink-0 px-3 text-[13px]")}
        >
          {busy ? "Adding…" : "Add command"}
        </button>
      </form>
      <p className="mt-1.5 text-[12px] text-ink-faint">
        The workspace's server sends requests to this address. It refuses addresses on a private
        network or on the server's own computer, unless the server was started with{" "}
        <code className="whitespace-nowrap font-mono">--allow-private-hooks</code>.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-alert">
          {error}
        </p>
      )}
      {ready && (
        <div className="mt-3">
          <div className="flex flex-wrap items-end gap-2">
            {choice.channelField("Try it in")}
            <button
              type="button"
              onClick={() => void run()}
              aria-disabled={running || undefined}
              className={buttonClass("primary", "h-8 shrink-0 px-3 text-[13px]")}
            >
              {running ? "Sending…" : "Send test command"}
            </button>
          </div>
          <p
            role="status"
            className={`mt-1.5 text-[12px] ${shownResult && !shownResult.ok ? "text-alert" : "text-ink-dim"}`}
          >
            {shownResult?.text}
          </p>
        </div>
      )}
      <Example
        label="Example service in Node.js"
        code={commandExample(name, app?.signingSecret ?? null)}
        secret={app?.signingSecret}
      />
      {!app && (
        <p className="mt-2 text-[12px] text-ink-faint">
          The example gets the app&rsquo;s signing secret once the app exists.
        </p>
      )}
    </>
  );
}

/**
 * An example to copy. A secret in it is dotted out on screen until revealed,
 * as SecretRow does, and copied whole either way.
 */
function Example({ label, code, secret }: { label: string; code: string; secret?: string }) {
  const toast = useToast();
  const { copy, label: copyLabel, copied } = useCopy();
  const [revealed, setRevealed] = useState(false);
  const shown = secret && !revealed ? code.replaceAll(secret, "•".repeat(24)) : code;

  async function copyCode() {
    if (await copy(code)) toast({ message: `${label} copied.`, kind: "success" });
  }

  return (
    <figure className="mt-3 overflow-hidden rounded-lg border border-edge bg-ground">
      <figcaption className="flex items-center gap-1 border-b border-edge py-1 pl-2.5 pr-1">
        <span className="mr-auto text-[12px] font-medium text-ink-dim">{label}</span>
        {secret && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            className="shrink-0 rounded px-2 py-1 text-[11px] text-ink-dim hover:bg-ink/[0.05] hover:text-ink"
          >
            {revealed ? "Hide secret" : "Reveal secret"}
          </button>
        )}
        <button
          type="button"
          onClick={() => void copyCode()}
          className={`shrink-0 rounded px-2 py-1 text-[11px] hover:bg-ink/[0.05] hover:text-ink ${
            copied && !copied.ok ? "text-alert" : "text-ink-dim"
          }`}
        >
          <Swap text>{copyLabel("Copy", "Copied", "Copy failed")}</Swap>
        </button>
      </figcaption>
      {/* Wrapped rather than scrolled sideways: a phone shows all of it, and
          nothing scrolls that a keyboard could not reach. */}
      <pre className="whitespace-pre-wrap p-2.5 font-mono text-[11.5px] leading-[1.6] text-ink [overflow-wrap:anywhere]">
        <code>{shown}</code>
      </pre>
    </figure>
  );
}
