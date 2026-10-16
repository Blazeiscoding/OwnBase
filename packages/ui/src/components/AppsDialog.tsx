import { useCallback, useEffect, useId, useRef, useState } from "react";
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
import type { App, Channel, EventSubscription, ID, SlashCommand } from "@slackoss/protocol";
import { ApiError, type AppDetail } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import { Dialog, inputCls } from "./Dialog.js";
import { Swap } from "./Motion.js";
import { useConfirm } from "./Confirm.js";
import { ListStatus } from "./ListStatus.js";
import { buttonClass } from "./Button.js";
import { Icon } from "./Icon.js";
import { useOptionalToast } from "./Toast.js";

/** What an integration can rely on from this server, and where it differs from Slack. */
const INTEGRATION_CONTRACT_URL =
  "https://github.com/Blazeiscoding/Tandem/blob/main/docs/INTEGRATIONS.md";

/** A secret with a copy button. Bot tokens are shown once; others can be re-read. */
function SecretRow({
  label,
  value,
  once,
  onReplace,
}: {
  label: string;
  value: string;
  once?: boolean;
  /** Offered beside the copy button, for a secret that may have leaked. */
  onReplace?: () => void;
}) {
  const { copy, label: copyLabel, copied } = useCopy();
  const [shown, setShown] = useState(false);
  return (
    <div className="mt-2 rounded-lg border border-copper/40 bg-copper/10 p-2.5">
      <div className="mb-1 text-[12px] font-medium text-copper">
        {label}
        {once && " · shown once"}
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
          {once || shown ? value : "•".repeat(24)}
        </code>
        {!once && (
          <button
            onClick={() => setShown((v) => !v)}
            className="shrink-0 rounded px-2 py-1 text-[11px] text-ink-dim hover:bg-ink/[0.05] hover:text-ink"
          >
            {shown ? "Hide" : "Reveal"}
          </button>
        )}
        <button
          onClick={() => void copy(value)}
          className={`shrink-0 rounded px-2 py-1 text-[11px] hover:bg-ink/[0.05] hover:text-ink ${
            copied && !copied.ok ? "text-alert" : "text-ink-dim"
          }`}
        >
          <Swap text>{copyLabel("Copy", "Copied", "Copy failed")}</Swap>
        </button>
        {onReplace && (
          <button
            onClick={onReplace}
            className="shrink-0 rounded px-2 py-1 text-[11px] text-ink-dim hover:bg-ink/[0.05] hover:text-ink"
          >
            Replace
          </button>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 mt-3 text-[12px] text-ink-faint">{children}</div>;
}

/** Admin view for integrations: bot tokens, webhooks, commands and events. */
export function AppsDialog({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const confirm = useConfirm();
  const channels = useWorkspace((s) => s.channels);
  const [apps, setApps] = useState<AppDetail[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const alive = useRef(true);
  const loadVersion = useRef(0);
  const loadInFlight = useRef(false);
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  /** Bot tokens from this session only; the server never returns them again. */
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [hookUrls, setHookUrls] = useState<Record<string, string>>({});
  const [rotateError, setRotateError] = useState<string | null>(null);

  const load = useCallback(
    (quiet = false) => {
      if (quiet && loadInFlight.current) return;
      const version = ++loadVersion.current;
      loadInFlight.current = true;
      if (!quiet) setLoading(true);
      void client.api
        .listApps()
        .then((result) => {
          if (!alive.current || version !== loadVersion.current) return;
          setApps(result.apps);
          setLoadError(null);
        })
        .catch(() => {
          if (!alive.current || version !== loadVersion.current) return;
          // Keep the last good rows. A failed first load is not an empty list.
          setLoadError("Could not load apps. Check your connection and try again.");
        })
        .finally(() => {
          if (!alive.current || version !== loadVersion.current) return;
          loadInFlight.current = false;
          if (!quiet) setLoading(false);
        });
    },
    [client],
  );

  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
      loadVersion.current++;
      loadInFlight.current = false;
    };
  }, [load]);

  const hasPendingDeliveries =
    apps?.some((app) => app.subscriptions.some((sub) => (sub.delivery?.pending ?? 0) > 0)) ?? false;
  useEffect(() => {
    if (!hasPendingDeliveries) return;
    const timer = setInterval(() => load(true), 5_000);
    return () => clearInterval(timer);
  }, [hasPendingDeliveries, load]);

  const rooms = Object.values(channels).filter(
    (c) => (c.type === "public" || c.type === "private") && !c.archived,
  );

  /**
   * Shows an app the server just made. A bot token is returned only once, so
   * its row stays visible even if the follow-up list request fails, and the
   * admin can still copy the token.
   */
  function adopt(r: { app: App; token: string; signingSecret: string }): AppDetail {
    const shown: AppDetail = {
      ...r.app,
      signingSecret: r.signingSecret,
      webhooks: [],
      commands: [],
      subscriptions: [],
    };
    setApps((list) => [shown, ...(list ?? []).filter((app) => app.id !== r.app.id)]);
    setSecrets((s) => ({ ...s, [r.app.id]: r.token }));
    load();
    return shown;
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setCreateError("Name the app first, such as Deploy Bot.");
      nameInput.current?.focus();
      return;
    }
    setCreateError(null);
    setBusy(true);
    try {
      adopt(await client.api.createApp({ name: name.trim() }));
      setName("");
    } catch {
      setCreateError("Could not create the app. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Every replacement asks first and says what stops working, because the old
   * credential is dead the moment the server answers and whatever was using
   * it fails until someone updates it.
   */
  async function replace(title: string, body: string, action: () => Promise<void>) {
    if (!(await confirm({ title, body, confirmLabel: "Replace", destructive: true }))) return;
    setRotateError(null);
    try {
      await action();
    } catch {
      setRotateError(
        "Could not confirm whether it was replaced. Check the integration before trying again.",
      );
    }
  }

  const replaceToken = (a: AppDetail) =>
    replace(
      `Replace ${a.name}'s bot token?`,
      "The current token stops working immediately.",
      async () => {
        const r = await client.api.replaceAppToken(a.id);
        setSecrets((s) => ({ ...s, [a.id]: r.token }));
      },
    );

  const replaceSigningSecret = (a: AppDetail) =>
    replace(
      `Replace ${a.name}'s signing secret?`,
      "The app will reject requests from this workspace until it has the new one.",
      async () => {
        await client.api.replaceSigningSecret(a.id);
        load();
      },
    );

  const replaceWebhookUrl = (a: AppDetail, webhookId: ID, channelName: string) =>
    replace(
      `Replace the webhook URL for #${channelName}?`,
      "Anything posting to the current URL will stop working.",
      async () => {
        const r = await client.api.replaceWebhookUrl(webhookId);
        setHookUrls((h) => ({ ...h, [webhookId]: `${client.baseUrl}${r.url}` }));
        load();
      },
    );

  /** Returns the webhook's URL, which the server shows only this once. */
  async function addWebhook(appId: ID, channelId: ID): Promise<string> {
    const r = await client.api.createWebhook(appId, { channelId });
    // The path comes back relative; show the address a tool would actually call.
    const url = `${client.baseUrl}${r.url}`;
    setHookUrls((h) => ({ ...h, [r.webhook.id]: url }));
    load();
    return url;
  }

  return (
    <Dialog title="Apps and integrations" onClose={onClose} width={620}>
      <p className="mb-4 text-sm text-ink-dim">
        Start from what you want to happen. Each app you make posts as its own bot.
      </p>

      <AppTemplates
        apps={apps ?? []}
        rooms={rooms}
        hookUrls={hookUrls}
        makeApp={async (appName) => adopt(await client.api.createApp({ name: appName }))}
        makeWebhook={addWebhook}
        onChanged={load}
      />

      <SlackDifferences />

      <h3 className="mb-2 mt-6 text-[13px] font-medium text-ink-dim">Your apps</h3>
      <form onSubmit={create} noValidate className="mb-5 flex gap-2">
        <input
          ref={nameInput}
          aria-label="App name"
          aria-invalid={!!createError || undefined}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setCreateError(null);
          }}
          placeholder="App name, e.g. Deploy Bot"
          className={inputCls}
        />
        {/* Beside a template's own primary action, this one stays secondary. */}
        <button type="submit" disabled={busy} className={buttonClass("secondary")}>
          Create
        </button>
      </form>

      {createError && (
        <p role="alert" className="-mt-3 mb-4 text-sm text-alert">
          {createError}
        </p>
      )}
      {rotateError && (
        <p role="alert" className="mb-3 text-sm text-alert">
          {rotateError}
        </p>
      )}

      <ListStatus
        loading={loading}
        placeholder={apps === null}
        loadingLabel="Loading apps…"
        error={loadError}
        onRetry={() => load()}
        empty={
          apps?.length === 0 && !loadError
            ? "No apps yet. Create one above to connect it to this workspace."
            : null
        }
      />

      <ul className="space-y-3" aria-busy={loading}>
        {(apps ?? []).map((a) => (
          <li key={a.id} className="rounded-xl border border-edge bg-ground p-3">
            <div className="flex items-center gap-2">
              <span className="font-medium">{a.name}</span>
              <button
                onClick={() => void replaceToken(a)}
                className="ml-auto rounded px-2 py-1 text-[11px] text-ink-faint transition-colors hover:text-ink"
              >
                New bot token
              </button>
              <button
                disabled={busy}
                onClick={async () => {
                  const go = await confirm({
                    title: `Delete ${a.name}?`,
                    body: "Its tokens and webhooks stop working.",
                    confirmLabel: "Delete",
                    destructive: true,
                  });
                  if (!go) return;
                  setBusy(true);
                  setRotateError(null);
                  try {
                    await client.api.deleteApp(a.id);
                    load();
                    void client.loadCommands();
                  } catch {
                    setRotateError(
                      "Could not confirm whether the app was deleted. Refreshing the app list; check it before trying again.",
                    );
                    load();
                    void client.loadCommands();
                  } finally {
                    setBusy(false);
                  }
                }}
                className="rounded px-2 py-1 text-[11px] text-ink-faint transition-colors hover:text-alert disabled:opacity-40"
              >
                Delete
              </button>
            </div>

            {secrets[a.id] && <SecretRow label="Bot token" value={secrets[a.id]!} once />}
            <SecretRow
              label="Signing secret"
              value={a.signingSecret}
              onReplace={() => void replaceSigningSecret(a)}
            />

            <SectionLabel>Incoming webhooks</SectionLabel>
            <ul className="space-y-1.5">
              {a.webhooks.map((w) => (
                <li key={w.id} className="text-[12px]">
                  <div className="flex items-center gap-2 text-ink-dim">
                    <span className="text-copper">#{channels[w.channelId]?.name ?? "unknown"}</span>
                    <button
                      onClick={() =>
                        void replaceWebhookUrl(a, w.id, channels[w.channelId]?.name ?? "unknown")
                      }
                      className="ml-auto text-ink-faint hover:text-ink"
                    >
                      New URL
                    </button>
                    <button
                      onClick={async () => {
                        await client.api.deleteWebhook(w.id);
                        load();
                      }}
                      className="text-ink-faint hover:text-alert"
                    >
                      Remove
                    </button>
                  </div>
                  {hookUrls[w.id] && <SecretRow label="Webhook URL" value={hookUrls[w.id]!} once />}
                </li>
              ))}
            </ul>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-ink-faint">Add to</span>
              {rooms.map((c) => (
                <button
                  key={c.id}
                  onClick={() => void addWebhook(a.id, c.id)}
                  className="rounded-full border border-edge px-2 py-0.5 text-[11px] text-ink-dim transition-colors hover:border-ink-faint/50 hover:text-ink"
                >
                  #{c.name}
                </button>
              ))}
            </div>

            <SectionLabel>Slash commands</SectionLabel>
            <CommandList app={a} onChanged={load} />

            <SectionLabel>Event subscriptions</SectionLabel>
            <SubscriptionList app={a} onChanged={load} />

            <SectionLabel>Interactivity</SectionLabel>
            <InteractivityUrl app={a} onChanged={load} />
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

const fieldLabel = "min-w-0 flex-1 basis-40 text-[12px] font-medium text-ink-dim";
const field =
  "mt-1 h-8 w-full min-w-0 rounded-lg border border-edge bg-raised px-2 text-[13px] font-normal text-ink outline-none placeholder:text-ink-faint focus:border-copper/60";

/**
 * A choice with its label beside it rather than around it: a label wrapped
 * round a select holds every option's text too, so the field would be named
 * "Post as A new app Webhook" wherever a label is read as its text.
 */
function SelectField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className={fieldLabel}>
      <label htmlFor={id}>{props.label}</label>
      <select
        id={id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className={field}
      >
        {props.children}
      </select>
    </div>
  );
}

/** What each template's choices come to, shared so that one made in a template is ready in the next. */
interface TemplateChoice {
  /** The app chosen to post as, or null for a new one. */
  app: AppDetail | null;
  /** What a new app would be called. */
  newName: string;
  channel: Channel | null;
  /** The chosen app, made first when it is to be a new one. */
  ensureApp: () => Promise<AppDetail>;
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
function AppTemplates(props: {
  apps: AppDetail[];
  rooms: Channel[];
  hookUrls: Record<ID, string>;
  /** Makes an app and shows it below with its one-time token. */
  makeApp: (name: string) => Promise<AppDetail>;
  makeWebhook: (appId: ID, channelId: ID) => Promise<string>;
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
      setAppId(made.id);
      return made;
    },
    postAs: (
      <>
        <SelectField label="Post as" value={app?.id ?? ""} onChange={setAppId}>
          <option value="">A new app</option>
          {props.apps.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </SelectField>
        {!app && (
          <label className={fieldLabel}>
            New app name
            <input
              value={newName}
              onChange={(e) => setTypedName(e.target.value)}
              className={field}
            />
          </label>
        )}
      </>
    ),
    channelField: (label) => (
      <SelectField label={label} value={channel?.id ?? ""} onChange={setChannelId}>
        {rooms.map((c) => (
          <option key={c.id} value={c.id}>
            #{c.name}
          </option>
        ))}
      </SelectField>
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
function webhookTestError(err: unknown, channelName: string): string {
  if (!(err instanceof ApiError)) {
    return "Could not reach the workspace at this URL. Check your connection and try again.";
  }
  if (err.code === "invalid_webhook") {
    return "This URL no longer works: it was replaced or removed. Create the webhook again.";
  }
  if (err.code === "channel_not_found") return `#${channelName} is gone or archived.`;
  if (err.code === "not_in_channel") {
    return `The app is no longer in #${channelName}. Add it back, then try again.`;
  }
  if (err.code === "too_many_requests") return "Too many posts to this webhook. Try again shortly.";
  return `The workspace refused the test (${err.code}).`;
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
  makeWebhook: (appId: ID, channelId: ID) => Promise<string>;
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
      setError("A webhook posts to a channel. Create one first.");
      return;
    }
    if (!app && !choice.newName.trim()) {
      setError("Name the new app first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const target = await choice.ensureApp();
      const madeUrl = await makeWebhook(target.id, channel.id);
      setMade({ appId: target.id, channelId: channel.id, url: madeUrl });
    } catch {
      setError("Could not create the webhook. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!url || !channel || sending) return;
    setSending(true);
    try {
      await client.api.postToWebhook(url, ci ? CI_TEST_MESSAGE : WEBHOOK_EXAMPLE);
      setResult({ url, ok: true, text: `Posted to #${channel.name}.` });
    } catch (err) {
      setResult({ url, ok: false, text: webhookTestError(err, channel.name) });
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <p className="mb-3 text-[13px] text-ink-dim">
        {ci
          ? "Tell a channel how each build went. Add the step below to the end of a GitHub Actions job."
          : "Post to a channel from a script, a scheduled job, or any tool that can send a web request."}
      </p>
      <form onSubmit={create} noValidate className="flex flex-wrap items-end gap-2">
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
            : "Create the webhook to fill in its URL."}
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
    try {
      const target = await choice.ensureApp();
      const r = await client.api.createCommand(target.id, { command: name, url: url.trim() });
      setMade(r.command);
      onChanged();
      // The composer's hint list is loaded once, so refresh it now.
      void client.loadCommands();
    } catch (err) {
      setError(
        !(err instanceof ApiError)
          ? "Could not add the command. Check your connection and try again."
          : err.code === "invalid_request"
            ? "Use letters, digits, - and _ in the command, and an http or https address."
            : err.message,
      );
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!ready || !channel || !runKey || running) return;
    const typed = `/${ready.command} test`;
    setRunning(true);
    try {
      const answer = await client.api.runCommand(channel.id, { text: typed });
      setResult({
        key: runKey,
        ok: answer.ok,
        text: answer.ok
          ? `Your service answered ${typed}. Its reply, if it sent one, is in #${channel.name}.`
          : answer.message
            ? `${typed} failed: ${answer.message}.`
            : `${typed} failed. #${channel.name} says why.`,
      });
    } catch (err) {
      setResult({
        key: runKey,
        ok: false,
        text: `Could not run ${typed}: ${err instanceof ApiError ? err.message : "the workspace did not answer"}.`,
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <p className="mb-3 text-[13px] text-ink-dim">
        Run your own service when someone types a command. Start the example below where the
        workspace can reach it, then add the command with its address.
      </p>
      <form onSubmit={add} noValidate className="flex flex-wrap items-end gap-2">
        <label className="w-28 shrink-0 text-[12px] font-medium text-ink-dim">
          Command
          <input value={command} onChange={(e) => onCommand(e.target.value)} className={field} />
        </label>
        <label className={fieldLabel}>
          Request URL
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://bot.example.com"
            className={field}
          />
        </label>
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
        The server calls this address itself. It refuses a private or loopback one unless it was
        started with <code className="whitespace-nowrap font-mono">--allow-private-hooks</code>.
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
          The app&rsquo;s signing secret goes in once the app exists.
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
  const toast = useOptionalToast();
  const { copy, label: copyLabel, copied } = useCopy();
  const [revealed, setRevealed] = useState(false);
  const shown = secret && !revealed ? code.replaceAll(secret, "•".repeat(24)) : code;

  async function copyCode() {
    if (await copy(code)) toast?.({ message: `${label} copied.`, kind: "success" });
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

/**
 * How apps here differ from Slack's, for someone bringing an integration
 * across. Folded away (UX-63): posting from a webhook should not need any of it.
 */
function SlackDifferences() {
  return (
    <details className="group mt-4 rounded-xl border border-edge">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] font-medium text-ink-dim hover:text-ink">
        <Icon name="chevronDown" size={14} className="transition-transform group-open:rotate-180" />
        How this differs from Slack
      </summary>
      <div className="space-y-2 border-t border-edge px-3 py-2.5 text-[13px] leading-relaxed text-ink-dim">
        <p>
          Many Slack integrations work when pointed at this workspace: incoming webhooks, slash
          commands, buttons, event subscriptions and{" "}
          <code className="font-mono">chat.postMessage</code> take the shapes Slack&rsquo;s do.
        </p>
        <p>
          Not everything carries over. There is no OAuth, Socket Mode or scopes: an app gets a bot
          token and a signing secret here, and receives events and button presses over HTTP. A
          message&rsquo;s <code className="font-mono">ts</code> is an id rather than a time.
        </p>
        <p>
          <a
            href={INTEGRATION_CONTRACT_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-ink underline decoration-ink-faint/60 underline-offset-2 hover:decoration-ink"
          >
            The integration contract
          </a>{" "}
          lists every supported method and where each one differs.
        </p>
      </div>
    </details>
  );
}

const smallInput =
  "min-w-0 rounded-lg border border-edge bg-raised px-2 py-1 text-[12px] outline-none focus:border-copper/60";

function CommandList({ app, onChanged }: { app: AppDetail; onChanged: () => void }) {
  const client = useClient();
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.api.createCommand(app.id, {
        command: command.trim(),
        url: url.trim(),
        description: description.trim(),
      });
      setCommand("");
      setUrl("");
      setDescription("");
      onChanged();
      // The composer's hint list is loaded once, so refresh it now.
      void client.loadCommands();
    } catch (err) {
      setError(err instanceof ApiError ? (err.message ?? err.code) : "could not add that command");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ul className="space-y-1">
        {app.commands.map((c) => (
          <li key={c.id} className="flex items-baseline gap-2 text-[12px]">
            <span className="font-mono text-copper">/{c.command}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
              {c.url}
            </span>
            <button
              onClick={async () => {
                await client.api.deleteCommand(c.id);
                onChanged();
                void client.loadCommands();
              }}
              className="text-ink-faint hover:text-alert"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="mt-1.5 flex flex-wrap gap-1.5">
        <input
          aria-label="Command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="/deploy"
          className={`${smallInput} w-24`}
        />
        <input
          aria-label="Command request URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://bot.example.com/deploy"
          className={`${smallInput} flex-1`}
        />
        <input
          aria-label="Command description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What it does"
          className={`${smallInput} w-32`}
        />
        <button
          type="submit"
          disabled={busy || !command.trim() || !url.trim()}
          className="rounded-lg border border-edge px-2 py-1 text-[12px] text-ink-dim transition-colors hover:border-ink-faint/50 hover:text-ink disabled:opacity-40"
        >
          Add
        </button>
      </form>
      {error && <p className="mt-1 text-[11px] text-alert">{error}</p>}
    </>
  );
}

/** Native event names, so the picker does not need the server to list them. */
const EVENT_TYPES = [
  "message.created",
  "message.updated",
  "message.deleted",
  "reaction.added",
  "reaction.removed",
  "member.joined",
  "channel.created",
];

/**
 * How an endpoint's queue is doing, in the terms an administrator has to act
 * on: work still waiting, work given up on, and events that never got queued
 * because the endpoint was too far behind to hold them.
 */
function DeliveryStatus({ delivery }: { delivery: EventSubscription["delivery"] }) {
  if (!delivery) return null;
  const { pending, failed, dropped, lastError } = delivery;
  const retrying = delivery.retrying ?? 0;
  if (pending === 0 && failed === 0 && dropped === 0 && retrying === 0) return null;
  const parts = [
    pending > 0 ? `${pending} waiting` : null,
    retrying > 0 ? `${retrying} to retry as room frees up` : null,
    failed > 0 ? `${failed} given up on` : null,
    dropped > 0 ? `${dropped} dropped while behind` : null,
    failed > 0 && lastError ? lastError : null,
  ].filter(Boolean);
  const bad = failed > 0 || dropped > 0;
  return (
    <p
      role={bad ? "alert" : "status"}
      title={lastError ?? undefined}
      className={`truncate ${bad ? "text-alert" : "text-ink-faint"}`}
    >
      {parts.join(" · ")}
    </p>
  );
}

function SubscriptionList({ app, onChanged }: { app: AppDetail; onChanged: () => void }) {
  const client = useClient();
  const [url, setUrl] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState<ID | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.api.createSubscription(app.id, { url: url.trim(), eventTypes: types });
      setUrl("");
      setTypes([]);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (err.message ?? err.code) : "could not subscribe");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ul className="space-y-1">
        {app.subscriptions.map((sub) => (
          <li key={sub.id} className="text-[12px]">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
                {sub.url}
              </span>
              <span className="shrink-0 text-[11px] text-ink-dim">
                {sub.eventTypes.length > 0 ? `${sub.eventTypes.length} types` : "everything"}
              </span>
              {(sub.delivery?.failed ?? 0) > 0 && (
                <button
                  disabled={retrying === sub.id}
                  onClick={async () => {
                    setRetrying(sub.id);
                    setError(null);
                    try {
                      await client.api.retrySubscription(sub.id);
                      onChanged();
                    } catch {
                      setError("Could not retry those deliveries.");
                    } finally {
                      setRetrying(null);
                    }
                  }}
                  className="text-copper hover:underline disabled:opacity-40"
                >
                  {retrying === sub.id ? "Retrying…" : "Retry failed"}
                </button>
              )}
              <button
                onClick={async () => {
                  await client.api.deleteSubscription(sub.id);
                  onChanged();
                }}
                className="text-ink-faint hover:text-alert"
              >
                Remove
              </button>
            </div>
            <DeliveryStatus delivery={sub.delivery} />
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="mt-1.5">
        <div className="flex gap-1.5">
          <input
            aria-label="Event request URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://bot.example.com/events"
            className={`${smallInput} flex-1`}
          />
          <button
            type="submit"
            disabled={busy || !url.trim()}
            className="rounded-lg border border-edge px-2 py-1 text-[12px] text-ink-dim transition-colors hover:border-ink-faint/50 hover:text-ink disabled:opacity-40"
          >
            {busy ? "Verifying…" : "Subscribe"}
          </button>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {EVENT_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() =>
                setTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
              }
              className={`rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors ${
                types.includes(t)
                  ? "border-copper text-copper"
                  : "border-edge text-ink-faint hover:text-ink"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-ink-faint">
          None selected sends everything. The URL must answer the{" "}
          <code className="font-mono">url_verification</code> challenge, and the app&rsquo;s bot
          only receives events from channels it has been added to.
        </p>
      </form>
      {error && <p className="mt-1 text-[11px] text-alert">{error}</p>}
    </>
  );
}

/**
 * Where this app's button clicks go. One URL per app, like Slack's
 * interactivity request URL, and it has to answer the same verification
 * handshake a subscription does before it is accepted.
 */
function InteractivityUrl({ app, onChanged }: { app: AppDetail; onChanged: () => void }) {
  const client = useClient();
  const [url, setUrl] = useState(app.interactivityUrl);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.api.setInteractivityUrl(app.id, url.trim());
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (err.message ?? err.code) : "could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      <div className="flex gap-1.5">
        <input
          aria-label="Interactivity request URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://bot.example.com/interactions"
          className={`${smallInput} flex-1`}
        />
        <button
          type="submit"
          disabled={busy || url.trim() === app.interactivityUrl}
          className="rounded-lg border border-edge px-2 py-1 text-[12px] text-ink-dim transition-colors hover:border-ink-faint/50 hover:text-ink disabled:opacity-40"
        >
          {busy ? "Checking…" : "Save"}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-ink-faint">
        Buttons in this app&apos;s messages post Slack&apos;s{" "}
        <code className="font-mono">block_actions</code> payload here. Leave empty to turn them off.
      </p>
      {error && (
        <p role="alert" className="mt-1 text-[11px] text-alert">
          {error}
        </p>
      )}
    </form>
  );
}
