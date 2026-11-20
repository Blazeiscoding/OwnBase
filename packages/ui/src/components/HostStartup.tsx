import { useEffect, useState } from "react";
import { failureMessage } from "../platform.js";
import { linkBtnCls, type Hosting } from "./hostParts.js";

/**
 * Whether the running workspace starts when OwnBase opens, and whether the
 * OS opens OwnBase when someone signs in. With both on, a workspace comes
 * back by itself after the computer restarts.
 */
export function StartWithComputer(props: {
  hosting: Hosting;
  folder: string;
  name: string;
  startsOnLaunch: boolean;
  /** The stable public address set up for hosting, if there is one. */
  publicAddress?: string;
  /** It is reopened when this workspace starts with OwnBase. */
  reopensPublic: boolean;
  disabled: boolean;
  /** What went wrong saving a choice, or null to clear it. */
  onError: (text: string | null) => void;
}) {
  const setStart = props.hosting.setStartOnLaunch;
  const login = props.hosting.openAtLogin;
  const reopen = props.hosting.setReopenPublicOnLaunch;
  const [atLogin, setAtLogin] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  /** The choice just made, shown until the status agrees or saving fails. */
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [reopenChosen, setReopenChosen] = useState<boolean | null>(null);
  useEffect(() => {
    if (chosen !== null && chosen === props.startsOnLaunch) setChosen(null);
  }, [chosen, props.startsOnLaunch]);
  useEffect(() => {
    if (reopenChosen !== null && reopenChosen === props.reopensPublic) setReopenChosen(null);
  }, [reopenChosen, props.reopensPublic]);
  useEffect(() => {
    if (!login) return;
    let alive = true;
    login.get().then(
      (value) => {
        if (alive) setAtLogin(value);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [login]);
  async function save(action: () => Promise<unknown>, undo: () => void) {
    setSaving(true);
    props.onError(null);
    try {
      await action();
    } catch (reason) {
      undo();
      props.onError(failureMessage(reason, "That choice could not be saved. Try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <fieldset className="space-y-2" disabled={props.disabled || saving}>
      <legend className="mb-1 text-ink-dim">When this computer starts</legend>
      <label className="flex items-start gap-2 text-ink">
        <input
          type="checkbox"
          className="mt-1"
          checked={chosen ?? props.startsOnLaunch}
          onChange={(event) => {
            const start = event.target.checked;
            setChosen(start);
            void save(
              () => setStart(start ? props.folder : null),
              () => setChosen(null),
            );
          }}
        />
        <span>Start hosting {props.name} when OwnBase opens</span>
      </label>
      {login && atLogin !== null && (
        <label className="flex items-start gap-2 text-ink">
          <input
            type="checkbox"
            className="mt-1"
            checked={atLogin}
            onChange={(event) => {
              const open = event.target.checked;
              setAtLogin(open);
              void save(
                async () => setAtLogin(await login.set(open)),
                () => setAtLogin(!open),
              );
            }}
          />
          <span>Open OwnBase when you sign in to this computer</span>
        </label>
      )}
      {props.publicAddress && (
        <label className="flex items-start gap-2 text-ink">
          <input
            type="checkbox"
            className="mt-1"
            checked={reopenChosen ?? props.reopensPublic}
            disabled={!(chosen ?? props.startsOnLaunch)}
            onChange={(event) => {
              const next = event.target.checked;
              setReopenChosen(next);
              void save(
                () => reopen(next),
                () => setReopenChosen(null),
              );
            }}
          />
          <span>
            Also reopen the public link at {props.publicAddress} when {props.name} starts. New
            accounts will need an invite.
          </span>
        </label>
      )}
      <p className="text-xs text-ink-faint">
        {atLogin === null
          ? `${props.name} starts whenever OwnBase opens.`
          : `With both on, ${props.name} comes back by itself after this computer restarts, as soon as you sign in. OwnBase waits in the tray.`}
      </p>
    </fieldset>
  );
}

/**
 * The same choices while nothing is running, so a workspace that fails to
 * start with OwnBase can be taken off it, and OwnBase off sign-in,
 * without having to start it first. Nothing here removes it from the list.
 */
export function StartupWhileStopped(props: {
  hosting: Hosting;
  /** The workspace chosen to start with OwnBase, if it is listed. */
  chosen: { folder: string; name: string } | null;
  /** Why starting with OwnBase did not happen, if it did not. */
  launchError: string | undefined;
  disabled: boolean;
  onChanged: () => void;
  onError: (text: string | null) => void;
}) {
  const setStart = props.hosting.setStartOnLaunch;
  const login = props.hosting.openAtLogin;
  const [atLogin, setAtLogin] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!login) return;
    let alive = true;
    login.get().then(
      (value) => {
        if (alive) setAtLogin(value);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [login]);
  if (!props.chosen && !props.launchError && !atLogin) return null;

  async function save(action: () => Promise<unknown>) {
    setSaving(true);
    props.onError(null);
    try {
      await action();
      props.onChanged();
    } catch (reason) {
      props.onError(failureMessage(reason, "That choice could not be saved. Try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="When this computer starts" className="mb-5 space-y-2 text-sm">
      <h3 className="text-[13px] font-semibold text-ink">When this computer starts</h3>
      {props.chosen ? (
        <p className="text-ink-dim">
          {props.chosen.name} starts hosting when OwnBase opens.{" "}
          <button
            type="button"
            disabled={props.disabled || saving}
            className={linkBtnCls}
            onClick={() => void save(() => setStart(null))}
          >
            Don’t start {props.chosen.name} with OwnBase
          </button>
        </p>
      ) : (
        props.launchError && (
          <p className="text-ink-dim">
            <button
              type="button"
              disabled={props.disabled || saving}
              className={linkBtnCls}
              onClick={() => void save(() => setStart(null))}
            >
              Start nothing when OwnBase opens
            </button>
          </p>
        )
      )}
      {login && atLogin !== null && (
        <label className="flex items-start gap-2 text-ink">
          <input
            type="checkbox"
            className="mt-1"
            checked={atLogin}
            disabled={props.disabled || saving}
            onChange={(event) => {
              const open = event.target.checked;
              setAtLogin(open);
              void save(async () => {
                try {
                  setAtLogin(await login.set(open));
                } catch (reason) {
                  setAtLogin(!open);
                  throw reason;
                }
              });
            }}
          />
          <span>Open OwnBase when you sign in to this computer</span>
        </label>
      )}
    </section>
  );
}
