import { useEffect, useMemo, useState } from "react";
import { Api } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import type { Platform } from "../platform.js";

/**
 * Workspace icons, as the client shows them (UX-60).
 *
 * The page's content security policy lets images come only from this page's
 * own server, `blob:` and `data:`, and the desktop app and a browser signed
 * in elsewhere show icons from other servers. So an icon is fetched, which
 * the policy allows anywhere, and shown as an object URL, as attachments are.
 */

/** Icons fetched this session, by server and version, oldest first. */
const loaded = new Map<string, Promise<string | null>>();
/** Object URLs kept at once; an older one is let go when another arrives. */
const KEEP = 24;

function iconUrl(baseUrl: string, version: string): Promise<string | null> {
  const key = `${baseUrl}\n${version}`;
  const known = loaded.get(key);
  if (known) {
    loaded.delete(key);
    loaded.set(key, known);
    return known;
  }
  const request = new Api(baseUrl)
    .workspaceIcon(version)
    .then((blob) => URL.createObjectURL(blob))
    // A workspace whose icon cannot be fetched shows its coloured square,
    // and asks again the next time it is shown.
    .catch(() => {
      loaded.delete(key);
      return null;
    });
  loaded.set(key, request);
  while (loaded.size > KEEP) {
    const [oldest, url] = loaded.entries().next().value!;
    loaded.delete(oldest);
    void url.then((value) => value && URL.revokeObjectURL(value));
  }
  return request;
}

/**
 * The address to show the icon of the workspace at `baseUrl` from, once
 * fetched: null while it loads, when there is none (`version` null or
 * absent), and when it could not be fetched.
 */
export function useWorkspaceIconUrl(
  baseUrl: string | null | undefined,
  version: string | null | undefined,
): string | null {
  const [shown, setShown] = useState<{ key: string; url: string | null } | null>(null);
  const key = baseUrl && version ? `${baseUrl}\n${version}` : null;
  useEffect(() => {
    if (!baseUrl || !version) return;
    let current = true;
    void iconUrl(baseUrl, version).then((url) => {
      if (current) setShown({ key: `${baseUrl}\n${version}`, url });
    });
    return () => {
      current = false;
    };
  }, [baseUrl, version]);
  return key && shown?.key === key ? shown.url : null;
}

/** The icon of the workspace on screen, or null while there is none to show. */
export function useCurrentWorkspaceIcon(): string | null {
  const client = useClient();
  const version = useWorkspace((s) => (s.workspaceIcon ? s.iconVersion : null));
  return useWorkspaceIconUrl(client.baseUrl, version);
}

// ---------- kept on this device, for saved workspaces ----------

/**
 * Where this device keeps a small copy of a saved workspace's icon, so the
 * list of saved workspaces shows it when that workspace's server is off.
 */
export function cachedIconKey(url: string): string {
  return `workspace-icon:${url}`;
}

/** A kept copy: which version of the icon it is, and the picture as a data URL. */
interface CachedIcon {
  version: 1;
  iconVersion: string;
  image: string;
}

/** How many pixels square a kept copy is: the rail's 48, twice over for sharp screens. */
const CACHED_SIDE = 96;
/** The most a kept copy may take, since the desktop app writes its settings whole. */
const CACHED_MAX_CHARS = 48 * 1024;

function parseCached(value: unknown): CachedIcon | null {
  if (!value || typeof value !== "object") return null;
  const { version, iconVersion, image } = value as Record<string, unknown>;
  if (version !== 1 || typeof iconVersion !== "string" || typeof image !== "string") return null;
  // Only a picture this device made itself: never markup, never somewhere else.
  if (!/^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(image)) return null;
  if (image.length > CACHED_MAX_CHARS) return null;
  return { version, iconVersion, image };
}

/** Whoever shows kept icons, told when one changes. */
const cacheListeners = new Set<() => void>();
function cacheChanged() {
  for (const listener of [...cacheListeners]) listener();
}

/**
 * Draws the middle square of `image` at `side` pixels a side, as the upload
 * and the kept copy both do. Null where there is no canvas to draw on.
 */
export function squareCanvas(
  image: CanvasImageSource & { width: number; height: number },
  side: number,
): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const edge = Math.min(image.width, image.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    (image.width - edge) / 2,
    (image.height - edge) / 2,
    edge,
    edge,
    0,
    0,
    side,
    side,
  );
  return canvas;
}

/** A small copy of the picture at `url`, as a data URL, or null when it cannot be made. */
async function smallCopy(url: string): Promise<string | null> {
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = squareCanvas(image, CACHED_SIDE);
    // WebP where the browser can write it; a browser that cannot gives PNG.
    const data = canvas?.toDataURL("image/webp", 0.9) ?? null;
    return data && parseCached({ version: 1, iconVersion: "-", image: data }) ? data : null;
  } catch {
    return null;
  }
}

