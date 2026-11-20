import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import { hostWithPort, type ServerInfo } from "@ownbase/protocol";
import { TITLE_BAR_HEIGHT } from "@ownbase/protocol/desktop";
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
import { normalizeServerUrlSafe } from "../lib/deeplinkHelpers.js";
import { buttonClass } from "../components/Button.js";
import { useConfirm } from "../components/Confirm.js";
import type { SignedOutFrom } from "../lib/signOut.js";
import { AuthCard, endedNote, type Connected } from "./JoinSignIn.js";

export type { Connected } from "./JoinSignIn.js";

/** How long the network is looked through before the join screen suggests other ways in. */
export const SCAN_PATIENCE_MS = 10_000;

interface Props {
  platform: Platform;
  savedServers: SavedServer[];
  /** The icons this device keeps for saved workspaces, by address. */
  savedIcons?: Record<string, string>;
  /** Probe this address immediately on mount. */
  autoProbe?: string;
  /** Prefilled from an invite link. */
  inviteCode?: string;
  /** Prefilled from a link to claim a workspace nobody owns yet (P7). */
  claimCode?: string;
  /** Back from the workspace's single sign-on: the code that signs in (P9). */
  ssoCode?: string;
  /** The workspace ended this sign-in: its sign-in form opens, saying so. */
  signedOut?: SignedOutFrom;
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
  signedOut,
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
  /** A sign-in that ended without anyone here giving it up, told on its form. */
  const [ended, setEnded] = useState<SignedOutFrom | null>(signedOut ?? null);
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
    if (!selfServed || savedServers.length > 0 || autoProbe || signedOut) return;
    setStage((current) =>
      current.view === "browse"
        ? { view: "auth", url: selfServed.url, info: selfServed.info }
        : current,
    );
  }, [selfServed, savedServers.length, autoProbe, signedOut]);

  // Signed out by the workspace: back to its form, where a password carries on.
  const backToForm = useEffectEvent(() => {
    if (signedOut) void probe(signedOut.url);
  });
  useEffect(() => backToForm(), []);

  useEffect(() => {
    if (!platform.discoverLan) return;
    return platform.discoverLan(setLanServers);
  }, [platform]);

  // Somewhere already signed in to reconnects with those credentials, and asks
  // again only if they no longer work — reopening your own hosted workspace
  // should not mean typing the password each time.
  const reconnect = useEffectEvent((address: string) => {
    const saved = savedServers.find((s) => s.url === normalizeServerUrlSafe(address));
    // A sign-in just made with single sign-on is used, not the one saved before.
    if (saved && !ssoCode) void openSaved(saved);
    else void probe(address);
  });
  useEffect(() => {
    if (autoProbe) reconnect(autoProbe);
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
        setEnded({ url: saved.url, handle: saved.handle, workspaceName: saved.workspaceName });
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
  const endedHere = authing && ended?.url === stage.url ? ended : null;
  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-deep">
      {platform.kind === "desktop" && (
        <div className="titlebar-drag relative shrink-0" style={{ height: TITLE_BAR_HEIGHT }} />
      )}
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
              savedHandle={
                savedServers.find((s) => s.url === stage.url)?.handle ??
                (endedHere?.handle.startsWith("guest-") ? undefined : endedHere?.handle)
              }
              endedNote={endedHere ? endedNote(endedHere) : undefined}
              presetInviteCode={inviteCode}
              presetClaimCode={claimCode}
              presetSsoCode={ssoCode}
              platform={platform}
              onBack={() => {
                setEnded(null);
                setStage({ view: "browse" });
              }}
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
              onSelect={(input) => void probe(input)}
              onOpenSaved={(saved) => void openSaved(saved)}
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
      await start({ folder, port });
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
  const confirm = useConfirm();
  // Looking goes on, but after a while it says what else to do rather than
  // pulsing forever over an empty list.
  const [scanGaveUp, setScanGaveUp] = useState(false);
  useEffect(() => {
    if (!props.lanSupported) return;
    const timer = setTimeout(() => setScanGaveUp(true), SCAN_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [props.lanSupported]);
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
          !props.savedServers.some(
            (s) => s.url === normalizeServerUrlSafe(hostWithPort(l.host, l.port)),
          ),
      ),
    [props.lanServers, props.savedServers],
  );
  // Signed in there already, it is listed once, with the account, under Your workspaces.
  const selfServed =
    props.selfServed &&
    !props.savedServers.some((s) => s.url === normalizeServerUrlSafe(props.selfServed!.url))
      ? props.selfServed
      : null;

  // Forgetting drops the saved sign-in: coming back needs the password.
  async function forget(saved: SavedServer) {
    const sure = await confirm({
      title: `Forget ${saved.workspaceName}?`,
      body: `This device stops keeping you signed in as @${saved.handle}. To come back you need its address and your password. Nothing in the workspace changes.`,
      confirmLabel: "Forget",
      destructive: true,
    });
    if (sure) props.onForget(saved.url);
  }

  return (
    <div className="space-y-6">
      {props.error && (
        <div
          role="alert"
          className="rounded-xl border border-alert/30 bg-alert/10 px-4 py-3 text-sm text-alert"
        >
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

      {selfServed && (
        <section>
          <SectionLabel>This workspace</SectionLabel>
          <ul className="card-warm overflow-hidden rounded-2xl">
            <ServerRow
              title={selfServed.info.workspaceName}
              icon={selfIcon}
              subtitle={host(selfServed.url)}
              meta="serving this page"
              busy={props.probing === selfServed.url}
              onClick={() => props.onSelect(selfServed.url)}
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
                onForget={() => void forget(s)}
              />
            ))}
          </ul>
        </section>
      )}

      <section>
        <SectionLabel>
          On your network
          {props.lanSupported && !scanGaveUp && (
            <span className="fc-fill ml-2 inline-block size-1.5 animate-pulse rounded-full bg-online align-middle" />
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
                      : // Under "On your network" already; a version number meant nothing.
                        ""
                  }
                  busy={props.probing?.includes(l.host) ?? false}
                  onClick={() => props.onSelect(address)}
                />
              );
            })}
          </ul>
        ) : (
          <p className="rounded-2xl border border-dashed border-edge px-4 py-5 text-center text-sm text-ink-faint">
            {!props.lanSupported
              ? "The desktop app finds workspaces on your network. Here, type the address below."
              : scanGaveUp
                ? "No workspaces found on this network yet. Type an address below, or host one."
                : "Looking for workspaces on your network…"}
          </p>
        )}
      </section>

      <section>
        <SectionLabel>Join with an address</SectionLabel>
        {/* Connect always answers: with no address, or one that is not one, it says so under the field. */}
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (props.probing !== null) return;
            const problem = !address.trim()
              ? "Type the workspace's address, such as 192.168.1.42:8543."
              : !normalizeServerUrlSafe(address)
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
          <p role="status" className="mt-2 flex items-center gap-2 text-sm text-ink-dim">
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
              className={`fc-fill size-2 shrink-0 rounded-full bg-online ${
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 px-1 text-[12px] font-medium text-ink-faint">{children}</h2>;
}

function ServerRow(props: {
  title: string;
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
  const icon = useWorkspaceIconUrl(normalizeServerUrlSafe(props.address), props.server.iconVersion);
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
