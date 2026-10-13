import { useCallback, useEffect, useRef, useState } from "react";
import { useCopy } from "../lib/useCopy.js";
import type { EventSubscription, ID } from "@slackoss/protocol";
import { ApiError, type AppDetail } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import { Dialog, inputCls } from "./Dialog.js";
import { Swap } from "./Motion.js";
import { useConfirm } from "./Confirm.js";
import { ListStatus } from "./ListStatus.js";
import { buttonClass } from "./Button.js";

/** What an integration can rely on from this server, and where it differs from Slack. */
const INTEGRATION_CONTRACT_URL =
  "https://github.com/Blazeiscoding/SlackOSS/blob/main/docs/INTEGRATIONS.md";

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
      const r = await client.api.createApp({ name: name.trim() });
      // A bot token is returned only once. Keep its row visible even if the
      // follow-up list request fails, so the admin can still copy the token.
      setApps((shown) => [
        {
          ...r.app,
          signingSecret: r.signingSecret,
          webhooks: [],
          commands: [],
          subscriptions: [],
        },
        ...(shown ?? []).filter((app) => app.id !== r.app.id),
      ]);
      setSecrets((s) => ({ ...s, [r.app.id]: r.token }));
      setName("");
      load();
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

  async function addWebhook(appId: ID, channelId: ID) {
    const r = await client.api.createWebhook(appId, { channelId });
    // The path comes back relative; show the address a tool would actually call.
    setHookUrls((h) => ({ ...h, [r.webhook.id]: `${client.baseUrl}${r.url}` }));
    load();
  }

  return (
    <Dialog title="Apps and integrations" onClose={onClose} width={620}>
      <p className="text-sm text-ink-dim">
        Connect bots, webhooks and slash commands. Each app posts as its own bot user, and many
        Slack integrations work when pointed here.
      </p>
      <p className="mb-5 mt-1.5 text-[13px] leading-relaxed text-ink-faint">
        Not everything carries over: there is no OAuth, Socket Mode or scopes, and a message&rsquo;s{" "}
        <code className="font-mono text-ink-dim">ts</code> is an id rather than a time.{" "}
        <a
          href={INTEGRATION_CONTRACT_URL}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-ink underline decoration-ink-faint/60 underline-offset-2 hover:decoration-ink"
        >
          <code className="font-mono">docs/INTEGRATIONS.md</code>
        </a>{" "}
        lists every supported method.
      </p>

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
        <button type="submit" disabled={busy} className={buttonClass("primary")}>
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
