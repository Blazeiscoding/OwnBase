import { useEffect, useRef, useState, type RefObject } from "react";
import { type AccessPolicy } from "@ownbase/protocol";
import { failureMessage, type HostingStatus } from "../platform.js";
import { formatBytes } from "../lib/format.js";
import { type useCopy } from "../lib/useCopy.js";
import { inputClass } from "./TextField.js";
import { Swap } from "./Motion.js";
import { buttonClass } from "./Button.js";
import { JoinPolicyChoice } from "./JoinPolicyChoice.js";
import { CallRelaySettings } from "./CallRelaySettings.js";
import { BreakableAddress } from "./BreakableAddress.js";
import { type Hosting, type HostingBusy } from "./hostParts.js";

/**
 * The Your own address form's state. The dialog keeps it, so a half-typed
 * address is still there after a look at another tab.
 */
export type OwnAddressState = {
  addressField: RefObject<HTMLInputElement | null>;
  addressValue: string;
  addressError: string | null;
  addressUnchanged: boolean;
  setAddressDraft: (text: string | null) => void;
  setAddressError: (text: string | null) => void;
  setAddressUnchanged: (unchanged: boolean) => void;
  saveAddress: () => Promise<void>;
};

/**
 * The Share on the internet tab of a running workspace: the public link card,
 * which opens, closes and installs what it needs, then the call relay.
 */
