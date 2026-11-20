import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ServerInfo } from "@ownbase/protocol";
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
import { connectionFailure, incompatibleWorkspace } from "../lib/connection.js";
import { normalizeServerUrlSafe } from "../lib/deeplinkHelpers.js";
import type { SignedOutFrom } from "../lib/signOut.js";
import { BrowseCard, type Notice } from "./JoinBrowse.js";
import { AuthCard, endedNote, type Connected } from "./JoinSignIn.js";

export type { Connected } from "./JoinSignIn.js";

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
