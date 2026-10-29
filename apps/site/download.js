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
   * The latest published release's files, `{ none: true }` when there is no
   * release, or null when GitHub did not answer.
   */
  async function latestRelease() {
    const known = remembered();
    if (known) return known;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json" },
        signal: controller.signal,
      });
      if (res.status === 404) {
        remember({ none: true });
        return { none: true };
      }
      // Rate limited or down: the GitHub links stay.
      if (!res.ok) return null;
      const data = await res.json();
      const pick = (pattern) => {
        const asset = (data.assets ?? []).find((a) => pattern.test(a.name));
        return asset ? { url: asset.browser_download_url, size: asset.size } : null;
      };
      const release = {
        version: String(data.tag_name ?? "").replace(/^v/, ""),
        page: data.html_url,
        windows: pick(/Setup.*\.exe$/i),
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

  // What a Mac or a phone can do never depends on a release.
  if (os === "mac" && note) {
    say(
      note,
      "The desktop app is Windows only for now. On a Mac, run the server or join a workspace in your browser.",
      {
        href: "#download",
        text: "Your options",
      },
    );
  } else if ((os === "phone" || os === "other") && note) {
    say(note, "Nothing to install here. Open your team's invite link in the browser.");
  }

  latestRelease().then((release) => {
    if (!release) return;
    const assets = {
      windows: document.querySelector('[data-asset="windows"]'),
      server: document.querySelector('[data-asset="server"]'),
    };
    const metas = {
      windows: document.querySelector('[data-meta="windows"]'),
      server: document.querySelector('[data-meta="server"]'),
    };

    if (release.none) {
      for (const [name, button] of Object.entries(assets)) {
        if (!button) continue;
        button.href = SOURCE;
        button.textContent = "Build from source";
        if (metas[name]) {
          metas[name].textContent =
            name === "windows"
              ? "No installer is published yet. pnpm build:win makes one."
              : "No release is published yet. pnpm build makes the server.";
        }
      }
      if ((os === "windows" || os === "linux") && note) {
        say(
          note,
          "No release is published yet, so the button leads to the source on GitHub.",
          others,
        );
      }
      return;
    }

    const version = release.version ? `Version ${release.version}` : "Latest release";
    for (const name of ["windows", "server"]) {
      const asset = release[name];
      if (!asset || !assets[name]) continue;
      assets[name].href = asset.url;
      if (metas[name]) metas[name].textContent = `${version}, ${megabytes(asset.size)}`;
    }
    if (release.windows && metas.windows) {
      metas.windows.textContent +=
        ". The installer isn't signed yet, so Windows may warn about an unknown publisher.";
    }

    const offer =
      os === "windows" && release.windows
        ? {
            url: release.windows.url,
            label: "Download for Windows",
            size: release.windows.size,
            what: "for 64-bit Windows",
          }
        : os === "linux" && release.server
          ? {
              url: release.server.url,
              label: "Download the server",
              size: release.server.size,
              what: "for any system with Node 24",
            }
          : null;
    if (!offer) return;
    for (const button of gets) {
      button.href = offer.url;
      button.textContent = offer.label;
    }
    if (note) {
      const extra = os === "linux" ? " The desktop app is Windows only for now." : "";
      say(
        note,
        `OwnBase ${release.version} ${offer.what}, ${megabytes(offer.size)}.${extra}`,
        others,
      );
    }
  });
})();
