// The apps build this package with Vite, which turns these imports into a
// file's address (`?url`) or its bytes as a data URL (`?inline`).
declare module "*?url" {
  const url: string;
  export default url;
}

// A file's address even when it is small enough that Vite would make it a
// data URL, which the desktop app's content security policy does not load.
declare module "*?url&no-inline" {
  const url: string;
  export default url;
}

declare module "*?inline" {
  const dataUrl: string;
  export default dataUrl;
}
