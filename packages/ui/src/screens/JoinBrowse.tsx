import { useEffect, useId, useMemo, useRef, useState } from "react";
import { hostWithPort, type ServerInfo } from "@ownbase/protocol";
import type {
  DiscoveredServer,
  HostingStatus,
  LastHosted,
  Platform,
  SavedServer,
} from "../platform.js";
import { Icon } from "../components/Icon.js";
import { Tooltip } from "../components/Tooltip.js";
import { host } from "../lib/connection.js";
import { useHostedIcon, useWorkspaceIconUrl } from "../lib/workspaceIcon.js";
import { WorkspaceIcon } from "../components/WorkspaceIcon.js";
import { resumeTarget } from "../lib/resume.js";
import { normalizeServerUrlSafe } from "../lib/deeplinkHelpers.js";
import { buttonClass } from "../components/Button.js";
import { useConfirm } from "../components/Confirm.js";

/** How long the network is looked through before the join screen suggests other ways in. */
export const SCAN_PATIENCE_MS = 10_000;

/** Something that went wrong, and what the reader can do about it. */
export interface Notice {
  text: string;
  retry?: () => void;
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

export function BrowseCard(props: {
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
