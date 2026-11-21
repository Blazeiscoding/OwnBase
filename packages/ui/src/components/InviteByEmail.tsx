import { useEffect, useRef, useState } from "react";
import { EMAIL_MAX, isEmailAddress } from "@ownbase/protocol";
import { ApiError } from "@ownbase/client-core";
import { useClient } from "../context.js";
import { failureText } from "../lib/failure.js";
import { buttonClass } from "./Button.js";
import { Swap } from "./Motion.js";
import { TextField } from "./TextField.js";
import { useToast } from "./Toast.js";

/**
 * Sends an invite by email (G10), in the invite dialog, where the workspace
 * sends email. Each address gets an invite of its own that works once, for
 * 7 days, rather than the link above, which may let in any number of people.
 * Nothing shows where the workspace sends none.
 */
export function InviteByEmail({ onSent }: { onSent: () => void }) {
  const client = useClient();
  const toast = useToast();
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
    const failed = await client.admin.emailInvite(typed);
    if (!alive.current) return;
    setBusy(false);
    if (failed) {
      setError(
        failed.code === "mail_failed"
          ? "The invite was not sent. The workspace's mail server did not take it. Copy the link above and send it another way, or try again later."
          : failureText("The invite was not sent.", failed, "Try again."),
      );
      field.current?.focus();
      return;
    }
    setEmail("");
    toast({ message: `Invite sent to ${typed}.`, kind: "success" });
    onSent();
  }

  return (
    <form
      noValidate
      aria-label="Send the invite by email"
      onSubmit={(event) => void send(event)}
      className="flex items-start gap-2 border-t border-edge px-4 py-3"
    >
      <TextField
        ref={field}
        size="small"
        className="min-w-0 flex-1"
        label="Send an invite by email"
        hint="Each one works once, for 7 days."
        type="email"
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="none"
        maxLength={EMAIL_MAX}
        placeholder="name@example.com"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        readOnly={busy}
        error={error ?? undefined}
      />
      {/* Level with the field, under its label. */}
      <button
        type="submit"
        aria-disabled={busy || undefined}
        className={buttonClass("secondary", "mt-5 h-8 shrink-0 px-3 text-[13px]")}
      >
        <Swap text>{busy ? "Sending…" : "Send invite"}</Swap>
      </button>
    </form>
  );
}
