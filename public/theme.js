"use strict";

// Run before the stylesheet so a saved light preference is applied at first paint.
(() => {
  let theme = "dark";
  try {
    const saved = localStorage.getItem("scene-finder-theme");
    if (saved === "light" || saved === "dark") theme = saved;
  } catch { /* Appearance still works when storage is unavailable. */ }

  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    document.getElementById("theme-color").setAttribute("content", theme === "dark" ? "#151518" : "#f6f7fa");
    for (const mode of ["light", "dark"]) {
      document.getElementById(`theme-${mode}`)?.setAttribute("aria-pressed", String(theme === mode));
    }
  }

  applyTheme();
  document.addEventListener("DOMContentLoaded", () => {
    for (const mode of ["light", "dark"]) {
      document.getElementById(`theme-${mode}`).addEventListener("click", () => {
        theme = mode;
        applyTheme();
        try { localStorage.setItem("scene-finder-theme", theme); } catch { /* Keep the current choice for this window. */ }
      });
    }
    applyTheme();
  });
})();
