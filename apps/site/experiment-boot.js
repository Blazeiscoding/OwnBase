// The hero headline A/B test, run with Flagsmith Experimentation. This part
// runs in <head>, before the page paints, so a visitor never sees one
// headline swap for the other. experiment.js does the rest once the page has
// loaded.
//
// Two headlines are in index.html. The <html> element's class picks one:
// none (or exp-control) shows "Your people. Your place. Your server.", and
// exp-plain shows "Team chat on a computer you own." While a first-time
// visitor's variation is on its way from Flagsmith, exp-wait hides the
// headline, for at most WAIT_MS; after that the visitor sees the control and
// is left out of the experiment for this visit.
//
// Nothing runs, and everyone sees the control, when ENVIRONMENT_KEY is empty,
// when the browser sends Global Privacy Control or Do Not Track, or when
// storage is off.

(() => {
  // Client-side environment keys from Flagsmith (SDK Keys). They are public by
  // design: they read flags and send events, and can't change anything.
  // ownbase.site counts toward the real experiment; Pages previews and a copy
  // served locally use the Development environment, so trying the page out
  // never adds to the results.
  const PRODUCTION = "eivmZoa7wVjrTYfq9qudsp";
  const DEVELOPMENT = "XEg6DQihjQWcTJKSff5mfa";
  const config = {
    ENVIRONMENT_KEY: location.hostname === "ownbase.site" ? PRODUCTION : DEVELOPMENT,
    FLAG: "hero_headline",
    VARIATIONS: ["control", "plain"],
    WAIT_MS: 800,
    VISITOR_KEY: "ownbase:visitor",
    SEEN_KEY: "ownbase:exp:hero_headline",
  };

  const optedOut = navigator.globalPrivacyControl === true || navigator.doNotTrack === "1";
  let seen = null;
  let storage = true;
  try {
    seen = localStorage.getItem(config.SEEN_KEY);
  } catch {
    storage = false;
  }
  const on = Boolean(config.ENVIRONMENT_KEY) && !optedOut && storage;
  const state = { config, on, seen: config.VARIATIONS.includes(seen) ? seen : null, late: false };
  window.ownbaseExperiment = state;
  if (!on) return;

  const html = document.documentElement;
  if (state.seen) {
    // A returning visitor: show the headline they saw last time straight away.
    // Bucketing is by visitor ID, so Flagsmith gives them the same one again.
    html.classList.add(`exp-${state.seen}`);
    return;
  }
  html.classList.add("exp-wait");
  state.timer = setTimeout(() => {
    state.late = true;
    html.classList.remove("exp-wait");
  }, config.WAIT_MS);
})();
