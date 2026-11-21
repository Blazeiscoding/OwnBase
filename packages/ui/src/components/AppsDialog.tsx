import { useCallback, useEffect, useRef, useState } from "react";
import { useDismissGuard } from "../lib/dismissGuard.js";
import { wasCopied } from "../lib/useCopy.js";
import { DEFAULT_APP_SCOPES, isRoom, type AppScope, type ID } from "@ownbase/protocol";
import { ApiError, type AppDetail } from "@ownbase/client-core";
import { useClient, useWorkspace } from "../context.js";
import { failureText } from "../lib/failure.js";
import { Dialog } from "./Dialog.js";
import { inputCls } from "./TextField.js";
import { useConfirm } from "./Confirm.js";
import { ListStatus } from "./ListStatus.js";
import { AppReceive } from "./AppReceive.js";
import { buttonClass } from "./Button.js";
import { Icon } from "./Icon.js";
import { useToast } from "./Toast.js";
import { AppTemplates } from "./AppTemplates.js";
import { CommandList } from "./AppCommands.js";
import { SubscriptionList } from "./AppSubscriptions.js";
import { scopeSummary, ScopePicker, AppScopes } from "./AppScopes.js";
import { InteractivityUrl } from "./AppInteractivity.js";
import { SecretRow } from "./appParts.js";

/** What an integration can rely on from this server, and where it differs from Slack. */
const INTEGRATION_CONTRACT_URL =
  "https://github.com/Blazeiscoding/OwnBase/blob/main/docs/INTEGRATIONS.md";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 mt-3 text-[12px] text-ink-faint">{children}</div>;
}

