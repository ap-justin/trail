// Loaded by a blocking <script src> in index.html's <head>, before the body paints, so a
// stored Dark (or a dark system) never flashes light first. A file and not an inline
// script because the CSP is script-src 'self'. Key and values match src/web/lib/theme.ts;
// theme.test.tsx runs this file against it.
(() => {
  let choice = null;
  try {
    choice = localStorage.getItem("trail-theme");
  } catch {
    // storage blocked: fall through to the system setting
  }
  const dark =
    choice === "dark" ||
    (choice !== "light" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
})();
