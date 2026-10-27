import { useEffect, useRef, useState } from "react";
import type { CallLogEntry, ServerInfo, WorkspaceStatus } from "@ownbase/protocol";
import { ApiError } from "@ownbase/client-core";
import { useClient, usePlatform, useWorkspace } from "../context.js";
import { CALL_LOG_HEADING, diagnosticsFileName, diagnosticsReport } from "../lib/diagnostics.js";
import { useCopy } from "../lib/useCopy.js";
import { Dialog } from "./Dialog.js";
import { Swap } from "./Motion.js";
import { buttonClass } from "./Button.js";

type Failed = { error: string };
const failure = (err: unknown): Failed => ({
  error: err instanceof Error ? err.message : "no answer",
});

/** Why the server's status could not be read, in words for the report. */
function statusFailure(err: unknown): Failed {
  if (err instanceof ApiError && err.status === 404)
    return { error: "this server's version does not report it" };
  if (err instanceof ApiError && err.status === 403)
    return { error: "only the owner and admins can read it" };
  return failure(err);
}

/**
 * Hands the report to the browser or desktop app as a text file. Nothing is
 * sent anywhere; where it goes from the downloads folder is up to the person.
 */
function saveReport(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Long enough for the download to have read it, in every browser.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * What to send whoever helps when something is wrong. It shows the whole
 * report before anything is copied or saved, and the report holds versions, the
 * connection and the device, never what anybody wrote. For the owner and
 * admins it also says how the server is keeping up (OPS-10): sizes, queues
 * and timings, never what is in them.
 */
export function DiagnosticsDialog({
  onClose,
  showCallLog,
}: {
  onClose: () => void;
  /** Opened to see why a call will not connect: start at the call log. */
  showCallLog?: boolean;
}) {
  const client = useClient();
  const platform = usePlatform();
  const admin = useWorkspace((s) => s.self?.role === "owner" || s.self?.role === "admin");
  const [report, setReport] = useState<{ text: string; taken: Date } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const { copy, label } = useCopy(2500);
  const callLogStart = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (showCallLog && report) callLogStart.current?.scrollIntoView?.({ block: "start" });
  }, [showCallLog, report]);

  // One snapshot, taken when the server answers or fails to: what is shown is
  // exactly what is copied, however long the dialog stays open.
  useEffect(() => {
    let alive = true;
    const take = (
      server: ServerInfo | Failed,
      workspace?: WorkspaceStatus | Failed,
      calls?: { entries: CallLogEntry[] } | Failed,
    ) => {
      const { status, huddle, pending, users, channels } = client.state;
      const taken = new Date();
      setReport({
        taken,
        text: diagnosticsReport({
          app: platform.kind,
          address: client.baseUrl,
          status,
          server,
          huddle,
          waitingToSend: pending.length,
          userAgent: navigator.userAgent,
          online: navigator.onLine,
          width: window.innerWidth,
          height: window.innerHeight,
          pixelRatio: window.devicePixelRatio,
          notifications:
            platform.kind === "desktop"
              ? "shown by the app"
              : typeof Notification === "undefined"
                ? "not supported"
                : Notification.permission,
          workspace,
          callLog: client.callLog(),
          calls: calls && "entries" in calls ? calls.entries : calls,
          // Handles, which say who is who in a call without a full name.
          names: {
            person: (id) => (users[id] ? `@${users[id].handle}` : id),
            conversation: (id) => {
              const channel = channels[id];
              return channel?.name ? `#${channel.name}` : "a direct message";
            },
          },
          now: taken,
        }),
      });
    };
    void Promise.all([
      client.api.serverInfo().catch(failure),
      admin ? client.api.workspaceStatus().catch(statusFailure) : undefined,
      admin ? client.api.callLog().catch(statusFailure) : undefined,
    ]).then(([server, workspace, calls]) => alive && take(server, workspace, calls));
    return () => {
      alive = false;
    };
  }, [client, platform, admin]);

  return (
    <Dialog title="Diagnostics" onClose={onClose} width={560}>
      <p className="text-sm text-ink-dim">
        Send this to whoever is helping you. It says which versions are running and how this device
        is connected
        {admin ? ", and how the server is keeping up: sizes, queues and timings" : ""}. A call log
        says each step of the last huddle
        {admin ? ", and the server's says what happened in huddles lately" : ""}, by username and
        kind of network route. It never includes messages, files or network addresses.
      </p>
      {report ? (
        <pre
          aria-label="Diagnostics report"
          tabIndex={0}
          className="mt-3 max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-edge bg-ground p-3 font-mono text-xs text-ink-dim"
        >
          {splitAt(report.text, CALL_LOG_HEADING).map((part, i) =>
            i === 1 ? (
              <span key={i} ref={callLogStart}>
                {part}
              </span>
            ) : (
              part
            ),
          )}
        </pre>
      ) : (
        <p role="status" className="mt-3 text-sm text-ink-faint">
          {admin ? "Asking the server how it is doing…" : "Asking the server for its version…"}
        </p>
      )}
      {saved && (
        <p role="status" className="mt-3 text-xs text-ink-dim">
          Handed to your browser or device as {saved}. Check its downloads or save dialog.
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button
          className={buttonClass("secondary")}
          disabled={!report}
          onClick={() => {
            if (!report) return;
            const name = diagnosticsFileName(report.taken);
            saveReport(report.text, name);
            setSaved(name);
          }}
        >
          Save as file
        </button>
        <button
          className={buttonClass("primary")}
          disabled={!report}
          onClick={() => report && void copy(report.text)}
        >
          <Swap text>
            {label("Copy diagnostics", "Copied", "Could not copy. Select the text instead")}
          </Swap>
        </button>
      </div>
    </Dialog>
  );
}

/** The text before `marker` and from it on; the whole text where it is absent. */
function splitAt(text: string, marker: string): string[] {
  const at = text.indexOf(marker);
  return at < 0 ? [text] : [text.slice(0, at), text.slice(at)];
}
