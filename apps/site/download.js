// Offers the download that fits the visitor's system: the installer on
// Windows, the server on Linux, and on a Mac or a phone, what they can use
// instead. The files come from the latest published GitHub release. Without
// this script, or when GitHub cannot be reached, every button still goes to
// GitHub; when nothing has been released yet, the page says so.

(() => {
  const REPO = "Blazeiscoding/OwnBase";
  const SOURCE = `https://github.com/${REPO}#try-it`;
  const KEY = "ownbase:release";

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

  const remember = (value) => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(value));
    } catch {
      // Storage can be off; the next page asks GitHub again.
    }
  };
  const remembered = () => {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    } catch {
      return null;
    }
  };

  /**
   * The newest published release's files, `{ none: true }` when there is no
   * release, or null when GitHub did not answer. A stable release wins; while
   * OwnBase is in beta there may only be pre-releases (v0.1.0-beta.1), which
   * GitHub's "latest release" leaves out, so the list is read instead.
   */
  async function latestRelease() {
    const known = remembered();
    if (known) return known;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, {
        headers: { Accept: "application/vnd.github+json" },
        signal: controller.signal,
      });
      // Rate limited or down: the GitHub links stay.
      if (!res.ok) return null;
      const list = await res.json();
      const published = Array.isArray(list) ? list.filter((r) => !r.draft) : [];
      const data = published.find((r) => !r.prerelease) ?? published[0];
      if (!data) {
        remember({ none: true });
        return { none: true };
      }
      const pick = (pattern) => {
        const asset = (data.assets ?? []).find((a) => pattern.test(a.name));
        return asset ? { url: asset.browser_download_url, size: asset.size } : null;
      };
      const release = {
        version: String(data.tag_name ?? "").replace(/^v/, ""),
        page: data.html_url,
        windows: pick(/Setup.*\.exe$/i),
        mac: pick(/-universal\.dmg$/i),
        server: pick(/^ownbase-server-.*\.tar\.gz$/i),
      };
      remember(release);
      return release;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const megabytes = (bytes) => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

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
    say(note, "Nothing to install here. Open your team's invite link in the browser.");
  }

  // Each file a release offers, the row it belongs to, and what its button
  // says when there is no release to take it from.
  const FILES = {
    windows: { source: "No installer is published yet. pnpm build:win makes one." },
    mac: { source: "No disk image is published yet. pnpm build:mac makes one." },
    server: { source: "No release is published yet. pnpm build makes the server." },
  };
  // What this system's main buttons offer, out of a release.
  const OFFERS = {
    windows: { file: "windows", label: "Download for Windows", what: "for 64-bit Windows" },
    mac: {
      file: "mac",
      label: "Download for Mac",
      what: "for Apple silicon and Intel Macs",
      extra: " macOS asks you to allow it the first time it opens.",
    },
    linux: {
      file: "server",
      label: "Download the server",
      what: "for any system with Node 24",
      extra: " The desktop app is for Windows and Mac.",
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
        say(
          note,
          "No release is published yet, so the button leads to the source on GitHub.",
          others,
        );
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
        say(
          note,
          "This release has no Mac app. Run the server, or join a workspace in your browser.",
          {
            href: "#download",
            text: "Your options",
          },
        );
      }
      return;
    }
    for (const get of gets) {
      get.href = asset.url;
      get.textContent = offer.label;
    }
    if (note) {
      say(
        note,
        `OwnBase ${release.version} ${offer.what}, ${megabytes(asset.size)}.${offer.extra ?? ""}`,
        others,
      );
    }
  });
})();
