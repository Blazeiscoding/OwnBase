import { useEffect, useId, useRef, useState } from "react";
import { isEmailAddress } from "@ownbase/protocol";
import { ApiError } from "@ownbase/client-core";
import { useClient } from "../context.js";
import { failureText } from "../lib/failure.js";
import { buttonClass } from "./Button.js";
import { Swap } from "./Motion.js";
import { useToast } from "./Toast.js";

/**
 * Sends an invite's link by email (G10), in the invite dialog, where the
 * workspace sends email. The invite is the same one the link above holds.
 * Nothing shows where the workspace sends none.
 */
export function InviteByEmail({ code }: { code: string }) {
  const client = useClient();
  const toast = useToast();
  const id = useId();
  const [on, setOn] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void client.serverInfo().then((info) => {
      // One that fails leaves the link to copy; nothing here is urgent.
      if (alive.current && !(info instanceof ApiError)) setOn(!!info.email);
    });
    return () => {
      alive.current = false;
    };
  }, [client]);

  if (!on) return null;

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const typed = email.trim();
    if (!isEmailAddress(typed)) {
      setError("Enter an email address, such as maya@example.com.");
      field.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const failed = await client.admin.emailInvite(code, typed);
    if (!alive.current) return;
    setBusy(false);
    if (failed) {
      setError(
        failed.code === "invite_inactive"
          ? "That invite no longer works. Make a new link and send that."
          : failureText("The invite was not sent.", failed, "Try again."),
      );
      field.current?.focus();
      return;
    }
    setEmail("");
    toast({ message: `Invite sent to ${typed}.`, kind: "success" });
  }

  return (
    <form
      noValidate
      aria-label="Send the invite by email"
      onSubmit={(event) => void send(event)}
      className="border-t border-edge px-4 py-3"
    >
      <label htmlFor={`${id}-email`} className="mb-1.5 block text-[12px] text-ink-faint">
        Send the link by email
      </label>
      <div className="flex items-center gap-2">
        <input
          id={`${id}-email`}
          ref={field}
          type="email"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          maxLength={254}
          placeholder="name@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          readOnly={busy}
          className="h-8 min-w-0 flex-1 rounded-lg border border-edge bg-raised px-2.5 text-[13px] text-ink"
        />
        <button
          type="submit"
          aria-disabled={busy || undefined}
          className={buttonClass("secondary", "h-8 shrink-0 px-3 text-[13px]")}
        >
          <Swap text>{busy ? "Sending…" : "Send"}</Swap>
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-alert">
          {error}
        </p>
      )}
    </form>
  );
}
