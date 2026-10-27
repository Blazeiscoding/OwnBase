import { useEffect, useState } from "react";
import type { FileMeta } from "@ownbase/protocol";
import { formatBytes } from "../lib/format.js";
import { saveUrl, useFileResource } from "./Attachments.js";
import { Modal } from "./Modal.js";

/** Full-size image viewer. Esc or a click outside closes it. */
export function LightboxView({ file, onClose }: { file: FileMeta; onClose: () => void }) {
  const { url, error, retry } = useFileResource(file.id);
  const [decodeFailed, setDecodeFailed] = useState(false);
  useEffect(() => setDecodeFailed(false), [url, file.id]);

  return (
    <Modal
      title={`Image ${file.name}`}
      onClose={onClose}
      backdropClassName="flex animate-fade-in items-center justify-center bg-black/85 p-8"
      className="flex max-h-full max-w-full animate-pop-in flex-col items-center gap-3 outline-none"
    >
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
          src={url}
          alt={file.name}
          onError={() => setDecodeFailed(true)}
          className="max-h-[80vh] max-w-full animate-reveal rounded-lg object-contain shadow-2xl"
        />
      )}
      <div className="flex items-center gap-3 text-sm text-ink-dim">
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
