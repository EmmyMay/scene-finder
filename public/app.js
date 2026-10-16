"use strict";

const ui = Object.fromEntries([
  "setup-notice", "error-notice", "replace-movie", "movie-file", "drop-zone",
  "movie-player", "upload-empty", "choose-movie", "upload-state", "upload-name",
  "upload-label", "upload-percent", "upload-progress", "cancel-upload", "movie-name",
  "movie-details", "playback-time", "timeline", "timeline-end", "timeline-markers",
  "contact-empty", "contact-strip", "search-form", "scene-query", "search-button",
  "search-progress-panel", "search-phase", "cancel-search", "search-progress",
  "search-count", "results-heading", "results-count", "results-status", "results-list",
  "sample-note", "settings-button", "settings-dialog", "close-settings", "settings-form",
  "api-key", "connection-status", "settings-error", "save-connection", "remove-connection",
  "cleanup-notice", "cleanup-message", "retry-cleanup",
  "clip-editor", "clip-duration", "clip-start", "clip-end", "set-clip-start", "set-clip-end",
  "clip-error", "preview-clip", "export-clip", "cancel-clip-export", "save-clip",
  "clip-export-progress", "clip-export-status",
].map(id => [id, document.getElementById(id)]));

const state = { generation: 0, movie: null, upload: null, run: null, ready: false, results: [], duration: 0 };
const player = ui["movie-player"];
const desktop = globalThis.sceneFinderDesktop;
const hasDesktopSettings = desktop && ["getSettings", "saveApiKey", "clearApiKey"].every(method => typeof desktop[method] === "function");
const connection = { configured: false, loaded: false, busy: false };
// Detached jobs outlive the active movie until cancellation is confirmed.
const pendingCleanup = new Set();
const clip = { previewing: false };

function timecode(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const parts = [minutes, total % 60].map(value => String(value).padStart(2, "0"));
  if (hours) parts.unshift(String(hours).padStart(2, "0"));
  return parts.join(":");
}

function rangeLabel(result) {
  const start = timecode(result.startSeconds);
  return result.startSeconds === result.endSeconds ? start : `${start} – ${timecode(result.endSeconds)}`;
}

function notice(message = "") {
  ui["error-notice"].textContent = message;
  ui["error-notice"].hidden = !message;
}

function resultStatus(message) {
  ui["results-status"].textContent = message;
  ui["results-status"].hidden = !message;
}

function updateControls() {
  ui["scene-query"].disabled = !state.movie || Boolean(state.upload || state.run);
  ui["search-button"].disabled = !state.movie || !state.ready || Boolean(state.upload || state.run) || pendingCleanup.size > 0 || !ui["scene-query"].value.trim();
  ui["search-form"].setAttribute("aria-busy", String(Boolean(state.run)));
}

function mediaUrl(path) {
  if (typeof path !== "string" || !path) throw new Error("Invalid media response");
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin || !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid media response");
  return url.href;
}

async function request(path, options = {}) {
  const response = await fetch(path, options);
  let data;
  try { data = await response.json(); } catch { throw new Error("The server returned an unreadable response. Try again."); }
  if (!response.ok) {
    const error = new Error("The request could not be completed.");
    error.status = response.status;
    error.code = data.error?.code || data.code || "";
    throw error;
  }
  return data;
}

function errorMessage(error, action) {
  if (error.status === 413) return "This movie is too large to upload. Choose a smaller video and try again.";
  if (error.status === 415 || /invalid_video|unsupported|probe/i.test(error.code || "")) return "This file could not be read as a movie. Choose a valid MKV or MP4 file and try again.";
  if (error.status === 429) return "Scene search is busy. Wait a moment, then try again.";
  if (/key|config|setup|ffmpeg|ffprobe/i.test(error.code || "")) return hasDesktopSettings ? "Scene search needs setup. Open Settings to check your Jev connection, then try again." : "Scene search needs setup. Ask the person running Scene Finder to check the server configuration, then check again above.";
  if (error.status === 404) return "This movie or search is no longer available. Choose your movie again.";
  return `${action} Check your connection and try again.`;
}