/** Forgets the kept copy of a saved workspace's icon, as when its sign-in is forgotten. */
export async function forgetCachedIcon(platform: Platform, url: string): Promise<void> {
  await platform.storage.set(cachedIconKey(url), null).catch(() => {});
  cacheChanged();
}

/**
 * Keeps a small copy of the icon of the workspace on screen on this device,
 * whenever it has one that is not kept yet, and forgets it when the
 * workspace has none, so the saved workspaces show it while it is offline.
 * Nothing is kept or forgotten for a server that keeps no icons.
 */
export function useRememberWorkspaceIcon(platform: Platform): void {
  const client = useClient();
  const capable = useWorkspace((s) => s.workspaceIcon);
  const version = useWorkspace((s) => s.iconVersion);
  const shown = useCurrentWorkspaceIcon();
  const baseUrl = client.baseUrl;
  useEffect(() => {
    if (!capable) return;
    if (version && !shown) return;
    let current = true;
    const key = cachedIconKey(baseUrl);
    void (async () => {
      const kept = parseCached(await platform.storage.get<unknown>(key).catch(() => null));
      if (!current) return;
      if (!version || !shown) {
        if (kept) await forgetCachedIcon(platform, baseUrl);
        return;
      }
      if (kept?.iconVersion === version) return;
      const image = await smallCopy(shown);
      if (!current || !image) return;
      const entry: CachedIcon = { version: 1, iconVersion: version, image };
      await platform.storage.set(key, entry).catch(() => {});
      cacheChanged();
    })();
    return () => {
      current = false;
    };
  }, [platform, baseUrl, capable, version, shown]);
}

/**
 * The kept icons of these saved workspaces, by address, read from this
 * device and again whenever one is kept or forgotten. Missing for a
 * workspace with none kept, which shows its coloured square.
 */
export function useCachedWorkspaceIcons(
  platform: Platform,
  urls: readonly string[],
): Record<string, string> {
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [revision, setRevision] = useState(0);
  const joined = urls.join("\n");
  const wanted = useMemo(() => (joined ? joined.split("\n") : []), [joined]);
  useEffect(() => {
    const listener = () => setRevision((n) => n + 1);
    cacheListeners.add(listener);
    return () => void cacheListeners.delete(listener);
  }, []);
  useEffect(() => {
    let current = true;
    void Promise.all(
      wanted.map(async (url) => {
        const kept = parseCached(
          await platform.storage.get<unknown>(cachedIconKey(url)).catch(() => null),
        );
        return [url, kept?.image] as const;
      }),
    ).then((entries) => {
      if (!current) return;
      const next: Record<string, string> = {};
      for (const [url, image] of entries) if (image) next[url] = image;
      setIcons(next);
    });
    return () => {
      current = false;
    };
  }, [platform, wanted, revision]);
  return icons;
}

// ---------- hosted on this computer ----------

/** Icons read from workspaces hosted here, by folder and version. */
const hosted = new Map<string, Promise<string | null>>();

/**
 * The icon of a workspace hosted on this computer, read from its own
 * database through the desktop app, running or not: a stopped one is not
 * started to show it. `version` null means it has none; undefined means not
 * known, which reads it once for this view.
 */
export function useHostedIcon(
  hosting: Platform["hosting"],
  folder: string | null | undefined,
  version: string | null | undefined,
): string | null {
  const read = hosting?.icon;
  const [shown, setShown] = useState<{ key: string; url: string | null } | null>(null);
  const key = read && folder && version !== null ? `${folder}\n${version ?? ""}` : null;
  useEffect(() => {
    if (!read || !folder || version === null) return;
    const id = `${folder}\n${version ?? ""}`;
    let request = version ? hosted.get(id) : undefined;
    if (!request) {
      request = read(folder)
        // Only a picture of a type an icon may be, as the server checked it.
        .then((url) => (url && /^data:image\/(png|jpeg|webp);base64,/.test(url) ? url : null))
        .catch(() => null)
        .then((url) => {
          // One that could not be read is read again next time.
          if (!url) hosted.delete(id);
          return url;
        });
      if (version) {
        hosted.set(id, request);
        if (hosted.size > KEEP) hosted.delete(hosted.keys().next().value!);
      }
    }
    let current = true;
    void request.then((url) => {
      if (current) setShown({ key: id, url });
    });
    return () => {
      current = false;
    };
  }, [read, folder, version]);
  return key && shown?.key === key ? shown.url : null;
}
