"use strict";

// Apply the browser cache before the stylesheet; desktop preferences survive port changes.
(() => {
  let theme = "dark";
  let userSelected = false;
  let appearanceSave = Promise.resolve();
  const desktop = globalThis.sceneFinderDesktop;
  const hasNativeAppearance = desktop && ["getAppearance", "setAppearance"].every(method => typeof desktop[method] === "function");
  try {
    const saved = localStorage.getItem("scene-finder-theme");
    if (saved === "light" || saved === "dark") theme = saved;
  } catch { /* Appearance still works when storage is unavailable. */ }

  function cacheTheme() {
    try { localStorage.setItem("scene-finder-theme", theme); } catch { /* Keep the current choice for this window. */ }
  }

  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    document.getElementById("theme-color").setAttribute("content", theme === "dark" ? "#111217" : "#f5f5f8");
    for (const mode of ["light", "dark"]) {
      document.getElementById(`theme-${mode}`)?.setAttribute("aria-pressed", String(theme === mode));
    }
  }

  applyTheme();
  if (hasNativeAppearance) {
    (async () => {
      try {
        const saved = await desktop.getAppearance();
        if (!userSelected && (saved === "dark" || saved === "light")) {
          theme = saved;
          applyTheme();
          cacheTheme();
        }
      } catch { /* Keep the cached or default appearance if the native read fails. */ }
    })();
  }
  document.addEventListener("DOMContentLoaded", () => {
    for (const mode of ["light", "dark"]) {
      document.getElementById(`theme-${mode}`).addEventListener("click", () => {
        userSelected = true;
        theme = mode;
        applyTheme();
        cacheTheme();
        if (hasNativeAppearance) {
          // Preserve click order without delaying the visible change or later saves after a failure.
          appearanceSave = appearanceSave.then(() => desktop.setAppearance(mode)).catch(() => {});
        }
      });
    }
    applyTheme();
  });
})();
