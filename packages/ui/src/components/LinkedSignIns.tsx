import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { SignInConnection, SignInMethod } from "@ownbase/protocol";
import { ApiError } from "@ownbase/client-core";
import { useClient, useWorkspace } from "../context.js";
import { buttonClass } from "./Button.js";

/** A path on the workspace's own server, with a query of plain values: nothing else is opened. */
const LINK = /^\/api\/[A-Za-z0-9/_-]+(\?[A-Za-z0-9=&_-]*)?$/;

/**
 * The workspace's single sign-on in Account settings, under Security (P9):
 * whether this account is linked to its provider, Link to sign in there in
 * a browser, and Unlink. Accounts have no email address to match on, so
 * linking is how an account that exists signs in that way. Nothing shows
 * where the workspace has no single sign-on, or for a guest.
 */
export function LinkedSignIns() {
  const client = useClient();
  const self = useWorkspace((s) => s.self);
  const id = useId();
  const [methods, setMethods] = useState<SignInMethod[]>([]);
  const [links, setLinks] = useState<Record<string, SignInConnection>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Linking was opened in a browser; what it says is asked again on coming back. */
  const [away, setAway] = useState(false);
  const alive = useRef(true);
  const owned = !!self && self.role !== "guest";

  const load = useCallback(async () => {
    try {
      const info = await client.api.serverInfo();
      const linkable = (info.signIn?.methods ?? []).filter((m) => m.connect);
      const states = await Promise.all(
        linkable.map(async (m) => [m.id, await client.api.signInConnection(m.connect!)] as const),
      );
      if (!alive.current) return;
      setMethods(linkable);
      setLinks(Object.fromEntries(states));
    } catch {
      // Asked again next time Account settings opens; nothing here is urgent.
    }
  }, [client]);
  useEffect(() => {
    alive.current = true;
    if (owned) void load();
    return () => {
      alive.current = false;
    };
  }, [load, owned]);
  useEffect(() => {
    if (!away) return;
    const again = () => void load();
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [away, load]);

  if (!owned || methods.length === 0) return null;

  async function link(method: SignInMethod) {
    setBusy(true);
    setError(null);
    try {
      const { url } = await client.api.connectSignIn(method.connect!);
      // In a new tab, or the system's browser in the desktop app: this window stays signed in.
      if (!LINK.test(url)) throw new ApiError(502, "invalid_response");
      window.open(`${client.api.baseUrl}${url}`, "_blank", "noopener");
      if (alive.current) setAway(true);
    } catch (err) {
      if (alive.current) setError(problem(err, "Linking did not start."));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function unlink(method: SignInMethod) {
    setBusy(true);
    setError(null);
    try {
      const now = await client.api.disconnectSignIn(method.connect!);
      if (alive.current) setLinks((current) => ({ ...current, [method.id]: now }));
    } catch (err) {
      if (alive.current) setError(problem(err, "It is still linked."));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="mt-6 border-t border-edge pt-5">
      <h3 id={`${id}-title`} className="font-semibold">
        Single sign-on
      </h3>
      {methods.map((method) => {
        const linked = links[method.id];
        return (
          <div key={method.id}>
            <p className="mt-1 text-sm text-ink-dim">
              {linked?.connected
                ? `Linked. You can sign in with ${method.name}${linked.as ? ` as ${linked.as}` : ""}.`
                : `Link your ${method.name} account to sign in to this workspace with it.`}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {linked?.connected ? (
                <button
                  type="button"
                  className={buttonClass("secondary")}
                  disabled={busy}
                  onClick={() => void unlink(method)}
                >
                  Unlink
                </button>
              ) : (
                <button
                  type="button"
                  className={buttonClass("primary")}
                  disabled={busy}
                  onClick={() => void link(method)}
                >
                  Link {method.name}
                </button>
              )}
            </div>
          </div>
        );
      })}
      {away && !error && !methods.every((m) => links[m.id]?.connected) && (
        <p role="status" className="mt-3 text-sm text-ink-dim">
          Finish in the browser that opened, then come back here.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-alert">
          {error}
        </p>
      )}
    </section>
  );
}

function problem(err: unknown, what: string): string {
  if (err instanceof ApiError && err.message && err.message !== err.code) return err.message;
  return `${what} Check your connection and try again.`;
}
