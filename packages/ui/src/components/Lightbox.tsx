import { useEffect, useState } from "react";
import type { FileMeta } from "@ownbase/protocol";
import { formatBytes } from "../lib/format.js";
import { saveUrl } from "../lib/download.js";
import { useFileResource } from "./Attachments.js";
import { Icon } from "./Icon.js";
import { Modal } from "./Modal.js";

const STEP =
  "grid size-10 shrink-0 place-items-center rounded-full border border-edge bg-black/40 text-ink-dim transition-colors hover:border-ink-faint/50 hover:text-ink";

/**
 * Full-size image viewer. Esc or a click outside closes it. Opened from a
 * message with more than one picture, it steps through them with the arrows
 * either side or the Left and Right keys, as Slack and Discord do.
 */
export function LightboxView({
  file: opened,
  gallery,
  onClose,
}: {
  file: FileMeta;
  gallery?: FileMeta[];
  onClose: () => void;
}) {
  const pictures = gallery?.some((f) => f.id === opened.id) ? gallery : [opened];
  const [at, setAt] = useState(() => pictures.findIndex((f) => f.id === opened.id));
  const file = pictures[at] ?? opened;
  const { url, error, retry } = useFileResource(file.id);
  const [decodeFailed, setDecodeFailed] = useState(false);
  useEffect(() => setDecodeFailed(false), [url, file.id]);
  const several = pictures.length > 1;
  // Round from the last to the first, so neither arrow ever goes dead under focus.
  const count = pictures.length;
  const step = (by: number) => setAt((i) => (i + by + count) % count);
  // Left and Right from wherever focus is in the viewer, Save and Close included.
  useEffect(() => {
    if (!several) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      setAt((i) => (i + (e.key === "ArrowLeft" ? -1 : 1) + count) % count);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [several, count]);

  return (
    <Modal
      title={several ? `Image ${file.name}, ${at + 1} of ${pictures.length}` : `Image ${file.name}`}
      onClose={onClose}
      backdropClassName="flex animate-fade-in items-center justify-center bg-black/85 p-8"
      className="flex max-h-full max-w-full animate-pop-in flex-col items-center gap-3 outline-none"
    >
      <div className="flex max-w-full items-center gap-3">
        {several && (
          <button
            type="button"
            aria-label="Previous image"
            onClick={() => step(-1)}
            className={STEP}
          >
            <Icon name="chevronLeft" size={20} />
          </button>
        )}
        <div className="flex min-w-0 flex-col items-center">
          {error && (
            <div role="alert" className="text-center text-ink">
              <p>{error}</p>
              <button
                onClick={retry}
                className="mt-2 font-medium text-ink underline decoration-ink-faint/60 hover:decoration-ink"
              >
                Retry image
              </button>
            </div>
          )}
          {!url && !error && (
            <p role="status" className="text-ink">
              Loading image…
            </p>
          )}
          {decodeFailed && (
            <p role="status" className="text-ink">
              This image cannot be previewed. You can still save the original file.
            </p>
          )}
          {url && !decodeFailed && (
            <img
              key={file.id}
              src={url}
              alt={file.name}
              onError={() => setDecodeFailed(true)}
              className="max-h-[80vh] max-w-full animate-reveal rounded-lg object-contain shadow-2xl"
            />
          )}
        </div>
        {several && (
          <button type="button" aria-label="Next image" onClick={() => step(1)} className={STEP}>
            <Icon name="chevronRight" size={20} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-3 text-sm text-ink-dim">
        {several && (
          <span className="shrink-0 tabular-nums text-ink-faint">
            {at + 1} of {pictures.length}
          </span>
        )}
        <span className="max-w-[420px] truncate">{file.name}</span>
        <span className="font-mono text-[11px] text-ink-faint">{formatBytes(file.size)}</span>
        <button
          disabled={!url}
          onClick={() => {
            if (url) saveUrl(url, file.name);
          }}
          className="rounded-lg border border-edge px-3 py-1 transition-colors hover:border-ink-faint/50 hover:text-ink"
        >
          Save
        </button>
        <button
          onClick={onClose}
          className="rounded-lg border border-edge px-3 py-1 transition-colors hover:border-ink-faint/50 hover:text-ink"
        >
          Close
        </button>
      </div>
    </Modal>
  );
}
