/** Hands what `url` holds to the browser or desktop app as a download named `name`. */
export function saveUrl(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}

/** Hands `text` to the browser or desktop app as a text file; nothing is sent anywhere. */
export function saveText(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  saveUrl(url, name);
  // Long enough for the download to have read it, in every browser.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