async function checkHealth() {
  const version = state.healthVersion = (state.healthVersion || 0) + 1;
  try {
    const health = await request("/api/health");
    if (version !== state.healthVersion) return;
    state.ready = health.ready === true;
    ui["setup-notice"].replaceChildren();
    if (!state.ready) {
      const text = document.createElement("span");
      const needsConnection = hasDesktopSettings && health.checks?.apiKey === false;
      text.textContent = needsConnection ? "Connect Jev in Settings to search your movie. " : hasDesktopSettings ? "Scene Finder is not ready to process movies. Restart the app, then check again. " : "Scene search needs setup. Ask the person running Scene Finder to check the server configuration. ";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "text-button";
      retry.textContent = needsConnection ? "Open Settings" : "Check again";
      retry.addEventListener("click", needsConnection ? openSettings : checkHealth);
      ui["setup-notice"].append(text, retry);
    }
    ui["setup-notice"].hidden = state.ready;
  } catch {
    if (version !== state.healthVersion) return;
    state.ready = false;
    ui["setup-notice"].textContent = "Scene Finder could not connect to the server. Check that it is running, then reload this page.";
    ui["setup-notice"].hidden = false;
  }
  updateControls();
}

function settingsError(message = "") {
  ui["settings-error"].textContent = message;
  ui["settings-error"].hidden = !message;
}

function updateSettingsControls() {
  ui["settings-form"].setAttribute("aria-busy", String(connection.busy));
  ui["api-key"].disabled = connection.busy || !connection.loaded;
  ui["save-connection"].disabled = connection.busy || !connection.loaded || !ui["api-key"].value.trim();
  ui["remove-connection"].hidden = !connection.configured;
  ui["remove-connection"].disabled = connection.busy;
}

function connectionLabel() {
  return connection.configured ? "Jev is connected" : "Jev is not connected";
}

function bridgeError(error) {
  // The desktop bridge contract supplies safe human-readable rejection messages.
  return typeof error?.message === "string" ? error.message : typeof error === "string" ? error : "The connection could not be updated. Try again.";
}

async function openSettings() {
  if (!hasDesktopSettings) return;
  if (!ui["settings-dialog"].open) ui["settings-dialog"].showModal();
  if (connection.busy) return;
  ui["api-key"].value = "";
  settingsError();
  connection.loaded = false;
  connection.busy = true;
  ui["connection-status"].textContent = "Checking connection…";
  updateSettingsControls();
  try {
    const settings = await desktop.getSettings();
    connection.configured = settings.configured === true;
    connection.loaded = true;
    ui["connection-status"].textContent = connectionLabel();
  } catch (error) {
    ui["connection-status"].textContent = "Connection status unavailable";
    settingsError(bridgeError(error));
  } finally {
    connection.busy = false;
    updateSettingsControls();
    if (ui["settings-dialog"].open && connection.loaded) ui["api-key"].focus();
  }
}

async function changeConnection(event, remove = false) {
  event?.preventDefault();
  if (!hasDesktopSettings || connection.busy || !connection.loaded) return;
  const key = ui["api-key"].value.trim();
  if (!remove && !key) return;
  // Keep credentials out of application state and clear the field before crossing the bridge.
  ui["api-key"].value = "";
  connection.busy = true;
  settingsError();
  ui["connection-status"].textContent = remove ? "Removing connection…" : "Checking and saving connection…";
  updateSettingsControls();
  try {
    const settings = remove ? await desktop.clearApiKey() : await desktop.saveApiKey(key);
    connection.configured = settings.configured === true;
    ui["connection-status"].textContent = connectionLabel();
    await checkHealth();
  } catch (error) {
    ui["connection-status"].textContent = connectionLabel();
    settingsError(bridgeError(error));
  } finally {
    connection.busy = false;
    updateSettingsControls();
  }
}

if (hasDesktopSettings) {
  ui["settings-button"].hidden = false;
  ui["settings-button"].addEventListener("click", openSettings);
  ui["close-settings"].addEventListener("click", () => ui["settings-dialog"].close());
  ui["settings-dialog"].addEventListener("close", () => { ui["api-key"].value = ""; settingsError(); });
  ui["settings-form"].addEventListener("submit", changeConnection);
  ui["api-key"].addEventListener("input", updateSettingsControls);
  ui["remove-connection"].addEventListener("click", event => changeConnection(event, true));
}

function clearResults() {
  state.results = [];
  ui["results-list"].replaceChildren();
  ui["contact-strip"].replaceChildren();
  ui["timeline-markers"].replaceChildren();
  ui["contact-strip"].hidden = true;
  ui["contact-empty"].hidden = false;
  ui["results-count"].hidden = true;
  ui["sample-note"].hidden = true;
}

