// The docs pages' script. scripts/generate-docs-site.mjs writes those pages
// and the search index this reads. It does three things:
//
// - searches the index as you type, results grouped by page;
// - folds the list of sections away on a phone, so the page starts with words;
// - sends a link to a heading this page lacks, such as /docs/#guests, to the
//   page that has it, so an anchor from DEPLOYMENT.md keeps working here.
//
// A classic deferred script, like scene.js: the site's policy allows scripts
// from this origin only, and nothing here needs a module.
(() => {
  const body = document.body;
  let index;
  const load = () => {
    index ??= fetch(body.dataset.search)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(({ pages, entries }) => ({
        pages,
        entries: entries.map(([page, id, title, text]) => ({
          page,
          id,
          title,
          text,
          lowTitle: title.toLowerCase(),
          lowText: text.toLowerCase(),
        })),
      }));
    index.catch(() => {
      index = undefined;
    });
    return index;
  };

  let wanted = "";
  try {
    wanted = decodeURIComponent(location.hash.slice(1));
  } catch {}
  if (wanted && !document.getElementById(wanted)) {
    load()
      .then(({ pages, entries }) => {
        const holds = (entry) => entry.id === wanted;
        const hit =
          entries.find((e) => holds(e) && pages[e.page].guide === body.dataset.guide) ??
          entries.find((e) => holds(e) && pages[e.page].guide === "hosting") ??
          entries.find(holds);
        if (hit) location.replace(`${pages[hit.page].url}#${encodeURIComponent(wanted)}`);
      })
      .catch(() => {});
  }

  const nav = document.querySelector(".docs-nav");
  const narrow = matchMedia("(max-width: 860px)");
  if (nav) {
    nav.open = !narrow.matches;
    narrow.addEventListener("change", () => {
      nav.open = !narrow.matches;
    });
  }

  const box = document.querySelector(".docs-search");
  if (!box) return;
  const input = box.querySelector("input");
  const status = box.querySelector(".docs-status");
  const results = box.querySelector(".docs-results");
  box.hidden = false;

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };

  /** Some words around the first match, with the match marked. */
  function snippet(entry, terms) {
    const span = element("span", "docs-snippet");
    let at = -1;
    let term = "";
    for (const t of terms) {
      const found = entry.lowText.indexOf(t);
      if (found >= 0 && (at < 0 || found < at)) [at, term] = [found, t];
    }
    if (at < 0) {
      span.textContent = entry.text.slice(0, 110) + (entry.text.length > 110 ? "…" : "");
      return span;
    }
    const from = Math.max(0, entry.text.lastIndexOf(" ", Math.max(0, at - 40)) + 1);
    const to = Math.min(entry.text.length, at + term.length + 80);
    span.append(
      (from > 0 ? "…" : "") + entry.text.slice(from, at),
      element("mark", "", entry.text.slice(at, at + term.length)),
      entry.text.slice(at + term.length, to) + (to < entry.text.length ? "…" : ""),
    );
    return span;
  }

  async function search() {
    const query = input.value.trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    if (!terms.length) {
      results.hidden = true;
      results.replaceChildren();
      status.textContent = "";
      return;
    }
    let data;
    try {
      data = await load();
    } catch {
      status.textContent = "Search could not load. Check your connection, then type again.";
      return;
    }
    if (input.value.trim().toLowerCase() !== query) return;
    const hits = [];
    for (const entry of data.entries) {
      let score = 0;
      for (const term of terms) {
        if (entry.lowTitle.includes(term)) score += 10;
        else if (entry.lowText.includes(term)) score += 1;
        else {
          score = 0;
          break;
        }
      }
      if (score) hits.push({ entry, score });
    }
    hits.sort((a, b) => b.score - a.score);
    const shown = hits.slice(0, 24);
    const groups = new Map();
    for (const { entry } of shown) {
      if (!groups.has(entry.page)) groups.set(entry.page, []);
      groups.get(entry.page).push(entry);
    }
    const list = element("ul", "docs-hits");
    for (const [page, entries] of groups) {
      const group = element("li", "docs-hit-page");
      group.append(element("p", "docs-hit-title", data.pages[page].title));
      const links = element("ul");
      for (const entry of entries) {
        const link = element("a");
        link.href = `${data.pages[page].url}#${encodeURIComponent(entry.id)}`;
        link.append(element("span", "docs-hit-heading", entry.title), snippet(entry, terms));
        const item = element("li");
        item.append(link);
        links.append(item);
      }
      group.append(links);
      list.append(group);
    }
    results.replaceChildren(list);
    results.hidden = shown.length === 0;
    status.textContent = shown.length
      ? `${hits.length} ${hits.length === 1 ? "match" : "matches"}${hits.length > shown.length ? `, the first ${shown.length} shown` : ""}.`
      : `Nothing matches “${input.value.trim()}”. Try fewer or shorter words.`;
  }

  input.addEventListener("focus", () => load().catch(() => {}), { once: true });
  input.addEventListener("input", search);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const first = results.querySelector("a");
      if (first) location.href = first.href;
    } else if (event.key === "Escape") {
      input.value = "";
      search();
    }
  });
  // A result on this page only moves the page, so close the list behind it.
  results.addEventListener("click", () => {
    results.hidden = true;
  });
  input.addEventListener("focus", () => {
    if (results.childElementCount && input.value.trim()) results.hidden = false;
  });
  document.addEventListener("click", (event) => {
    if (!box.contains(event.target)) results.hidden = true;
  });
})();
