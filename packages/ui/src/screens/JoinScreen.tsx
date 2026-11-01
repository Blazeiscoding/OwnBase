import { useEffect, useId, useMemo, useRef, useState } from "react";
import { hostWithPort, type ServerInfo, type SignInMethod } from "@ownbase/protocol";
import { Api, ApiError, normalizeServerUrl } from "@ownbase/client-core";
import type {
  DiscoveredServer,
  HostingStatus,
  LastHosted,
  Platform,
  SavedServer,
} from "../platform.js";
import { BrandMark } from "../components/BrandMark.js";
import { Icon } from "../components/Icon.js";
import { Tooltip } from "../components/Tooltip.js";
import { connectionFailure, host, incompatibleWorkspace } from "../lib/connection.js";
import { useHostedIcon, useWorkspaceIconUrl } from "../lib/workspaceIcon.js";
import { WorkspaceIcon } from "../components/WorkspaceIcon.js";
import { resumeTarget } from "../lib/resume.js";
import { buttonClass } from "../components/Button.js";
import { inputClass } from "../components/TextField.js";
import { useTabs } from "../lib/useTabs.js";
import { Swap, useChanges } from "../components/Motion.js";
import { beginSingleSignOn, redeemSingleSignOn } from "../lib/singleSignOn.js";
import { useOptionalConfirm } from "../components/Confirm.js";

/** How a sign-in came about, where it matters to what opens next. */
export interface Connected {
  /** This account was just created as the workspace's first, so its owner. */
  founded?: boolean;
}

interface Props {
  platform: Platform;
  savedServers: SavedServer[];
  /** The icons this device keeps for saved workspaces, by address. */
  savedIcons?: Record<string, string>;
  /** Probe this address immediately on mount (used after "Open to LAN" starts). */
  autoProbe?: string;
  /** Prefilled from an invite link. */
  inviteCode?: string;
  /** Prefilled from a link to claim a workspace nobody owns yet (P7). */
  claimCode?: string;
  /** Back from the workspace's single sign-on: the code that signs in (P9). */
  ssoCode?: string;
  onConnected: (server: SavedServer, how?: Connected) => void;
  onForget: (url: string) => void;
  onHostClick?: () => void;
  hostingStatus?: HostingStatus | null;
  hostingStatusError?: boolean;
  hostingStatusLoading?: boolean;
  lastHosted?: LastHosted | null;
}

type Stage =
  | { view: "browse" }
  | { view: "auth"; url: string; info: ServerInfo }
  | { view: "probing"; url: string };

/** Something that went wrong, and what the reader can do about it. */
interface Notice {
  text: string;
  retry?: () => void;
}

function selfOrigin(): string | null {
  if (typeof window === "undefined") return null;
  const { origin, protocol } = window.location;
  return protocol === "http:" || protocol === "https:" ? origin : null;
}

const pageProtocol = () => (typeof window === "undefined" ? undefined : window.location.protocol);