function isCurrent(run) {
  return state.run === run && run.generation === state.generation;
}

async function deleteSearch(run) {
  if (!run.id) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    await request(`/api/searches/${encodeURIComponent(run.id)}`, { method: "DELETE", signal: controller.signal });
  } catch (error) {
    // A search removed by the server has no remaining work to cancel.
    if (error.status !== 404) throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function updateCleanupNotice() {
  const jobs = [...pendingCleanup];
  ui["cleanup-notice"].hidden = jobs.length === 0;
  if (jobs.some(run => run.creationUncertain)) {
    ui["cleanup-message"].textContent = hasDesktopSettings ? "A search response was lost, so cancellation cannot be confirmed. Quit and reopen Scene Finder before searching again." : "A search response was lost, so cancellation cannot be confirmed. Restart the Scene Finder server before searching again.";
  } else if (jobs.some(run => run.cleanupFailures > 0)) {
    ui["cleanup-message"].textContent = "A previous search could not be stopped and may still be running. Check your connection and retry cancellation. New searches are paused until it stops.";
  } else {
    ui["cleanup-message"].textContent = "Stopping the previous search before starting another…";
  }
  ui["retry-cleanup"].hidden = !jobs.some(run => run.id && run.cleanupFailures > 0);
  ui["retry-cleanup"].disabled = !jobs.some(run => run.id && !run.cleanupBusy);
  updateControls();
}

async function retryCleanup(run) {
  if (!pendingCleanup.has(run) || !run.id || run.cleanupBusy) return;
  clearTimeout(run.cleanupTimer);
  run.cleanupBusy = true;
  updateCleanupNotice();
  try {
    await deleteSearch(run);
    pendingCleanup.delete(run);
  } catch {
    run.cleanupFailures = (run.cleanupFailures || 0) + 1;
    // Keep the job and its ID after bounded retries so the user can retry explicitly.
    if (run.cleanupFailures < 3) run.cleanupTimer = setTimeout(() => retryCleanup(run), 1000 * run.cleanupFailures);
  } finally {
    run.cleanupBusy = false;
    updateCleanupNotice();
  }
}

function queueCleanup(run) {
  pendingCleanup.add(run);
  updateCleanupNotice();
  if (run.id) retryCleanup(run);
}

ui["retry-cleanup"].addEventListener("click", () => {
  for (const run of pendingCleanup) if (run.id && !run.cleanupBusy) {
    run.cleanupFailures = 0;
    retryCleanup(run);
  }
});

function detachSearch() {
  const old = state.run;
  state.run = null;
  if (old) {
    clearTimeout(old.timer);
    old.controller?.abort();
    // Preserve even a pending creation until its eventual ID can be cancelled.
    queueCleanup(old);
  }
  ui["search-progress-panel"].hidden = true;
  ui["results-list"].setAttribute("aria-busy", "false");
}

function resetMovie() {
  stopClipPreview();
  resetClipExport();
  ui["clip-editor"].hidden = true;
  ui["clip-error"].hidden = true;
  state.generation += 1;
  detachSearch();
  const upload = state.upload;
  state.upload = null;
  upload?.abort();
  state.movie = null;
  state.duration = 0;
  player.pause();
  player.removeAttribute("src");
  player.load();
  player.hidden = true;
  ui["upload-empty"].hidden = false;
  ui["upload-state"].hidden = true;
  ui["replace-movie"].hidden = true;
  ui["movie-name"].textContent = "No movie selected";
  ui["movie-details"].textContent = "—";
  ui["timeline"].disabled = true;
  ui["timeline"].value = "0";
  ui["timeline-end"].textContent = "—";
  ui["playback-time"].textContent = "00:00 / 00:00";
  clearResults();
  updateControls();
}

function uploadMovie(file) {
  if (!file) return;
  notice();
  resetMovie();
  const generation = state.generation;
  const xhr = new XMLHttpRequest();
  state.upload = xhr;
  ui["upload-name"].textContent = file.name;
  ui["upload-label"].textContent = "Uploading movie…";
  ui["upload-percent"].textContent = "0%";
  ui["upload-progress"].value = 0;
  ui["upload-empty"].hidden = true;
  ui["upload-state"].hidden = false;
  resultStatus("Your movie will be ready to search after the upload.");
  updateControls();

  function preparingMovie() {
    if (generation !== state.generation || state.upload !== xhr) return;
    ui["upload-label"].textContent = "Preparing movie…";
    ui["upload-percent"].textContent = "100%";
    ui["upload-progress"].removeAttribute("value");
  }
  xhr.upload.addEventListener("load", preparingMovie);
  xhr.upload.addEventListener("progress", event => {
    if (generation !== state.generation || state.upload !== xhr) return;
    if (event.lengthComputable) {
      const percent = Math.min(100, Math.floor(event.loaded / event.total * 100));
      ui["upload-progress"].value = percent;
      ui["upload-percent"].textContent = `${percent}%`;
      if (percent === 100) preparingMovie();
    } else {
      ui["upload-progress"].removeAttribute("value");
      ui["upload-percent"].textContent = "";
    }
  });

  function fail(message) {
    if (generation !== state.generation) return;
    state.upload = null;
    ui["upload-state"].hidden = true;
    ui["upload-empty"].hidden = false;
    resultStatus("Choose a movie to get started.");
    notice(message);
    updateControls();
  }
  xhr.addEventListener("load", () => {
    if (generation !== state.generation) return;
    let data;
    try { data = JSON.parse(xhr.responseText); } catch { fail("The upload response could not be read. Try again."); return; }
    if (xhr.status < 200 || xhr.status >= 300) {
      fail(errorMessage({ status: xhr.status, code: data.error?.code }, "The movie could not be uploaded."));
      return;
    }
    const movie = data.movie;
    let source;
    try {
      if (!movie?.id || !Number.isFinite(movie.durationSeconds) || movie.durationSeconds <= 0) throw new Error();
      source = mediaUrl(movie.mediaUrl);
    } catch { fail("The movie could not be prepared. Choose the file again."); return; }
    state.upload = null;
    state.movie = movie;
    state.duration = movie.durationSeconds;
    ui["upload-state"].hidden = true;
    ui["replace-movie"].hidden = false;
    player.hidden = false;
    player.src = source;
    player.load();
    ui["movie-name"].textContent = movie.name || file.name;
    ui["movie-details"].textContent = movie.width && movie.height ? `${movie.width} × ${movie.height}` : "";
    ui["timeline-end"].textContent = timecode(state.duration);
    ui["playback-time"].textContent = `00:00 / ${timecode(state.duration)}`;
    seedClip({ startSeconds: 0, endSeconds: Math.min(5, state.duration) });
    ui["clip-editor"].hidden = false;
    resultStatus("Describe a scene to find matching moments.");
    updateControls();
    ui["scene-query"].focus();
    checkHealth();
  });
  xhr.addEventListener("error", () => fail("The movie could not be uploaded. Check your connection and try again."));
  xhr.open("POST", "/api/movies");
  const body = new FormData();
  body.append("file", file);
  xhr.send(body);
}

function setPhase(message) {
  if (ui["search-phase"].textContent !== message) ui["search-phase"].textContent = message;
}

function finishSearch(run, message) {
  if (!isCurrent(run)) return;
  clearTimeout(run.timer);
  state.run = null;
  ui["search-progress-panel"].hidden = true;
  ui["results-list"].setAttribute("aria-busy", "false");
  resultStatus(message);
  updateControls();
}

async function cancelSearch(run = state.run) {
  if (!run || !isCurrent(run)) return;
  run.cancelRequested = true;
  ui["cancel-search"].disabled = true;
  setPhase("Cancelling search…");
  if (!run.id) return;
  clearTimeout(run.timer);
  run.controller?.abort();
  try {
    await deleteSearch(run);
    finishSearch(run, "Search cancelled. Change the description and try again.");
  } catch {
    if (!isCurrent(run)) return;
    run.cancelRequested = false;
    ui["cancel-search"].disabled = false;
    notice("The search could not be cancelled. Check your connection and try Cancel again.");
    run.timer = setTimeout(() => pollSearch(run), 1000);
  }
}

function validResults(results) {
  if (!Array.isArray(results)) throw new Error("Invalid results");
  return results.map(result => {
    if (!result.id || ![result.startSeconds, result.endSeconds, result.peakTimestampSeconds, result.score].every(Number.isFinite) || result.startSeconds < 0 || result.endSeconds < result.startSeconds || result.endSeconds > state.duration + 1 || result.peakTimestampSeconds < result.startSeconds || result.peakTimestampSeconds > result.endSeconds) throw new Error("Invalid result");
    return { ...result, thumbnailUrl: mediaUrl(result.thumbnailUrl) };
  }).sort((a, b) => b.score - a.score);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function markActive(id) {
  for (const parent of [ui["results-list"], ui["contact-strip"], ui["timeline-markers"]]) {
    for (const button of parent.children) {
      const active = button.dataset.resultId === String(id);
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }
}

function seekTo(result) {
  if (!Number.isFinite(player.duration) || player.readyState < 1) {
    notice("The movie is not ready to seek yet. Wait for playback to load, then try again.");
    return;
  }
  // Seek to a measured matching frame, including an isolated single-frame hit.
  player.currentTime = Math.min(result.startSeconds, player.duration);
  ui["timeline"].value = String(player.currentTime);
  markActive(result.id);
  seedClip(result);
}

function clipTime(seconds) {
  const millis = Math.max(0, Math.floor(seconds * 1000 + 0.000001));
  const hours = Math.floor(millis / 3600000);
  const minutes = Math.floor(millis / 60000) % 60;
  const wholeSeconds = Math.floor(millis / 1000) % 60;
  return `${[hours, minutes, wholeSeconds].map(value => String(value).padStart(2, "0")).join(":")}.${String(millis % 1000).padStart(3, "0")}`;
}

function parseClipTime(value) {
  const match = /^(\d+):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number((match[4] || "").padEnd(3, "0")) / 1000;
}

function clipRange() {
  const startSeconds = parseClipTime(ui["clip-start"].value);
  const endSeconds = parseClipTime(ui["clip-end"].value);
  if (!state.movie || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds > state.duration) return null;
  return { startSeconds, endSeconds };
}

function updateClipControls(showError = false) {
  const range = clipRange();
  const exporting = Boolean(clip.export);
  ui["clip-duration"].textContent = range ? `${((range.endSeconds - range.startSeconds)).toFixed(3)}s selected` : "";
  ui["preview-clip"].disabled = !range || player.readyState < 1 || exporting;
  ui["preview-clip"].textContent = clip.previewing ? "Stop preview" : "Preview clip";
  ui["export-clip"].disabled = !range || exporting;
  ui["cancel-clip-export"].hidden = !exporting;
  for (const id of ["clip-start", "clip-end", "set-clip-start", "set-clip-end"]) ui[id].disabled = exporting;
  if (showError) ui["clip-error"].hidden = Boolean(range);
  if (!range && showError) ui["clip-error"].textContent = "Enter valid timecodes with an out point after the in point and within this movie.";
}

function stopClipPreview() {
  clip.version = (clip.version || 0) + 1;
  if (clip.previewing) player.pause();
  clip.previewing = false;
  ui["preview-clip"].textContent = "Preview clip";
}

function seedClip(result) {
  stopClipPreview();
  resetClipExport();
  ui["clip-error"].hidden = true;
  // An initial editable selection gives an isolated sampled hit some playback context.
  // It is a clip choice, not a claim about the detected scene boundary.
  const isolated = result.startSeconds === result.endSeconds;
  const peak = result.peakTimestampSeconds ?? result.startSeconds;
  const start = Math.min(state.duration, isolated ? Math.max(0, peak - 1.5) : result.startSeconds);
  const end = Math.min(state.duration, isolated ? peak + 1.5 : result.endSeconds);
  ui["clip-start"].value = clipTime(start);
  ui["clip-end"].value = clipTime(end);
  updateClipControls();
}

function resetClipExport(message = "") {
  const old = clip.export;
  clip.export = null;
  old?.controller.abort();
  if (clip.downloadUrl) URL.revokeObjectURL(clip.downloadUrl);
  clip.downloadUrl = null;
  ui["save-clip"].removeAttribute("href");
  ui["save-clip"].hidden = true;
  ui["clip-export-progress"].hidden = true;
  ui["clip-export-status"].textContent = message;
  ui["clip-export-status"].hidden = !message;
}

async function exportClip() {
  const range = clipRange();
  if (!range || clip.export) { updateClipControls(true); return; }
  stopClipPreview();
  resetClipExport();
  const job = { controller: new AbortController(), generation: state.generation };
  clip.export = job;
  ui["clip-error"].hidden = true;
  const current = () => clip.export === job && job.generation === state.generation;
  ui["clip-export-progress"].hidden = false;
  ui["clip-export-status"].textContent = "Preparing your MP4 clip…";
  ui["clip-export-status"].hidden = false;
  updateClipControls();
  try {
    const response = await fetch(`/api/movies/${encodeURIComponent(state.movie.id)}/clips`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(range), signal: job.controller.signal,
    });
    if (!response.ok) {
      const error = new Error("Clip export failed");
      error.status = response.status;
      try { error.code = (await response.json()).error?.code; } catch { /* Use the safe fallback below. */ }
      throw error;
    }
    const blob = await response.blob();
    if (!current()) return;
    if (blob.size === 0 || blob.type.split(";")[0] !== "video/mp4") throw new Error("Invalid clip response");
    clip.downloadUrl = URL.createObjectURL(blob);
    ui["save-clip"].href = clip.downloadUrl;
    ui["save-clip"].download = `scene-${range.startSeconds.toFixed(3)}-${range.endSeconds.toFixed(3)}.mp4`;
    ui["save-clip"].hidden = false;
    ui["clip-export-status"].textContent = "Your clip is ready. Choose Save MP4 to save it.";
  } catch (error) {
    if (!current()) return;
    ui["clip-export-status"].textContent = "Clip export could not finish. Try again.";
    ui["clip-error"].textContent = error.status === 400 ? "The clip range could not be exported. Check the in and out points and try again." : errorMessage(error, "The MP4 clip could not be exported.");
    ui["clip-error"].hidden = false;
  } finally {
    if (current()) {
      clip.export = null;
      ui["clip-export-progress"].hidden = true;
      updateClipControls();
    }
  }
}

async function previewClip() {
  if (clip.previewing) { stopClipPreview(); updateClipControls(); return; }
  const range = clipRange();
  if (!range || player.readyState < 1) { updateClipControls(true); return; }
  const version = clip.version = (clip.version || 0) + 1;
  ui["clip-error"].hidden = true;
  player.currentTime = range.startSeconds;
  clip.previewing = true;
  updateClipControls();
  try { await player.play(); } catch {
    if (version !== clip.version) return;
    stopClipPreview();
    ui["clip-error"].textContent = "The clip preview could not play. Try loading the movie again.";
    ui["clip-error"].hidden = false;
  }
}

for (const id of ["clip-start", "clip-end"]) {
  ui[id].addEventListener("input", () => { stopClipPreview(); resetClipExport(); ui["clip-error"].hidden = true; updateClipControls(); });
  ui[id].addEventListener("change", () => updateClipControls(true));
}
for (const boundary of ["start", "end"]) ui[`set-clip-${boundary}`].addEventListener("click", () => {
  if (!state.movie || player.readyState < 1) return;
  stopClipPreview();
  resetClipExport();
  ui[`clip-${boundary}`].value = clipTime(Math.min(player.currentTime, state.duration));
  updateClipControls(true);
});
ui["preview-clip"].addEventListener("click", previewClip);
ui["export-clip"].addEventListener("click", exportClip);
ui["cancel-clip-export"].addEventListener("click", () => { resetClipExport("Clip export cancelled."); updateClipControls(); });
player.addEventListener("pause", () => { clip.previewing = false; updateClipControls(); });

function renderResults(results, step) {
  clearResults();
  state.results = results;
  ui["results-count"].textContent = String(results.length);
  ui["results-count"].hidden = false;
  for (const [index, result] of results.entries()) {
    const button = element("button", "result");
    button.type = "button";
    button.dataset.resultId = String(result.id);
    button.setAttribute("aria-label", `Jump to matching moment ${index + 1}, ${rangeLabel(result)}`);
    const img = element("img");
    img.src = result.thumbnailUrl;
    img.alt = "";
    img.loading = "lazy";
    const copy = element("span", "result-copy");
    copy.append(element("strong", "", `Moment ${String(index + 1).padStart(2, "0")}`), element("span", "timecode", rangeLabel(result)));
    const arrow = element("span", "result-arrow", "↗");
    arrow.setAttribute("aria-hidden", "true");
    button.append(img, copy, arrow);
    button.addEventListener("click", () => seekTo(result));
    ui["results-list"].append(button);
  }
  for (const result of [...results].sort((a, b) => a.peakTimestampSeconds - b.peakTimestampSeconds)) {
    const contact = element("button", "contact");
    contact.type = "button";
    contact.dataset.resultId = String(result.id);
    contact.setAttribute("aria-label", `Jump to matching frame at ${timecode(result.peakTimestampSeconds)}`);
    const img = element("img");
    img.src = result.thumbnailUrl;
    img.alt = "";
    img.loading = "lazy";
    contact.append(img, element("span", "timecode", timecode(result.peakTimestampSeconds)));
    // The contact image depicts the peak frame; the result card seeks to its first hit.
    contact.addEventListener("click", () => seekTo({ ...result, startSeconds: result.peakTimestampSeconds }));
    ui["contact-strip"].append(contact);
    const marker = element("button", "timeline-marker");
    marker.type = "button";
    marker.dataset.resultId = String(result.id);
    marker.style.left = `${Math.min(100, result.peakTimestampSeconds / state.duration * 100)}%`;
    marker.setAttribute("aria-label", `Jump to matching frame at ${timecode(result.peakTimestampSeconds)}`);
    marker.addEventListener("click", () => seekTo({ ...result, startSeconds: result.peakTimestampSeconds }));
    ui["timeline-markers"].append(marker);
  }
  ui["contact-strip"].hidden = results.length === 0;
  ui["contact-empty"].hidden = results.length > 0;
  if (results.length > 0) {
    ui["sample-note"].textContent = `Matching sampled frames${Number.isFinite(step) && step > 0 ? ` · checked every ${step}s` : ""}. Times show observed matches, not exact scene boundaries.`;
    ui["sample-note"].hidden = false;
  }
}

async function pollSearch(run) {
  if (!isCurrent(run) || run.cancelRequested) return;
  run.controller = new AbortController();
  try {
    const search = await request(`/api/searches/${encodeURIComponent(run.id)}`, { signal: run.controller.signal });
    if (!isCurrent(run) || run.cancelRequested) return;
    if (search.movieId !== state.movie.id || search.id !== run.id) throw new Error("Invalid search response");
    run.failures = 0;
    if (search.status === "completed") {
      const results = validResults(search.results);
      renderResults(results, search.sampleStepSeconds);
      finishSearch(run, results.length ? `${results.length} matching ${results.length === 1 ? "moment" : "moments"}. Select one to jump there.` : "No matching moments found. Try a different description with visible details from the scene.");
      return;
    }
    if (search.status === "failed") {
      finishSearch(run, "Search could not finish. You can try again.");
      notice(errorMessage({ code: search.error?.code }, "The scene search could not finish."));
      return;
    }
    if (search.status === "cancelled") { finishSearch(run, "Search cancelled. Change the description and try again."); return; }
    const phases = { queued: "Waiting to search…", extracting: "Reading your movie…", searching: "Looking for your scene…" };
    if (!phases[search.status]) throw new Error("Unknown search status");
    setPhase(phases[search.status]);
    const total = Number(search.total);
    const processed = Math.max(0, Number(search.processed) || 0);
    if (search.status === "searching" && Number.isFinite(total) && total > 0) {
      ui["search-progress"].max = total;
      ui["search-progress"].value = Math.min(processed, total);
      ui["search-count"].textContent = `${Math.min(processed, total)} of ${total} frames checked`;
    } else {
      ui["search-progress"].removeAttribute("value");
      ui["search-count"].textContent = search.status === "extracting" ? "Preparing frames to check. Longer movies take more time." : "Your search will start shortly.";
    }
    run.timer = setTimeout(() => pollSearch(run), 800);
  } catch (error) {
    if (!isCurrent(run) || run.cancelRequested || error.name === "AbortError") return;
    if (error.status === 404) {
      finishSearch(run, "This search is no longer available. Try searching again.");
      return;
    }
    // Keep the ID available so the user can still cancel a job after a connection failure.
    setPhase("Connection interrupted");
    ui["search-count"].textContent = "Reconnecting to your search… You can still cancel.";
    run.failures = (run.failures || 0) + 1;
    if (run.failures < 4 && !error.status) {
      run.timer = setTimeout(() => pollSearch(run), 2000);
    } else {
      notice(errorMessage(error, "Search progress could not be loaded."));
      ui["search-count"].textContent = "Cancel this search before trying again.";
    }
  }
}

async function startSearch(event) {
  event.preventDefault();
  const query = ui["scene-query"].value.trim();
  if (!state.movie || state.upload || state.run || pendingCleanup.size > 0 || !state.ready || !query) return;
  notice();
  clearResults();
  const run = { generation: state.generation, id: null, cancelRequested: false };
  state.run = run;
  ui["search-progress-panel"].hidden = false;
  ui["cancel-search"].disabled = false;
  ui["search-progress"].removeAttribute("value");
  ui["search-count"].textContent = "Starting your search";
  ui["results-list"].setAttribute("aria-busy", "true");
  setPhase("Preparing search…");
  resultStatus("Finding moments that match your description.");
  updateControls();
  try {
    // Do not abort creation: even after a movie change, retrieve the ID and cancel it.
    const data = await request(`/api/movies/${encodeURIComponent(state.movie.id)}/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
    if (typeof data.searchId !== "string" || !data.searchId) throw new Error("Invalid search ID");
    run.id = data.searchId;
    if (!isCurrent(run)) { queueCleanup(run); return; }
    if (run.cancelRequested) { cancelSearch(run); return; }
    pollSearch(run);
  } catch (error) {
    const rejected = error.status >= 400 && error.status < 500;
    if (!isCurrent(run)) {
      if (rejected) pendingCleanup.delete(run);
      else { run.creationUncertain = true; pendingCleanup.add(run); }
      updateCleanupNotice();
      return;
    }
    finishSearch(run, "Search could not start. You can try again.");
    notice(errorMessage(error, "The scene search could not start."));
    if (!rejected) {
      run.creationUncertain = true;
      queueCleanup(run);
      resultStatus("Search startup could not be confirmed. See the cancellation message above.");
    }
  }
}

ui["choose-movie"].addEventListener("click", () => ui["movie-file"].click());
ui["replace-movie"].addEventListener("click", () => ui["movie-file"].click());
ui["movie-file"].addEventListener("change", event => { uploadMovie(event.target.files[0]); event.target.value = ""; });
ui["cancel-upload"].addEventListener("click", () => { resetMovie(); resultStatus("Upload cancelled. Choose a movie when you’re ready."); });
ui["search-form"].addEventListener("submit", startSearch);
ui["scene-query"].addEventListener("input", updateControls);
ui["cancel-search"].addEventListener("click", () => cancelSearch());

let dragDepth = 0;
ui["drop-zone"].addEventListener("dragenter", event => { event.preventDefault(); dragDepth += 1; ui["drop-zone"].classList.add("is-dragging"); });
ui["drop-zone"].addEventListener("dragover", event => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; });
ui["drop-zone"].addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) ui["drop-zone"].classList.remove("is-dragging"); });
ui["drop-zone"].addEventListener("drop", event => {
  event.preventDefault(); dragDepth = 0; ui["drop-zone"].classList.remove("is-dragging");
  uploadMovie(event.dataTransfer.files[0]);
});
for (const name of ["dragover", "drop"]) document.addEventListener(name, event => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); });

player.addEventListener("loadedmetadata", () => {
  if (!state.movie || !Number.isFinite(player.duration)) return;
  ui["timeline"].max = String(player.duration);
  ui["timeline"].disabled = false;
  ui["timeline-end"].textContent = timecode(player.duration);
  updateClipControls();
});
player.addEventListener("timeupdate", () => {
  if (!state.movie) return;
  const duration = Number.isFinite(player.duration) ? player.duration : state.duration;
  ui["playback-time"].textContent = `${timecode(player.currentTime)} / ${timecode(duration)}`;
  ui["timeline"].value = String(player.currentTime);
  const active = state.results.find(result => player.currentTime >= result.startSeconds && player.currentTime <= Math.max(result.endSeconds, result.startSeconds + .5));
  markActive(active?.id);
  const range = clip.previewing && clipRange();
  if (range && player.currentTime >= range.endSeconds) {
    stopClipPreview();
    player.currentTime = range.endSeconds;
    updateClipControls();
  }
});
player.addEventListener("error", () => { if (state.movie) notice("Scene Finder could not play this movie. Choose it again to retry. If playback still fails, report this app issue."); });
ui["timeline"].addEventListener("input", () => { if (player.readyState >= 1) player.currentTime = Number(ui["timeline"].value); });

checkHealth();
