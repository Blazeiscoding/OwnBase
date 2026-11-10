import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Dialog } from "./Dialog.js";
import { buttonClass } from "./Button.js";

export interface ConfirmRequest {
  /** The question, as something a person can answer yes or no to. */
  title: string;
  /** What saying yes causes, where the question does not already say it. */
  body?: ReactNode;
  /** Names the action, so the button never reads "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Marks the action as one that takes something away, and starts on Cancel. */
  destructive?: boolean;
}

type Ask = (request: ConfirmRequest) => Promise<boolean>;

interface ConfirmService {
  ask: (owner: object, request: ConfirmRequest) => Promise<boolean>;
  cancel: (owner: object) => void;
}

const ConfirmContext = createContext<ConfirmService | null>(null);

/**
 * Ask before doing something that cannot be undone. Resolves true only when
 * the person chose the named action; closing, cancelling and Escape all
 * resolve false, so a caller can act on the answer and nothing else.
 */
export function useConfirm(): Ask {
  const service = useContext(ConfirmContext);
  const owner = useRef({});
  useEffect(() => () => service?.cancel(owner.current), [service]);
  const ask = useCallback<Ask>(
    (request) => {
      if (!service) throw new Error("ConfirmContext missing");
      return service.ask(owner.current, request);
    },
    [service],
  );
  if (!service) throw new Error("ConfirmContext missing");
  return ask;
}

interface Pending {
  id: number;
  owner: object;
  request: ConfirmRequest;
  resolve: (confirmed: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const latest = useRef<Pending | null>(null);
  const serial = useRef(0);

  const settle = useCallback((question: Pending, confirmed: boolean) => {
    // A stale click from a question replaced in the same turn cannot dismiss
    // the newer question.
    if (latest.current !== question) return;
    latest.current = null;
    setPending((shown) => (shown === question ? null : shown));
    question.resolve(confirmed);
  }, []);

  const ask = useCallback<ConfirmService["ask"]>(
    (owner, request) =>
      new Promise<boolean>((resolve) => {
        // Two questions cannot share one dialog. Resolve the older one as a
        // cancellation before replacing it, without nesting a state update in
        // another state updater.
        const earlier = latest.current;
        if (earlier) settle(earlier, false);
        const next = { id: ++serial.current, owner, request, resolve };
        latest.current = next;
        setPending(next);
      }),
    [settle],
  );

  const cancel = useCallback<ConfirmService["cancel"]>(
    (owner) => {
      const question = latest.current;
      if (question?.owner === owner) settle(question, false);
    },
    [settle],
  );
  const service = useMemo(() => ({ ask, cancel }), [ask, cancel]);

  useEffect(
    () => () => {
      // Unmounting takes the question off the screen. Leaving its caller
      // waiting forever would hold whatever it was guarding.
      const question = latest.current;
      latest.current = null;
      question?.resolve(false);
    },
    [],
  );

  return (
    <ConfirmContext.Provider value={service}>
      {children}
      {pending && (
        <ConfirmDialog
          key={pending.id}
          pending={pending}
          settle={(answer) => settle(pending, answer)}
        />
      )}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({
  pending,
  settle,
}: {
  pending: Pending;
  settle: (confirmed: boolean) => void;
}) {
  const { request } = pending;
  const { title, body, confirmLabel, cancelLabel = "Cancel", destructive } = request;
  const bodyId = useId();
  const describedBy = body ? bodyId : undefined;
  return (
    <Dialog title={title} onClose={() => settle(false)} width={400} describedBy={describedBy}>
      {body && (
        <div id={describedBy} className="mb-4 text-sm text-ink-dim">
          {body}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          // First in the DOM so a destructive action is not what focus lands
          // on, and so Tab reaches it before the button that cannot be undone.
          autoFocus={destructive}
          onClick={() => settle(false)}
          className={buttonClass("quiet")}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          autoFocus={!destructive}
          onClick={() => settle(true)}
          className={destructive ? buttonClass("danger") : buttonClass("primary")}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