export function JoinScreen({
  platform,
  savedServers,
  savedIcons,
  autoProbe,
  inviteCode,
  claimCode,
  ssoCode,
  onConnected,
  onForget,
  onHostClick,
  hostingStatus,
  hostingStatusError,
  hostingStatusLoading,
  lastHosted,
}: Props) {
  const [stage, setStage] = useState<Stage>({ view: "browse" });
  const [lanServers, setLanServers] = useState<DiscoveredServer[]>([]);
  const [error, setError] = useState<Notice | null>(null);
  const [selfServed, setSelfServed] = useState<{ url: string; info: ServerInfo } | null>(null);
  // Web only: whether the question "is this page served by a workspace?" has
  // been answered yet. Rendering the full list before it is answered shows a
  // screen that is about to be replaced.
  const [selfChecked, setSelfChecked] = useState(platform.kind !== "web");
  /**
   * Which look at a workspace, or sign-in with a saved one, is current. An
   * answer to an older one is not acted on, nor one that comes after this
   * screen is gone: cancelling, or choosing somewhere else, means the person
   * no longer wants it (Q06).
   */
  const probeAttempt = useRef(0);
  useEffect(
    () => () => {
      probeAttempt.current = -1;
    },
    [],
  );

  // A browser that was served *by* a workspace already knows where it is. Ask
  // that origin quietly; if it is not a workspace (a dev server, a static
  // host), nothing is shown and nothing is said.
  useEffect(() => {
    const origin = platform.kind === "web" ? selfOrigin() : null;
    if (!origin) {
      setSelfChecked(true);
      return;
    }
    let disposed = false;
    void new Api(origin)
      .serverInfo()
      .then((info) => {
        if (disposed || incompatibleWorkspace(origin, info)) return;
        setSelfServed({ url: origin, info });
      })
      .catch(() => {})
      .finally(() => {
        if (!disposed) setSelfChecked(true);
      });
    return () => {
      disposed = true;
    };
  }, [platform]);

  // With nowhere else to go, the workspace serving this page is the answer.
  useEffect(() => {
    if (!selfServed || savedServers.length > 0 || autoProbe) return;
    setStage((current) =>
      current.view === "browse"
        ? { view: "auth", url: selfServed.url, info: selfServed.info }
        : current,
    );
  }, [selfServed, savedServers.length, autoProbe]);

  useEffect(() => {
    if (!platform.discoverLan) return;
    return platform.discoverLan(setLanServers);
  }, [platform]);

  useEffect(() => {
    if (!autoProbe) return;
    // Somewhere already signed in to reconnects with those credentials, and asks
    // again only if they no longer work — reopening your own hosted workspace
    // should not mean typing the password each time.
    const saved = savedServers.find((s) => s.url === normalizeSafe(autoProbe));
    // A sign-in just made with single sign-on is used, not the one saved before.
    if (saved && !ssoCode) void openSaved(saved);
    else void probe(autoProbe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoProbe]);

  /** Saved servers reconnect with their stored token; fall back to the auth card if it expired. */
  async function openSaved(saved: SavedServer) {
    setError(null);
    const attempt = ++probeAttempt.current;
    setStage({ view: "probing", url: saved.url });
    try {
      await new Api(saved.url, saved.token).me();
      if (probeAttempt.current !== attempt) return;
      onConnected(saved);
    } catch (err) {
      if (probeAttempt.current !== attempt) return;
      if (err instanceof ApiError && err.status === 401) {
        await probe(saved.url);
      } else {
        setError({
          text: connectionFailure({
            url: saved.url,
            error: err,
            name: saved.workspaceName,
            pageProtocol: pageProtocol(),
          }),
          retry: () => void openSaved(saved),
        });
        setStage({ view: "browse" });
      }
    }
  }

  async function probe(input: string) {
    setError(null);
    let url: string;
    try {
      url = normalizeServerUrl(input);
    } catch {
      setError({ text: "That doesn't look like a workspace address." });
      return;
    }
    const attempt = ++probeAttempt.current;
    setStage({ view: "probing", url });
    try {
      const info = await new Api(url).serverInfo();
      // A slower probe the user cancelled, or moved on from, must not win.
      if (probeAttempt.current !== attempt) return;
      const incompatible = incompatibleWorkspace(url, info);
      if (incompatible) {
        setError({ text: incompatible });
        setStage({ view: "browse" });
        return;
      }
      setStage({ view: "auth", url, info });
    } catch (err) {
      if (probeAttempt.current !== attempt) return;
      setError({
        text: connectionFailure({ url, error: err, pageProtocol: pageProtocol() }),
        retry: () => void probe(url),
      });
      setStage({ view: "browse" });
    }
  }

  /** Abandons a probe that is taking too long, without waiting for it to finish. */
  function cancelProbe() {
    probeAttempt.current++;
    setError(null);
    setStage({ view: "browse" });
  }

  const authing = stage.view === "auth";
  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-deep">
      {platform.kind === "desktop" && <div className="titlebar-drag relative h-10 shrink-0" />}
      <main className="relative flex flex-1 overflow-y-auto px-4 py-8 sm:px-8">
        <div className="join-layout m-auto w-full max-w-[440px] animate-rise-in">
          {/* Signing in, the card is the page, as Clerk's is: one line above it, not three. */}
          <header className={`flex flex-col items-center text-center ${authing ? "mb-6" : "mb-8"}`}>
            <div
              className={`flex items-center gap-2.5 font-brand text-[17px] font-semibold tracking-tight ${authing ? "mb-3" : "mb-6"}`}
            >
              <BrandMark size={32} />
              OwnBase
            </div>
            {authing ? (
              <p className="text-[15px] text-ink-dim">Your people. Your place. Your server.</p>
            ) : (
              <>
                <h1 className="text-4xl font-semibold leading-tight tracking-[-0.02em]">
                  Find your workspace
                </h1>
                <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-ink-dim">
                  {/* Only the desktop app can host. */}
                  {platform.hosting
                    ? "Join your team’s server, or host one on this computer."
                    : "Enter your team’s server address, or open the invite link someone sent you."}
                </p>
              </>
            )}
          </header>

          {stage.view === "auth" ? (
            <AuthCard
              url={stage.url}
              info={stage.info}
              savedHandle={savedServers.find((s) => s.url === stage.url)?.handle}
              presetInviteCode={inviteCode}
              presetClaimCode={claimCode}
              presetSsoCode={ssoCode}
              platform={platform}
              onBack={() => setStage({ view: "browse" })}
              onConnected={onConnected}
            />
          ) : !selfChecked && savedServers.length === 0 && !autoProbe ? (
            <p className="rounded-2xl border border-dashed border-edge px-4 py-8 text-center text-sm text-ink-faint">
              Looking for this workspace…
            </p>
          ) : (
            <BrowseCard
              savedServers={savedServers}
              savedIcons={savedIcons ?? {}}
              lanServers={lanServers}
              lanSupported={!!platform.discoverLan}
              probing={stage.view === "probing" ? stage.url : null}
              error={error}
              selfServed={selfServed}
              onCancelProbe={cancelProbe}
              hostingStatus={hostingStatus}
              hostingStatusError={hostingStatusError}
              hostingStatusLoading={hostingStatusLoading}
              lastHosted={lastHosted ?? null}
              platform={platform}
              onSelect={probe}
              onOpenSaved={openSaved}
              onForget={onForget}
              onHostClick={onHostClick}
            />
          )}
          {/* Signing in, the card's own footer says this about the server it names. */}
          {!authing && (
            <footer className="mt-8 flex items-center justify-center gap-2 text-[12px] text-ink-faint">
              <Icon name="lock" size={12} />
              Your messages and files stay on your server
            </footer>
          )}
        </div>
      </main>
    </div>
  );
}

/**
 * The workspace this computer hosted last, while hosting is stopped. One
 * click starts it again on its remembered port and reopens the saved sign-in,
 * instead of reconnecting to a server that is not there.
 */