/** Admin view for integrations: bot tokens, webhooks, commands and events. */
export function AppsDialog({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const toast = useToast();
  const confirm = useConfirm();
  const channels = useWorkspace((s) => s.channels);
  const [apps, setApps] = useState<AppDetail[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const alive = useRef(true);
  const loadVersion = useRef(0);
  const loadInFlight = useRef(false);
  const [name, setName] = useState("");
  /** What the next app made here may do: post, and be sent nothing, until more is ticked. */
  const [scopes, setScopes] = useState<AppScope[]>([...DEFAULT_APP_SCOPES]);
  const [createError, setCreateError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Bot tokens, and app-level tokens under `app:<id>`, from this session
   * only; the server never returns them again.
   */
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [hookUrls, setHookUrls] = useState<Record<string, string>>({});
  const [rotateError, setRotateError] = useState<string | null>(null);

  const load = useCallback(
    (quiet = false) => {
      if (quiet && loadInFlight.current) return;
      const version = ++loadVersion.current;
      loadInFlight.current = true;
      if (!quiet) setLoading(true);
      void client.apps.list().then((listed) => {
        if (!alive.current || version !== loadVersion.current) return;
        if (listed instanceof ApiError) {
          // Keep the last good rows. A failed first load is not an empty list.
          setLoadError(failureText("Could not load apps.", listed, "Try again."));
        } else {
          setApps(listed);
          setLoadError(null);
        }
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
      loadVersion.current += 1;
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

  /*
   * The server tells nobody when an app's socket opens or closes, so while a
   * Socket Mode app is on show its count is fetched again every few seconds.
   * A hidden window waits, and asks once as soon as it is seen again.
   */
  const showsSocketApp = apps?.some((app) => app.receive === "socket") ?? false;
  useEffect(() => {
    if (!showsSocketApp) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const follow = (seenAgain: boolean) => {
      clearInterval(timer);
      timer = undefined;
      if (document.visibilityState !== "visible") return;
      if (seenAgain) load(true);
      timer = setInterval(() => load(true), 5_000);
    };
    const onVisibility = () => follow(true);
    follow(false);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [showsSocketApp, load]);

  const rooms = Object.values(channels).filter((c) => isRoom(c.type) && !c.archived);

  /**
   * Makes an app and shows it. A bot token is returned only once, so its row
   * stays visible even if the follow-up list request fails, and the admin can
   * still copy the token.
   */
  async function makeApp(appName: string, appScopes: AppScope[]): Promise<AppDetail | ApiError> {
    const r = await client.apps.create({ name: appName, scopes: appScopes });
    if (r instanceof ApiError) return r;
    const shown: AppDetail = {
      ...r.app,
      signingSecret: r.signingSecret,
      webhooks: [],
      commands: [],
      subscriptions: [],
      hasAppToken: false,
      sockets: 0,
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
    const made = await makeApp(name.trim(), scopes);
    setBusy(false);
    if (made instanceof ApiError) {
      setCreateError(failureText("Could not create the app.", made, "Try again."));
      return;
    }
    setName("");
    setScopes([...DEFAULT_APP_SCOPES]);
  }

  /**
   * Every replacement asks first and says what stops working, because the old
   * credential is dead the moment the server answers and whatever was using
   * it fails until someone updates it.
   */
  async function replace(title: string, body: string, action: () => Promise<ApiError | null>) {
    if (!(await confirm({ title, body, confirmLabel: "Replace", destructive: true }))) return;
    setRotateError(null);
    if (await action())
      setRotateError(
        "Could not confirm whether it was replaced. Check that the app still works before you try again.",
      );
  }

  const replaceToken = (a: AppDetail) =>
    replace(
      `Replace ${a.name}'s bot token?`,
      "The current token stops working immediately. Whatever uses it fails until you give it the new one.",
      async () => {
        const token = await client.apps.replaceToken(a.id);
        if (token instanceof ApiError) return token;
        setSecrets((s) => ({ ...s, [a.id]: token }));
        return null;
      },
    );

  const replaceSigningSecret = (a: AppDetail) =>
    replace(
      `Replace ${a.name}'s signing secret?`,
      "The app will reject requests from this workspace until it has the new one.",
      async () => {
        const failed = await client.apps.replaceSigningSecret(a.id);
        if (!failed) load();
        return failed;
      },
    );

  const replaceWebhookUrl = (a: AppDetail, webhookId: ID, channelName: string) =>
    replace(
      `Replace the webhook URL for #${channelName}?`,
      "Anything posting to the current URL will stop working.",
      async () => {
        const path = await client.apps.replaceWebhookUrl(webhookId);
        if (path instanceof ApiError) return path;
        setHookUrls((h) => ({ ...h, [webhookId]: `${client.baseUrl}${path}` }));
        load();
        return null;
      },
    );

  async function removeApp(a: AppDetail) {
    const go = await confirm({
      title: `Delete ${a.name}?`,
      body: "Its tokens and webhooks stop working.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!go) return;
    setBusy(true);
    setRotateError(null);
    if (await client.apps.remove(a.id))
      setRotateError(
        "Could not confirm whether the app was deleted. OwnBase is loading the list again. Check it before you try again.",
      );
    load();
    setBusy(false);
  }

  async function removeWebhook(webhookId: ID, room: string) {
    const go = await confirm({
      title: `Remove the webhook for #${room}?`,
      body: "Anything posting to its address stops reaching the channel at once.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!go) return;
    const failed = await client.apps.removeWebhook(webhookId);
    if (failed)
      toast({
        message: failureText(`Could not remove the webhook for #${room}.`, failed, "Try again."),
        kind: "error",
      });
    else load();
  }

  /** Returns the webhook's URL, which the server shows only this once. */
  async function addWebhook(appId: ID, channelId: ID): Promise<string | ApiError> {
    const r = await client.apps.createWebhook(appId, channelId);
    if (r instanceof ApiError) return r;
    // The path comes back relative; show the address a tool would actually call.
    const url = `${client.baseUrl}${r.url}`;
    setHookUrls((h) => ({ ...h, [r.webhook.id]: url }));
    load();
    return url;
  }

  return (
    <Dialog title="Apps and integrations" onClose={onClose} width={620}>
      <OnceGuard shown={[...Object.values(secrets), ...Object.values(hookUrls)]} />
      <p className="mb-4 text-sm text-ink-dim">
        Connect your own scripts and tools to this workspace. Pick what you want to happen. Each app
        you make posts messages under its own name, as a bot.
      </p>

      <AppTemplates
        apps={apps ?? []}
        rooms={rooms}
        hookUrls={hookUrls}
        makeApp={(appName) => makeApp(appName, [...DEFAULT_APP_SCOPES])}
        makeWebhook={addWebhook}
        onChanged={load}
      />

      <SlackDifferences />

      <h3 className="mb-2 mt-6 text-[13px] font-medium text-ink-dim">Your apps</h3>
      <form onSubmit={(e) => void create(e)} noValidate className="mb-2 flex gap-2">
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
      {/* Chosen when the app is added, as Slack asks at installation (E18c). */}
      <details className="group mb-5 rounded-lg border border-edge">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-[12px] text-ink-dim hover:text-ink">
          <Icon
            name="chevronDown"
            size={12}
            className="shrink-0 transition-transform group-open:rotate-180"
          />
          <span className="min-w-0">What it may do: {scopeSummary(scopes)}</span>
        </summary>
        <div className="border-t border-edge px-3 py-2">
          <ScopePicker scopes={scopes} onChange={setScopes} />
        </div>
      </details>

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
                onClick={() => void removeApp(a)}
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
                      onClick={() =>
                        void removeWebhook(w.id, channels[w.channelId]?.name ?? "unknown")
                      }
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

            <FormSection label="What it may do">
              <AppScopes app={a} onChanged={load} />
            </FormSection>

            <FormSection label="How it receives">
              <AppReceive
                app={a}
                onChanged={load}
                onToken={(token) => setSecrets((s) => ({ ...s, [`app:${a.id}`]: token }))}
              />
              {a.receive === "socket" && secrets[`app:${a.id}`] && (
                <>
                  <SecretRow label="App-level token" value={secrets[`app:${a.id}`]!} once />
                  <p className="mt-1 text-[11px] text-ink-dim">
                    Give this to your app as <code className="font-mono">SLACK_APP_TOKEN</code>,
                    next to its bot token (<code className="font-mono">SLACK_BOT_TOKEN</code>).
                  </p>
                </>
              )}
            </FormSection>

            <FormSection label="Slash commands">
              <CommandList app={a} onChanged={load} />
            </FormSection>

            <FormSection label="Event subscriptions">
              <SubscriptionList app={a} onChanged={load} />
            </FormSection>

            <FormSection label="Interactivity">
              {a.receive === "socket" ? (
                <p className="text-[12px] text-ink-dim">
                  Button presses and forms arrive over its connection.
                </p>
              ) : (
                <InteractivityUrl app={a} onChanged={load} />
              )}
            </FormSection>
          </li>
        ))}
      </ul>
    </Dialog>
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
          Not everything carries over. There is no OAuth. An app here gets a bot token and a signing
          secret, with the scopes ticked below. It receives events and button presses at its URLs,
          or over Socket Mode when it has no public address. A message&rsquo;s{" "}
          <code className="font-mono">ts</code> is an id, not a time.
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

/**
 * A part of an app's card with a form in it. Its name groups the fields, so
 * a screen reader says which Request URL is which.
 */
function FormSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset className="mt-3 min-w-0">
      <legend className="mb-1 text-[12px] text-ink-faint">{label}</legend>
      {children}
    </fieldset>
  );
}

/**
 * A token or webhook address is shown once: closing asks first while one is
 * up that has not been copied. Asked at the moment of closing, since a copy
 * button deep in the dialog does not render this again.
 */
function OnceGuard({ shown }: { shown: string[] }) {
  useDismissGuard(() =>
    shown.some((value) => !wasCopied(value))
      ? {
          title: "Close before copying?",
          body: "Bot tokens, app-level tokens and webhook addresses show only once. Copy them first if you have not already.",
          confirmLabel: "Close anyway",
        }
      : null,
  );
  return null;
}
