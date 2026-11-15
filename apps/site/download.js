// Offers the download that fits the visitor's system: the installer on
// Windows, the server on Linux, and on a Mac or a phone, what they can use
// instead. The files come from Cloudflare (dl.ownbase.site), several times
// faster than GitHub's servers in some places, and from the latest GitHub
// release only when dl.ownbase.site cannot be read. Without this script every
// button goes to GitHub's release page; when nothing has been released yet,
// the page says so.

(() => {
  const REPO = "Blazeiscoding/OwnBase";
  const SOURCE = `https://github.com/${REPO}#try-it`;
  const KEY = "ownbase:release";
  // The release workflow copies each published release's files here, then
  // writes latest.json naming them, last, so it never names a missing file.
  const MIRROR = "https://dl.ownbase.site/latest.json";

  /** windows, mac, linux, phone or other. */
  function system() {
    const ua = navigator.userAgent;
    const platform = (navigator.userAgentData?.platform || navigator.platform || "").toLowerCase();
    if (/Android|iPhone|iPad|iPod/i.test(ua)) return "phone";
    // iPadOS asks for desktop pages and calls itself a Mac, but it has a touchscreen.
    if (platform === "macintel" && navigator.maxTouchPoints > 1) return "phone";
    if (/CrOS/.test(ua) || platform.includes("chrome os") || platform.includes("chromium os")) {
      return "other";
    }
    if (platform.startsWith("win") || /Windows/.test(ua)) return "windows";
    if (platform.startsWith("mac") || /Mac OS X/.test(ua)) return "mac";
    if (platform.includes("linux") || /Linux|X11/.test(ua)) return "linux";
    return "other";
  }

  // GitHub's answer is kept a while, since it allows each address 60 asks an
  // hour, but not for the whole visit. Only GitHub's: dl.ownbase.site is asked
  // on every page (the browser keeps latest.json for a minute), so the page
  // goes back to it as soon as it answers again.
  const KEEP_MS = 10 * 60 * 1000;
  const remember = (value) => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), value }));
    } catch {
      // Storage can be off; the next page asks GitHub again.
    }
  };
  const remembered = () => {
    try {
      const kept = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
      return kept && Date.now() - kept.at < KEEP_MS ? kept.value : null;
    } catch {
      return null;
    }
  };

  // Which file of a release each row offers, by the name GitHub gives it.
  const PATTERNS = {
    windows: /Setup.*\.exe$/i,
    mac: /-universal\.dmg$/i,
    server: /^ownbase-server-.*\.tar\.gz$/i,
  };
  const versionOf = (tag) => String(tag ?? "").replace(/^v/, "");

  /** A fetch that gives up after a few seconds. */
  async function ask(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The release on dl.ownbase.site, or null when it cannot be read. Each
   * release from main is copied there before latest.json names it, so it can
   * trail GitHub by the minute or two the copy takes, offering the release
   * before, but never a file that is missing.
   */
  async function fromMirror() {
    try {
      const res = await ask(MIRROR);
      if (!res.ok) return null;
      const { tag, files } = await res.json();
      if (typeof tag !== "string" || !files || typeof files !== "object") return null;
      const pick = (pattern) => {
        const name = Object.keys(files).find((n) => pattern.test(n));
        const file = name ? files[name] : null;
        return file && /^https:\/\/dl\.ownbase\.site\//.test(file.url) && file.size > 0
          ? { url: file.url, size: file.size }
          : null;
      };
      const release = { version: versionOf(tag) };
      for (const [row, pattern] of Object.entries(PATTERNS)) release[row] = pick(pattern);
      return release.windows || release.mac || release.server ? release : null;
    } catch {
      return null;
    }
  }

  /**
   * The newest published release's files, `{ none: true }` when there is no
   * release, or null when neither dl.ownbase.site nor GitHub answered.
   */
  async function latestRelease() {
    const copied = await fromMirror();
    if (copied) return copied;
    const known = remembered();
    if (known) return known;
    return fromGitHub();
  }

  /**
   * GitHub's newest release. Releases from main, alphas included
   * (v0.2.0-alpha.30), are normal releases, so the newest that is not a
   * pre-release wins: a pre-release can only be a draft published by hand.
   * Releases before mid-November 2026 were all pre-releases, which is why the
   * list is read, with the newest of anything as the fallback.
   */
  async function fromGitHub() {
    try {
      const res = await ask(`https://api.github.com/repos/${REPO}/releases?per_page=20`, {
        headers: { Accept: "application/vnd.github+json" },
      });
      // Rate limited or down: the GitHub links stay.
      if (!res.ok) return null;
      const list = await res.json();
      // GitHub does not list them newest first (beta.9 came before beta.10),
      // so they are put in the order they were published.
      const when = (r) => Date.parse(r.published_at ?? r.created_at ?? "") || 0;
      const published = Array.isArray(list)
        ? list.filter((r) => !r.draft).sort((a, b) => when(b) - when(a))
        : [];
      const data = published.find((r) => !r.prerelease) ?? published[0];
      if (!data) {
        remember({ none: true });
        return { none: true };
      }
      const pick = (pattern) => {
        const asset = (data.assets ?? []).find((a) => pattern.test(a.name));
        return asset ? { url: asset.browser_download_url, size: asset.size } : null;
      };
      const release = { version: versionOf(data.tag_name) };
      for (const [row, pattern] of Object.entries(PATTERNS)) release[row] = pick(pattern);
      remember(release);
      return release;
    } catch {
      return null;
    }
  }

  // A no-break space, so "119" and "MB" never land on separate lines.
  const megabytes = (bytes) => `${Math.max(1, Math.round(bytes / 1e6))}\u00a0MB`;

  /** Text, with an optional link at the end, into a note element. */
  function say(el, text, link) {
    el.textContent = text;
    if (link) {
      el.append(" ");
      const a = document.createElement("a");
      a.href = link.href;
      a.textContent = link.text;
      el.append(a);
    }
    el.hidden = false;
  }

  const os = system();
  const row = {
    windows: "windows",
    linux: "server",
    mac: "mac",
    phone: "browser",
    other: "browser",
  }[os];
  const yours = document.querySelector(`[data-platform="${row}"]`);
  if (yours) {
    yours.classList.add("is-yours");
    yours.querySelector(".yours")?.removeAttribute("hidden");
  }

  const gets = [...document.querySelectorAll("[data-get]")];
  const note = document.querySelector("[data-get-note]");
  const others = { href: "#download", text: "Other systems" };

  // What a phone can do never depends on a release.
  if ((os === "phone" || os === "other") && note) {
    say(note, "Nothing to install here. Open your team's invite link.");
  }

  // Each file a release offers, the row it belongs to, and what its button
  // says when there is no release to take it from.
  const FILES = {
    windows: { source: "No installer is published yet. pnpm build:win makes one." },
    mac: { source: "No disk image is published yet. pnpm build:mac makes one." },
    server: { source: "No release is published yet. pnpm build makes the server." },
  };
  // What this system's main buttons offer, out of a release, and the short
  // note beside them. The Download section says the rest.
  const OFFERS = {
    windows: {
      file: "windows",
      label: "Download for Windows",
      note: (version, size) => `${version} for 64-bit Windows, ${size}.`,
      link: others,
    },
    mac: {
      file: "mac",
      label: "Download for Mac",
      note: (version, size) => `${version} for Apple silicon and Intel, ${size}.`,
      link: { href: "#download", text: "How to open it" },
    },
    linux: {
      file: "server",
      label: "Download the server",
      note: (version, size) => `${version} of the server, ${size}. It needs Node 24.`,
      link: others,
    },
  };

  latestRelease().then((release) => {
    if (!release) return;
    const button = (name) => document.querySelector(`[data-asset="${name}"]`);
    const meta = (name) => document.querySelector(`[data-meta="${name}"]`);

    if (release.none) {
      for (const [name, file] of Object.entries(FILES)) {
        if (button(name)) {
          button(name).href = SOURCE;
          button(name).textContent = "Build from source";
        }
        if (meta(name)) meta(name).textContent = file.source;
      }
      if (OFFERS[os] && note) {
        say(note, "No release is published yet.", others);
      }
      return;
    }

    const version = release.version ? `Version ${release.version}` : "Latest release";
    for (const name of Object.keys(FILES)) {
      const asset = release[name];
      if (!asset || !button(name)) continue;
      button(name).href = asset.url;
      if (meta(name)) meta(name).textContent = `${version}, ${megabytes(asset.size)}`;
    }
    if (release.windows && meta("windows")) {
      meta("windows").textContent +=
        ". The installer isn't signed yet, so Windows may warn about an unknown publisher.";
    }
    if (release.mac && meta("mac")) {
      meta("mac").textContent += ". Signed ad hoc, not yet by Apple.";
    }

    const offer = OFFERS[os];
    const asset = offer && release[offer.file];
    if (!asset) {
      if (os === "mac" && note) {
        say(note, "This release has no Mac app.", { href: "#download", text: "Your options" });
      }
      return;
    }
    for (const get of gets) {
      get.href = asset.url;
      get.textContent = offer.label;
    }
    if (note) say(note, offer.note(version, megabytes(asset.size)), offer.link);
  });
})();