function ResumeHosted(props: {
  platform: Platform;
  savedServers: SavedServer[];
  hostingStatus?: HostingStatus | null;
  lastHosted: LastHosted | null;
  onOpenSaved: (saved: SavedServer) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Read from its own database, since it is stopped: showing it starts nothing.
  const icon = useHostedIcon(props.platform.hosting, props.lastHosted?.folder, undefined);
  const target = resumeTarget(props.savedServers, props.hostingStatus, props.lastHosted);
  if (!target || !props.platform.hosting || !props.lastHosted) return null;
  // Plain locals: narrowing does not reach into the async handler below.
  const { saved, workspaceName } = target;
  const { start } = props.platform.hosting;
  const { port, folder } = props.lastHosted;
  const onOpenSaved = props.onOpenSaved;

  async function resume() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      // The remembered port keeps the saved sign-in's address working; a
      // fallback port would open somewhere the sign-in does not point.
      await start(folder ? { folder, port } : { workspaceName, port });
      // Its own sign-in still works, so reopening it asks for no password;
      // one that stopped working falls back to the sign-in form.
      onOpenSaved(saved);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Hosted on this computer">
      <SectionLabel>Hosted on this computer</SectionLabel>
      <div className="card-warm rounded-2xl p-4 text-sm">
        <div className="flex items-start gap-3">
          <WorkspaceIcon name={workspaceName} src={icon} size={36} className="rounded-xl text-sm" />
          <p className="min-w-0 flex-1 text-ink">
            <span className="font-semibold">{workspaceName}</span> isn’t running. Its messages,
            files and accounts are still on this computer.
          </p>
        </div>
        {failed && (
          <p role="alert" className="mt-2 text-alert">
            Could not start {workspaceName} on port {port}. Something else may be using that port,
            or the workspace&rsquo;s folder may not be writable. To start it on a free port, choose
            Host a workspace on this computer and start it from the list there.
          </p>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void resume()}
          className={buttonClass("primary", "mt-3 w-full")}
        >
          {busy ? "Starting…" : `Start hosting ${workspaceName}`}
        </button>
      </div>
    </section>
  );
}

function BrowseCard(props: {
  savedServers: SavedServer[];
  savedIcons: Record<string, string>;
  lanServers: DiscoveredServer[];
  lanSupported: boolean;
  probing: string | null;
  error: Notice | null;
  /** The workspace serving this page, when a browser was opened from one. */
  selfServed: { url: string; info: ServerInfo } | null;
  onCancelProbe: () => void;
  hostingStatus?: HostingStatus | null;
  hostingStatusError?: boolean;
  hostingStatusLoading?: boolean;
  lastHosted?: LastHosted | null;
  platform: Platform;
  onSelect: (address: string) => void;
  onOpenSaved: (saved: SavedServer) => void;
  onForget: (url: string) => void;
  onHostClick?: () => void;
}) {
  const confirm = useOptionalConfirm();
  const [address, setAddress] = useState("");
  /** What is wrong with the typed address, said under it once Connect is pressed. */
  const [addressError, setAddressError] = useState<string | null>(null);
  const addressField = useRef<HTMLInputElement>(null);
  const addressErrorId = useId();
  // The workspace serving this page is there to ask, so its icon is fetched.
  const selfIcon = useWorkspaceIconUrl(props.selfServed?.url, props.selfServed?.info.iconVersion);
  const lanNotSaved = useMemo(
    () =>
      props.lanServers.filter(
        (l) =>
          !props.savedServers.some((s) => s.url === normalizeSafe(hostWithPort(l.host, l.port))),
      ),
    [props.lanServers, props.savedServers],
  );

  return (
    <div className="space-y-6">
      {props.error && (
        <div className="rounded-xl border border-alert/30 bg-alert/10 px-4 py-3 text-sm text-alert">
          <p>{props.error.text}</p>
          {props.error.retry && (
            <button
              onClick={props.error.retry}
              className="mt-1.5 font-medium underline underline-offset-2"
            >
              Try again
            </button>
          )}
        </div>
      )}

      <ResumeHosted
        platform={props.platform}
        savedServers={props.savedServers}
        hostingStatus={props.hostingStatus}
        lastHosted={props.lastHosted ?? null}
        onOpenSaved={props.onOpenSaved}
      />

      {props.selfServed && (
        <section>
          <SectionLabel>This workspace</SectionLabel>
          <ul className="card-warm overflow-hidden rounded-2xl">
            <ServerRow
              title={props.selfServed.info.workspaceName}
              icon={selfIcon}
              subtitle={host(props.selfServed.url)}
              meta="serving this page"
              busy={props.probing === props.selfServed.url}
              onClick={() => props.onSelect(props.selfServed!.url)}
            />
          </ul>
        </section>
      )}

      {props.savedServers.length > 0 && (
        <section>
          <SectionLabel>Your workspaces</SectionLabel>
          <ul className="card-warm overflow-hidden rounded-2xl">
            {props.savedServers.map((s) => (
              <ServerRow
                key={s.url}
                title={s.workspaceName}
                // Kept on this device, since its server may be off.
                icon={props.savedIcons[s.url]}
                subtitle={s.url.replace(/^https?:\/\//, "")}
                meta={`@${s.handle}`}
                busy={props.probing === s.url}
                onClick={() => props.onOpenSaved(s)}
                onForget={async () => {
                  // Forgetting drops the saved sign-in: coming back needs the password.
                  const sure = confirm
                    ? await confirm({
                        title: `Forget ${s.workspaceName}?`,
                        body: `This device stops keeping you signed in as @${s.handle}. To come back you need its address and your password. Nothing in the workspace changes.`,
                        confirmLabel: "Forget",
                        destructive: true,
                      })
                    : true;
                  if (sure) props.onForget(s.url);
                }}
              />
            ))}
          </ul>
        </section>
      )}

      <section>
        <SectionLabel>
          On your network
          {props.lanSupported && (
            <span className="ml-2 inline-block size-1.5 animate-pulse rounded-full bg-online align-middle" />
          )}
        </SectionLabel>
        {lanNotSaved.length > 0 ? (
          <ul className="card-warm overflow-hidden rounded-2xl">
            {lanNotSaved.map((l) => {
              const address = hostWithPort(l.host, l.port);
              return (
                <FoundServerRow
                  key={address}
                  server={l}
                  address={address}
                  // Our own advertisement comes back over mDNS like any other.
                  // Recognised by the running server's instance id: another
                  // computer on the usual port shares the port, not the id.
                  meta={
                    !props.hostingStatusError &&
                    props.hostingStatus?.running &&
                    l.instanceId !== undefined &&
                    l.instanceId === props.hostingStatus.instanceId
                      ? "hosted here"
                      : `v${l.serverVersion}`
                  }
                  busy={props.probing?.includes(l.host) ?? false}
                  onClick={() => props.onSelect(address)}
                />
              );
            })}
          </ul>
        ) : (
          <p className="rounded-2xl border border-dashed border-edge px-4 py-5 text-center text-sm text-ink-faint">
            {props.lanSupported
              ? "Scanning for workspaces on your Wi-Fi…"
              : "LAN discovery works in the desktop app."}
          </p>
        )}
      </section>

      <section>
        <SectionLabel>Direct connect</SectionLabel>
        {/* Connect always answers: with no address, or one that is not one, it says so under the field. */}
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (props.probing !== null) return;
            const problem = !address.trim()
              ? "Type the workspace's address, such as 192.168.1.42:8543."
              : !normalizeSafe(address)
                ? "That doesn't look like a workspace address."
                : null;
            setAddressError(problem);
            if (problem) addressField.current?.focus();
            else props.onSelect(address);
          }}
        >
          <div className="flex gap-2">
            <input
              ref={addressField}
              value={address}
              aria-label="Server address"
              aria-invalid={addressError ? true : undefined}
              aria-describedby={addressError ? addressErrorId : undefined}
              onChange={(e) => {
                setAddress(e.target.value);
                setAddressError(null);
              }}
              placeholder="192.168.1.42:8543 or chat.yourteam.dev"
              spellCheck={false}
              className="h-10 min-w-0 flex-1 rounded-xl border border-[var(--card-edge)] bg-[var(--card-fill)] px-3.5 font-mono text-[13px] outline-none transition-colors placeholder:text-ink-faint hover:border-ink-faint/40 focus:border-copper aria-invalid:border-alert"
            />
            <button
              type="submit"
              aria-disabled={props.probing !== null || undefined}
              className={buttonClass("primary", "h-10 rounded-xl")}
            >
              Connect
            </button>
          </div>
          {addressError && (
            <p
              id={addressErrorId}
              role="alert"
              className="mt-1.5 flex items-start gap-1 px-1 text-[12px] text-alert"
            >
              <Icon name="alert" size={13} className="mt-px" />
              <span>{addressError}</span>
            </p>
          )}
        </form>
        {props.probing && (
          <p className="mt-2 flex items-center gap-2 text-sm text-ink-dim">
            <span className="text-xs">Contacting {host(props.probing)}…</span>
            <button onClick={props.onCancelProbe} className="underline underline-offset-2">
              Cancel
            </button>
          </p>
        )}
      </section>

      {props.onHostClick &&
        (props.hostingStatusError || props.hostingStatusLoading || !props.hostingStatus ? (
          <p className="text-center text-sm text-ink-dim">
            {props.hostingStatusError
              ? "Hosting status unavailable. "
              : "Checking hosting status… "}
            <button onClick={props.onHostClick} className="font-medium text-ink hover:underline">
              Manage hosting
            </button>
          </p>
        ) : props.hostingStatus.running ||
          props.hostingStatus.phase === "starting" ||
          props.hostingStatus.phase === "stopping" ? (
          <div className="card-warm flex items-center gap-3 rounded-2xl px-4 py-3 text-sm">
            {/* Steady while it runs, as the sidebar's is; it pulses only on the way up or down. */}
            <span
              className={`size-2 shrink-0 rounded-full bg-online ${
                props.hostingStatus.phase === "starting" || props.hostingStatus.phase === "stopping"
                  ? "animate-pulse"
                  : ""
              }`}
            />
            <span className="min-w-0 flex-1 text-ink-dim">
              {props.hostingStatus.phase === "starting"
                ? "Starting your workspace…"
                : props.hostingStatus.phase === "stopping"
                  ? "Stopping your workspace…"
                  : "You're hosting on this computer."}
            </span>
            <button
              onClick={props.onHostClick}
              className="shrink-0 font-medium text-ink hover:underline"
            >
              Manage hosting
            </button>
          </div>
        ) : (
          <HostCard onClick={props.onHostClick} />
        ))}
    </div>
  );
}

/** Hosting, offered as one of the two ways in rather than a footnote. */
function HostCard(props: { onClick: () => void }) {
  const id = useId();
  return (
    <section>
      <div className="mb-3 flex items-center gap-3 text-[12px] text-ink-faint">
        <span className="h-px flex-1 bg-edge" />
        or start your own
        <span className="h-px flex-1 bg-edge" />
      </div>
      <button
        onClick={props.onClick}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        className="card-warm group flex w-full items-center gap-3.5 rounded-2xl p-4 text-left hover:bg-ink/[0.03]"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-[var(--card-edge)] bg-lifted text-ink-dim">
          <Icon name="server" size={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span id={`${id}-title`} className="block text-sm font-semibold">
            Host a workspace on this computer
          </span>
          <span id={`${id}-body`} className="mt-0.5 block text-[13px] leading-snug text-ink-faint">
            Your computer becomes the server. People on your Wi-Fi can join right away.
          </span>
        </span>
        <Icon
          name="arrow"
          size={16}
          className="text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink"
        />
      </button>
    </section>
  );
}

function normalizeSafe(input: string): string {
  try {
    return normalizeServerUrl(input);
  } catch {
    return "";
  }
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 px-1 text-[12px] font-medium text-ink-faint">{children}</h2>;
}

function ServerRow(props: {
  title: string;
  /** The workspace's icon, when there is one to show. */
  icon?: string | null;
  subtitle: string;
  meta: string;
  busy: boolean;
  onClick: () => void;
  onForget?: () => void;
}) {
  return (
    <li className="group border-b border-edge last:border-b-0">
      <div className="flex items-center transition-colors hover:bg-ink/[0.04]">
        <button
          onClick={props.onClick}
          disabled={props.busy}
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
        >
          <WorkspaceIcon
            name={props.title}
            src={props.icon}
            size={36}
            className="rounded-xl text-sm"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{props.title}</span>
            <span className="block truncate font-mono text-xs text-ink-faint">
              {props.subtitle}
            </span>
          </span>
          <span className="text-xs text-ink-faint">{props.busy ? "…" : props.meta}</span>
          <Icon name="arrow" size={14} className="text-ink-faint" />
        </button>
        {props.onForget && (
          <Tooltip label="Forget this workspace">
            <button
              onClick={props.onForget}
              aria-label="Forget this workspace"
              className="mr-2 rounded-md p-1 text-ink-faint opacity-0 hover:text-alert focus-visible:opacity-100 group-hover:opacity-100"
            >
              <Icon name="close" size={12} />
            </button>
          </Tooltip>
        )}
      </div>
    </li>
  );
}

/**
 * A workspace found on the network. Its announcement names its icon's
 * version, and the icon is asked of the server at that address, as the join
 * card asks for it.
 */
function FoundServerRow(props: {
  server: DiscoveredServer;
  address: string;
  meta: string;
  busy: boolean;
  onClick: () => void;
}) {
  const icon = useWorkspaceIconUrl(normalizeSafe(props.address) || null, props.server.iconVersion);
  return (
    <ServerRow
      title={props.server.name}
      icon={icon}
      subtitle={props.address}
      meta={props.meta}
      busy={props.busy}
      onClick={props.onClick}
    />
  );
}

function AuthCard(props: {
  url: string;
  info: ServerInfo;
  savedHandle?: string;
  presetInviteCode?: string;
  presetClaimCode?: string;
  presetSsoCode?: string;
  platform: Pick<Platform, "kind">;
  onBack: () => void;
  onConnected: (server: SavedServer, how?: Connected) => void;
}) {
  const hasUsers = props.info.userCount > 0;
  const isFirstUser = !hasUsers;
  // Anyone may see it before signing in, as they see the workspace's name.
  const icon = useWorkspaceIconUrl(props.url, props.info.iconVersion);
  // Older servers say nothing about guests, and offer accounts only.
  const guestAllowed = hasUsers && props.info.accessPolicy === "guest_allowed";
  const modes = guestAllowed ? GUEST_MODES : MODES;
  // An empty workspace has nothing to sign in to, even if we remember a handle
  // here, and someone arriving with an invite has no account to sign in with.
  // Where guests are welcome, joining as one comes first, unless this device
  // remembers an account here.
  const [mode, setMode] = useState<Mode>(
    isFirstUser || props.presetInviteCode
      ? "register"
      : guestAllowed && !(props.savedHandle && !props.savedHandle.startsWith("guest-"))
        ? "guest"
        : "login",
  );
  const [handle, setHandle] = useState(props.savedHandle ?? "");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState(props.presetInviteCode ?? "");
  // A claim link brings its code: kept for an empty workspace only, where
  // it is asked for, and shown so the person sees what they are using.
  const [claimCode, setClaimCode] = useState(isFirstUser ? (props.presetClaimCode ?? "") : "");
  const [requiresClaim, setRequiresClaim] = useState(!!props.info.requiresClaim);
  const [error, setError] = useState<string | null>(null);
  // A form that was refused shakes its head. Each new refusal shakes it again:
  // one that replaces another takes the twin animation, which starts afresh.
  const refusals = useChanges(error);
  const shake = error ? (refusals % 2 ? "animate-shake" : "animate-shake-again") : "";
  const [busy, setBusy] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);
  /**
   * Which attempt is current. An answer to an older one, or one that comes
   * after the card is gone, is not acted on: going back or leaving means the
   * person no longer wants it.
   */
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current = -1;
    },
    [],
  );
  /**
   * Set when the password just used was issued by someone else — an admin
   * reset, or host recovery. The workspace is closed to this account until it
   * chooses its own, so the card asks for one instead of going in.
   */
  const [mustReplace, setMustReplace] = useState<{ token: string; current: string } | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  /**
   * Set when the password was right for an account with two-step sign-in
   * (E11): the card asks for a code from its authenticator app, or one of its
   * recovery codes, before going in.
   */
  const [secondStep, setSecondStep] = useState<{ challenge: string } | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [answer, setAnswer] = useState("");
  /** Signed in with a recovery code: how many are left is said before going in. */
  const [recoveryNote, setRecoveryNote] = useState<{ server: SavedServer; left: number } | null>(
    null,
  );
  const id = useId();
  const { platform } = props;
  // Ways in besides a password (P9), and whether passwords are the owner's alone.
  const ssoMethods = hasUsers ? (props.info.signIn?.methods ?? []) : [];
  const ownerPasswordsOnly = props.info.signIn?.passwords === "owner_only";
  /** The desktop app sent the person to their browser to sign in there. */
  const [ssoAway, setSsoAway] = useState(false);

  useEffect(() => firstField.current?.focus(), []);

  // Back from single sign-on with a code: it signs in with the secret this
  // device began with, so a code someone else passed on signs nobody in.
  useEffect(() => {
    const code = props.presetSsoCode;
    if (!code) return;
    let gone = false;
    setBusy(true);
    redeemSingleSignOn(props.url, code).then(
      (result) => {
        if (gone) return;
        props.onConnected({
          url: props.url,
          token: result.token,
          workspaceName: props.info.workspaceName,
          handle: result.user.handle,
          lastUsedAt: Date.now(),
        });
      },
      (err: unknown) => {
        if (gone) return;
        setError(err instanceof ApiError ? errorMessage(err, "login") : (err as Error).message);
        setBusy(false);
      },
    );
    return () => {
      gone = true;
    };
    // The code arrives once, with the card; nothing else here changes what it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.presetSsoCode, props.url]);

  async function signInWith(method: SignInMethod) {
    setError(null);
    try {
      await beginSingleSignOn(platform, props.url, method);
      if (platform.kind === "desktop") setSsoAway(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const tabs = useTabs({
    label: "Account",
    tabs: modes,
    selected: mode,
    onSelect(next, how) {
      setMode(next);
      // A click is a choice of form, so the cursor goes to its first field,
      // which both forms share. The arrow keys leave focus on the tabs, as in
      // any tab list.
      if (how === "click") firstField.current?.focus();
    },
  });

  /**
   * What is missing or malformed, said before asking the server, with focus
   * on the field to fix. The button stays enabled: one that silently refuses
   * gives no reason, and a keyboard cannot even reach it.
   */
  function problem(): { text: string; field: "name" | "handle" | "password" } | null {
    if (mode === "guest")
      return displayName.trim()
        ? null
        : { text: "Enter the name everyone will see.", field: "name" };
    const name = handle.trim().toLowerCase();
    if (!name)
      return {
        text: mode === "login" ? "Enter your username." : "Choose a username.",
        field: "handle",
      };
    if (mode === "register" && !/^[a-z0-9][a-z0-9._-]{1,31}$/.test(name))
      return {
        text: "Usernames are 2 to 32 lowercase letters or numbers, and may use . _ or -.",
        field: "handle",
      };
    if (!password) return { text: "Enter your password.", field: "password" };
    if (mode === "register" && password.length < 8)
      return { text: "Use at least 8 characters for your password.", field: "password" };
    return null;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const missing = problem();
    if (missing) {
      setError(missing.text);
      document
        .getElementById(`${id}-${missing.field === "name" ? "guest-name" : missing.field}`)
        ?.focus();
      return;
    }
    setBusy(true);
    const api = new Api(props.url);
    const ticket = ++attempt.current;
    try {
      const result =
        mode === "guest"
          ? await api.joinAsGuest(displayName.trim())
          : mode === "login"
            ? await api.login({ handle: handle.trim().toLowerCase(), password })
            : await api.register({
                handle: handle.trim().toLowerCase(),
                displayName: displayName.trim() || handle.trim(),
                password,
                ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}),
                ...(claimCode.trim() ? { claimCode: claimCode.trim() } : {}),
              });
      if (ticket !== attempt.current) return;
      if ("twoStep" in result) {
        setSecondStep({ challenge: result.twoStep.challenge });
        setUseRecovery(false);
        setAnswer("");
        setBusy(false);
        return;
      }
      if ("mustChangePassword" in result && result.mustChangePassword) {
        setMustReplace({ token: result.token, current: password });
        setBusy(false);
        return;
      }
      props.onConnected(
        {
          url: props.url,
          token: result.token,
          workspaceName: props.info.workspaceName,
          handle: result.user.handle,
          lastUsedAt: Date.now(),
        },
        // The first account owns the workspace: it was made just now (UX-42).
        { founded: mode === "register" && result.user.role === "owner" },
      );
    } catch (err) {
      if (ticket !== attempt.current) return;
      if (err instanceof ApiError && err.code === "claim_required") setRequiresClaim(true);
      setError(errorMessage(err, mode));
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!secondStep) return;
    setError(null);
    const typed = answer.trim();
    if (!typed) {
      setError(
        useRecovery ? "Enter one of your recovery codes." : "Enter the code your app shows.",
      );
      document.getElementById(`${id}-answer`)?.focus();
      return;
    }
    setBusy(true);
    const ticket = ++attempt.current;
    try {
      const result = await new Api(props.url).signInSecondStep({
        challenge: secondStep.challenge,
        ...(useRecovery ? { recoveryCode: typed } : { code: typed }),
      });
      if (ticket !== attempt.current) return;
      setSecondStep(null);
      if (result.mustChangePassword) {
        setMustReplace({ token: result.token, current: password });
        setBusy(false);
        return;
      }
      const server: SavedServer = {
        url: props.url,
        token: result.token,
        workspaceName: props.info.workspaceName,
        handle: result.user.handle,
        lastUsedAt: Date.now(),
      };
      if (useRecovery) {
        setRecoveryNote({ server, left: result.recoveryCodesLeft });
        setBusy(false);
        return;
      }
      props.onConnected(server);
    } catch (err) {
      if (ticket !== attempt.current) return;
      // Too long, or too many wrong codes: back to the password, which is asked again.
      if (err instanceof ApiError && err.code === "two_step_expired") {
        setSecondStep(null);
        setPassword("");
      }
      setError(errorMessage(err, "login"));
      setBusy(false);
    }
  }

  async function replacePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!mustReplace) return;
    setError(null);
    if (newPassword.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Those two do not match.");
      return;
    }
    if (newPassword === mustReplace.current) {
      setError("Choose something other than the password you were given.");
      return;
    }
    setBusy(true);
    const ticket = ++attempt.current;
    try {
      const api = new Api(props.url, mustReplace.token);
      await api.changePassword(mustReplace.current, newPassword);
      if (ticket !== attempt.current) return;
      props.onConnected({
        url: props.url,
        token: mustReplace.token,
        workspaceName: props.info.workspaceName,
        handle: handle.trim().toLowerCase(),
        lastUsedAt: Date.now(),
      });
    } catch (err) {
      if (ticket !== attempt.current) return;
      setError(errorMessage(err, "login"));
      setBusy(false);
    }
  }

  const fieldCls = inputClass("large");
  const labelCls = "mb-1.5 block text-[13px] font-medium text-ink-dim";
  const hintCls = "mt-1.5 text-xs text-ink-faint";
  const submitCls = buttonClass("primary", "h-10 w-full rounded-xl");

  return (
    <div className="card-warm sign-in-card overflow-hidden rounded-3xl p-6 sm:p-7">
      <div className="mb-6 flex flex-col items-center text-center">
        <WorkspaceIcon
          name={props.info.workspaceName}
          src={icon}
          size={56}
          className="rounded-2xl text-xl shadow-[0_8px_20px_-12px_rgb(0_0_0/0.5)]"
        />
        <h1 className="mt-4 font-brand text-2xl font-semibold tracking-tight">
          {props.info.workspaceName}
        </h1>
        <p className="mt-1 text-[13px] text-ink-faint">
          <span className="font-mono text-[12px]">{props.url.replace(/^https?:\/\//, "")}</span> ·{" "}
          {props.info.userCount === 0
            ? "No members yet"
            : `${props.info.userCount} ${props.info.userCount === 1 ? "member" : "members"}`}
        </p>
      </div>

      {mustReplace ? (
        <>
          <p className="mb-4 rounded-xl border border-edge bg-ink/[0.04] px-3.5 py-3 text-sm text-ink-dim">
            That password was issued to you by someone else. Choose your own to finish signing in —
            the workspace stays closed until you do.
          </p>
          <form onSubmit={replacePassword} className={`space-y-4 ${shake}`}>
            <div>
              <label className={labelCls} htmlFor={`${id}-new-password`}>
                New password
              </label>
              <input
                id={`${id}-new-password`}
                autoFocus
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                aria-describedby={`${id}-new-password-hint`}
                className={fieldCls}
              />
              <p id={`${id}-new-password-hint`} className={hintCls}>
                At least 8 characters.
              </p>
            </div>
            <div>
              <label className={labelCls} htmlFor={`${id}-confirm-password`}>
                Confirm new password
              </label>
              <input
                id={`${id}-confirm-password`}
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={fieldCls}
              />
            </div>
            {error && (
              <p role="alert" className="animate-text-in text-sm text-alert">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy} className={submitCls}>
              <Swap text>{busy ? "Saving…" : "Set password and continue"}</Swap>
            </button>
          </form>
        </>
      ) : recoveryNote ? (
        <>
          <p
            role="status"
            className="mb-4 rounded-xl border border-edge bg-ink/[0.04] px-3.5 py-3 text-sm text-ink-dim"
          >
            You signed in with a recovery code.{" "}
            {recoveryNote.left === 0
              ? "It was your last one."
              : `You have ${recoveryNote.left} left, and each works once.`}{" "}
            If your phone is gone, make new codes or set up your authenticator app again in Account
            settings, under Security.
          </p>
          <button
            type="button"
            autoFocus
            className={submitCls}
            onClick={() => props.onConnected(recoveryNote.server)}
          >
            Continue
          </button>
        </>
      ) : secondStep ? (
        <>
          <p className="mb-4 rounded-xl border border-edge bg-ink/[0.04] px-3.5 py-3 text-sm text-ink-dim">
            {useRecovery
              ? "Enter one of the recovery codes you saved when you set up two-step sign-in."
              : "This account has two-step sign-in. Enter the 6-digit code your authenticator app shows."}
          </p>
          <form onSubmit={verify} noValidate className={`space-y-4 ${shake}`}>
            <div>
              <label className={labelCls} htmlFor={`${id}-answer`}>
                {useRecovery ? "Recovery code" : "Code"}
              </label>
              <input
                id={`${id}-answer`}
                key={useRecovery ? "recovery" : "code"}
                autoFocus
                inputMode={useRecovery ? "text" : "numeric"}
                autoComplete={useRecovery ? "off" : "one-time-code"}
                spellCheck={false}
                autoCapitalize="none"
                maxLength={useRecovery ? 32 : 16}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                className={`${fieldCls} font-mono tracking-widest`}
              />
            </div>
            {error && (
              <p role="alert" className="animate-text-in text-sm text-alert">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy} className={submitCls}>
              <Swap text>{busy ? "Checking…" : "Sign in"}</Swap>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setUseRecovery((value) => !value);
                setAnswer("");
                setError(null);
              }}
              className="w-full text-center text-[13px] text-ink-dim underline-offset-2 transition-colors hover:text-ink hover:underline"
            >
              {useRecovery ? "Use a code from your app instead" : "Use a recovery code instead"}
            </button>
          </form>
        </>
      ) : (
        <>
          {isFirstUser && (
            <p className="mb-5 flex items-start gap-2.5 rounded-xl border border-edge bg-ink/[0.04] px-3.5 py-3 text-sm text-ink-dim">
              <Icon name="info" size={16} className="mt-0.5 shrink-0 text-ink-faint" />
              <span>This workspace is brand new. The first account becomes its owner.</span>
            </p>
          )}

          {ssoMethods.length > 0 && (
            <div className="mb-5">
              <div className="space-y-2">
                {ssoMethods.map((method) => (
                  <button
                    key={method.id}
                    type="button"
                    disabled={busy}
                    className={buttonClass("secondary", "h-10 w-full rounded-xl")}
                    onClick={() => void signInWith(method)}
                  >
                    <Icon name="lock" size={14} />
                    Sign in with {method.name}
                  </button>
                ))}
              </div>
              {(ssoAway || (props.presetSsoCode && busy)) && (
                <p role="status" className="mt-2 text-[13px] text-ink-dim">
                  {props.presetSsoCode && busy
                    ? "Signing you in…"
                    : "Finish signing in in your browser. OwnBase opens again when you are done."}
                </p>
              )}
              {ownerPasswordsOnly && (
                <p className="mt-2 text-[13px] text-ink-faint">
                  Passwords here sign in only the workspace's owner.
                </p>
              )}
              <div
                aria-hidden="true"
                className="mt-5 flex items-center gap-3 text-[12px] text-ink-faint"
              >
                <span className="h-px flex-1 bg-edge" />
                or
                <span className="h-px flex-1 bg-edge" />
              </div>
            </div>
          )}

          {hasUsers && (
            <div
              {...tabs.listProps}
              className="relative mb-5 flex gap-1 rounded-xl border border-edge bg-ground p-1"
            >
              {/* One thumb that slides to the chosen form, rather than one that blinks across. */}
              <span
                aria-hidden="true"
                className="segment-thumb"
                style={
                  {
                    "--segments": modes.length,
                    "--segment": Math.max(0, (modes as readonly Mode[]).indexOf(mode)),
                  } as React.CSSProperties
                }
              />
              {modes.map((m) => (
                <button
                  key={m}
                  {...tabs.tabProps(m)}
                  className={`relative flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                    mode === m ? "text-ink" : "text-ink-faint hover:text-ink"
                  }`}
                >
                  {MODE_LABELS[m]}
                </button>
              ))}
            </div>
          )}

          <div {...(hasUsers ? tabs.panelProps : {})}>
            {mode === "guest" ? (
              <form onSubmit={submit} noValidate className={`space-y-4 ${shake}`}>
                <div>
                  <label className={labelCls} htmlFor={`${id}-guest-name`}>
                    Display name
                  </label>
                  <input
                    id={`${id}-guest-name`}
                    ref={firstField}
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    autoComplete="nickname"
                    maxLength={80}
                    aria-describedby={`${id}-guest-name-hint`}
                    className={fieldCls}
                  />
                  <p id={`${id}-guest-name-hint`} className={hintCls}>
                    What everyone sees. As a guest you can read and post in public channels for a
                    day. Creating an account is optional.
                  </p>
                </div>
                {error && (
                  <p role="alert" className="animate-text-in text-sm text-alert">
                    {error}
                  </p>
                )}
                <button type="submit" disabled={busy} className={submitCls}>
                  <Swap text>{busy ? "Joining…" : "Join as guest"}</Swap>
                </button>
              </form>
            ) : (
              <form onSubmit={submit} noValidate className={`space-y-4 ${shake}`}>
                <div>
                  <label className={labelCls} htmlFor={`${id}-handle`}>
                    Username
                  </label>
                  <input
                    id={`${id}-handle`}
                    ref={firstField}
                    value={handle}
                    onChange={(e) => setHandle(e.target.value)}
                    autoComplete="username"
                    spellCheck={false}
                    autoCapitalize="none"
                    aria-describedby={mode === "register" ? `${id}-handle-hint` : undefined}
                    className={fieldCls}
                  />
                  {mode === "register" && (
                    <p id={`${id}-handle-hint`} className={hintCls}>
                      Lowercase letters and numbers, such as maya or sam.r
                    </p>
                  )}
                </div>
                {mode === "register" && (
                  <div>
                    <label className={labelCls} htmlFor={`${id}-display-name`}>
                      Display name
                    </label>
                    <input
                      id={`${id}-display-name`}
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      autoComplete="nickname"
                      aria-describedby={`${id}-display-name-hint`}
                      className={fieldCls}
                    />
                    <p id={`${id}-display-name-hint`} className={hintCls}>
                      What everyone sees. Left empty, it is your username.
                    </p>
                  </div>
                )}
                <div>
                  <label className={labelCls} htmlFor={`${id}-password`}>
                    Password
                  </label>
                  <input
                    id={`${id}-password`}
                    type="password"
                    autoComplete={mode === "register" ? "new-password" : "current-password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-describedby={mode === "register" ? `${id}-password-hint` : undefined}
                    className={fieldCls}
                  />
                  {mode === "register" && (
                    <p id={`${id}-password-hint`} className={hintCls}>
                      At least 8 characters.
                    </p>
                  )}
                </div>
                {mode === "register" && !isFirstUser && props.info.requiresInvite && (
                  <div>
                    <label className={labelCls} htmlFor={`${id}-invite-code`}>
                      Invite code
                    </label>
                    <input
                      id={`${id}-invite-code`}
                      value={inviteCode}
                      onChange={(e) => setInviteCode(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby={`${id}-invite-code-hint`}
                      className={`${fieldCls} font-mono`}
                    />
                    <p id={`${id}-invite-code-hint`} className={hintCls}>
                      From whoever invited you. This workspace takes new accounts only with one.
                    </p>
                  </div>
                )}
                {mode === "register" && requiresClaim && (
                  <div>
                    <label className={labelCls} htmlFor="workspace-claim-code">
                      Workspace claim code
                    </label>
                    <input
                      id="workspace-claim-code"
                      type="password"
                      autoComplete="off"
                      value={claimCode}
                      onChange={(e) => setClaimCode(e.target.value)}
                      placeholder="Claim code from the host"
                      aria-describedby="workspace-claim-help"
                      spellCheck={false}
                      className={`${fieldCls} font-mono`}
                    />
                    <p id="workspace-claim-help" className="mt-1 text-xs text-ink-dim">
                      {props.presetClaimCode && claimCode === props.presetClaimCode
                        ? "Filled in from your link. It makes this account the workspace's owner."
                        : "Enter the code shown when the host started this workspace to create its owner account."}
                    </p>
                  </div>
                )}
                {error && (
                  <p role="alert" className="animate-text-in text-sm text-alert">
                    {error}
                  </p>
                )}
                <button type="submit" disabled={busy} className={submitCls}>
                  <Swap text>
                    {busy ? "Connecting…" : mode === "login" ? "Sign in" : "Join workspace"}
                  </Swap>
                </button>
              </form>
            )}
          </div>
        </>
      )}
      {/* Clerk's footer band, out to the card's edges: the way back, and where what you write is kept. */}
      <div className="-mx-6 -mb-6 mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-[var(--card-edge)] bg-ink/[0.03] px-6 py-3.5 sm:-mx-7 sm:-mb-7 sm:px-7">
        <button
          onClick={props.onBack}
          className="flex items-center gap-1.5 text-[13px] text-ink-dim transition-colors hover:text-ink"
        >
          <Icon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} />
          All workspaces
        </button>
        <span className="flex items-center gap-1.5 text-[12px] text-ink-faint">
          <Icon name="lock" size={12} />
          Messages and files stay on this server
        </span>
      </div>
    </div>
  );
}

const MODES = ["login", "register"] as const;
const GUEST_MODES = ["guest", "login", "register"] as const;
type Mode = (typeof GUEST_MODES)[number];
const MODE_LABELS: Record<Mode, string> = {
  guest: "Join as guest",
  login: "Sign in",
  register: "Create account",
};

function errorMessage(err: unknown, mode: Mode): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "guest_access_off":
        return "This workspace no longer lets guests in. Sign in or create an account instead.";
      case "guests_full":
        return "Too many guests are here right now. Try again later, or create an account.";
      case "workspace_unclaimed":
        return "This workspace has no owner yet, so guests cannot join it.";
      case "invalid_credentials":
        return "Wrong username or password.";
      case "handle_taken":
        return "That username is taken — sign in instead?";
      case "invite_required":
        return "This workspace needs an invite code to join.";
      case "claim_required":
        return "Enter the workspace claim code shown on the host. The code you entered was not accepted.";
      case "sso_required":
        return mode === "register"
          ? "New accounts here are made through the workspace's single sign-on. Use its button above."
          : "This workspace signs people in with its single sign-on. Use its button above.";
      case "invalid_request":
        return mode === "guest"
          ? "Enter a display name of up to 80 characters."
          : mode === "register"
            ? "Usernames are lowercase letters and digits; passwords need 8+ characters."
            : "Check the username and password.";
      case "too_many_requests":
        return "Too many tries for now. Wait a minute, then try again.";
    }
    // The server answered, so it was reached: say what it said where it said something.
    if (err.message && err.message !== err.code) return err.message;
    if (err.status >= 500)
      return "The workspace's server ran into a problem. Try again in a moment, and tell whoever runs it if it keeps happening.";
    return `The workspace's server turned that down (${err.code}). Try again, or ask whoever runs it.`;
  }
  // No answer came: the request failed on the way, or waited too long.
  if (err instanceof DOMException && err.name === "TimeoutError")
    return "The server took too long to answer. Check the address and your connection, then try again.";
  return "Could not reach the server. Check the address and try again.";
}
