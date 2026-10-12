import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { FileMeta, ID } from "@slackoss/protocol";
import { ApiError, type LocalAttachment } from "@slackoss/client-core";
import { useClient, usePlatform } from "../context.js";
import { formatBytes } from "../lib/format.js";
import { Icon, type IconName } from "./Icon.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { Modal } from "./Modal.js";

/** Largest an inline image is drawn at; the real file opens in the lightbox. */
const MAX_W = 380;
const MAX_H = 300;
const NATIVE_DOWNLOAD_BYTES = 8 * 1024 * 1024;

function fitted(width: number | null, height: number | null) {
  if (!width || !height) return { width: MAX_W, height: 220 };
  const scale = Math.min(MAX_W / width, MAX_H / height, 1);
  return {
    width: Math.max(44, Math.round(width * scale)),
    height: Math.max(44, Math.round(height * scale)),
  };
}

export function MessageAttachments({
  files,
  onOpenImage,
}: {
  files: FileMeta[];
  onOpenImage: (file: FileMeta) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {files.map((f) =>
        f.mime.startsWith("image/") && f.size < NATIVE_DOWNLOAD_BYTES ? (
          <ImageAttachment key={f.id} file={f} onOpen={() => onOpenImage(f)} />
        ) : (
          <FileCard key={f.id} file={f} />
        ),
      )}
    </div>
  );
}

function ImageAttachment({ file, onOpen }: { file: FileMeta; onOpen: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = container.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { rootMargin: "160px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    // A flex item will not shrink below its content by default, so without
    // min-w-0 a preview wider than a phone's column would run off its edge.
    <div ref={container} className="flex min-w-0 max-w-full">
      <ImagePreview file={file} onOpen={onOpen} visible={visible} />
    </div>
  );
}

function ImagePreview({
  file,
  onOpen,
  visible,
}: {
  file: FileMeta;
  onOpen: () => void;
  visible: boolean;
}) {
  const { url, error, retry } = useFileResource(file.id, visible);
  const [decodeFailed, setDecodeFailed] = useState(false);
  useEffect(() => setDecodeFailed(false), [url, file.id]);
  const box = fitted(file.width, file.height);
  if (error || decodeFailed)
    return (
      <div
        className="rounded-xl border border-edge bg-lifted p-3 text-sm"
        style={{ maxWidth: MAX_W }}
      >
        <p className="break-all font-medium">{file.name}</p>
        <p role="status" className="my-2 text-ink-dim">
          {error ?? "This image cannot be previewed."}
        </p>
        {error ? (
          <button
            onClick={retry}
            className="font-medium text-ink underline decoration-ink-faint/60 hover:decoration-ink"
          >
            Retry image
          </button>
        ) : (
          <button
            onClick={onOpen}
            className="font-medium text-ink underline decoration-ink-faint/60 hover:decoration-ink"
          >
            Open file options
          </button>
        )}
      </div>
    );
  return (
    <button
      onClick={onOpen}
      aria-label={`Open image ${file.name}`}
      title={file.name}
      // Size is reserved from the stored dimensions, so nothing jumps on load.
      // The ratio, not a fixed height, keeps that reservation right when a
      // narrow column scales the preview down.
      style={{ width: box.width, maxWidth: "100%", aspectRatio: `${box.width} / ${box.height}` }}
      className="group/img relative overflow-hidden rounded-xl border border-edge bg-lifted transition-colors hover:border-ink-faint/40"
    >
      {url ? (
        <img
          src={url}
          alt={file.name}
          decoding="async"
          onError={() => setDecodeFailed(true)}
          className="size-full object-contain transition-transform duration-200 group-hover/img:scale-[1.02]"
        />
      ) : (
        <span className="flex size-full items-center justify-center font-mono text-[11px] text-ink-faint">
          {visible ? "loading…" : "Image preview"}
        </span>
      )}
    </button>
  );
}

function FileCard({ file }: { file: FileMeta }) {
  const client = useClient();
  const platform = usePlatform();
  const native = file.size >= NATIVE_DOWNLOAD_BYTES;
  const [handedOff, setHandedOff] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<object | null>(null);
  useEffect(() => {
    const current = {};
    lifetime.current = current;
    client.files.retain(file.id);
    return () => {
      if (lifetime.current === current) lifetime.current = null;
      client.files.release(file.id);
    };
  }, [client, file.id]);

  // Sandboxed viewers block <a download>, so fetch the bytes and save via a click we own.
  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    setHandedOff(false);
    const current = lifetime.current;
    try {
      if (native) {
        const url = await client.api.downloadUrl(file.id);
        if (!current || lifetime.current !== current) return;
        if (!platform.downloadFile) throw new ApiError(409, "download_upgrade_required");
        await platform.downloadFile(url);
        if (lifetime.current === current) setHandedOff(true);
        return;
      }
      const url = await client.files.get(file.id);
      if (current && lifetime.current === current) saveUrl(url, file.name);
    } catch (err) {
      setError(fileError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <button
        onClick={save}
        disabled={saving}
        aria-label={`${error ? "Retry download" : "Download"} ${file.name}`}
        className="flex items-center gap-2.5 rounded-xl border border-edge bg-raised px-3 py-2.5 text-left transition-colors hover:border-ink-faint/40"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-lifted text-copper">
          <Icon name={iconFor(file.mime, file.name)} size={18} />
        </span>
        <span className="min-w-0">
          <span className="block max-w-[220px] truncate text-sm font-medium">{file.name}</span>
          <span className="block font-mono text-[11px] text-ink-faint">
            {saving
              ? native
                ? "Preparing download…"
                : "Downloading…"
              : error
                ? "Retry download"
                : formatBytes(file.size)}
          </span>
        </span>
      </button>
      {error && (
        <p role="alert" className="mt-1 max-w-[300px] text-sm text-alert">
          {error}
        </p>
      )}
      {handedOff && (
        <p role="status" className="mt-1 max-w-[300px] text-xs text-ink-dim">
          Download handed to your browser or device. Check its downloads or save dialog; click again
          if it did not start.
        </p>
      )}
    </div>
  );
}

/** A file's kind as an icon, for one without a picture to show. */
export function iconFor(mime: string, name: string): IconName {
  if (mime.startsWith("video/")) return "film";
  if (mime.startsWith("audio/")) return "music";
  if (mime === "application/pdf") return "fileText";
  if (/zip|tar|gzip|compressed/.test(mime)) return "fileArchive";
  if (/\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|json|yml|yaml|sh)$/i.test(name)) return "fileCode";
  if (mime.startsWith("text/")) return "fileText";
  return "file";
}

export function saveUrl(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}

const UNAVAILABLE = "File unavailable or you no longer have access.";

function fileError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "download_upgrade_required")
      return "Update the workspace server and app to download large files.";
    if (err.status === 401) return "Sign in again to download this file.";
    if (err.status === 403 || err.status === 404) return UNAVAILABLE;
  }
  if (err instanceof DOMException && err.name === "TimeoutError")
    return "The download timed out. Try again.";
  if (err instanceof DOMException && err.name === "AbortError")
    return "Download stopped. Try again if you still have access.";
  return "Could not download this file. Check your connection and try again.";
}

