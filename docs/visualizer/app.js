(() => {
  "use strict";
  const data = JSON.parse(document.getElementById("project-data").textContent);
  const { files, flows, guide, meta } = data;
  const improvements = data.optimizations;
  const byPath = new Map(files.map((file) => [file.path, file]));
  const main = document.getElementById("main");
  const root = document.documentElement;

  // Eleven areas fold into six layers so colour can carry identity: the chart
  // palette is validated for five hues plus a neutral, not for eleven.
  const layers = [
    { id: "interface", title: "Screens", areas: ["ui", "web"] },
    { id: "client", title: "App engine", areas: ["client-core"] },
    { id: "contract", title: "Shared rules", areas: ["protocol"] },
    { id: "server", title: "Server", areas: ["server", "server-cli"] },
    { id: "desktop", title: "Desktop app", areas: ["desktop"] },
    { id: "support", title: "Tools and docs", areas: ["tooling", "docs", "root", "visualizer"] },
  ];
  const layerOf = (area) => layers.find((layer) => layer.areas.includes(area)) ?? layers[5];
  const layerById = (id) => layers.find((layer) => layer.id === id);
  const areaInfo = (id) => guide.areas.find((area) => area.id === id);
  const areaTitle = (id) => areaInfo(id)?.title ?? id;
  const kinds = {
    runtime: "Code",
    test: "Test",
    documentation: "Docs",
    configuration: "Settings",
    tooling: "Build script",
    asset: "Image or font",
  };
  // Listed in the order the improvements page groups them: open work first.
  const statuses = {
    "follow-up": { label: "Still open", icon: "circle" },
    measured: { label: "Done and measured", icon: "gauge" },
    implemented: { label: "Done", icon: "check" },
  };
  const views = {
    overview: { label: "Overview", icon: "map" },
    files: { label: "Files", icon: "folder" },
    flows: { label: "How it works", icon: "route" },
    improvements: { label: "Improvements", icon: "spark" },
    evidence: { label: "Scope & limits", icon: "scale" },
  };
  const flowGroups = {
    client: "In the app",
    server: "On the server",
    desktop: "In the desktop app",
  };
  // Improvement categories, named for people rather than for the code.
  const categoryNames = {
    performance: "Speed",
    reliability: "Reliability",
    privacy: "Privacy",
    resources: "Memory and disk",
    tooling: "Build tools",
    measurement: "Measuring",
  };
  const categoryName = (category) => categoryNames[category] ?? category;
  const store = {
    get(key, fallback) {
      try {
        const value = localStorage.getItem(`tandem-atlas:${key}`);
        return value === null ? fallback : JSON.parse(value);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(`tandem-atlas:${key}`, JSON.stringify(value));
      } catch {
        /* Private windows can refuse storage; the atlas works without it. */
      }
    },
  };
  const state = {
    filter: "",
    sourceSearch: false,
    kind: "all",
    layer: "all",
    limit: 150,
    expanded: new Set(),
    wrap: store.get("wrap", false),
    impStatus: "all",
    impCategory: "all",
    impQuery: "",
    symbolQuery: "",
    find: { query: "", hits: [], index: -1 },
    showAllConnections: false,
  };

  // ---------- small helpers ----------
  const number = (value) => Number(value).toLocaleString("en-US");
  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
    );
  const size = (bytes) =>
    bytes >= 1_000_000
      ? `${(bytes / 1_000_000).toFixed(2)} MB`
      : bytes >= 1_000
        ? `${(bytes / 1_000).toFixed(1)} kB`
        : `${bytes} B`;
  const base = (path) => path.slice(path.lastIndexOf("/") + 1);
  const folder = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
  const href = (path, tab = "explain", line) =>
    `#files?${new URLSearchParams({ path, ...(tab !== "explain" ? { tab } : {}), ...(line ? { line: String(line) } : {}) })}`;
  const layerStyle = (area) => `style="--c: var(--layer-${layerOf(area).id})"`;
  const announce = (text) => (document.getElementById("announcement").textContent = text);
  let toastTimer;
  const toast = (text) => {
    const element = document.getElementById("toast");
    element.textContent = text;
    element.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove("visible"), 1800);
  };
  const copy = async (text, done) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(done);
    } catch {
      toast("Copying is blocked here. Select the text instead.");
    }
  };

  const iconPaths = {
    map: "M9 4 3 6.5v13L9 17l6 2.5 6-2.5V4l-6 2.5L9 4Zm0 0v13m6-10.5v13",
    folder:
      "M3 7.5A1.5 1.5 0 0 1 4.5 6h4.4l2 2h8.6A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z",
    "folder-open":
      "M3 17.5v-10A1.5 1.5 0 0 1 4.5 6h4.4l2 2h7.6A1.5 1.5 0 0 1 20 9.5V11M3 17.5 5.6 12a1.5 1.5 0 0 1 1.4-1h13.6a.8.8 0 0 1 .7 1.1l-2.5 6.1a1.5 1.5 0 0 1-1.4.8H4.5A1.5 1.5 0 0 1 3 17.5Z",
    route:
      "M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm12-10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 17h7.5a3.5 3.5 0 0 0 0-7h-7a3.5 3.5 0 0 1 0-7H16",
    spark: "M4 17l5-5 4 4 7-8M15 8h5v5",
    scale:
      "M12 4v16M7 20h10M5 8h14M5 8l-2.5 6a3 3 0 0 0 5 0L5 8Zm14 0-2.5 6a3 3 0 0 0 5 0L19 8ZM12 4l-1 1.5h2L12 4Z",
    search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm9 2-4-4",
    sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-13v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4",
    moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z",
    monitor: "M4 5h16v11H4zM9 20h6m-3-4v4",
    menu: "M4 7h16M4 12h16M4 17h16",
    close: "M6 6l12 12M18 6 6 18",
    chevron: "m9 6 6 6-6 6",
    back: "m15 6-6 6 6 6",
    file: "M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm7 0v5h5",
    code: "m9 8-4 4 4 4m6-8 4 4-4 4",
    test: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3M7.5 14h9",
    doc: "M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm2 9h6m-6 4h6",
    gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z",
    tool: "M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5a4 4 0 0 0-2-2Z",
    image: "M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1Z",
    copy: "M9 9h10v11H9zM5 15V4h10",
    download: "M12 4v11m-4-4 4 4 4-4M5 20h14",
    external: "M14 4h6v6m0-6-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
    check: "m5 12.5 4.5 4.5L19 7",
    circle: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z",
    gauge: "M4 15a8 8 0 1 1 16 0M12 15l4-5",
    wrap: "M4 6h16M4 12h13a3 3 0 0 1 0 6h-4m0 0 2-2m-2 2 2 2M4 18h5",
    link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    arrow: "M5 12h14m-5-5 5 5-5 5",
    hash: "M9 4 7 20M17 4l-2 16M4 9h16M3 15h16",
    layers: "m12 4 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5",
  };
  const icon = (name, extra = "") =>
    `<svg class="icon ${extra}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${iconPaths[name]}"/></svg>`;
  const fileIcon = (file) =>
    icon(
      file.kind === "test"
        ? "test"
        : file.kind === "documentation"
          ? "doc"
          : file.kind === "configuration"
            ? "gear"
            : file.kind === "tooling"
              ? "tool"
              : file.kind === "asset"
                ? "image"
                : "code",
    );
  const fileRef = (path, note = "") => {
    const file = byPath.get(path);
    if (!file) return "";
    return `<a class="file-ref" href="${escape(href(path))}" ${layerStyle(file.area)} title="${escape(path)}"><span class="file-ref-dot" aria-hidden="true"></span><span class="file-ref-name">${escape(base(path))}</span><span class="file-ref-dir">${escape(folder(path))}</span>${note ? `<span class="file-ref-note">${escape(note)}</span>` : ""}</a>`;
  };
  const fileRefs = (paths = []) =>
    paths.length
      ? `<div class="file-refs">${paths.map((path) => fileRef(path)).join("")}</div>`
      : "";
  const statusMark = (status) =>
    `<span class="status-mark status-${escape(status)}" title="${statuses[status].label}">${icon(statuses[status].icon)}<span class="sr-only">${statuses[status].label}: </span></span>`;
  const empty = (title, text, action = "") =>
    `<div class="empty"><h3>${escape(title)}</h3><p>${escape(text)}</p>${action}</div>`;
  // The technical version of something said in plain words, one click below it.
  const inCode = (body, note = "", open = false, label = "In the code") =>
    `<details class="in-code" ${open ? "open" : ""}><summary>${escape(label)}${note ? `<small>${escape(note)}</small>` : ""}</summary><div class="in-code-body">${body}</div></details>`;
  const pageHead = (title, intro, aside = "") =>
    `<header class="page-head"><div><h1>${escape(title)}</h1><p>${escape(intro)}</p></div>${aside}</header>`;

  // ---------- derived data ----------
  const layerStats = layers.map((layer) => {
    const members = files.filter((file) => layerOf(file.area) === layer);
    return {
      layer,
      files: members.length,
      lines: members.reduce((sum, file) => sum + file.lines, 0),
    };
  });
  const flowFiles = (flow) => [...new Set(flow.steps.flatMap((step) => step.files))];
  const stepLayers = (step) => {
    const counts = new Map();
    for (const path of step.files) {
      const file = byPath.get(path);
      if (!file) continue;
      const layer = layerOf(file.area).id;
      counts.set(layer, (counts.get(layer) ?? 0) + 1);
    }
    return counts;
  };
  // The layer doing most of the work in a step. A tie goes to the layer nearer the screen.
  const primaryLayer = (counts) =>
    [...counts.entries()].sort(
      (a, b) =>
        b[1] - a[1] ||
        layers.findIndex((layer) => layer.id === a[0]) -
          layers.findIndex((layer) => layer.id === b[0]),
    )[0]?.[0];
  const metricChange = (metric) => {
    const before = Number(metric.before);
    const after = Number(metric.after);
    if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0) return null;
    return ((after - before) / before) * 100;
  };
  const changeText = (change) =>
    change === null
      ? ""
      : `${change > 0 ? "+" : "−"}${Math.abs(change) < 10 ? Math.abs(change).toFixed(1) : Math.round(Math.abs(change))}%`;

  // ---------- routing ----------
  function route() {
    const [view, query = ""] = location.hash.slice(1).split("?");
    return {
      view: Object.hasOwn(views, view) ? view : "overview",
      params: new URLSearchParams(query),
    };
  }
  let lastView = "";

  // ---------- chrome ----------
  function renderChrome() {
    // Only the open count earns a place in the navigation; the other totals are
    // on the pages themselves.
    const open = improvements.filter((item) => item.status === "follow-up").length;
    document.getElementById("navigation").innerHTML = Object.entries(views)
      .map(
        ([key, view]) =>
          `<a href="#${key}" data-view="${key}">${icon(view.icon)}<span>${escape(view.label)}</span>${key === "improvements" && open ? `<b>${open} open</b>` : ""}</a>`,
      )
      .join("");
    const date = new Date(meta.revisionDate);
    document.getElementById("snapshot").innerHTML =
      `<span>Snapshot of</span><a href="${escape(`${meta.repository}/commit/${meta.revision}`)}" target="_blank" rel="noopener noreferrer"><code>${escape(meta.revision.slice(0, 7))}</code>${icon("external")}</a><small>${escape(Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }))}</small>`;
    document.getElementById("menu-button").innerHTML = icon("menu");
    document.querySelector(".search-trigger-icon").innerHTML = icon("search");
    document.querySelector(".palette-icon").innerHTML = icon("search");
    if (/Mac|iPhone|iPad/.test(navigator.platform))
      document.getElementById("search-shortcut").textContent = "⌘ K";
    applyTheme(store.get("theme", "system"));
  }
  function applyTheme(theme) {
    root.dataset.theme = theme;
    const next = { system: "dark", dark: "light", light: "system" }[theme];
    const names = { system: "Theme follows your device", dark: "Dark theme", light: "Light theme" };
    const button = document.getElementById("theme-button");
    button.innerHTML = icon(theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor");
    button.setAttribute(
      "aria-label",
      `${names[theme]}. Switch to ${names[next].replace("Theme follows your device", "the device theme")}`,
    );
    button.title = names[theme];
    button.dataset.next = next;
  }
  function setNav(open) {
    document.body.classList.toggle("nav-open", open);
    document.getElementById("scrim").hidden = !open;
    document.getElementById("menu-button").setAttribute("aria-expanded", String(open));
  }
  function crumbs(view, params) {
    const parts = [`<a href="#overview">Atlas</a>`];
    if (view !== "overview") parts.push(`<a href="#${view}">${escape(views[view].label)}</a>`);
    const path = params.get("path");
    if (view === "files" && path && byPath.has(path))
      parts.push(`<span>${escape(base(path))}</span>`);
    if (view === "flows") {
      const flow = flows.find((item) => item.id === params.get("id")) ?? flows[0];
      parts.push(`<span>${escape(flow.title)}</span>`);
    }
    document.getElementById("crumbs").innerHTML = parts.join(icon("chevron", "crumb-sep"));
  }

  // ---------- overview ----------
  // The map tells the story of a request, one node per area, and every file is
  // a dot in its node. A wire with a number is imports, counted from the source
  // with tests left out. A dotted wire happens at runtime, where no import says
  // so. Each wire names the side it leaves by and the side it arrives at.
  const mapNodes = [
    { area: "web", name: "Web version", role: "Opens OwnBase in any web browser" },
    { area: "desktop", name: "Desktop app", role: "The app for your computer. It can also host" },
    { area: "ui", name: "Screens", role: "Everything you see and click" },
    {
      area: "client-core",
      name: "App engine",
      role: "Your copy of the workspace, unsent messages, calls",
    },
    { area: "protocol", name: "Shared rules", role: "What both sides agree a message looks like" },
    { area: "server", name: "Server", role: "Accounts, messages, files, connected apps" },
    { area: "server-cli", name: "Server on its own", role: "The server without the desktop app" },
  ];
  const mapWires = [
    { from: "web", to: "ui", out: "right", into: "left" },
    { from: "desktop", to: "ui", out: "right", into: "left" },
    { from: "ui", to: "client-core", out: "right", into: "left" },
    { from: "ui", to: "protocol", out: "top", into: "left" },
    { from: "client-core", to: "protocol", out: "top", into: "bottom" },
    { from: "server", to: "protocol", out: "top", into: "right" },
    {
      from: "client-core",
      to: "server",
      out: "right",
      into: "left",
      runtime: "over the network",
      verb: "Talks over the network to",
    },
    { from: "desktop", to: "server", out: "right", into: "bottom" },
    {
      from: "server-cli",
      to: "server",
      out: "left",
      into: "top",
      runtime: "packs up",
      verb: "Packs up",
    },
    {
      from: "server",
      to: "store",
      out: "right",
      into: "left",
      runtime: "saves to",
      verb: "Saves to",
    },
  ];
  const supportAreas = layers[5].areas;
  const mapName = (id) =>
    id === "store" ? "the workspace folder" : mapNodes.find((node) => node.area === id).name;
  const countFiles = (count) => `${count} ${count === 1 ? "file" : "files"}`;
  // Files in one area that import a file in another, tests left out.
  const importCount = (from, to) => {
    let count = 0;
    for (const file of files) {
      if (file.area !== from || file.kind === "test") continue;
      const seen = new Set();
      for (const dependency of file.imports) {
        const target = dependency.path && byPath.get(dependency.path);
        if (!target || target.area !== to || seen.has(target.path)) continue;
        seen.add(target.path);
        count += 1;
      }
    }
    return count;
  };
  const wireCounts = new Map(
    mapWires.map((wire) => [wire, wire.runtime ? 0 : importCount(wire.from, wire.to)]),
  );
  // Source first, then tests, then everything else, so a node shows its make-up.
  const dotKind = (file) =>
    file.kind === "runtime" || file.kind === "tooling"
      ? "source"
      : file.kind === "test"
        ? "test"
        : "other";
  const dotRank = { source: 0, test: 1, other: 2 };
  function dots(members) {
    return `<div class="dots" aria-hidden="true">${[...members]
      .sort((a, b) => dotRank[dotKind(a)] - dotRank[dotKind(b)] || a.path.localeCompare(b.path))
      .map(
        (file) =>
          `<a class="d k-${dotKind(file)}" tabindex="-1" href="${escape(href(file.path))}" data-file="${escape(file.path)}"></a>`,
      )
      .join("")}</div>`;
  }
  // The wires leaving a node, as sentences: what it imports, then what it does at runtime.
  function mapRelations(area) {
    const leaving = mapWires.filter((wire) => wire.from === area);
    const sentences = [
      ...leaving
        .filter((wire) => !wire.runtime)
        .map((wire) => `${countFiles(wireCounts.get(wire))} here use ${mapName(wire.to)}.`),
      ...leaving.filter((wire) => wire.runtime).map((wire) => `${wire.verb} ${mapName(wire.to)}.`),
    ];
    return sentences.length ? `<p class="map-rel">${escape(sentences.join(" "))}</p>` : "";
  }
  // How many files a node holds, and how many of them are tests: the rings.
  const fileCount = (members) => {
    const tests = members.filter((file) => file.kind === "test").length;
    return `<small class="map-count">${number(members.length)} files${tests ? `, ${number(tests)} tests` : ""}</small>`;
  };
  function atlasMap() {
    const node = ({ area, name, role }) => {
      const members = files.filter((file) => file.area === area);
      return `<article class="map-node" data-node="${area}" style="--c: var(--layer-${layerOf(area).id}); grid-area: n-${area}">
        <a class="map-node-head" href="${escape(href(areaInfo(area).entry))}"><strong><span class="dot" aria-hidden="true"></span>${escape(name)}</strong><span>${escape(role)}</span></a>
        ${dots(members)}${fileCount(members)}${mapRelations(area)}
      </article>`;
    };
    const support = files.filter((file) => supportAreas.includes(file.area));
    return `<figure class="atlas-map" id="atlas-map" aria-label="How OwnBase's areas connect, with a dot for every file">
      <div class="map-grid" id="map-grid">
        <svg class="map-wires" id="map-wires" aria-hidden="true"></svg>
        ${mapNodes.map(node).join("")}
        <a class="map-node map-store" data-node="store" href="${escape(href("packages/server/src/store.ts"))}" style="--c: var(--layer-server); grid-area: n-store"><strong>Workspace folder</strong><span>Saved messages, uploaded files and backups</span></a>
        <article class="map-node map-support" data-node="support" style="--c: var(--layer-support); grid-area: n-support">
          <a class="map-node-head" href="#files?layer=support"><strong><span class="dot" aria-hidden="true"></span>Tools and docs</strong><span>Build scripts, settings, guides and this atlas</span></a>
          ${dots(support)}${fileCount(support)}
        </article>
        <div class="dot-tip" id="dot-tip" hidden></div>
      </div>
      <figcaption class="map-legend" aria-hidden="true">
        <span><i class="d k-source"></i>Code</span>
        <span><i class="d k-test"></i>Test that checks the code</span>
        <span><i class="d k-other"></i>Settings, docs and images</span>
        <span class="legend-wire"><i class="wire-sample"></i>A number counts the files in one part that use another, tests left out</span>
        <span class="legend-wire"><i class="wire-sample runtime"></i>Connects while OwnBase runs</span>
      </figcaption>
    </figure>`;
  }
  // Where a wire meets a node: ports share a side evenly, ordered by where
  // their other ends are, so two wires from one side do not cross.
  function drawMap(animate = false) {
    const grid = document.getElementById("map-grid");
    const svg = document.getElementById("map-wires");
    if (!grid || !svg) return;
    grid.querySelectorAll(".wire-label").forEach((label) => label.remove());
    if (getComputedStyle(svg).display === "none") {
      svg.innerHTML = "";
      return;
    }
    const box = grid.getBoundingClientRect();
    svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    const rects = new Map(
      [...grid.querySelectorAll("[data-node]")].map((element) => {
        const rect = element.getBoundingClientRect();
        return [
          element.dataset.node,
          {
            left: rect.left - box.left,
            right: rect.right - box.left,
            top: rect.top - box.top,
            bottom: rect.bottom - box.top,
            x: rect.left - box.left + rect.width / 2,
            y: rect.top - box.top + rect.height / 2,
          },
        ];
      }),
    );
    const ports = new Map();
    const claim = (id, side, wire, other) => {
      const key = `${id}:${side}`;
      if (!ports.has(key)) ports.set(key, []);
      ports.get(key).push({ wire, other });
    };
    for (const wire of mapWires) {
      claim(wire.from, wire.out, wire, wire.to);
      claim(wire.to, wire.into, wire, wire.from);
    }
    const point = (id, side, wire) => {
      const rect = rects.get(id);
      const vertical = side === "left" || side === "right";
      const sharing = ports
        .get(`${id}:${side}`)
        .slice()
        .sort((a, b) =>
          vertical
            ? rects.get(a.other).y - rects.get(b.other).y
            : rects.get(a.other).x - rects.get(b.other).x,
        );
      const share = (sharing.findIndex((port) => port.wire === wire) + 1) / (sharing.length + 1);
      return vertical
        ? {
            x: side === "left" ? rect.left : rect.right,
            y: rect.top + (rect.bottom - rect.top) * share,
            dx: side === "left" ? -1 : 1,
            dy: 0,
          }
        : {
            x: rect.left + (rect.right - rect.left) * share,
            y: side === "top" ? rect.top : rect.bottom,
            dx: 0,
            dy: side === "top" ? -1 : 1,
          };
    };
    const colour = (id) => `var(--layer-${id === "store" ? "server" : layerOf(id).id})`;
    const mid = (p0, p1, p2, p3) => 0.125 * p0 + 0.375 * p1 + 0.375 * p2 + 0.125 * p3;
    let defs = "";
    let lines = "";
    let ends = "";
    mapWires.forEach((wire, index) => {
      const a = point(wire.from, wire.out, wire);
      const b = point(wire.to, wire.into, wire);
      const reach = Math.max(28, Math.min(120, Math.hypot(b.x - a.x, b.y - a.y) * 0.45));
      const c1 = { x: a.x + a.dx * reach, y: a.y + a.dy * reach };
      const c2 = { x: b.x + b.dx * reach, y: b.y + b.dy * reach };
      const d = `M${a.x.toFixed(1)} ${a.y.toFixed(1)} C${c1.x.toFixed(1)} ${c1.y.toFixed(1)} ${c2.x.toFixed(1)} ${c2.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
      const count = wireCounts.get(wire);
      const width = wire.runtime ? 2.2 : 1.6 + Math.log2(count + 1) * 0.55;
      defs += `<linearGradient id="wire-${index}" gradientUnits="userSpaceOnUse" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"><stop offset="0" style="stop-color: ${colour(wire.from)}"/><stop offset="1" style="stop-color: ${colour(wire.to)}"/></linearGradient>`;
      const attrs = `data-from="${wire.from}" data-to="${wire.to}"`;
      lines += wire.runtime
        ? `<path class="wire runtime" ${attrs} d="${d}" stroke="url(#wire-${index})" stroke-width="${width}"/>`
        : `<path class="wire-glow" ${attrs} d="${d}" stroke="url(#wire-${index})" stroke-width="${(width + 7).toFixed(2)}"/><path class="wire" ${attrs} d="${d}" pathLength="1" stroke="url(#wire-${index})" stroke-width="${width.toFixed(2)}"/>`;
      ends += `<circle class="port" ${attrs} cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" r="4" style="fill: ${colour(wire.from)}"/><circle class="port" ${attrs} cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="4" style="fill: ${colour(wire.to)}"/>`;
      // The label sits at the middle of the curve.
      const label = document.createElement("span");
      label.className = `wire-label${wire.runtime ? " runtime" : ""}`;
      label.dataset.from = wire.from;
      label.dataset.to = wire.to;
      label.textContent = wire.runtime ?? String(count);
      label.style.left = `${mid(a.x, c1.x, c2.x, b.x).toFixed(1)}px`;
      label.style.top = `${mid(a.y, c1.y, c2.y, b.y).toFixed(1)}px`;
      grid.append(label);
    });
    svg.innerHTML = `<defs>${defs}</defs>${lines}${ends}`;
    svg.classList.toggle("draw-in", animate);
  }
  // Pointing at a node lights its own wires and quietens the rest.
  function focusMap(id) {
    const grid = document.getElementById("map-grid");
    if (!grid) return;
    const wired = mapWires.some((wire) => wire.from === id || wire.to === id);
    grid.classList.toggle("focused", wired);
    grid
      .querySelectorAll("[data-from]")
      .forEach((element) =>
        element.classList.toggle(
          "lit",
          wired && (element.dataset.from === id || element.dataset.to === id),
        ),
      );
  }
  // A tip sits above the mark it names, inside the mark's container, and
  // below the mark when there is no room above.
  function placeTip(tip, container, mark) {
    tip.hidden = false;
    const box = container.getBoundingClientRect();
    const rect = mark.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    const x = Math.max(
      half + 6,
      Math.min(box.width - half - 6, rect.left - box.left + rect.width / 2),
    );
    const above = rect.top - box.top - tip.offsetHeight - 8;
    tip.style.left = `${x}px`;
    tip.style.top = `${above < 4 ? rect.bottom - box.top + 8 : above}px`;
  }
  function showDotTip(dot) {
    const tip = document.getElementById("dot-tip");
    const grid = document.getElementById("map-grid");
    if (!tip || !grid) return;
    const file = dot && byPath.get(dot.dataset.file);
    if (!file) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = `<strong>${escape(base(file.path))}</strong>${file.plain ? `<em>${escape(file.plain)}</em>` : ""}<small>${escape(kinds[file.kind])}, ${number(file.lines)} lines</small>`;
    placeTip(tip, grid, dot);
  }
  // One row per layer: its share of the lines as a thin bar, then the areas in
  // it, each opening on the file to read first.
  function layersSection() {
    const total = layerStats.reduce((sum, stat) => sum + stat.lines, 0);
    return `<section class="section" aria-labelledby="layers-title">
      <div class="section-head"><h2 id="layers-title">What each part does</h2><p>${number(total)} lines of code in ${number(files.length)} files. Click a part to open the file to start with.</p></div>
      <div class="layer-table">${layerStats
        .map(({ layer, files: count, lines }) => {
          const areas = guide.areas.filter((area) => layer.areas.includes(area.id));
          const share = (100 * lines) / total;
          return `<div class="layer-row" style="--c: var(--layer-${layer.id})"><div class="layer-key"><h3><a href="#files?layer=${layer.id}"><span class="dot" aria-hidden="true"></span>${escape(layer.title)}</a></h3><div class="share"><span class="share-bar" aria-hidden="true"><span style="width: ${share.toFixed(2)}%"></span></span><b>${Math.round(share)}%<span class="sr-only"> of lines</span></b></div><small>${number(count)} files, ${number(lines)} lines</small></div><ul>${areas
            .map(
              (area) =>
                `<li><a href="${escape(href(area.entry))}"><span class="area-name">${escape(area.title)}</span><span class="area-summary">${escape(area.summary)}</span></a></li>`,
            )
            .join("")}</ul></div>`;
        })
        .join("")}</div>
    </section>`;
  }
  // A journey drawn small: one point per step, on the row of the layer doing
  // most of the work in it.
  function routeGlyph(flow) {
    const primary = flow.steps.map((step) => primaryLayer(stepLayers(step)));
    const used = layers.filter((layer) => primary.includes(layer.id));
    const width = 88;
    const height = 28;
    const x = (index) =>
      flow.steps.length === 1 ? width / 2 : 6 + (index * (width - 12)) / (flow.steps.length - 1);
    const y = (layerId) => {
      const row = used.findIndex((layer) => layer.id === layerId);
      return used.length === 1 ? height / 2 : 6 + (row * (height - 12)) / (used.length - 1);
    };
    const points = primary
      .map((layerId, index) => (layerId ? [x(index), y(layerId), layerId] : null))
      .filter(Boolean);
    return `<svg class="route-glyph" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true"><path d="${points.map(([px, py], index) => `${index ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ")}"/>${points.map(([px, py, layerId]) => `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.2" style="fill: var(--layer-${layerId})"/>`).join("")}</svg>`;
  }
  function overview() {
    return `<div class="page overview">
      <section class="hero">
        <h1>${escape(guide.title)}</h1>
        <div class="hero-copy">
          <p class="hero-intro">${escape(guide.intro)}</p>
          <div class="hero-actions">
            <a class="button primary" href="#flows">See how a message travels</a>
            <a class="button" href="#files">Browse the files</a>
          </div>
        </div>
      </section>
      ${atlasMap()}
      ${layersSection()}
      <section class="section" aria-labelledby="principles-title">
        <div class="section-head"><h2 id="principles-title">Four ideas behind the design</h2><p>They explain most of the choices in the code.</p></div>
        <div class="principles">${guide.principles
          .map(
            (principle) =>
              `<article class="principle"><h3>${escape(principle.title)}</h3><p>${escape(principle.text)}</p>${fileRefs(principle.files)}</article>`,
          )
          .join("")}</div>
      </section>
      <section class="section" aria-labelledby="start-title">
        <div class="section-head"><h2 id="start-title">Follow one action through OwnBase</h2><p>${flows.length} everyday actions. Each line shows which parts of OwnBase do the work, step by step.</p></div>
        <div class="routes">${Object.entries(flowGroups)
          .map(
            ([area, title]) =>
              `<div class="route-group"><h3>${title}</h3>${flows
                .filter((flow) => flow.area === area)
                .map(
                  (flow) =>
                    `<a class="route" href="#flows?id=${encodeURIComponent(flow.id)}">${routeGlyph(flow)}<strong>${escape(flow.title)}</strong><small>${flow.steps.length} steps, ${flowFiles(flow).length} files</small></a>`,
                )
                .join("")}</div>`,
          )
          .join("")}</div>
      </section>
    </div>`;
  }

  // ---------- files: tree ----------
  const tree = { name: "", path: "", dirs: new Map(), files: [], count: 0 };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = tree;
    node.count++;
    for (let index = 0; index < parts.length - 1; index++) {
      const name = parts[index];
      if (!node.dirs.has(name))
        node.dirs.set(name, {
          name,
          path: parts.slice(0, index + 1).join("/"),
          dirs: new Map(),
          files: [],
          count: 0,
        });
      node = node.dirs.get(name);
      node.count++;
    }
    node.files.push(file);
  }
  const sortedDirs = (node) => [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  function expandTo(path) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++)
      state.expanded.add(parts.slice(0, index).join("/"));
  }
  function treeRows(node, depth, selected) {
    let html = "";
    for (const dir of sortedDirs(node)) {
      const open = state.expanded.has(dir.path);
      html += `<button type="button" class="tree-row tree-dir" data-dir="${escape(dir.path)}" aria-expanded="${open}" style="--depth:${depth}">${icon("chevron", "tree-caret")}${icon(open ? "folder-open" : "folder")}<span class="tree-name">${escape(dir.name)}</span><span class="tree-count">${dir.count}</span></button>`;
      if (open) html += `<div class="tree-group">${treeRows(dir, depth + 1, selected)}</div>`;
    }
    for (const file of [...node.files].sort((a, b) => base(a.path).localeCompare(base(b.path)))) {
      const current = file.path === selected;
      html += `<a class="tree-row tree-file ${current ? "current" : ""}" href="${escape(href(file.path))}" ${current ? 'aria-current="page"' : ""} style="--depth:${depth}; --c: var(--layer-${layerOf(file.area).id})" title="${escape(file.path)}"><span class="tree-spacer"></span>${fileIcon(file)}<span class="tree-name">${escape(base(file.path))}</span></a>`;
    }
    return html;
  }
  const filtering = () => state.filter.trim() || state.kind !== "all" || state.layer !== "all";
  function searchFiles() {
    const words = state.filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const results = [];
    for (const file of files) {
      if (state.kind !== "all" && file.kind !== state.kind) continue;
      if (state.layer !== "all" && layerOf(file.area).id !== state.layer) continue;
      if (!words.length) {
        results.push({ file, score: 0 });
        continue;
      }
      const name = base(file.path).toLowerCase();
      const path = file.path.toLowerCase();
      const about =
        `${file.summary} ${file.concepts.join(" ")} ${file.symbols.map((symbol) => symbol.name).join(" ")}`.toLowerCase();
      const source = state.sourceSearch ? (file.source ?? "").toLowerCase() : "";
      let score = 0;
      let ok = true;
      for (const word of words) {
        if (name.startsWith(word)) score += 40;
        else if (name.includes(word)) score += 25;
        else if (path.includes(word)) score += 12;
        else if (about.includes(word)) score += 5;
        else if (source.includes(word)) score += 1;
        else {
          ok = false;
          break;
        }
      }
      if (ok) results.push({ file, score: score - file.path.length / 200 });
    }
    return results.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  }
  function mark(text, words) {
    let html = escape(text);
    for (const word of words) {
      if (!word) continue;
      html = html.replace(
        new RegExp(escape(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
        (match) => `<mark>${match}</mark>`,
      );
    }
    return html;
  }
  function sourceHit(file, words) {
    if (!state.sourceSearch || !file.source || !words.length) return "";
    const lines = file.source.split("\n");
    const index = lines.findIndex((line) =>
      words.every((word) => line.toLowerCase().includes(word)),
    );
    if (index < 0) return "";
    return `<span class="result-line"><b>${index + 1}</b>${mark(lines[index].trim().slice(0, 120), words)}</span>`;
  }
  function renderTree() {
    const target = document.getElementById("tree");
    if (!target) return;
    const selected = route().params.get("path");
    const count = document.getElementById("tree-count");
    if (!filtering()) {
      target.innerHTML = treeRows(tree, 0, selected);
      count.textContent = `${number(files.length)} files`;
      return;
    }
    const results = searchFiles();
    const words = state.filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    count.textContent = `${number(results.length)} of ${number(files.length)} files`;
    target.innerHTML = results.length
      ? results
          .slice(0, state.limit)
          .map(
            ({ file }) =>
              `<a class="tree-row result ${file.path === selected ? "current" : ""}" href="${escape(href(file.path))}" ${file.path === selected ? 'aria-current="page"' : ""} style="--c: var(--layer-${layerOf(file.area).id})">${fileIcon(file)}<span class="result-text"><span class="tree-name">${mark(base(file.path), words)}</span><span class="result-dir">${mark(folder(file.path) || "repository root", words)}</span>${sourceHit(file, words)}</span></a>`,
          )
          .join("") +
        (results.length > state.limit
          ? `<button type="button" class="more" data-action="more-files">Show ${Math.min(150, results.length - state.limit)} more</button>`
          : "")
      : empty(
          "No files match",
          state.sourceSearch
            ? "Try fewer words, or clear the filters."
            : "Try fewer words, search the source text as well, or clear the filters.",
          `<button type="button" class="button small" data-action="reset-filters">Clear search and filters</button>`,
        );
  }

  // ---------- files: panes ----------
  function filesHome() {
    const recent = store.get("recent", []).filter((path) => byPath.has(path));
    return `<div class="files-home">
      <h1>Pick a file, or search for one</h1>
      <p>The list on the left has every file in the project. Type in its filter to narrow it, or press <kbd>/</kbd> to search file names, code and journeys together.</p>
      ${recent.length ? `<h2>Opened recently</h2>${fileRefs(recent)}` : ""}
      <h2>Good places to start</h2>
      <div class="first-files">${guide.areas
        .map(
          (area) =>
            `<a href="${escape(href(area.entry))}" ${layerStyle(area.id)}><span class="dot" aria-hidden="true"></span><strong>${escape(area.title)}</strong><code>${escape(area.entry)}</code></a>`,
        )
        .join("")}</div>
    </div>`;
  }
  function fileHeader(file, tab) {
    const local = file.imports.filter((dependency) => dependency.path);
    const tabs = [
      ["explain", "About"],
      ["source", file.source === null ? "Preview" : "Code"],
      ["symbols", `What's inside${file.symbols.length ? ` <b>${file.symbols.length}</b>` : ""}`],
      [
        "connections",
        `Connections${local.length + file.usedBy.length ? ` <b>${new Set(local.map((dependency) => dependency.path)).size + file.usedBy.length}</b>` : ""}`,
      ],
    ];
    const segments = file.path.split("/");
    return `<div class="file-head" ${layerStyle(file.area)}>
      <a class="back-to-tree button small" href="#files">${icon("back")}All files</a>
      <div class="file-path">${segments
        .slice(0, -1)
        .map((segment) => `<span>${escape(segment)}</span>`)
        .join('<i aria-hidden="true">/</i>')}</div>
      <div class="file-title"><h1>${fileIcon(file)}${escape(base(file.path))}</h1>
        <div class="file-actions">
          <button type="button" class="icon-button" data-action="copy-path" aria-label="Copy file path" title="Copy file path">${icon("copy")}</button>
          ${file.source !== null ? `<button type="button" class="icon-button" data-action="download-source" aria-label="Download this file" title="Download this file">${icon("download")}</button>` : ""}
          <a class="icon-button" href="${escape(`${meta.repository}/blob/${meta.revision}/${file.path}`)}" target="_blank" rel="noopener noreferrer" aria-label="Open on GitHub" title="Open on GitHub">${icon("external")}</a>
        </div>
      </div>
      <div class="file-facts"><span class="fact-layer"><span class="dot" aria-hidden="true"></span>${escape(areaTitle(file.area))}</span><span>${escape(kinds[file.kind] ?? file.kind)}</span>${file.source !== null ? `<span>${number(file.lines)} lines</span>` : ""}<span>${size(file.bytes)}</span>${file.curated ? `<span class="fact-reviewed">${icon("check")}Explanation checked by a person</span>` : ""}</div>
      <nav class="tabs" aria-label="File views">${tabs
        .map(
          ([key, label]) =>
            `<a href="${escape(href(file.path, key))}" ${tab === key ? 'aria-current="page"' : ""}>${label}</a>`,
        )
        .join("")}</nav>
    </div>`;
  }
  function explainPane(file) {
    const order = Object.keys(statuses);
    const related = improvements
      .filter((item) => item.files.includes(file.path))
      .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    const journeys = flows
      .map((flow) => ({
        flow,
        steps: flow.steps
          .map((step, index) => (step.files.includes(file.path) ? index + 1 : 0))
          .filter(Boolean),
      }))
      .filter((entry) => entry.steps.length);
    const tests = file.usedBy.filter((path) => byPath.get(path)?.kind === "test");
    const keySymbols = file.symbols
      .filter((symbol) => symbol.exported || symbol.kind === "class" || symbol.kind === "function")
      .slice(0, 10);
    const cases = file.checks.filter((check) => !check.group);
    return `<div class="explain">
      <p class="lead">${escape(file.plain ?? file.summary)}</p>
      ${file.curated ? "" : `<p class="note">Nobody has written an explanation for this file, so this one comes from its contents.</p>`}
      <div class="prose">${file.plain ? `<h2 class="prose-label">In the code</h2><p>${escape(file.summary)}</p>` : ""}${file.details.map((detail) => `<p>${escape(detail)}</p>`).join("")}</div>
      ${
        keySymbols.length
          ? `<section class="block"><h2>Start reading here</h2><div class="symbol-grid">${keySymbols
              .map(
                (symbol) =>
                  `<a href="${escape(href(file.path, "source", symbol.line))}"><code>${escape(symbol.name)}</code><span>${escape(symbol.kind)}, line ${symbol.line}</span></a>`,
              )
              .join(
                "",
              )}</div>${file.symbols.length > keySymbols.length ? `<a class="text-link" href="${escape(href(file.path, "symbols"))}">All ${file.symbols.length} declarations</a>` : ""}</section>`
          : ""
      }
      ${
        cases.length
          ? `<section class="block"><h2>What its tests check</h2><ul class="checks">${cases
              .slice(0, 12)
              .map(
                (check) =>
                  `<li><a href="${escape(href(file.path, "source", check.line))}">${icon(check.skipped ? "circle" : "check")}<span>${escape(check.name)}</span><small>line ${check.line}</small></a></li>`,
              )
              .join(
                "",
              )}</ul>${cases.length > 12 ? `<a class="text-link" href="${escape(href(file.path, "symbols"))}">All ${cases.length} cases</a>` : ""}<p class="note">A named case shows what is asserted, not that it ran.</p></section>`
          : ""
      }
      ${tests.length ? `<section class="block"><h2>Tests that check it</h2>${fileRefs(tests)}</section>` : ""}
      ${
        journeys.length
          ? `<section class="block"><h2>Journeys it takes part in</h2><div class="link-list">${journeys
              .map(
                ({ flow, steps }) =>
                  `<a href="#flows?id=${encodeURIComponent(flow.id)}&step=${steps[0]}">${icon("route")}<span>${escape(flow.title)}</span><small>${steps.length > 1 ? `steps ${steps.join(", ")}` : `step ${steps[0]}`} of ${flow.steps.length}</small></a>`,
              )
              .join("")}</div></section>`
          : ""
      }
      ${
        related.length
          ? `<section class="block"><h2>Changes and open work here</h2><div class="link-list">${related
              .map(
                (item) =>
                  `<a href="#improvements?id=${encodeURIComponent(item.id)}" class="${item.status === "follow-up" ? "is-open" : ""}">${statusMark(item.status)}<span>${escape(item.title)}</span><small>${escape(item.id)}</small></a>`,
              )
              .join("")}</div></section>`
          : ""
      }
      <p class="hash">SHA-256 <code>${escape(file.hash)}</code></p>
    </div>`;
  }

  // ---------- syntax highlighting ----------
  const keywords =
    "abstract|as|async|await|break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|keyof|let|new|of|private|protected|public|readonly|return|satisfies|set|static|super|switch|this|throw|try|type|typeof|var|void|while|with|yield";
  const grammars = {
    script: new RegExp(
      [
        "(?<comment>\\/\\/.*$|\\/\\*.*?(?:\\*\\/|$))",
        "(?<string>\"(?:\\\\.|[^\"\\\\])*\"?|'(?:\\\\.|[^'\\\\])*'?|`(?:\\\\.|[^`\\\\])*`?)",
        `(?<keyword>\\b(?:${keywords})\\b)`,
        "(?<literal>\\b(?:true|false|null|undefined|NaN|Infinity)\\b)",
        "(?<number>\\b\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?n?\\b|\\b0x[\\da-f]+\\b)",
        "(?<type>\\b[A-Z][A-Za-z0-9_]*\\b)",
        "(?<fn>\\b[a-z_$][\\w$]*(?=\\s*\\())",
      ].join("|"),
      "gi",
    ),
    json: /(?<key>"(?:\\.|[^"\\])*"(?=\s*:))|(?<string>"(?:\\.|[^"\\])*")|(?<literal>\b(?:true|false|null)\b)|(?<number>-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)/gi,
    css: /(?<comment>\/\*.*?(?:\*\/|$))|(?<string>"[^"]*"|'[^']*')|(?<keyword>@[\w-]+|!important)|(?<key>--[\w-]+|\b[a-z-]+(?=\s*:(?!:)))|(?<number>-?\b\d+(?:\.\d+)?(?:px|rem|em|ms|s|%|vh|vw|dvh|fr|deg)?\b|#[\da-f]{3,8}\b)/gi,
    yaml: /(?<comment>#.*$)|(?<key>^\s*-?\s*[\w./-]+(?=\s*:))|(?<string>"(?:\\.|[^"\\])*"|'[^']*')|(?<literal>\b(?:true|false|null|yes|no)\b)|(?<number>\b\d+(?:\.\d+)?\b)/gi,
    shell:
      /(?<comment>#.*$)|(?<string>"(?:\\.|[^"\\])*"|'[^']*')|(?<keyword>\b(?:FROM|RUN|COPY|WORKDIR|ENV|EXPOSE|CMD|ENTRYPOINT|ARG|USER|VOLUME|LABEL|HEALTHCHECK|if|then|fi|for|do|done|echo|export)\b)|(?<number>\b\d+\b)/g,
    markdown:
      /(?<keyword>^#{1,6}\s.*$)|(?<string>`[^`]+`)|(?<fn>\[[^\]]+\]\([^)]+\))|(?<type>\*\*[^*]+\*\*)/g,
    html: /(?<comment>&lt;!--.*?(?:--&gt;|$))|(?<keyword>&lt;\/?[\w-]+|\/?&gt;)|(?<key>\b[\w-]+(?==))|(?<string>"[^"]*")/g,
  };
  function grammarFor(path) {
    const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    if (/^(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(extension)) return "script";
    if (extension === "json") return "json";
    if (extension === "css") return "css";
    if (/^(ya?ml)$/.test(extension)) return "yaml";
    if (extension === "md") return "markdown";
    if (/^(html|svg|xml)$/.test(extension)) return "html";
    if (
      /^(sh|ps1)$/.test(extension) ||
      /Dockerfile|\.dockerignore|\.gitignore|\.gitattributes|\.npmrc|\.prettierignore|\.env/.test(
        path,
      )
    )
      return "shell";
    return null;
  }
  function highlightLines(path, source) {
    const grammar = grammarFor(path);
    const lines = source.split("\n");
    if (!grammar) return lines.map(escape);
    // A block comment or a template string can run over several lines; the
    // tokenizer works a line at a time, so carry which one is still open.
    let open = null;
    const closing = (line, kind) => {
      if (kind === "comment") {
        const end = line.indexOf("*/");
        return end < 0 ? -1 : end + 2;
      }
      for (let index = 0; index < line.length; index++) {
        if (line[index] === "\\") index++;
        else if (line[index] === "`") return index + 1;
      }
      return -1;
    };
    return lines.map((line) => {
      let prefix = "";
      let rest = line;
      if (open && (grammar === "script" || grammar === "css")) {
        const end = closing(line, open);
        if (end < 0) return `<span class="t-${open}">${escape(line)}</span>`;
        prefix = `<span class="t-${open}">${escape(line.slice(0, end))}</span>`;
        rest = line.slice(end);
        open = null;
      }
      const text = grammar === "html" ? escape(rest) : rest;
      const pattern = grammars[grammar];
      pattern.lastIndex = 0;
      let html = "";
      let position = 0;
      for (const match of text.matchAll(pattern)) {
        const kind = Object.entries(match.groups).find(([, value]) => value !== undefined)?.[0];
        const raw = match[0];
        if (!kind || !raw) continue;
        const piece = grammar === "html" ? raw : escape(raw);
        html +=
          grammar === "html"
            ? text.slice(position, match.index)
            : escape(text.slice(position, match.index));
        html += `<span class="t-${kind}">${piece}</span>`;
        position = match.index + raw.length;
        if (kind === "comment" && raw.startsWith("/*") && (raw.length < 4 || !raw.endsWith("*/")))
          open = "comment";
        if (kind === "string" && raw.startsWith("`") && closing(raw.slice(1), "string") < 0)
          open = "string";
      }
      html += grammar === "html" ? text.slice(position) : escape(text.slice(position));
      return prefix + html;
    });
  }
  const highlightCache = new Map();
  function highlighted(file) {
    if (!highlightCache.has(file.path)) {
      if (highlightCache.size > 12) highlightCache.delete(highlightCache.keys().next().value);
      highlightCache.set(file.path, highlightLines(file.path, file.source));
    }
    return highlightCache.get(file.path);
  }

  function sourcePane(file, params) {
    if (file.source === null)
      return `<div class="binary">${/\.(png|jpe?g|gif|webp|ico)$/i.test(file.path) ? "" : ""}<h2>This is a binary file</h2><p>The atlas records its name, size and SHA-256 but not its contents. Open it on GitHub to see it.</p><a class="button" href="${escape(`${meta.repository}/blob/${meta.revision}/${file.path}`)}" target="_blank" rel="noopener noreferrer">${icon("external")}Open on GitHub</a></div>`;
    const lines = highlighted(file);
    const selected = Number(params.get("line")) || 0;
    const chunks = [];
    for (let start = 0; start < lines.length; start += 200) {
      chunks.push(
        `<div class="chunk" style="contain-intrinsic-size: auto ${Math.min(200, lines.length - start) * 21}px">${lines
          .slice(start, start + 200)
          .map(
            (html, offset) =>
              `<div class="ln${start + offset + 1 === selected ? " selected" : ""}" id="L${start + offset + 1}"><span class="num" data-line="${start + offset + 1}">${start + offset + 1}</span><span class="txt">${html || " "}</span></div>`,
          )
          .join("")}</div>`,
      );
    }
    const outline = file.symbols.length
      ? `<aside class="outline" aria-label="Declarations in this file"><h2>Outline</h2><div class="outline-list">${file.symbols
          .map(
            (symbol) =>
              `<a href="${escape(href(file.path, "source", symbol.line))}" data-kind="${escape(symbol.kind)}" class="${symbol.kind === "method" ? "nested" : ""}"><span class="sym-kind">${escape(symbol.kind.slice(0, 1))}</span>${escape(symbol.name)}</a>`,
          )
          .join("")}</div></aside>`
      : "";
    return `<div class="source-layout ${outline ? "has-outline" : ""}">
      <div class="source-main">
        <div class="code-tools" role="toolbar" aria-label="Source tools">
          <label class="find">${icon("search")}<span class="sr-only">Find in this file</span><input id="find-input" type="search" placeholder="Find in file" value="${escape(state.find.query)}" autocomplete="off" /><span id="find-count" class="find-count"></span></label>
          <button type="button" class="icon-button" data-action="find-prev" aria-label="Previous match" title="Previous match (Shift+Enter)">${icon("back")}</button>
          <button type="button" class="icon-button" data-action="find-next" aria-label="Next match" title="Next match (Enter)">${icon("chevron")}</button>
          <label class="goto">Line <input id="line-input" type="number" min="1" max="${lines.length}" value="${selected || ""}" /> <span>of ${number(lines.length)}</span></label>
          <button type="button" class="icon-button ${state.wrap ? "on" : ""}" data-action="toggle-wrap" aria-pressed="${state.wrap}" aria-label="Wrap long lines" title="Wrap long lines">${icon("wrap")}</button>
          <button type="button" class="icon-button" data-action="copy-source" aria-label="Copy the whole file" title="Copy the whole file">${icon("copy")}</button>
        </div>
        <div class="code ${state.wrap ? "wrap" : ""}" id="code" tabindex="0" aria-label="Source of ${escape(file.path)}">${chunks.join("")}</div>
        <p class="note">Shown as text and never run. Click a line number to copy a link to that line.</p>
      </div>
      ${outline}
    </div>`;
  }
  function symbolsPane(file) {
    const query = state.symbolQuery.toLowerCase();
    const symbols = file.symbols.filter(
      (symbol) => !query || symbol.name.toLowerCase().includes(query),
    );
    const rows = symbols
      .map(
        (symbol) =>
          `<a class="symbol-row" href="${escape(href(file.path, "source", symbol.line))}"><span class="sym-kind" data-kind="${escape(symbol.kind)}">${escape(symbol.kind)}</span><code class="sym-name">${escape(symbol.name)}</code>${symbol.exported ? '<span class="sym-export">exported</span>' : ""}<span class="sym-lines">${symbol.line === symbol.end ? `line ${symbol.line}` : `lines ${symbol.line}–${symbol.end}`}</span>${symbol.comment ? `<span class="sym-doc">${escape(symbol.comment)}</span>` : `<code class="sym-sig">${escape(symbol.signature)}</code>`}</a>`,
      )
      .join("");
    const checks = file.checks.length
      ? `<section class="block"><h2>Named tests</h2><ul class="checks tree-checks">${file.checks
          .map(
            (check) =>
              `<li class="${check.group ? "group" : ""}"><a href="${escape(href(file.path, "source", check.line))}">${check.group ? icon("folder") : icon(check.skipped ? "circle" : "check")}<span>${escape(check.name)}</span><small>line ${check.line}</small></a></li>`,
          )
          .join("")}</ul></section>`
      : "";
    if (!file.symbols.length)
      return `${empty("No declarations indexed", "Only TypeScript and JavaScript files are parsed for declarations. Read the whole file in Source.")}${checks}`;
    return `<div class="symbols"><label class="filter-input">${icon("search")}<span class="sr-only">Filter declarations</span><input id="symbol-filter" type="search" placeholder="Filter ${file.symbols.length} declarations" value="${escape(state.symbolQuery)}" autocomplete="off" /></label><div class="symbol-list" id="symbol-list">${rows || empty("Nothing matches", "Try a shorter name.")}</div></div>${checks}`;
  }
  function connectionsPane(file) {
    const seen = new Set();
    const imports = [];
    for (const dependency of file.imports) {
      if (!dependency.path || seen.has(dependency.path)) continue;
      seen.add(dependency.path);
      imports.push(dependency);
    }
    const external = [
      ...new Set(
        file.imports
          .filter((dependency) => !dependency.path)
          .map((dependency) => dependency.specifier),
      ),
    ];
    const cap = state.showAllConnections ? Infinity : 24;
    const node = (path, note, side) => {
      const target = byPath.get(path);
      return `<a class="graph-node" data-side="${side}" href="${escape(href(path, "connections"))}" ${layerStyle(target.area)} title="${escape(path)}"><span class="graph-name">${escape(base(path))}</span><span class="graph-dir">${escape(folder(path))}</span>${note ? `<span class="graph-note">${escape(note)}</span>` : ""}</a>`;
    };
    const column = (title, items, side, emptyText) =>
      `<div class="graph-col graph-${side}"><h2>${title} <b>${items.length}</b></h2>${
        items.length
          ? items
              .slice(0, cap)
              .map((item) => node(item.path, item.note, side))
              .join("")
          : `<p class="note">${emptyText}</p>`
      }</div>`;
    const more = imports.length > cap || file.usedBy.length > cap;
    return `<div class="graph" id="graph" ${layerStyle(file.area)}>
      <svg class="graph-lines" id="graph-lines" aria-hidden="true"></svg>
      ${column(
        "Uses",
        imports.map((dependency) => ({
          path: dependency.path,
          note: dependency.typeOnly ? "types only" : dependency.dynamic ? "loaded on demand" : "",
        })),
        "in",
        "Uses no other file in the project.",
      )}
      <div class="graph-col graph-center"><div class="graph-self"><span class="graph-name">${escape(base(file.path))}</span><span class="graph-dir">${escape(folder(file.path))}</span></div></div>
      ${column(
        "Used by",
        file.usedBy.map((path) => ({ path, note: byPath.get(path).kind === "test" ? "test" : "" })),
        "out",
        "No file imports this one. Entry points, scripts and injected adapters look like this.",
      )}
    </div>
    ${more ? `<button type="button" class="button small" data-action="all-connections">${state.showAllConnections ? "Show fewer" : "Show every connection"}</button>` : ""}
    ${external.length ? `<section class="block"><h2>Outside code it uses</h2><ul class="concepts mono">${external.map((specifier) => `<li>${escape(specifier)}</li>`).join("")}</ul></section>` : ""}
    <p class="note">A line means one file names the other in its code. It shows which files depend on which, not every step the code takes while it runs.</p>`;
  }
  function drawGraph() {
    const graph = document.getElementById("graph");
    const svg = document.getElementById("graph-lines");
    if (!graph || !svg) return;
    const box = graph.getBoundingClientRect();
    const self = graph.querySelector(".graph-self")?.getBoundingClientRect();
    if (!self || getComputedStyle(svg).display === "none") return;
    svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    const middle = self.top + self.height / 2 - box.top;
    const paths = [...graph.querySelectorAll(".graph-node")].map((element) => {
      const rect = element.getBoundingClientRect();
      const y = rect.top + rect.height / 2 - box.top;
      const incoming = element.dataset.side === "in";
      const x1 = incoming ? rect.right - box.left : self.right - box.left;
      const x2 = incoming ? self.left - box.left : rect.left - box.left;
      const y1 = incoming ? y : middle;
      const y2 = incoming ? middle : y;
      const bend = (x2 - x1) / 2;
      const d = `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
      const colour = getComputedStyle(element).getPropertyValue("--c");
      return `<path class="glow" d="${d}" style="stroke: ${colour}"/><path d="${d}" style="stroke: ${colour}"/><circle cx="${x1}" cy="${y1}" r="3.5" style="fill: ${colour}"/><circle cx="${x2}" cy="${y2}" r="3.5" style="fill: ${colour}"/>`;
    });
    svg.innerHTML = paths.join("");
  }

  function filesPage(params) {
    const path = params.get("path");
    const file = path ? byPath.get(path) : null;
    if (file) expandTo(file.path);
    return `<div class="files ${file ? "has-file" : ""}">
      <aside class="tree-pane" aria-label="All files">
        ${file ? "" : '<h1 class="tree-title sr-only">All files</h1>'}
        <div class="tree-tools">
          <label class="filter-input">${icon("search")}<span class="sr-only">Filter files</span><input id="tree-filter" type="search" placeholder="Filter files" value="${escape(state.filter)}" autocomplete="off" /></label>
          <div class="tree-filters">
            <select id="kind-filter" aria-label="File kind"><option value="all">Any kind</option>${Object.entries(
              kinds,
            )
              .map(
                ([key, label]) =>
                  `<option value="${key}" ${state.kind === key ? "selected" : ""}>${label}</option>`,
              )
              .join("")}</select>
            <select id="layer-filter" aria-label="Part"><option value="all">Any part</option>${layers
              .map(
                (layer) =>
                  `<option value="${layer.id}" ${state.layer === layer.id ? "selected" : ""}>${layer.title}</option>`,
              )
              .join("")}</select>
          </div>
          <label class="toggle"><input id="source-toggle" type="checkbox" ${state.sourceSearch ? "checked" : ""} /><span>Search inside files too</span></label>
          <div class="tree-status"><span id="tree-count" aria-live="polite"></span>${filtering() ? '<button type="button" class="text-button" data-action="reset-filters">Clear</button>' : '<button type="button" class="text-button" data-action="collapse">Collapse all</button>'}</div>
        </div>
        <div class="tree" id="tree" aria-label="Files"></div>
      </aside>
      <section class="file-pane" id="file-pane" aria-label="File">${file ? filePane(file, params) : path ? empty("This file is not in the snapshot", "It may have been renamed or added after the atlas was built. Rebuild the atlas, or pick a file from the tree.") : filesHome()}</section>
    </div>`;
  }
  function filePane(file, params) {
    const tab = ["explain", "source", "symbols", "connections"].includes(params.get("tab"))
      ? params.get("tab")
      : "explain";
    const body =
      tab === "source"
        ? sourcePane(file, params)
        : tab === "symbols"
          ? symbolsPane(file)
          : tab === "connections"
            ? connectionsPane(file)
            : explainPane(file);
    return `${fileHeader(file, tab)}<div class="file-body tab-${tab}">${body}</div>`;
  }
  function rememberFile(path) {
    const recent = store.get("recent", []).filter((entry) => entry !== path);
    recent.unshift(path);
    store.set("recent", recent.slice(0, 8));
  }

  // ---------- journeys ----------
  function handoffMap(flow) {
    const perStep = flow.steps.map(stepLayers);
    const used = layers.filter((layer) => perStep.some((counts) => counts.has(layer.id)));
    const columnWidth = Math.max(84, Math.min(140, Math.floor(640 / flow.steps.length)));
    const rowHeight = 38;
    const left = 112;
    const top = 30;
    const width = left + flow.steps.length * columnWidth + 8;
    const height = top + used.length * rowHeight + 6;
    const x = (index) => left + index * columnWidth + columnWidth / 2;
    const y = (layerId) =>
      top + used.findIndex((layer) => layer.id === layerId) * rowHeight + rowHeight / 2;
    const primary = perStep.map(primaryLayer);
    // One wire per handoff: level while a layer keeps the work, a curve that
    // changes colour where the next layer takes over.
    let defs = "";
    let wires = "";
    let last = null;
    primary.forEach((layerId, index) => {
      if (!layerId) return;
      if (last) {
        const [x1, y1, x2, y2] = [x(last.index), y(last.layerId), x(index), y(layerId)];
        const bend = (x2 - x1) / 2;
        const d = `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
        defs += `<linearGradient id="handoff-${index}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><stop offset="0" style="stop-color: var(--layer-${last.layerId})"/><stop offset="1" style="stop-color: var(--layer-${layerId})"/></linearGradient>`;
        wires += `<path class="map-path-glow" d="${d}" stroke="url(#handoff-${index})"/><path class="map-path" d="${d}" stroke="url(#handoff-${index})"/>`;
      }
      last = { index, layerId };
    });
    const rows = used
      .map(
        (layer) =>
          `<g style="--c: var(--layer-${layer.id})"><line class="map-rule" x1="${left - 8}" x2="${width - 8}" y1="${y(layer.id)}" y2="${y(layer.id)}"/><circle class="map-key" cx="12" cy="${y(layer.id)}" r="4.5"/><text class="map-label" x="24" y="${y(layer.id) + 4}">${escape(layer.title)}</text></g>`,
      )
      .join("");
    const heads = flow.steps
      .map(
        (step, index) =>
          `<a href="#flows?id=${encodeURIComponent(flow.id)}&step=${index + 1}" class="map-step"><rect class="map-hit" x="${left + index * columnWidth + 4}" y="0" width="${columnWidth - 8}" height="${height}" rx="8"><title>Step ${index + 1}: ${escape(step.title)}</title></rect><text class="map-head" x="${x(index)}" y="16">${index + 1}</text></a>`,
      )
      .join("");
    const dots = perStep
      .map((counts, index) =>
        [...counts.entries()]
          .map(
            ([layerId, count]) =>
              `<circle class="map-dot ${layerId === primary[index] ? "primary" : ""}" style="--c: var(--layer-${layerId})" cx="${x(index)}" cy="${y(layerId)}" r="${layerId === primary[index] ? 9 : 6}"><title>Step ${index + 1}: ${count} ${count === 1 ? "file" : "files"} in ${escape(layerById(layerId).title)}</title></circle>`,
          )
          .join(""),
      )
      .join("");
    return `<figure class="handoff"><figcaption><strong>Who does each step</strong><span>Which parts of OwnBase work in each step. The line follows the part doing most of the work, and small dots are parts that help.</span></figcaption><div class="handoff-scroll"><svg viewBox="0 0 ${width} ${height}" style="max-width: ${width}px" role="group" aria-label="${escape(flow.steps.map((step, index) => `Step ${index + 1} ${step.title}: ${[...perStep[index].keys()].map((id) => layerById(id).title).join(" and ")}`).join(". "))}"><defs>${defs}</defs>${rows}${heads}${wires}${dots}</svg></div></figure>`;
  }
  function flowsPage(params) {
    const flow = flows.find((item) => item.id === params.get("id")) ?? flows[0];
    const index = flows.indexOf(flow);
    const previous = flows[index - 1];
    const next = flows[index + 1];
    const groups = Object.entries(flowGroups)
      .map(
        ([area, title]) =>
          `<div class="journey-group"><h2>${title}</h2>${flows
            .filter((item) => item.area === area)
            .map(
              (item) =>
                `<a href="#flows?id=${encodeURIComponent(item.id)}" ${item === flow ? 'aria-current="page"' : ""}>${escape(item.title)}</a>`,
            )
            .join("")}</div>`,
      )
      .join("");
    const all = flowFiles(flow);
    return `<div class="journeys">
      <nav class="journey-nav" aria-label="Journeys">${groups}</nav>
      <article class="journey">
        <header class="journey-head">
          <label class="journey-picker"><span class="sr-only">Choose a journey</span><select id="journey-select">${Object.entries(
            flowGroups,
          )
            .map(
              ([area, title]) =>
                `<optgroup label="${title}">${flows
                  .filter((item) => item.area === area)
                  .map(
                    (item) =>
                      `<option value="${escape(item.id)}" ${item === flow ? "selected" : ""}>${escape(item.title)}</option>`,
                  )
                  .join("")}</optgroup>`,
            )
            .join("")}</select></label>
          <p class="journey-group-label">Journey ${index + 1} of ${flows.length}, ${escape((flowGroups[flow.area] ?? flow.area).toLowerCase())}</p>
          <h1>${escape(flow.title)}</h1>
          <p>${escape(flow.summary)}</p>
          ${flow.detail ? inCode(`<p>${escape(flow.detail)}</p>`) : ""}
          <p class="journey-meta">${flow.steps.length} steps through ${all.length} files</p>
        </header>
        ${handoffMap(flow)}
        <ol class="steps">${flow.steps
          .map(
            (step, stepIndex) =>
              `<li class="step" id="step-${stepIndex + 1}"><span class="step-number" aria-hidden="true">${stepIndex + 1}</span><div class="step-body"><h2><span class="sr-only">Step ${stepIndex + 1}: </span>${escape(step.title)}</h2><p>${escape(step.description)}</p>${inCode(`${step.detail ? `<p>${escape(step.detail)}</p>` : ""}${fileRefs(step.files)}`, countFiles(step.files.length), Number(params.get("step")) === stepIndex + 1)}</div></li>`,
          )
          .join("")}</ol>
        <nav class="pager" aria-label="Other journeys">${previous ? `<a href="#flows?id=${encodeURIComponent(previous.id)}" class="prev"><small>${icon("back")}Previous journey</small><span>${escape(previous.title)}</span></a>` : "<span></span>"}${next ? `<a href="#flows?id=${encodeURIComponent(next.id)}" class="next"><small>Next journey${icon("chevron")}</small><span>${escape(next.title)}</span></a>` : "<span></span>"}</nav>
      </article>
    </div>`;
  }

  // ---------- improvements ----------
  // The board above the list: every record as a dot in its category's row,
  // and the measured changes ranked by how much they took away. Each mark
  // opens its record, and the list below says the same in words.
  const statusOrder = Object.keys(statuses);
  const amount = (value) => (typeof value === "number" ? number(value) : value);
  function improvementBoard() {
    const rows = [...new Set(improvements.map((item) => item.category))]
      .map((category) => ({
        category,
        items: improvements
          .filter((item) => item.category === category)
          .sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status)),
      }))
      .sort((a, b) => b.items.length - a.items.length || a.category.localeCompare(b.category));
    const cuts = improvements
      .map((item) => ({ item, metric: item.metrics?.[0] }))
      .map((entry) => ({ ...entry, change: entry.metric ? metricChange(entry.metric) : null }))
      .filter(({ change }) => change !== null && change < 0)
      .sort((a, b) => a.change - b.change || a.item.id.localeCompare(b.item.id));
    const link = (item) => `#improvements?id=${encodeURIComponent(item.id)}`;
    // Which layers the open findings reach into, through the files they name.
    const open = improvements.filter((item) => item.status === "follow-up");
    const reach = layers
      .map((layer) => ({
        layer,
        count: open.filter((item) =>
          item.files.some((path) => byPath.has(path) && layerOf(byPath.get(path).area) === layer),
        ).length,
      }))
      .filter(({ count }) => count)
      .sort((a, b) => b.count - a.count);
    return `<div class="imp-board">
      <figure class="board-panel board-records" aria-labelledby="board-records">
        <figcaption><h2 id="board-records">Every record</h2><p>One dot each, in a row for its category</p></figcaption>
        <dl class="board-figures">${statusOrder
          .map(
            (status) =>
              `<div><dt><i class="r s-${status}" aria-hidden="true"></i>${statuses[status].label}</dt><dd>${improvements.filter((item) => item.status === status).length}</dd></div>`,
          )
          .join("")}</dl>
        <div class="board-rows" aria-hidden="true">${rows
          .map(
            ({ category, items }) =>
              `<div class="board-row"><span class="board-cat">${escape(categoryName(category))}</span><span class="board-dots">${items
                .map(
                  (item) =>
                    `<a class="r s-${escape(item.status)}" tabindex="-1" href="${link(item)}" data-record="${escape(item.id)}"></a>`,
                )
                .join("")}</span><b>${items.length}</b></div>`,
          )
          .join("")}</div>
        <div class="dot-tip record-tip" id="record-tip" hidden></div>
      </figure>
      <figure class="board-panel board-reach" aria-labelledby="board-reach">
        <figcaption><h2 id="board-reach">Where the open problems are</h2><p>How many open problems involve each part of OwnBase. One problem can involve several.</p></figcaption>
        <ul class="reach-list">${reach
          .map(
            ({ layer, count }) =>
              `<li style="--c: var(--layer-${layer.id})"><span class="reach-name"><span class="dot" aria-hidden="true"></span>${escape(layer.title)}</span><span class="share-bar" aria-hidden="true"><span style="width: ${((100 * count) / open.length).toFixed(1)}%"></span></span><b>${count}<span class="sr-only"> of ${open.length}</span></b></li>`,
          )
          .join("")}</ul>
      </figure>
      <figure class="board-panel board-cuts" aria-labelledby="board-cuts">
        <figcaption><h2 id="board-cuts">How much each change saved</h2><p>The main measurement of each change, after compared with before</p></figcaption>
        <ol class="cut-list">${cuts
          .map(
            ({ item, metric, change }) =>
              `<li data-record="${escape(item.id)}"><a href="${link(item)}" title="${escape(metric.label)}"><span class="cut-name"><span>${escape(item.title)}</span><small>${escape(amount(metric.before))} to ${escape(amount(metric.after))} ${escape(metric.unit)}</small></span><span class="cut-bar" aria-hidden="true"><span style="width: ${(-change).toFixed(1)}%"></span></span><b>${changeText(change)}</b></a></li>`,
          )
          .join("")}</ol>
      </figure>
    </div>`;
  }
  function showRecordTip(dot) {
    const tip = document.getElementById("record-tip");
    if (!tip) return;
    const item = dot && improvements.find((record) => record.id === dot.dataset.record);
    if (!item) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = `<strong>${escape(item.id)}</strong><span>${escape(item.title)}</span><small>${statuses[item.status].label}, ${escape(categoryName(item.category).toLowerCase())}</small>`;
    placeTip(tip, dot.closest(".board-panel"), dot);
  }
  function metricRows(metrics) {
    return `<div class="metrics">${metrics
      .map((metric) => {
        const before = Number(metric.before);
        const after = Number(metric.after);
        const numeric =
          Number.isFinite(before) &&
          Number.isFinite(after) &&
          before >= 0 &&
          after >= 0 &&
          Math.max(before, after) > 0;
        const change = metricChange(metric);
        const scale = numeric ? Math.max(before, after) : 1;
        return `<div class="metric"><div class="metric-label" ${metric.detail ? `title="${escape(metric.detail)}"` : ""}>${escape(metric.label)}${change !== null ? `<span class="delta ${change > 0 ? "up" : "down"}">${changeText(change)}</span>` : ""}</div>${
          numeric
            ? `<div class="bar-row"><span class="bar-name">Before</span><span class="bar"><span class="bar-fill before" style="width:${((100 * before) / scale).toFixed(2)}%"></span></span><span class="bar-value">${escape(metric.before)} ${escape(metric.unit)}</span></div><div class="bar-row"><span class="bar-name">After</span><span class="bar"><span class="bar-fill after" style="width:${((100 * after) / scale).toFixed(2)}%"></span></span><span class="bar-value">${escape(metric.after)} ${escape(metric.unit)}</span></div>`
            : `<p class="metric-text">${escape(metric.before)} ${escape(metric.unit)} before, ${escape(metric.after)} ${escape(metric.unit)} after</p>`
        }</div>`;
      })
      .join("")}</div>`;
  }
  function improvementDetail(item) {
    const open = item.status === "follow-up";
    const now = open ? "What happens now" : "Before";
    const next = open ? "What should happen" : "After";
    const technical = item.technical;
    return `<div class="imp-detail">
      <p class="lead">${escape(item.summary)}</p>
      <div class="before-after"><div><h2>${now}</h2><p>${escape(item.before)}</p></div><div><h2>${next}</h2><p>${escape(item.after)}</p></div></div>
      ${item.metrics?.length ? `<section class="block"><h2>Measurements</h2>${metricRows(item.metrics)}</section>` : ""}
      ${item.limits?.length ? `<section class="block limits"><h2>What this does not show</h2><ul>${item.limits.map((limit) => `<li>${escape(limit)}</li>`).join("")}</ul></section>` : ""}
      ${inCode(
        `${technical ? `<p class="in-code-title">${escape(technical.title)}</p><p>${escape(technical.summary)}</p><dl class="in-code-pair"><div><dt>${now}</dt><dd>${escape(technical.before)}</dd></div><div><dt>${next}</dt><dd>${escape(technical.after)}</dd></div></dl>` : ""}<p><strong>How it works.</strong> ${escape(item.mechanism)}</p>${technical?.limits?.length ? `<h3>Limits, as first written</h3><ul>${technical.limits.map((limit) => `<li>${escape(limit)}</li>`).join("")}</ul>` : ""}<h3>Files</h3>${fileRefs(item.files)}${item.evidence?.length ? `<h3>Where the numbers come from</h3><div class="link-list">${item.evidence.map((evidence) => `<a href="${escape(href(evidence.path, "source"))}">${icon("file")}<span>${escape(evidence.label)}</span><small>${escape(base(evidence.path))}</small></a>`).join("")}</div>` : ""}`,
        countFiles(item.files.length),
      )}
      <button type="button" class="text-button" data-action="copy-link" data-id="${escape(item.id)}">${icon("link")}Copy a link to ${escape(item.id)}</button>
    </div>`;
  }
  function improvementRow(item, open) {
    const metric = item.metrics?.[0];
    const change = metric ? metricChange(metric) : null;
    return `<article class="imp ${open ? "open" : ""} ${item.status === "follow-up" ? "is-open" : ""}" id="improvement-${escape(item.id)}">
      <button type="button" class="imp-row" data-improvement="${escape(item.id)}" aria-expanded="${open}" aria-controls="detail-${escape(item.id)}">
        ${statusMark(item.status)}
        <span class="imp-title">${escape(item.title)}</span>
        ${change !== null ? `<span class="imp-headline" title="${escape(metric.label)}">${escape(metric.before)} to ${escape(metric.after)} ${escape(metric.unit)}<span class="delta ${change > 0 ? "up" : "down"}">${changeText(change)}</span></span>` : '<span class="imp-headline"></span>'}
        <span class="imp-id">${escape(item.id)}</span>
        ${icon("chevron", "imp-caret")}
      </button>
      <div class="imp-body" id="detail-${escape(item.id)}" ${open ? "" : "hidden"}>${open ? improvementDetail(item) : ""}</div>
    </article>`;
  }
  function improvementMatches() {
    const words = state.impQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return improvements.filter(
      (item) =>
        (state.impStatus === "all" || item.status === state.impStatus) &&
        (state.impCategory === "all" || item.category === state.impCategory) &&
        words.every((word) =>
          [
            item.id,
            item.title,
            item.summary,
            categoryName(item.category),
            item.mechanism,
            item.technical?.title,
            item.technical?.summary,
            ...item.files,
          ]
            .join(" ")
            .toLowerCase()
            .includes(word),
        ),
    );
  }
  function renderImprovementList() {
    const list = document.getElementById("imp-list");
    if (!list) return;
    const id = route().params.get("id");
    const matches = improvementMatches();
    // A heading per status carries the status once, instead of a label on every row.
    list.innerHTML = matches.length
      ? Object.entries(statuses)
          .map(([status, { label }]) => {
            const group = matches.filter((item) => item.status === status);
            return group.length
              ? `<section class="imp-group" aria-labelledby="group-${status}"><h2 id="group-${status}">${label} <b>${group.length}</b></h2>${group.map((item) => improvementRow(item, item.id === id)).join("")}</section>`
              : "";
          })
          .join("")
      : empty(
          "Nothing matches",
          "Clear the search or pick another status.",
          `<button type="button" class="button small" data-action="reset-improvements">Show all changes</button>`,
        );
    document.getElementById("imp-count").textContent =
      matches.length === improvements.length ? "" : `${matches.length} of ${improvements.length}`;
    const shown = new Set(matches.map((item) => item.id));
    document.querySelectorAll(".imp-board [data-record]").forEach((mark) => {
      mark.classList.toggle("dim", !shown.has(mark.dataset.record));
      mark.classList.toggle("current", mark.dataset.record === id);
    });
    document
      .querySelectorAll("[data-status-filter]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.statusFilter === state.impStatus),
        ),
      );
  }
  function improvementsPage(params) {
    if (params.get("id")) {
      state.impStatus = "all";
      state.impCategory = "all";
      state.impQuery = "";
    }
    const counts = Object.fromEntries(
      Object.keys(statuses).map((status) => [
        status,
        improvements.filter((item) => item.status === status).length,
      ]),
    );
    const categories = [...new Set(improvements.map((item) => item.category))].sort();
    return `<div class="page">
      ${pageHead("What changed, and what is still open", "Each record says what used to happen, what happens now and how it was checked. Problems that are found but not fixed yet stay on the list until they are.")}
      ${improvementBoard()}
      <div class="imp-tools">
        <div class="segmented" role="group" aria-label="Status">${[
          ["all", "All", improvements.length],
          ...Object.entries(statuses).map(([key, status]) => [key, status.label, counts[key]]),
        ]
          .map(
            ([key, label, count]) =>
              `<button type="button" data-status-filter="${key}" aria-pressed="${state.impStatus === key}">${label}<b>${count}</b></button>`,
          )
          .join("")}</div>
        <select id="imp-category" aria-label="Category"><option value="all">Every category</option>${categories.map((category) => `<option value="${escape(category)}" ${state.impCategory === category ? "selected" : ""}>${escape(categoryName(category))}</option>`).join("")}</select>
        <label class="filter-input grow">${icon("search")}<span class="sr-only">Search changes</span><input id="imp-search" type="search" placeholder="Search the changes" value="${escape(state.impQuery)}" autocomplete="off" /></label>
        <span class="imp-count" id="imp-count" aria-live="polite"></span>
      </div>
      <div class="imp-list" id="imp-list"></div>
    </div>`;
  }

  // ---------- scope ----------
  function evidencePage() {
    const date = new Date(meta.revisionDate);
    return `<div class="page narrow">
      ${pageHead("What this atlas can and cannot tell you", "It is a snapshot of the code with explanations. It does not run OwnBase, so it cannot prove the tests pass or that old numbers still hold.")}
      ${guide.validation.length ? `<div class="validation">${guide.validation.map((record) => `<article><strong>${escape(record.value)}</strong><h3>${escape(record.label)}</h3><p>${escape(record.detail)}</p>${fileRef(record.path)}</article>`).join("")}</div>` : ""}
      <section class="section"><div class="section-head"><h2>Before you quote a number</h2></div><ul class="limits-list">${guide.limits.map((limit) => `<li>${escape(limit.text)}</li>`).join("")}</ul>${inCode(`<ul>${guide.limits.map((limit) => `<li>${escape(limit.detail)}</li>`).join("")}</ul>`, "", false, "The precise wording, for developers")}</section>
      <section class="section"><div class="section-head"><h2>Words you may meet in the code sections</h2></div><dl class="glossary">${guide.glossary.map((item) => `<div><dt>${escape(item.term)}</dt><dd>${escape(item.meaning)}</dd></div>`).join("")}</dl></section>
      <section class="section snapshot-facts"><div class="section-head"><h2>This snapshot</h2></div>
        <dl>
          <div><dt>Commit</dt><dd><a href="${escape(`${meta.repository}/commit/${meta.revision}`)}" target="_blank" rel="noopener noreferrer"><code>${escape(meta.revision)}</code></a></dd></div>
          <div><dt>Committed</dt><dd>${escape(Number.isNaN(date.getTime()) ? meta.revisionDate : date.toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short" }))}</dd></div>
          <div><dt>Contents</dt><dd>${number(meta.fileCount)} files, ${number(meta.textCount)} of them text, ${number(meta.totalLines)} lines, ${number(meta.symbols)} declarations, ${number(meta.edges)} import links</dd></div>
          <div><dt>Input SHA-256</dt><dd><code>${escape(meta.inputDigest)}</code></dd></div>
        </dl>
        <p>Rebuild it after changing the code with <code>pnpm visualizer:build</code>. ${fileRef("docs/visualizer/README.md", "How the atlas is built")}</p>
      </section>
    </div>`;
  }

  // ---------- render ----------
  function render() {
    const { view, params } = route();
    // Files and journeys bring their own list pane, so the navigation folds to
    // icons there rather than standing as a second column of names.
    const rail = view === "files" || view === "flows";
    document.querySelector(".shell").classList.toggle("rail", rail);
    document.querySelectorAll("#navigation [data-view]").forEach((link) => {
      if (link.dataset.view === view) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
      if (rail) link.title = views[link.dataset.view].label;
      else link.removeAttribute("title");
    });
    crumbs(view, params);
    setNav(false);
    const path = params.get("path");
    document.title = `${view === "files" && path ? base(path) : views[view].label} · OwnBase atlas`;
    if (view === "files" && params.get("layer")) {
      state.layer = layers.some((layer) => layer.id === params.get("layer"))
        ? params.get("layer")
        : "all";
      state.kind = "all";
      state.filter = "";
    }
    const sameFiles =
      view === "files" && lastView === "files" && document.getElementById("file-pane");
    if (view !== "files") state.find = { query: "", hits: [], index: -1 };
    if (sameFiles) {
      const file = path ? byPath.get(path) : null;
      if (file) expandTo(file.path);
      document.querySelector(".files").classList.toggle("has-file", Boolean(file));
      const pane = document.getElementById("file-pane");
      pane.innerHTML = file ? filePane(file, params) : filesHome();
      renderTree();
      revealTreeSelection();
    } else {
      main.innerHTML =
        view === "files"
          ? filesPage(params)
          : view === "flows"
            ? flowsPage(params)
            : view === "improvements"
              ? improvementsPage(params)
              : view === "evidence"
                ? evidencePage()
                : overview();
      if (view === "files") {
        renderTree();
        revealTreeSelection();
      }
      if (view === "improvements") renderImprovementList();
    }
    main.dataset.view = view;
    lastView = view;
    afterRender(view, params);
    announce(`${view === "files" && path ? base(path) : views[view].label} opened`);
  }
  // The wires are measured from where the cards land, so they are drawn again
  // whenever the map changes size: a narrower window, or the fonts arriving.
  let mapSize = "";
  const sizeOf = (element) => `${element.offsetWidth}x${element.offsetHeight}`;
  const mapObserver =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          const grid = document.getElementById("map-grid");
          if (!grid || sizeOf(grid) === mapSize) return;
          mapSize = sizeOf(grid);
          drawMap();
        })
      : null;
  function watchMap() {
    mapObserver?.disconnect();
    const grid = document.getElementById("map-grid");
    if (!grid) return;
    mapSize = sizeOf(grid);
    drawMap(true);
    mapObserver?.observe(grid);
  }
  function afterRender(view, params) {
    watchMap();
    const path = params.get("path");
    const line = Number(params.get("line"));
    if (view === "files" && path && byPath.has(path)) {
      rememberFile(path);
      const tab = params.get("tab");
      if (tab === "source") {
        if (state.find.query) runFind(false);
        if (line)
          requestAnimationFrame(() =>
            document.getElementById(`L${line}`)?.scrollIntoView({ block: "center" }),
          );
        else document.getElementById("file-pane")?.scrollTo?.(0, 0);
      }
      if (tab === "connections") requestAnimationFrame(drawGraph);
      if (!line) window.scrollTo(0, 0);
      return;
    }
    if (view === "flows") {
      const current = document.querySelector('.journey-nav [aria-current="page"]');
      const nav = document.querySelector(".journey-nav");
      if (current && nav && getComputedStyle(nav).display !== "none") {
        const box = nav.getBoundingClientRect();
        const row = current.getBoundingClientRect();
        if (row.bottom > box.bottom || row.top < box.top)
          nav.scrollTop += row.top - box.top - box.height / 3;
      }
    }
    if (view === "flows" && params.get("step")) {
      requestAnimationFrame(() => {
        const step = document.getElementById(`step-${params.get("step")}`);
        step?.scrollIntoView({
          block: "center",
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        });
        step?.classList.add("flash");
      });
      return;
    }
    if (view === "improvements" && params.get("id")) {
      requestAnimationFrame(() =>
        document
          .getElementById(`improvement-${params.get("id")}`)
          ?.scrollIntoView({ block: "start" }),
      );
      return;
    }
    window.scrollTo(0, 0);
  }
  function revealTreeSelection() {
    const current = document.querySelector("#tree .current");
    const tree = document.getElementById("tree");
    if (!current || !tree) return;
    const box = tree.getBoundingClientRect();
    const row = current.getBoundingClientRect();
    if (row.top < box.top || row.bottom > box.bottom)
      tree.scrollTop += row.top - box.top - box.height / 3;
  }

  // ---------- find in file ----------
  function runFind(move, backwards = false) {
    const file = byPath.get(route().params.get("path"));
    const count = document.getElementById("find-count");
    if (!file?.source || !count) return;
    document
      .querySelectorAll("#code .hit")
      .forEach((element) => element.classList.remove("hit", "hit-current"));
    const query = state.find.query.toLowerCase();
    if (!query) {
      count.textContent = "";
      state.find.hits = [];
      return;
    }
    const lines = file.source.split("\n");
    const hits = [];
    lines.forEach((text, index) => {
      if (text.toLowerCase().includes(query)) hits.push(index + 1);
    });
    state.find.hits = hits;
    if (!hits.length) {
      count.textContent = "No matches";
      return;
    }
    if (move)
      state.find.index = (state.find.index + (backwards ? -1 : 1) + hits.length) % hits.length;
    else state.find.index = Math.max(0, Math.min(state.find.index, hits.length - 1));
    for (const line of hits) document.getElementById(`L${line}`)?.classList.add("hit");
    const current = document.getElementById(`L${hits[state.find.index]}`);
    current?.classList.add("hit-current");
    if (move) current?.scrollIntoView({ block: "center" });
    count.textContent = `${state.find.index + 1} of ${hits.length}`;
  }

  // ---------- command palette ----------
  const palette = document.getElementById("palette");
  const paletteInput = document.getElementById("palette-input");
  const paletteResults = document.getElementById("palette-results");
  let paletteItems = [];
  let paletteActive = 0;
  const symbolIndex = files.flatMap((file) =>
    file.symbols
      .filter((symbol) => symbol.kind !== "method" || symbol.exported)
      .map((symbol) => ({ file, symbol })),
  );
  function score(text, query) {
    const value = text.toLowerCase();
    const at = value.indexOf(query);
    if (at === 0) return 100 - value.length / 100;
    if (at > 0) return (/[\s/._-]/.test(value[at - 1]) ? 80 : 60) - at / 50;
    let position = -1;
    for (const character of query) {
      position = value.indexOf(character, position + 1);
      if (position < 0) return -1;
    }
    return 20 - value.length / 100;
  }
  function paletteSearch(raw) {
    const query = raw.trim().toLowerCase();
    const groups = [];
    const pages = Object.entries(views).map(([key, view]) => ({
      kind: "Pages",
      title: view.label,
      note: "",
      href: `#${key}`,
      icon: view.icon,
    }));
    if (!query) {
      const recent = store
        .get("recent", [])
        .filter((path) => byPath.has(path))
        .slice(0, 6);
      groups.push(["Pages", pages]);
      if (recent.length)
        groups.push([
          "Recent files",
          recent.map((path) => ({
            title: base(path),
            note: folder(path),
            href: href(path),
            file: byPath.get(path),
          })),
        ]);
      groups.push([
        "Journeys",
        flows.slice(0, 5).map((flow) => ({
          title: flow.title,
          note: `${flowGroups[flow.area]}, ${flow.steps.length} steps`,
          href: `#flows?id=${encodeURIComponent(flow.id)}`,
          icon: "route",
        })),
      ]);
      return groups;
    }
    const rank = (items, limit, get) =>
      items
        .map((item) => ({ item, score: get(item) }))
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((entry) => entry.item);
    const pageHits = rank(pages, 3, (page) => score(page.title, query));
    const fileHits = rank(files, 10, (file) =>
      Math.max(score(base(file.path), query) + 10, score(file.path, query) - 5),
    );
    const symbolHits =
      query.length > 1
        ? rank(
            symbolIndex,
            8,
            ({ symbol }) => score(symbol.name, query) + (symbol.exported ? 3 : 0),
          )
        : [];
    const flowHits = rank(flows, 4, (flow) =>
      Math.max(score(flow.title, query), flow.summary.toLowerCase().includes(query) ? 30 : -1),
    );
    const impHits = rank(improvements, 5, (item) =>
      Math.max(
        score(item.id, query) + 5,
        score(item.title, query),
        item.technical ? score(item.technical.title, query) - 5 : -1,
        item.summary.toLowerCase().includes(query) ? 25 : -1,
      ),
    );
    if (pageHits.length) groups.push(["Pages", pageHits]);
    if (fileHits.length)
      groups.push([
        "Files",
        fileHits.map((file) => ({
          title: base(file.path),
          note: folder(file.path),
          href: href(file.path),
          file,
        })),
      ]);
    if (symbolHits.length)
      groups.push([
        "Declarations",
        symbolHits.map(({ file, symbol }) => ({
          title: symbol.name,
          note: `${symbol.kind} in ${base(file.path)}, line ${symbol.line}`,
          href: href(file.path, "source", symbol.line),
          icon: "hash",
        })),
      ]);
    if (flowHits.length)
      groups.push([
        "Journeys",
        flowHits.map((flow) => ({
          title: flow.title,
          note: `${flowGroups[flow.area]}, ${flow.steps.length} steps`,
          href: `#flows?id=${encodeURIComponent(flow.id)}`,
          icon: "route",
        })),
      ]);
    if (impHits.length)
      groups.push([
        "Changes",
        impHits.map((item) => ({
          title: item.title,
          note: `${item.id}, ${statuses[item.status].label.toLowerCase()}`,
          href: `#improvements?id=${encodeURIComponent(item.id)}`,
          icon: statuses[item.status].icon,
          open: item.status === "follow-up",
        })),
      ]);
    return groups;
  }
  function renderPalette() {
    const groups = paletteSearch(paletteInput.value);
    paletteItems = groups.flatMap(([, items]) => items);
    paletteActive = Math.min(paletteActive, Math.max(0, paletteItems.length - 1));
    let index = 0;
    paletteResults.innerHTML = paletteItems.length
      ? groups
          .map(
            ([title, items]) =>
              `<div class="palette-group" role="group" aria-label="${escape(title)}"><div class="palette-group-title" aria-hidden="true">${escape(title)}</div>${items
                .map((item) => {
                  const current = index++;
                  return `<a id="palette-item-${current}" role="option" aria-selected="${current === paletteActive}" class="palette-item ${item.open ? "is-open" : ""}" href="${escape(item.href)}" data-index="${current}" ${item.file ? layerStyle(item.file.area) : ""}>${item.file ? fileIcon(item.file) : icon(item.icon ?? "file")}<span class="palette-title">${escape(item.title)}</span><span class="palette-note">${escape(item.note)}</span></a>`;
                })
                .join("")}</div>`,
          )
          .join("")
      : `<p class="palette-empty">Nothing found for “${escape(paletteInput.value.trim())}”. File names, declaration names, journey titles and change IDs are all searchable.</p>`;
    paletteInput.setAttribute(
      "aria-activedescendant",
      paletteItems.length ? `palette-item-${paletteActive}` : "",
    );
  }
  function movePalette(step) {
    if (!paletteItems.length) return;
    paletteActive = (paletteActive + step + paletteItems.length) % paletteItems.length;
    paletteResults
      .querySelectorAll(".palette-item")
      .forEach((element) =>
        element.setAttribute(
          "aria-selected",
          String(Number(element.dataset.index) === paletteActive),
        ),
      );
    const active = document.getElementById(`palette-item-${paletteActive}`);
    active?.scrollIntoView({ block: "nearest" });
    paletteInput.setAttribute("aria-activedescendant", `palette-item-${paletteActive}`);
  }
  function openPalette() {
    if (palette.open) return;
    paletteInput.value = "";
    paletteActive = 0;
    renderPalette();
    palette.showModal();
    paletteInput.focus();
  }
  function closePalette() {
    if (palette.open) palette.close();
  }
  paletteInput.addEventListener("input", () => {
    paletteActive = 0;
    renderPalette();
  });
  paletteInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      movePalette(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      movePalette(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = paletteItems[paletteActive];
      if (item) {
        closePalette();
        location.hash = item.href;
      }
    }
  });
  paletteResults.addEventListener("click", (event) => {
    if (event.target.closest(".palette-item")) closePalette();
  });
  paletteResults.addEventListener("mousemove", (event) => {
    const item = event.target.closest(".palette-item");
    if (item && Number(item.dataset.index) !== paletteActive)
      movePalette(Number(item.dataset.index) - paletteActive);
  });
  palette.addEventListener("click", (event) => {
    if (event.target === palette) closePalette();
  });

  // ---------- events ----------
  document.getElementById("open-search").addEventListener("click", openPalette);
  document.getElementById("theme-button").addEventListener("click", (event) => {
    const next = event.currentTarget.dataset.next;
    store.set("theme", next);
    applyTheme(next);
    toast(
      next === "system"
        ? "Theme follows your device"
        : next === "dark"
          ? "Onyx theme"
          : "White theme",
    );
    if (route().view === "files" && route().params.get("tab") === "connections")
      requestAnimationFrame(drawGraph);
  });
  document
    .getElementById("menu-button")
    .addEventListener("click", () => setNav(!document.body.classList.contains("nav-open")));
  document.getElementById("scrim").addEventListener("click", () => setNav(false));
  document.querySelector(".skip-link").addEventListener("click", (event) => {
    event.preventDefault();
    main.focus();
  });
  document.addEventListener("keydown", (event) => {
    const typing =
      ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) ||
      event.target.isContentEditable;
    if ((event.key === "k" || event.key === "K") && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (palette.open) closePalette();
      else openPalette();
      return;
    }
    if (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      openPalette();
      return;
    }
    if (event.key === "Escape" && document.body.classList.contains("nav-open")) setNav(false);
    if (event.target.id === "find-input" && event.key === "Enter") {
      event.preventDefault();
      runFind(true, event.shiftKey);
    }
    if (event.target.id === "line-input" && event.key === "Enter") {
      event.preventDefault();
      goToLine(event.target.value);
    }
    if (
      event.target.closest?.("#tree") &&
      ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    )
      treeKeys(event);
  });
  function goToLine(value) {
    const file = byPath.get(route().params.get("path"));
    if (!file?.source) return;
    const line = Math.min(file.lines, Math.max(1, Math.trunc(Number(value)) || 1));
    location.hash = href(file.path, "source", line);
  }
  function treeKeys(event) {
    const rows = [...document.querySelectorAll("#tree .tree-row")];
    const index = rows.indexOf(document.activeElement);
    if (index < 0) return;
    const row = rows[index];
    event.preventDefault();
    if (event.key === "ArrowDown") rows[index + 1]?.focus();
    else if (event.key === "ArrowUp") rows[index - 1]?.focus();
    else if (event.key === "Home") rows[0]?.focus();
    else if (event.key === "End") rows.at(-1)?.focus();
    else if (row.dataset.dir) {
      const open = state.expanded.has(row.dataset.dir);
      if (event.key === "ArrowRight" && !open) toggleDir(row.dataset.dir);
      else if (event.key === "ArrowLeft" && open) toggleDir(row.dataset.dir);
      else if (event.key === "ArrowRight") rows[index + 1]?.focus();
      else if (event.key === "ArrowLeft") focusParent(row);
    } else if (event.key === "ArrowLeft") focusParent(row);
  }
  function focusParent(row) {
    const group = row.parentElement.closest(".tree-group");
    group?.previousElementSibling?.focus();
  }
  function toggleDir(dir) {
    if (state.expanded.has(dir)) state.expanded.delete(dir);
    else state.expanded.add(dir);
    renderTree();
    document.querySelector(`#tree [data-dir="${CSS.escape(dir)}"]`)?.focus();
  }
  let filterTimer;
  main.addEventListener("input", (event) => {
    const target = event.target;
    if (target.id === "tree-filter") {
      state.filter = target.value;
      state.limit = 150;
      clearTimeout(filterTimer);
      filterTimer = setTimeout(
        () => {
          renderTree();
          document.getElementById("tree").scrollTop = 0;
          updateTreeStatus();
        },
        state.sourceSearch ? 160 : 40,
      );
    } else if (target.id === "imp-search") {
      state.impQuery = target.value;
      renderImprovementList();
    } else if (target.id === "symbol-filter") {
      state.symbolQuery = target.value;
      const file = byPath.get(route().params.get("path"));
      const list = document.getElementById("symbol-list");
      if (file && list) {
        const holder = document.createElement("div");
        holder.innerHTML = symbolsPane(file);
        list.innerHTML = holder.querySelector("#symbol-list")?.innerHTML ?? "";
      }
    } else if (target.id === "find-input") {
      state.find.query = target.value;
      state.find.index = 0;
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => runFind(false, false) || jumpToFirstHit(), 80);
    }
  });
  function jumpToFirstHit() {
    const first = state.find.hits[state.find.index];
    if (first) document.getElementById(`L${first}`)?.scrollIntoView({ block: "center" });
  }
  function updateTreeStatus() {
    const status = document.querySelector(".tree-status");
    if (!status) return;
    status.querySelector("button")?.remove();
    status.insertAdjacentHTML(
      "beforeend",
      filtering()
        ? '<button type="button" class="text-button" data-action="reset-filters">Clear</button>'
        : '<button type="button" class="text-button" data-action="collapse">Collapse all</button>',
    );
  }
  main.addEventListener("change", (event) => {
    const target = event.target;
    if (target.id === "journey-select") {
      location.hash = `#flows?id=${encodeURIComponent(target.value)}`;
      return;
    }
    if (target.id === "kind-filter") state.kind = target.value;
    else if (target.id === "layer-filter") state.layer = target.value;
    else if (target.id === "source-toggle") state.sourceSearch = target.checked;
    else if (target.id === "imp-category") {
      state.impCategory = target.value;
      renderImprovementList();
      return;
    } else return;
    state.limit = 150;
    renderTree();
    document.getElementById("tree").scrollTop = 0;
    updateTreeStatus();
  });
  main.addEventListener("click", (event) => {
    const number = event.target.closest(".num");
    if (number) {
      const file = byPath.get(route().params.get("path"));
      const line = Number(number.dataset.line);
      history.replaceState(null, "", href(file.path, "source", line));
      document
        .querySelectorAll("#code .ln.selected")
        .forEach((element) => element.classList.remove("selected"));
      document.getElementById(`L${line}`)?.classList.add("selected");
      const input = document.getElementById("line-input");
      if (input) input.value = line;
      copy(location.href, `Link to line ${line} copied`);
      return;
    }
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.dir) {
      toggleDir(button.dataset.dir);
      return;
    }
    if (button.dataset.improvement) {
      const id = button.dataset.improvement;
      const article = button.closest(".imp");
      const body = article.querySelector(".imp-body");
      const opening = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(opening));
      article.classList.toggle("open", opening);
      body.hidden = !opening;
      if (opening && !body.innerHTML)
        body.innerHTML = improvementDetail(improvements.find((item) => item.id === id));
      history.replaceState(
        null,
        "",
        opening ? `#improvements?id=${encodeURIComponent(id)}` : "#improvements",
      );
      return;
    }
    if (button.dataset.statusFilter) {
      state.impStatus = button.dataset.statusFilter;
      renderImprovementList();
      return;
    }
    const file = byPath.get(route().params.get("path"));
    switch (button.dataset.action) {
      case "more-files":
        state.limit += 150;
        renderTree();
        break;
      case "reset-filters":
        state.filter = "";
        state.kind = "all";
        state.layer = "all";
        state.sourceSearch = false;
        state.limit = 150;
        if (location.hash.includes("layer=")) location.hash = "#files";
        else {
          document.getElementById("tree-filter").value = "";
          document.getElementById("kind-filter").value = "all";
          document.getElementById("layer-filter").value = "all";
          document.getElementById("source-toggle").checked = false;
          renderTree();
          updateTreeStatus();
        }
        break;
      case "collapse":
        state.expanded.clear();
        renderTree();
        break;
      case "copy-path":
        if (file) copy(file.path, "Path copied");
        break;
      case "copy-source":
        if (file?.source) copy(file.source, `${number(file.lines)} lines copied`);
        break;
      case "download-source":
        if (file?.source !== null && file) {
          const url = URL.createObjectURL(
            new Blob([file.source], { type: "text/plain;charset=utf-8" }),
          );
          const link = document.createElement("a");
          link.href = url;
          link.download = base(file.path);
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        break;
      case "find-next":
        runFind(true);
        break;
      case "find-prev":
        runFind(true, true);
        break;
      case "toggle-wrap":
        state.wrap = !state.wrap;
        store.set("wrap", state.wrap);
        document.getElementById("code")?.classList.toggle("wrap", state.wrap);
        button.classList.toggle("on", state.wrap);
        button.setAttribute("aria-pressed", String(state.wrap));
        break;
      case "all-connections":
        state.showAllConnections = !state.showAllConnections;
        render();
        break;
      case "reset-improvements":
        state.impStatus = "all";
        state.impCategory = "all";
        state.impQuery = "";
        render();
        break;
      case "copy-link":
        copy(
          `${location.href.split("#")[0]}#improvements?id=${encodeURIComponent(button.dataset.id)}`,
          "Link copied",
        );
        break;
    }
  });
  main.addEventListener("focusout", (event) => {
    if (
      event.target.id === "line-input" &&
      event.target.value &&
      Number(event.target.value) !== Number(route().params.get("line"))
    )
      goToLine(event.target.value);
  });
  // The map answers the pointer: a dot names its file, a card lights its wires.
  main.addEventListener("mouseover", (event) => {
    if (main.dataset.view === "improvements") showRecordTip(event.target.closest("a.r"));
    if (main.dataset.view !== "overview") return;
    showDotTip(event.target.closest("a.d"));
    focusMap(event.target.closest("[data-node]")?.dataset.node);
  });
  main.addEventListener("mouseleave", () => {
    showDotTip(null);
    showRecordTip(null);
    focusMap();
  });
  main.addEventListener("focusin", (event) => {
    if (main.dataset.view === "overview")
      focusMap(event.target.closest("[data-node]")?.dataset.node);
  });
  let resizeFrame;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      drawGraph();
      if (!mapObserver) drawMap();
    });
  });
  document.fonts?.ready.then(() => drawMap());
  window.addEventListener("hashchange", render);
  renderChrome();
  render();
})();
