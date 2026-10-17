import { useEffect, useId, useRef, useState } from "react";
import type { CallRelayDraft, CallRelaySetting, Platform } from "../platform.js";
import { probeRelay } from "../lib/relayProbe.js";
import { inputClass, TextField } from "./TextField.js";
import { buttonClass } from "./Button.js";
import { Icon } from "./Icon.js";

type RelayApi = NonNullable<NonNullable<Platform["hosting"]>["relay"]>;
type Kind = CallRelayDraft["kind"];
/** The fields a relay is described by, each of which can be what is wrong. */
type Field = "keyId" | "apiToken" | "urls" | "username" | "credential";
type Problems = Partial<Record<Field, string>>;

const KINDS: { kind: Kind; label: string }[] = [
  { kind: "none", label: "No relay" },
  { kind: "cloudflare", label: "Cloudflare" },
  { kind: "custom", label: "Another TURN server" },
];

/** Each kind's fields, in the order they are shown, so the first with a problem gets focus. */
const FIELDS: Record<Kind, Field[]> = {
  none: [],
  cloudflare: ["keyId", "apiToken"],
  custom: ["urls", "username", "credential"],
};

/**
 * Which field a refusal from the app is about, by its words. The app checks
 * what the card checks, so these come from a relay the card could not judge,
 * such as Cloudflare refusing the token; the rest are about no one field.
 */