/** An explicit recoverable state, scoped to the current workspace and file. */
export function useFileResource(fileId: ID, enabled = true) {
  const client = useClient();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState(() => ({
    client,
    fileId,
    url: client.files.peek(fileId) ?? null,
    error: null as string | null,
  }));

  useEffect(() => {
    if (!enabled) return;
    client.files.retain(fileId);
    let active = true;
    setState({ client, fileId, url: client.files.peek(fileId) ?? null, error: null });
    client.files
      .get(fileId)
      .then((u) => {
        if (active) setState({ client, fileId, url: u, error: null });
      })
      .catch((err) => {
        if (active) setState({ client, fileId, url: null, error: fileError(err) });
      });
    // Taken away: deleted, no longer readable, or only perhaps so (a file
    // whose conversation was not known goes with any lost access). An open
    // preview stops showing it and asks the server again, which answers
    // with the file, or with why it is unavailable (F07).
    const stop = client.files.onInvalidate((gone) => {
      if (!active || gone !== fileId) return;
      setState({ client, fileId, url: null, error: null });
      setAttempt((n) => n + 1);
    });
    return () => {
      active = false;
      stop();
      client.files.release(fileId);
    };
  }, [client, fileId, attempt, enabled]);

  const current = enabled && state.client === client && state.fileId === fileId;
  return {
    // An idle URL may have been evicted while this preview was off screen.
    url: current && state.url === client.files.peek(fileId) ? state.url : null,
    error: current ? state.error : null,
    retry: () => setAttempt((n) => n + 1),
  };
}

/** Attachments on a message that hasn't reached the server yet. */
export function PendingAttachments({
  attachments,
  progress,
}: {
  attachments: LocalAttachment[];
  progress: number | null;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {attachments.map((a, i) => (
        <div
          key={i}
          className="relative overflow-hidden rounded-xl border border-edge bg-lifted"
          style={{ width: a.previewUrl ? 200 : undefined }}
        >
          {a.previewUrl ? (
            <img
              src={a.previewUrl}
              alt={a.name}
              className="block max-h-[160px] w-full object-cover"
            />
          ) : (
            <div className="px-3 py-2.5">
              <div className="max-w-[200px] truncate text-sm">{a.name}</div>
              <div className="font-mono text-[11px] text-ink-faint">{formatBytes(a.size)}</div>
            </div>
          )}
          {progress !== null && progress < 1 && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-ground/70">
              <div
                className="h-full bg-copper transition-[width] duration-150"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const LightboxView = lazy(() =>
  import("./Lightbox.js").then((module) => ({ default: module.LightboxView })),
);

/**
 * Full-size image viewer. Opening a picture is now and then, so the viewer
 * loads on first use; the moment that takes shows nothing new.
 */
export function Lightbox(props: { file: FileMeta; onClose: () => void }) {
  return (
    <ErrorBoundary
      fallback={
        <Modal title={`Image ${props.file.name}`} onClose={props.onClose}>
          <p role="alert" className="text-sm text-ink-dim">
            The image viewer could not load. Reload the app to try again.
          </p>
        </Modal>
      }
    >
      <Suspense fallback={null}>
        <LightboxView {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