export function HostInternet(props: {
  hosting: Hosting;
  status: HostingStatus;
  /** The open public link's address, if one is open. */
  publicUrl: string | null;
  tunnelError: string | undefined;
  /** The public address is carried by a tunnel or proxy OwnBase does not run. */
  externallyCarried: boolean;
  /** Who may join, as the running workspace holds it. */
  livePolicy: AccessPolicy | undefined;
  /** Invite people can open here, as the hosted workspace is on screen. */
  invitesHere: boolean;
  onInvite?: () => void;
  busy: HostingBusy;
  unavailable: boolean;
  copy: ReturnType<typeof useCopy>["copy"];
  copyLabel: ReturnType<typeof useCopy>["label"];
  refresh: () => unknown;
  /** Who may join once the link opens, chosen before opening. */
  openPolicy: AccessPolicy;
  setOpenPolicy: (policy: AccessPolicy) => void;
  openToAll: () => Promise<void>;
  endOpenToAll: () => Promise<void>;
  changeAccessPolicy: (next: AccessPolicy) => Promise<void>;
  address: OwnAddressState;
}) {
  const {
    status,
    publicUrl,
    tunnelError,
    externallyCarried,
    livePolicy,
    invitesHere,
    busy,
    unavailable,
    copy,
    copyLabel,
    refresh,
    openPolicy,
    setOpenPolicy,
    openToAll,
    endOpenToAll,
    changeAccessPolicy,
  } = props;
  const {
    addressField,
    addressValue,
    addressError,
    addressUnchanged,
    setAddressDraft,
    setAddressError,
    setAddressUnchanged,
    saveAddress,
  } = props.address;

  // Once cloudflared is installed, the install button that had focus is gone,
  // and Get a public link, which took its place, is what comes next.
  const openButton = useRef<HTMLButtonElement>(null);
  const tunnelWasMissing = useRef(false);
  useEffect(() => {
    if (
      status.tunnelAvailable &&
      tunnelWasMissing.current &&
      document.activeElement === document.body
    )
      openButton.current?.focus();
    tunnelWasMissing.current = status.tunnelAvailable === false;
  }, [status.tunnelAvailable]);

  return (
    <>
      <div>
        <h3 className="font-semibold text-ink">Let people outside your network join</h3>
        <p className="mt-1 text-ink-dim">
          {publicUrl
            ? "The workspace has a public link now, so people can join from anywhere. Messages and files still stay on this computer."
            : "Right now only people on the same Wi-Fi or network as this computer can join. A public link lets people join from home or on mobile data too. Messages and files still stay on this computer."}
        </p>
      </div>
      {!status.isolated && (
        <div className="card-warm rounded-xl p-3">
          <div className="mb-1 flex items-center justify-between gap-3">
            <h3 className="font-semibold text-ink">Public link</h3>
            {publicUrl && (
              <span className="rounded-full bg-copper/15 px-2 py-0.5 text-xs text-copper">
                Public
              </span>
            )}
          </div>
          <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {publicUrl
              ? `Public link open at ${publicUrl}`
              : status.openToAll?.phase === "opening"
                ? "Opening public link"
                : "Public link closed"}
          </p>
          {tunnelError && (
            <p role="alert" className="mb-2 text-xs text-alert">
              {tunnelError}
            </p>
          )}
          {publicUrl ? (
            <>
              <p className="mb-2 text-xs text-ink-dim">
                {!status.publicAddress
                  ? "This link works from anywhere while OwnBase is running. You get a new one each time you open it."
                  : status.publicAddressManaged
                    ? "This address stays the same each time you open the link. Keep OwnBase and its Cloudflare connector running so people can connect."
                    : "This address stays the same each time you open the link. OwnBase can stop using it, but turning off the tunnel or proxy behind it is up to you."}
              </p>
              <div className="flex items-center justify-between gap-2 rounded-lg border border-edge bg-raised p-2">
                <a
                  href={publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 font-mono text-xs text-ink underline decoration-ink-faint/60 underline-offset-2 hover:decoration-ink"
                >
                  <BreakableAddress text={publicUrl} />
                </a>
                <button
                  type="button"
                  onClick={() => void copy(publicUrl, "public-address")}
                  className="shrink-0 rounded px-2 py-1 text-xs text-ink-dim hover:bg-ink/[0.05]"
                >
                  <Swap text>
                    {copyLabel("Copy address", "Copied", "Copy failed", "public-address")}
                  </Swap>
                </button>
              </div>
              {livePolicy && (
                <div className="mt-3">
                  <JoinPolicyChoice
                    compact
                    legend="Who can join"
                    hint="Who can join through the public link. A change applies right away."
                    value={livePolicy}
                    disabled={!!busy}
                    onChange={(next) => void changeAccessPolicy(next)}
                  />
                </div>
              )}
              <p className="mt-2 text-xs text-ink-dim">
                {livePolicy === "guest_allowed"
                  ? "Anyone with this address can join as a guest for a day and post in public channels. Choosing either of the others signs every guest out."
                  : livePolicy !== "invite_only"
                    ? "Anyone with this address can create an account. Send the address only to people you trust."
                    : invitesHere
                      ? "This address alone will not let anyone in. Send an invite link instead. It has this address and an invite code, so people join in one click."
                      : "This address alone will not let anyone in. To bring someone in, open the workspace, choose Invite people from its menu and send them that link."}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {livePolicy === "invite_only" && invitesHere && (
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={props.onInvite}
                    className={buttonClass("primary", "h-8 px-3 text-[13px]")}
                  >
                    Get an invite link
                  </button>
                )}
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void endOpenToAll()}
                  className="h-8 rounded-lg border border-edge px-3 text-xs text-ink-dim hover:text-ink disabled:opacity-40"
                >
                  {busy === "closing"
                    ? externallyCarried
                      ? "Stopping use of address…"
                      : "Closing public link…"
                    : externallyCarried
                      ? "Stop using address"
                      : "Close public link"}
                </button>
              </div>
            </>
          ) : (
            <>
              {status.publicAddress ? (
                <div className="space-y-2 text-xs text-ink-dim">
                  <p>The public link will use your own address, which never changes.</p>
                  <p className="font-mono text-ink">
                    <BreakableAddress text={status.publicAddress} />
                  </p>
                  {status.port !== undefined && (
                    <p>
                      {status.publicAddressManaged ? "In Cloudflare, route" : "Send"} this address
                      to{" "}
                      <code className="break-all text-ink">{`http://127.0.0.1:${status.port}`}</code>
                      .
                    </p>
                  )}
                  <p>Keep OwnBase running so teammates can connect.</p>
                  {externallyCarried && (
                    <p>
                      The tunnel or proxy behind this address may already let people reach the
                      workspace, so saving it turned on invites. To make the address stop working,
                      turn off that tunnel or proxy yourself.
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-ink-dim">
                  OwnBase asks Cloudflare for a free web address that leads to this computer. You do
                  not need a Cloudflare account or any router settings. The address changes each
                  time you open the link.
                </p>
              )}
              {status.tunnelAvailable === false ? (
                <div className="mt-3 text-xs text-ink-dim">
                  {status.cloudflaredInstall ? (
                    <InstallCloudflared
                      install={status.cloudflaredInstall}
                      onInstall={props.hosting.installCloudflared}
                      disabled={!!busy}
                    />
                  ) : (
                    <p>
                      Install cloudflared, a free program from Cloudflare, then press Check again.
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => void refresh()}
                    className="mt-2 font-medium text-ink underline decoration-ink-faint/60 underline-offset-2 hover:decoration-ink disabled:opacity-40"
                  >
                    Check again
                  </button>
                </div>
              ) : (
                <>
                  <div className="mt-3">
                    <JoinPolicyChoice
                      compact
                      legend="Who can join"
                      hint="Who can join once the link is open."
                      value={openPolicy}
                      disabled={!!busy}
                      onChange={setOpenPolicy}
                    />
                  </div>
                  <button
                    ref={openButton}
                    type="button"
                    disabled={
                      unavailable ||
                      !!status.publicAddressError ||
                      status.openToAll?.phase === "opening"
                    }
                    onClick={() => void openToAll()}
                    className={buttonClass("primary", "mt-3 w-full")}
                  >
                    {busy === "opening" || status.openToAll?.phase === "opening"
                      ? "Opening public link…"
                      : "Get a public link"}
                  </button>
                </>
              )}
              <div className="mt-3 border-t border-edge pt-3">
                <label htmlFor="public-address" className="block text-xs font-medium text-ink-dim">
                  Your own address
                </label>
                <p id="public-address-help" className="mt-1 text-xs text-ink-dim">
                  Only if you already run Tailscale Funnel, a reverse proxy or a tunnel of your own
                  to this computer. Enter its address to keep the same link every time. Most people
                  leave this empty, and OwnBase{" "}
                  {status.publicAddressManaged
                    ? "uses the Cloudflare address set up for it"
                    : "gets a new address each time"}
                  .
                </p>
                <form
                  noValidate
                  className="mt-2 flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveAddress();
                  }}
                >
                  <input
                    ref={addressField}
                    id="public-address"
                    type="url"
                    inputMode="url"
                    spellCheck={false}
                    placeholder="https://box.tail1234.ts.net"
                    value={addressValue}
                    // Off only when the environment fixes it; read-only
                    // while saving, so focus stays here.
                    disabled={status.publicAddressLocked}
                    readOnly={busy === "address"}
                    aria-describedby={`public-address-help${addressError ? " public-address-error" : ""}`}
                    aria-invalid={!!addressError}
                    aria-errormessage={addressError ? "public-address-error" : undefined}
                    onChange={(event) => {
                      setAddressDraft(event.target.value);
                      setAddressError(null);
                      setAddressUnchanged(false);
                    }}
                    className={inputClass("small", "flex-1 font-mono disabled:opacity-40")}
                  />
                  {/* Never off for want of a change: sent unchanged, it says so. */}
                  <button
                    type="submit"
                    disabled={status.publicAddressLocked}
                    aria-disabled={!!busy || undefined}
                    className="h-8 shrink-0 rounded-lg border border-edge px-3 text-xs text-ink-dim hover:text-ink disabled:opacity-40"
                  >
                    {busy === "address" ? "Saving…" : "Save"}
                  </button>
                </form>
                {status.publicAddressLocked && (
                  <p className="mt-2 text-xs text-ink-dim">
                    An environment variable sets this address, so you cannot change it here.
                  </p>
                )}
                {addressError && (
                  <p id="public-address-error" role="alert" className="mt-2 text-xs text-alert">
                    {addressError}
                  </p>
                )}
                <p role="status" className="mt-2 text-xs text-ink-dim empty:hidden">
                  {addressUnchanged ? "That address is already saved." : ""}
                </p>
              </div>
            </>
          )}
        </div>
      )}
      {!status.isolated && <CallRelaySettings relay={props.hosting.relay} disabled={unavailable} />}
    </>
  );
}

const INSTALLED_WITH = { winget: "winget", homebrew: "Homebrew" } as const;

/**
 * Installs cloudflared for a public link with what this computer has, or by
 * downloading Cloudflare's own release, and shows how far it has got. The
 * install is the main process's, so a window opened again while it runs
 * shows it too.
 */
export function InstallCloudflared(props: {
  install: NonNullable<HostingStatus["cloudflaredInstall"]>;
  onInstall: () => Promise<void>;
  disabled: boolean;
}) {
  const [pressed, setPressed] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { via, received, total } = props.install;
  const installing = pressed || !!props.install.installing;
  const downloading = via === "download" && installing && total !== undefined;

  async function install() {
    if (installing || props.disabled) return;
    setPressed(true);
    setFailure(null);
    try {
      await props.onInstall();
    } catch (err) {
      setFailure(
        failureMessage(
          err,
          "cloudflared could not be installed. Install it yourself, then check again.",
        ),
      );
    } finally {
      setPressed(false);
    }
  }

  return (
    <>
      <p>
        A public link needs cloudflared, a free program from Cloudflare. This computer does not have
        it yet.
      </p>
      {/* Kept in place while it installs, so focus stays where it was. */}
      <button
        type="button"
        disabled={props.disabled && !installing}
        aria-disabled={installing || undefined}
        onClick={() => void install()}
        className={buttonClass("primary", "mt-3 w-full aria-disabled:opacity-60")}
      >
        {installing ? "Installing cloudflared…" : "Install cloudflared"}
      </button>
      <p role="status" className="mt-2">
        {!installing
          ? via === "download"
            ? "OwnBase downloads it from Cloudflare's page on GitHub and checks that it matches what Cloudflare published."
            : `OwnBase installs it with ${INSTALLED_WITH[via]}, which this computer already has.`
          : via === "download"
            ? "Downloading from Cloudflare…"
            : `Installing with ${INSTALLED_WITH[via]}. This can take a few minutes.`}
      </p>
      {/* Outside the status above, so a screen reader is not told every percent. */}
      {downloading && (
        <>
          <progress
            max={total}
            value={received ?? 0}
            aria-label="Downloading cloudflared"
            className="mt-2 h-1.5 w-full accent-[var(--color-copper)]"
          />
          <p className="mt-1 tabular-nums">
            {formatBytes(received ?? 0)} of {formatBytes(total)}
          </p>
        </>
      )}
      {failure && (
        <p role="alert" className="mt-2 text-alert">
          {failure}
        </p>
      )}
      <p className="mt-3">Or install it yourself, then press Check again.</p>
    </>
  );
}
