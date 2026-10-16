import { useEffect, useState } from "react";
import type { CallRelayDraft, CallRelaySetting, Platform } from "../platform.js";
import { probeRelay } from "../lib/relayProbe.js";
import { inputCls } from "./TextField.js";
import { buttonClass } from "./Button.js";

type RelayApi = NonNullable<NonNullable<Platform["hosting"]>["relay"]>;
type Kind = CallRelayDraft["kind"];

const KINDS: { kind: Kind; label: string }[] = [
  { kind: "none", label: "No relay" },
  { kind: "cloudflare", label: "Cloudflare" },
  { kind: "custom", label: "Another TURN server" },
];

const fieldCls = `${inputCls} py-1.5 font-mono text-xs`;
const labelCls = "block text-xs font-medium text-ink-dim";
const SAVED = "Saved. Leave empty to keep it.";

const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/**
 * The TURN relay for calls between networks that will not let people reach
 * each other directly, kept for every workspace hosted on this computer.
 * Cloudflare's asks for passwords that expire; any other is used as typed.
 */
export function CallRelaySettings(props: { relay: RelayApi; disabled?: boolean }) {
  const [saved, setSaved] = useState<CallRelaySetting | null>(null);
  const [kind, setKind] = useState<Kind>("none");
  const [keyId, setKeyId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [urls, setUrls] = useState("");
  const [username, setUsername] = useState("");
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState<"saving" | "testing" | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const show = (setting: CallRelaySetting) => {
    setSaved(setting);
    setKind(setting.kind);
    setKeyId(setting.kind === "cloudflare" ? setting.keyId : "");
    setUrls(setting.kind === "custom" ? setting.urls.join("\n") : "");
    setUsername(setting.kind === "custom" ? setting.username : "");
    setApiToken("");
    setCredential("");
  };

  useEffect(() => {
    let live = true;
    props.relay
      .get()
      .then((setting) => live && show(setting))
      // Still offer to set one; saving says whether it can be kept.
      .catch((reason: unknown) => live && show({ kind: "none", error: errorText(reason) }));
    return () => {
      live = false;
    };
    // The relay API is the platform's, fixed for the window's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const draft = (): CallRelayDraft =>
    kind === "cloudflare"
      ? { kind, keyId, ...(apiToken.trim() ? { apiToken } : {}) }
      : kind === "custom"
        ? {
            kind,
            urls: urls.split(/\s+/).filter(Boolean),
            username,
            ...(credential.trim() ? { credential } : {}),
          }
        : { kind };
  // A secret already saved for this key or username can be left empty.
  const tokenSaved = saved?.kind === "cloudflare" && saved.keyId === keyId.trim();
  const credentialSaved = saved?.kind === "custom" && saved.username === username.trim();
  const changed =
    !saved ||
    kind !== saved.kind ||
    !!apiToken.trim() ||
    !!credential.trim() ||
    (saved.kind === "cloudflare" && keyId.trim() !== saved.keyId) ||
    (saved.kind === "custom" &&
      (username.trim() !== saved.username ||
        urls.split(/\s+/).filter(Boolean).join("\n") !== saved.urls.join("\n")));

  const save = async () => {
    setBusy("saving");
    setNote(null);
    try {
      const next = await props.relay.set(draft());
      show(next);
      setNote({
        ok: true,
        text:
          next.kind === "none"
            ? "Saved. Calls between networks that block a direct route will not connect."
            : "Saved. Calls that start from now on can use it.",
      });
    } catch (reason) {
      setNote({ ok: false, text: errorText(reason) });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("testing");
    setNote(null);
    try {
      const result = await probeRelay(await props.relay.test(draft()));
      setNote(
        result === "works"
          ? { ok: true, text: "The relay works: this computer reached it and got a route." }
          : result === "refused"
            ? { ok: false, text: "The relay refused the username or password." }
            : {
                ok: false,
                text: "This computer could not reach the relay. Check its address, and that its ports are open.",
              },
      );
    } catch (reason) {
      setNote({ ok: false, text: errorText(reason) });
    } finally {
      setBusy(null);
    }
  };

  const off = props.disabled || !!busy || saved === null;
  return (
    <section aria-labelledby="call-relay-title" className="card-warm mt-3 rounded-xl p-3">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 id="call-relay-title" className="font-semibold text-ink">
          Calls from other networks
        </h3>
        {saved && saved.kind !== "none" && (
          <span className="rounded-full bg-copper/15 px-2 py-0.5 text-xs text-copper">
            Relay on
          </span>
        )}
      </div>
      <p className="text-xs text-ink-dim">
        Calls go straight between people. Some networks, like mobile data, do not allow that, so a
        call from one never gets past Connecting. A TURN relay carries those calls instead.
      </p>
      {saved?.error && (
        <p role="alert" className="mt-2 text-xs text-alert">
          {saved.error}
        </p>
      )}
      <fieldset className="mt-3" disabled={off}>
        <legend className="sr-only">Relay</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {KINDS.map((option) => (
            <label key={option.kind} className="flex items-center gap-2 text-xs text-ink">
              <input
                type="radio"
                name="call-relay"
                value={option.kind}
                checked={kind === option.kind}
                onChange={() => {
                  setKind(option.kind);
                  setNote(null);
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
        {kind === "cloudflare" && (
          <div className="mt-3 space-y-2">
            <div>
              <label htmlFor="relay-key-id" className={labelCls}>
                TURN key ID
              </label>
              <input
                id="relay-key-id"
                spellCheck={false}
                autoComplete="off"
                value={keyId}
                onChange={(event) => setKeyId(event.target.value)}
                className={`mt-1 ${fieldCls}`}
              />
            </div>
            <div>
              <label htmlFor="relay-api-token" className={labelCls}>
                API token
              </label>
              <input
                id="relay-api-token"
                type="password"
                autoComplete="off"
                placeholder={tokenSaved ? SAVED : undefined}
                value={apiToken}
                onChange={(event) => setApiToken(event.target.value)}
                className={`mt-1 ${fieldCls}`}
              />
            </div>
            <p className="text-xs text-ink-dim">
              Create a TURN key in your Cloudflare dashboard, under Realtime, and copy its ID and
              API token.{" "}
              <a
                href="https://developers.cloudflare.com/realtime/turn/"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-ink-faint/60 underline-offset-2 hover:text-ink"
              >
                How Cloudflare's relay works
              </a>
              . The token stays on this computer; each call is given a password that lasts a day.
            </p>
          </div>
        )}
        {kind === "custom" && (
          <div className="mt-3 space-y-2">
            <div>
              <label htmlFor="relay-urls" className={labelCls}>
                Addresses, one per line
              </label>
              <textarea
                id="relay-urls"
                rows={2}
                spellCheck={false}
                placeholder={"turn:relay.example.org:3478\nturns:relay.example.org:5349"}
                value={urls}
                onChange={(event) => setUrls(event.target.value)}
                className={`mt-1 resize-y ${fieldCls}`}
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label htmlFor="relay-username" className={labelCls}>
                  Username
                </label>
                <input
                  id="relay-username"
                  spellCheck={false}
                  autoComplete="off"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  className={`mt-1 ${fieldCls}`}
                />
              </div>
              <div>
                <label htmlFor="relay-credential" className={labelCls}>
                  Password
                </label>
                <input
                  id="relay-credential"
                  type="password"
                  autoComplete="off"
                  placeholder={credentialSaved ? SAVED : undefined}
                  value={credential}
                  onChange={(event) => setCredential(event.target.value)}
                  className={`mt-1 ${fieldCls}`}
                />
              </div>
            </div>
            <p className="text-xs text-ink-dim">
              Everyone in a call is given this username and password, so use ones made for the
              relay.
            </p>
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={!changed}
            onClick={() => void save()}
            className={buttonClass("secondary", "h-8 text-xs")}
          >
            {busy === "saving" ? "Saving…" : "Save"}
          </button>
          {kind !== "none" && (
            <button
              type="button"
              onClick={() => void test()}
              className={buttonClass("quiet", "h-8 text-xs")}
            >
              {busy === "testing" ? "Testing…" : "Test"}
            </button>
          )}
        </div>
      </fieldset>
      <p
        role="status"
        aria-live="polite"
        className={`mt-2 text-xs ${note && !note.ok ? "text-alert" : "text-ink-dim"}`}
      >
        {note?.text}
      </p>
    </section>
  );
}