const REFUSALS: [RegExp, Field][] = [
  [/TURN key ID|TURN key with that ID/, "keyId"],
  [/API token/, "apiToken"],
  [/relay address|relay's address/, "urls"],
  [/relay's username/, "username"],
  [/relay's password/, "credential"],
];

const SAVED = "Saved. Leave empty to keep it.";
/** What a key, username or secret may not hold, as the app checks it. */
const SPACE = /[\s\p{Cc}]/u;

const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/**
 * The TURN relay for calls between networks that will not let people reach
 * each other directly, kept for every workspace hosted on this computer.
 * Cloudflare's asks for passwords that expire; any other is used as typed.
 * Save and Test always answer: what is missing or wrong is said under its
 * field before anything is sent, and saving what is already saved saves it
 * again, which hands it to running workspaces afresh.
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
  /** What is wrong with each field, said under it once Save or Test is pressed. */
  const [problems, setProblems] = useState<Problems>({});
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const fields = useRef<Partial<Record<Field, HTMLInputElement | HTMLTextAreaElement | null>>>({});
  const urlsId = useId();

  const show = (setting: CallRelaySetting) => {
    setSaved(setting);
    setKind(setting.kind);
    setKeyId(setting.kind === "cloudflare" ? setting.keyId : "");
    setUrls(setting.kind === "custom" ? setting.urls.join("\n") : "");
    setUsername(setting.kind === "custom" ? setting.username : "");
    setApiToken("");
    setCredential("");
    setProblems({});
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

  const addresses = () => urls.split(/\s+/).filter(Boolean);
  const draft = (): CallRelayDraft =>
    kind === "cloudflare"
      ? { kind, keyId, ...(apiToken.trim() ? { apiToken } : {}) }
      : kind === "custom"
        ? {
            kind,
            urls: addresses(),
            username,
            ...(credential.trim() ? { credential } : {}),
          }
        : { kind };
  // A secret already saved for this key or username can be left empty.
  const tokenSaved = saved?.kind === "cloudflare" && saved.keyId === keyId.trim();
  const credentialSaved = saved?.kind === "custom" && saved.username === username.trim();

  /** The app's own rules for a relay, checked here so each can be said beside its field. */
  const check = (): Problems => {
    if (kind === "cloudflare") {
      const id = keyId.trim();
      const token = apiToken.trim();
      return {
        keyId: !id
          ? "Enter the TURN key ID."
          : !/^[A-Za-z0-9_-]{1,128}$/.test(id)
            ? "A TURN key ID has only letters, digits, hyphens and underscores."
            : undefined,
        apiToken: !token
          ? tokenSaved
            ? undefined
            : "Enter the TURN key's API token."
          : SPACE.test(token)
            ? "An API token has no spaces."
            : undefined,
      };
    }
    if (kind === "custom") {
      const listed = addresses();
      const user = username.trim();
      const password = credential.trim();
      return {
        urls:
          listed.length === 0
            ? "Enter the relay's address."
            : listed.some((url) => !/^turns?:/.test(url))
              ? "A relay address starts with turn: or turns:, like turn:relay.example.org:3478."
              : listed.length > 8
                ? "Enter at most eight relay addresses."
                : undefined,
        username: !user
          ? "Enter the relay's username."
          : SPACE.test(user)
            ? "A username has no spaces."
            : undefined,
        credential: !password
          ? credentialSaved
            ? undefined
            : "Enter the relay's password."
          : SPACE.test(password)
            ? "A password has no spaces."
            : undefined,
      };
    }
    return {};
  };

  /** Says what is missing or wrong under each field and goes to the first; true when nothing is. */
  const ready = (): boolean => {
    const found = check();
    setProblems(found);
    const first = FIELDS[kind].find((name) => found[name]);
    if (!first) return true;
    fields.current[first]?.focus();
    return false;
  };

  /** A refusal goes under the field it is about, or under the buttons when it is about none. */
  const refused = (reason: unknown) => {
    const text = errorText(reason);
    const about = REFUSALS.find(
      ([words, name]) => words.test(text) && FIELDS[kind].includes(name),
    )?.[1];
    if (about) {
      setProblems({ [about]: text });
      fields.current[about]?.focus();
    } else setNote({ ok: false, text });
  };

  const save = async () => {
    if (busy) return;
    setNote(null);
    if (!ready()) return;
    setBusy("saving");
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
      refused(reason);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (busy) return;
    setNote(null);
    if (!ready()) return;
    setBusy("testing");
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
      refused(reason);
    } finally {
      setBusy(null);
    }
  };

  /** What each text field shares: its value, its problem, and where focus goes back to. */
  const field = (name: Field, value: string, set: (value: string) => void) => ({
    ref: (element: HTMLInputElement | null) => {
      fields.current[name] = element;
    },
    value,
    error: problems[name],
    // Read-only rather than disabled while it saves, so focus stays where it is.
    readOnly: !!busy,
    spellCheck: false,
    autoComplete: "off" as const,
    inputClassName: "font-mono",
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      set(event.target.value);
      setProblems((found) => ({ ...found, [name]: undefined }));
    },
  });

  const urlsProblem = problems.urls;
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
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {/* Off only while the saved relay is read, or while hosting is busy with something else. */}
        <fieldset className="mt-3" disabled={props.disabled || saved === null}>
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
                    if (busy) return;
                    setKind(option.kind);
                    setProblems({});
                    setNote(null);
                  }}
                />
                {option.label}
              </label>
            ))}
          </div>
          {kind === "cloudflare" && (
            <div className="mt-3 space-y-3">
              <TextField label="TURN key ID" {...field("keyId", keyId, setKeyId)} />
              <TextField
                label="API token"
                type="password"
                placeholder={tokenSaved ? SAVED : undefined}
                {...field("apiToken", apiToken, setApiToken)}
              />
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
            <div className="mt-3 space-y-3">
              {/* A TextField's parts, drawn by hand around a textarea. */}
              <div>
                <label
                  htmlFor={urlsId}
                  className="mb-1.5 block text-[13px] font-medium text-ink-dim"
                >
                  Addresses, one per line
                </label>
                <textarea
                  id={urlsId}
                  ref={(element) => {
                    fields.current.urls = element;
                  }}
                  rows={2}
                  spellCheck={false}
                  placeholder={"turn:relay.example.org:3478\nturns:relay.example.org:5349"}
                  value={urls}
                  readOnly={!!busy}
                  aria-invalid={!!urlsProblem || undefined}
                  aria-describedby={urlsProblem ? `${urlsId}-error` : undefined}
                  onChange={(event) => {
                    setUrls(event.target.value);
                    setProblems((found) => ({ ...found, urls: undefined }));
                  }}
                  className={inputClass("regular", "resize-y font-mono")}
                />
                {urlsProblem && (
                  <p
                    id={`${urlsId}-error`}
                    role="alert"
                    className="mt-1.5 flex items-start gap-1 text-[12px] text-alert"
                  >
                    <Icon name="alert" size={13} className="mt-px" />
                    <span>{urlsProblem}</span>
                  </p>
                )}
              </div>
              <div className="grid items-start gap-3 sm:grid-cols-2">
                <TextField label="Username" {...field("username", username, setUsername)} />
                <TextField
                  label="Password"
                  type="password"
                  placeholder={credentialSaved ? SAVED : undefined}
                  {...field("credential", credential, setCredential)}
                />
              </div>
              <p className="text-xs text-ink-dim">
                Everyone in a call is given this username and password, so use ones made for the
                relay.
              </p>
            </div>
          )}
          <div className="mt-3 flex gap-2">
            {/* Never off for want of a change: saving the same relay hands it out again. */}
            <button
              type="submit"
              aria-disabled={busy !== null || undefined}
              className={buttonClass("secondary", "h-8 text-xs")}
            >
              {busy === "saving" ? "Saving…" : "Save"}
            </button>
            {kind !== "none" && (
              <button
                type="button"
                aria-disabled={busy !== null || undefined}
                onClick={() => void test()}
                className={buttonClass("quiet", "h-8 text-xs")}
              >
                {busy === "testing" ? "Testing…" : "Test"}
              </button>
            )}
          </div>
        </fieldset>
      </form>
      <p role="status" className="mt-2 text-xs text-ink-dim empty:hidden">
        {note?.ok ? note.text : ""}
      </p>
      {note && !note.ok && (
        <p role="alert" className="mt-2 text-xs text-alert">
          {note.text}
        </p>
      )}
    </section>
  );
}
