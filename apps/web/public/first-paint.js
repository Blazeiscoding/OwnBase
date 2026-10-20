// Puts the theme and density chosen on this device on the page before it is
// first painted, so a page whose chosen theme is not the device's does not
// show the other one first. packages/ui/src/lib/appearance.ts keeps the copy
// read here whenever the choice is applied. With none, the page follows the
// device, as "system" does in theme.css.
//
// A classic script from this origin, as the CSP allows, run from <head>
// before anything is drawn. It must never throw, whatever is stored. The same
// file is in apps/web/public and apps/desktop/src/renderer/public, which
// packages/ui/test/firstPaint.dom.test.ts checks.
(function () {
  var root = document.documentElement;
  var theme = "system";
  var density = "comfortable";
  try {
    var saved = JSON.parse(localStorage.getItem("tandem:appearance") || "null");
    if (saved && (saved.theme === "dark" || saved.theme === "light")) theme = saved.theme;
    if (saved && saved.density === "compact") density = "compact";
  } catch (error) {
    // Unreadable, or storage refused: the device's theme, as with nothing kept.
  }
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-density", density);
  // The browser's own bars, on a phone or an installed app, in the same theme.
  var light =
    theme === "light" ||
    (theme === "system" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: light)").matches);
  var bar = document.querySelector('meta[name="theme-color"]');
  if (bar) bar.setAttribute("content", light ? "#e9e9ec" : "#111115");
})();
