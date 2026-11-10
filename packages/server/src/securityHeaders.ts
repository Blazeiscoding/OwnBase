/**
 * What a page served by this workspace is allowed to do.
 *
 * The client has no inline scripts, no `innerHTML`, and no `eval`, so
 * `script-src 'self'` costs nothing and is the directive that actually matters:
 * it means injected markup cannot become running code, which is the failure a
 * chat application is most exposed to, since its whole job is displaying text
 * other people wrote. `'wasm-unsafe-eval'` beside it lets the app compile
 * WebAssembly it ships (strong noise suppression for calls) and nothing else:
 * JavaScript `eval` and `new Function` stay refused.
 *
 * `connect-src` is deliberately open. The browser client is a static app that
 * can be pointed at any workspace — that is how someone signs in to a server
 * other than the one that served the page, and how one browser holds several
 * workspaces at once. Narrowing it would break that rather than protect
 * anything, since the client is supposed to talk to addresses this server has
 * never heard of.
 */
const DIRECTIVES: Record<string, string> = {
  "default-src": "'self'",
  "script-src": "'self' 'wasm-unsafe-eval'",
  // React sets styles through the DOM rather than as markup, which CSP does not
  // govern, but the bundler is free to emit a style element and this costs
  // little: style injection cannot execute anything.
  "style-src": "'self' 'unsafe-inline'",
  // Previews and avatars arrive as object URLs; icons are inlined by the build.
  "img-src": "'self' blob: data:",
  "media-src": "'self' blob:",
  "font-src": "'self' data:",
  "connect-src": "* blob: data: ws: wss:",
  "worker-src": "'self' blob:",
  "object-src": "'none'",
  "base-uri": "'self'",
  "form-action": "'self'",
  "frame-ancestors": "'none'",
};

export const CONTENT_SECURITY_POLICY = Object.entries(DIRECTIVES)
  .map(([name, value]) => `${name} ${value}`)
  .join("; ");

/**
 * The same policy for a page loaded from disk rather than over HTTP, which is
 * how the desktop app loads its client. A meta element cannot express
 * `frame-ancestors`, and browsers ignore it there rather than failing, so it is
 * left out instead of being written and quietly disregarded.
 */
export const CONTENT_SECURITY_POLICY_META = Object.entries(DIRECTIVES)
  .filter(([name]) => name !== "frame-ancestors")
  .map(([name, value]) => `${name} ${value}`)
  .join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  // This server puts tokens in URLs — a download ticket, a webhook, a
  // response_url. Sending no referrer means following a link off one of those
  // pages cannot hand the token to wherever it leads.
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  // frame-ancestors above says the same thing to anything current; this is for
  // what is not.
  "x-frame-options": "DENY",
};
