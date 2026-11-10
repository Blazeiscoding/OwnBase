import { relative, resolve, sep } from "node:path";

/**
 * How the browser client's files are cached (REV-13). The build names every
 * file under `assets/` after a hash of its content, so a new build is a new
 * name: a browser keeps those for a year without asking again. Anything else,
 * the page above all, names the current build's files, so a browser asks
 * about it every time and is answered 304 while it has not changed.
 */
export const ASSETS_DIR = "assets";
export const HASHED_ASSET_CACHE = "public, max-age=31536000, immutable";
export const REVALIDATED_CACHE = "no-cache";

export function webCacheControl(root: string, file: string): string {
  const [top, ...rest] = relative(resolve(root), resolve(file)).split(sep);
  return top === ASSETS_DIR && rest.length > 0 ? HASHED_ASSET_CACHE : REVALIDATED_CACHE;
}

/**
 * Whether a request no file answered was for one of the build's files rather
 * than a page. Those get a 404, not the page: a chunk from a build that has
 * since been replaced would otherwise arrive as HTML and fail as a script.
 */
export function isMissingAsset(url: string): boolean {
  return url.startsWith(`/${ASSETS_DIR}/`);
}
