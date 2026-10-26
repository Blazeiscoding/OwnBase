import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { WorkspaceClient } from "@slackoss/client-core";
import type { Platform } from "../platform.js";
import {
  checkWorkspaceAddress,
  trustWorkspaceAddress,
  type WorkspaceAddressAccess,
} from "../lib/workspaceAddressTrust.js";
import { Dialog } from "./Dialog.js";
import { buttonClass } from "./Button.js";

interface Props {
  platform: Platform;
  client: WorkspaceClient;
  onLeaveWorkspace: () => void;
  onSignedOut: () => void;
  children: ReactNode;
  /** Shown across the top while it waits, as the workspace would in its banner place. */
  banner?: ReactNode;
  /** Shown under what it is waiting for, such as this computer's hosting. */
  footer?: ReactNode;
}

interface Scope {
  client: WorkspaceClient;
  workspaceId: string;
  userId: string;
}

interface CheckState {
  scope: Scope;
  phase: "checking" | "approval" | "saving" | "allowed" | "error";
  access?: WorkspaceAddressAccess;
  error?: string;
}

/** Keeps every local-work consumer unmounted until this address is approved. */
export function WorkspaceStorageGate({
  platform,
  client,
  onLeaveWorkspace,
  onSignedOut,
  children,
  banner,
  footer,
}: Props) {
  const userId = useStore(client.store, (state) => state.self?.id);
  const workspaceId = useStore(client.store, (state) => state.workspaceId);
  const status = useStore(client.store, (state) => state.status);
  const scope = useMemo<Scope | null>(
    () => (userId && workspaceId ? { client, workspaceId, userId } : null),
    [client, workspaceId, userId],
  );
  const [check, setCheck] = useState<CheckState | null>(null);
  const retry = useRef<(() => void) | null>(null);
  const approve = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (status === "auth_failed" || status === "password_change_required") onSignedOut();
  }, [status, onSignedOut]);

  useEffect(() => {
    if (!scope) return;
    let active = true;
    let busy = false;
    let access: WorkspaceAddressAccess | undefined;
    const run = (explicitApproval: boolean) => {
      if (busy) return;
      busy = true;
      setCheck({ scope, phase: explicitApproval ? "saving" : "checking", access });
      const operation = explicitApproval ? trustWorkspaceAddress : checkWorkspaceAddress;
      void operation(platform, scope.workspaceId, scope.userId, scope.client.baseUrl)
        .then((result) => {
          if (!active) return;
          access = result;
          setCheck({ scope, phase: result.allowed ? "allowed" : "approval", access });
        })
        .catch(() => {
          if (!active) return;
          retry.current = () => run(explicitApproval);
          setCheck({
            scope,
            phase: "error",
            access,
            error: explicitApproval
              ? "Could not save your address approval on this device. Retry to continue."
              : "Could not check saved workspace addresses on this device. Retry to continue.",
          });
        })
        .finally(() => {
          busy = false;
        });
    };
    const approveAddress = () => run(true);
    approve.current = approveAddress;
    retry.current = () => run(false);
    run(false);
    return () => {
      active = false;
      approve.current = null;
      retry.current = null;
    };
  }, [platform, scope]);

  const current = check?.scope === scope ? check : null;
  const signedOut = status === "auth_failed" || status === "password_change_required";
  if (!signedOut && userId && (!workspaceId || current?.phase === "allowed")) return children;

  const access = current?.access;
  const asking = current?.phase === "approval" || current?.phase === "saving";
  const waiting =
    status === "protocol_mismatch"
      ? "Server version incompatible. Update OwnBase to connect."
      : signedOut
        ? "Returning to sign in…"
        : userId
          ? "Checking saved workspace access…"
          : "Connecting to the workspace…";

  return (
    <div className="flex h-full flex-col bg-ground text-ink">
      {banner}
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        {asking && access ? (
          <Dialog title="Confirm workspace address" onClose={onLeaveWorkspace} width={520}>
            <div className="space-y-4 text-sm">
              <p>
                This address claims to be a workspace you have used before. Check that you recognize
                it before sharing work saved on this device.
              </p>
              <div className="space-y-3 rounded-lg border border-edge bg-ground p-3">
                <div>
                  <p className="mb-1 font-semibold">Previously trusted</p>
                  <ul className="max-h-32 space-y-1 overflow-y-auto text-ink-dim">
                    {access.addresses.map((address) => (
                      <li key={address} className="break-all font-mono text-xs">
                        {address}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="mb-1 font-semibold">Connecting to</p>
                  <p className="break-all font-mono text-xs">{access.address}</p>
                </div>
              </div>
              <p className="text-ink-dim">
                Continuing gives this address access to your saved drafts and recent searches.
                Queued messages may be sent automatically, and scheduling recovery becomes
                available.
              </p>
              <div className="flex flex-wrap justify-end gap-2 pt-1">
                <button type="button" className={buttonClass("quiet")} onClick={onLeaveWorkspace}>
                  Back to workspaces
                </button>
                <button
                  type="button"
                  className={buttonClass("primary")}
                  disabled={current?.phase === "saving"}
                  onClick={() => approve.current?.()}
                >
                  {current?.phase === "saving" ? "Saving approval…" : "Trust address and continue"}
                </button>
              </div>
            </div>
          </Dialog>
        ) : (
          <div className="max-w-md space-y-4 text-center">
            <p role={current?.phase === "error" ? "alert" : "status"}>
              {current?.error ?? waiting}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <button type="button" className={buttonClass("quiet")} onClick={onLeaveWorkspace}>
                Back to workspaces
              </button>
              {current?.phase === "error" && (
                <button
                  type="button"
                  className={buttonClass("primary")}
                  onClick={() => retry.current?.()}
                >
                  Retry
                </button>
              )}
            </div>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
