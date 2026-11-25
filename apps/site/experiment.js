// The hero headline A/B test, second half (experiment-boot.js explains the
// first). It asks Flagsmith which headline this visitor gets, shows it,
// records the exposure, and records the conversions the experiment measures:
//
// - download_click, the primary metric: a click on a download button that
//   goes to a file or a release page (not one that only scrolls to #download).
// - demo_play: the 90-second demo video starts playing.
//
// The visitor is a random ID kept in localStorage, sent to Flagsmith as a
// transient identity, so Flagsmith keeps no identity record for it. Nothing
// else about the visitor is sent.
//
// Flagsmith counts a visitor's conversions only after their first exposure,
// and an exposure is recorded only when the visitor is looking at the
// headline they were assigned. A first-time visitor whose answer came after
// experiment-boot.js gave up waiting has already seen the control, so they
// are exposed only if the control is what they were assigned. Either way
// their assignment is remembered, and they see it from their next visit.

(() => {
  const state = window.ownbaseExperiment;
  if (!state || !state.on) return;
  const html = document.documentElement;
  const { config } = state;
  const flagsmith = window.flagsmith;

  const settle = () => {
    clearTimeout(state.timer);
    html.classList.remove("exp-wait");
  };
  if (!flagsmith) {
    settle();
    return;
  }

  const show = (variation) => {
    settle();
    for (const v of config.VARIATIONS) html.classList.toggle(`exp-${v}`, v === variation);
  };

  function visitorId() {
    let id = localStorage.getItem(config.VISITOR_KEY);
    if (!id) {
      id = crypto.randomUUID
        ? crypto.randomUUID()
        : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join("");
      localStorage.setItem(config.VISITOR_KEY, id);
    }
    return id;
  }

  let ready = false;
  flagsmith
    .init({
      environmentID: config.ENVIRONMENT_KEY,
      evaluationContext: { identity: { identifier: visitorId(), transient: true } },
      enableEvents: true,
    })
    .then(() => {
      // A plain read first: getExperimentFlag records an exposure, which waits
      // until the visitor is looking at their headline.
      const value = flagsmith.getValue(config.FLAG);
      const variation = config.VARIATIONS.includes(value) ? value : "control";
      const painted = state.late && !state.seen ? "control" : null;
      if (!painted) show(variation);
      localStorage.setItem(config.SEEN_KEY, variation);
      if ((painted ?? variation) === variation) flagsmith.getExperimentFlag(config.FLAG);
      ready = true;
    })
    .catch(settle);

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const track = (event, metadata) => {
    if (ready) flagsmith.trackEvent(event, { metadata });
  };

  document.addEventListener("click", (e) => {
    const link = e.target instanceof Element && e.target.closest("a[data-get], a[data-asset]");
    const href = link && link.getAttribute("href");
    if (!href || !href.startsWith("https://")) return;
    track("download_click", {
      file: link.dataset.asset ?? "suggested",
      place: link.closest(".hero") ? "hero" : link.closest("#download") ? "downloads" : "footer",
    });
    // A file from dl.ownbase.site downloads and the page stays, so the events
    // go out in the background. GitHub's release page replaces this page, so
    // hold the click until they are sent, for half a second at most.
    const leaves = new URL(href).host === "github.com";
    const plain = e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
    if (ready && leaves && plain && !e.defaultPrevented) {
      e.preventDefault();
      Promise.race([flagsmith.flushEvents(), wait(500)]).finally(() => location.assign(href));
    } else if (ready) {
      flagsmith.flushEvents();
    }
  });

  document
    .querySelector("#demo video")
    ?.addEventListener("play", () => track("demo_play", {}), { once: true });
})();
