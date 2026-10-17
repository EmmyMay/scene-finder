"use strict";

const ui = Object.fromEntries([
  "setup-notice", "error-notice", "replace-movie", "movie-file", "drop-zone",
  "movie-player", "upload-empty", "choose-movie", "upload-state", "upload-name",
  "upload-label", "upload-percent", "upload-progress", "cancel-upload", "movie-name",
  "movie-details", "playback-time", "timeline", "timeline-end", "timeline-markers",
  "contact-empty", "contact-strip", "search-form", "scene-query", "search-button",
  "search-progress-panel", "search-phase", "cancel-search", "search-progress",
  "search-count", "results-heading", "results-count", "results-status", "results-list",
  "sample-note", "resume-search", "settings-button", "settings-dialog", "close-settings", "settings-form",
  "api-key", "connection-status", "settings-error", "save-connection", "remove-connection",
  "cleanup-notice", "cleanup-message", "retry-cleanup",
  "clip-editor", "clip-duration", "clip-start", "clip-end", "set-clip-start", "set-clip-end",
  "clip-error", "preview-clip", "export-clip", "cancel-clip-export", "save-clip",
  "clip-export-progress", "clip-export-status", "query-shortcut",
].map(id => [id, document.getElementById(id)]));

const state = { generation: 0, movie: null, upload: null, run: null, ready: false, results: [], duration: 0 };
const player = ui["movie-player"];
const desktop = globalThis.sceneFinderDesktop;
const hasDesktopSettings = desktop && ["getSettings", "saveApiKey", "clearApiKey"].every(method => typeof desktop[method] === "function");
const hasDirectFileOpening = desktop && ["openMovie", "cancelOpenMovie", "onMovieProgress"].every(method => typeof desktop[method] === "function");
const hasConnectionUpdates = hasDesktopSettings && typeof desktop.onConnectionChanged === "function";
const connection = { configured: false, loaded: false, busy: false, loading: Boolean(hasConnectionUpdates), refreshPending: false, readError: false };
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
  if (ui["results-status"].textContent !== message) ui["results-status"].textContent = message;
  ui["results-status"].hidden = !message;
}

function updateControls() {
  ui["scene-query"].disabled = !state.movie || Boolean(state.upload || state.run);
  ui["search-button"].disabled = !state.movie || !state.ready || Boolean(state.upload || state.run) || pendingCleanup.size > 0 || !ui["scene-query"].value.trim();
  ui["resume-search"].hidden = !state.resume || state.resume.query !== ui["scene-query"].value.trim();
  ui["resume-search"].disabled = !state.ready || Boolean(state.run || state.upload) || pendingCleanup.size > 0;
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
  if (error.code === "JEV_TIMEOUT") return "Jev took too long to respond. Your matches are kept; retry the remaining frames.";
  if (error.code === "JEV_RATE_LIMITED") return "Jev is limiting requests. Wait a moment, then retry the remaining frames.";
  if (error.code === "FRAME_BUDGET_EXCEEDED") return "This movie is too long for the current search limit. Choose a video shorter than 133 minutes.";
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
    state.ready = health.ready === true && !connection.loading;
    ui["setup-notice"].replaceChildren();
    if (connection.loading) {
      ui["setup-notice"].textContent = "Unlocking saved connection…";
    } else if (!state.ready) {
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
    ui["setup-notice"].textContent = connection.loading ? "Unlocking saved connection…" : "Scene Finder could not connect to the server. Check that it is running, then reload this page.";
    ui["setup-notice"].hidden = false;
  }
  updateControls();
}

function settingsError(message = "") {
  connection.readError = false;
  ui["settings-error"].textContent = message;
  ui["settings-error"].hidden = !message;
}

function updateSettingsControls() {
  ui["settings-form"].setAttribute("aria-busy", String(connection.busy || connection.loading));
  ui["api-key"].disabled = connection.busy || connection.loading || !connection.loaded;
  ui["save-connection"].disabled = connection.busy || connection.loading || !connection.loaded || !ui["api-key"].value.trim();
  ui["remove-connection"].hidden = !connection.configured;
  ui["remove-connection"].disabled = connection.busy || connection.loading;
}

function connectionLabel() {
  if (connection.loading) return "Unlocking saved connection…";
  return connection.configured ? "Jev is connected" : "Jev is not connected";
}

function bridgeError(error) {
  // The desktop bridge contract supplies safe human-readable rejection messages.
  const fallback = "The connection could not be updated. Try again.";
  const message = typeof error?.message === "string" ? error.message : typeof error === "string" ? error : fallback;
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "").trim() || fallback;
}

async function openSettings() {
  if (!hasDesktopSettings) return;
  if (!ui["settings-dialog"].open) ui["settings-dialog"].showModal();
  if (connection.busy) return;
  ui["api-key"].value = "";
  settingsError();
  await refreshConnection();
  if (ui["settings-dialog"].open && connection.loaded && !connection.loading) ui["api-key"].focus();
}

async function refreshConnection() {
  if (!hasDesktopSettings) return;
  // Coalesce notifications that arrive during a read, save, or removal.
  if (connection.busy) { connection.refreshPending = true; return; }
  connection.loaded = false;
  connection.busy = true;
  ui["connection-status"].textContent = connection.loading ? connectionLabel() : "Checking connection…";
  updateSettingsControls();
  try {
    const settings = await desktop.getSettings();
    connection.configured = settings.configured === true;
    connection.loading = settings.loading === true;
    connection.loaded = true;
    if (typeof settings.error === "string" && settings.error) {
      settingsError(settings.error);
      connection.readError = true;
    } else if (connection.readError) settingsError();
    ui["connection-status"].textContent = connectionLabel();
  } catch (error) {
    connection.loading = false;
    ui["connection-status"].textContent = "Connection status unavailable";
    settingsError(bridgeError(error));
    connection.readError = true;
  } finally {
    connection.busy = false;
    if (connection.refreshPending) {
      connection.refreshPending = false;
      await refreshConnection();
    } else {
      updateSettingsControls();
      await checkHealth();
    }
  }
}

async function changeConnection(event, remove = false) {
  event?.preventDefault();
  if (!hasDesktopSettings || connection.busy || connection.loading || !connection.loaded) return;
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
    settingsError(typeof settings.error === "string" ? settings.error : "");
    ui["connection-status"].textContent = connectionLabel();
    await checkHealth();
  } catch (error) {
    ui["connection-status"].textContent = connectionLabel();
    settingsError(bridgeError(error));
  } finally {
    connection.busy = false;
    updateSettingsControls();
    if (connection.refreshPending) {
      connection.refreshPending = false;
      await refreshConnection();
    }
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
  if (hasConnectionUpdates) desktop.onConnectionChanged(() => { void refreshConnection(); });
}

function clearResults() {
  state.resume = null;
  ui["resume-search"].hidden = true;
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
  ui["movie-details"].textContent = "MKV and MP4 supported";
  ui["timeline"].disabled = true;
  ui["timeline"].value = "0";
  ui["timeline-end"].textContent = "—";
  ui["playback-time"].textContent = "00:00 / 00:00";
  clearResults();
  updateControls();
}

function showMovie(movie, source = mediaUrl(movie.mediaUrl)) {
    state.upload = null;
    state.movie = movie;
    state.duration = movie.durationSeconds;
    ui["upload-state"].hidden = true;
    ui["replace-movie"].hidden = false;
    player.hidden = false;
    player.src = source;
    player.load();
    ui["movie-name"].textContent = movie.name;
    ui["movie-details"].textContent = [timecode(movie.durationSeconds), movie.width && movie.height ? `${movie.width} × ${movie.height}` : ""].filter(Boolean).join(" · ");
    ui["timeline-end"].textContent = timecode(state.duration);
    ui["playback-time"].textContent = `00:00 / ${timecode(state.duration)}`;
    seedClip({ startSeconds: 0, endSeconds: Math.min(5, state.duration) });
    ui["clip-editor"].hidden = false;
    resultStatus("Describe a scene to find matching moments.");
    updateControls();
    ui["scene-query"].focus();
    checkHealth();
}

async function openLocalMovie(file) {
  notice();
  resetMovie();
  const requestId = crypto.randomUUID();
  const operation = { generation: state.generation, requestId,
    abort: () => { void desktop.cancelOpenMovie(requestId).catch(() => {}); } };
  state.upload = operation;
  ui["upload-name"].textContent = file.name;
  ui["upload-label"].textContent = "Opening movie…";
  ui["upload-percent"].textContent = "";
  ui["upload-progress"].removeAttribute("value");
  ui["upload-empty"].hidden = true;
  ui["upload-state"].hidden = false;
  resultStatus("Opening your movie from this device.");
  updateControls();
  try {
    const result = await desktop.openMovie(file, requestId);
    if (state.upload !== operation || state.generation !== operation.generation) return;
    if (result.cancelled) { resetMovie(); return; }
    if (result.error) throw new Error(result.error.message);
    const movie = result.movie;
    if (!movie?.id || !Number.isFinite(movie.durationSeconds) || movie.durationSeconds <= 0) throw new Error("The movie could not be opened.");
    showMovie(movie);
  } catch (error) {
    if (state.upload !== operation || state.generation !== operation.generation) return;
    resetMovie();
    notice(bridgeError(error));
    resultStatus("Choose a movie to get started.");
  }
}

if (hasDirectFileOpening) desktop.onMovieProgress(({ requestId, percent }) => {
  if (state.upload?.requestId !== requestId || !Number.isFinite(percent)) return;
  ui["upload-label"].textContent = "Preparing a playback copy…";
  ui["upload-percent"].textContent = `${percent}%`;
  ui["upload-progress"].value = percent;
});

function uploadMovie(file) {
  if (!file) return;
  if (hasDirectFileOpening) { void openLocalMovie(file); return; }
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
    showMovie(movie, source);
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
    if (!isCurrent(run)) return;
    state.resume = run;
    ui["resume-search"].textContent = "Continue searching";
    finishSearch(run, "Search stopped. Your matching moments are kept.");
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
  // Keep scene positions stable as scores/peaks change. Updating results never seeks,
  // reseeds an edited trim, clears an export, or replaces a focused result button.
  const previousOrder = new Map(state.results.map((result, i) => [result.startSeconds, i]));
  results.sort((a, b) => (previousOrder.get(a.startSeconds) ?? Infinity) - (previousOrder.get(b.startSeconds) ?? Infinity) || b.score - a.score);
  state.results = results;
  ui["results-count"].textContent = String(results.length);
  ui["results-count"].hidden = false;
  function reconcile(parent, ordered, kind) {
    const existing = new Map([...parent.children].map(node => [Number(node.dataset.sceneStart), node]));
    ordered.forEach((result, index) => {
      let button = existing.get(result.startSeconds);
      existing.delete(result.startSeconds);
      if (!button) {
        button = element("button", kind);
        button.type = "button";
        button.dataset.sceneStart = String(result.startSeconds);
        if (kind !== "timeline-marker") {
          const img = element("img"); img.alt = ""; img.loading = "lazy";
          button.append(img);
          if (kind === "result") {
            const copy = element("span", "result-copy");
            copy.append(element("strong"), element("span", "timecode"));
            const arrow = element("span", "result-arrow", "↗"); arrow.setAttribute("aria-hidden", "true");
            button.append(copy, arrow);
          } else button.append(element("span", "timecode"));
        }
        button.addEventListener("click", () => {
          const match = button.sceneResult;
          seekTo(kind === "result" ? match : { ...match, startSeconds: match.peakTimestampSeconds });
        });
      }
      button.sceneResult = result;
      button.dataset.resultId = String(result.id);
      button.setAttribute("aria-label", kind === "result" ? `Jump to matching moment ${index + 1}, ${rangeLabel(result)}` : `Jump to matching frame at ${timecode(result.peakTimestampSeconds)}`);
      if (kind === "timeline-marker") button.style.left = `${Math.min(100, result.peakTimestampSeconds / state.duration * 100)}%`;
      else {
        const img = button.querySelector("img");
        if (img.src !== result.thumbnailUrl) img.src = result.thumbnailUrl;
        button.querySelector(".timecode").textContent = kind === "result" ? rangeLabel(result) : timecode(result.peakTimestampSeconds);
        if (kind === "result") button.querySelector("strong").textContent = `Moment ${String(index + 1).padStart(2, "0")}`;
      }
      if (parent.children[index] !== button) parent.insertBefore(button, parent.children[index] || null);
    });
    for (const stale of existing.values()) stale.remove();
  }
  reconcile(ui["results-list"], results, "result");
  const chronological = [...results].sort((a, b) => a.startSeconds - b.startSeconds);
  reconcile(ui["contact-strip"], chronological, "contact");
  reconcile(ui["timeline-markers"], chronological, "timeline-marker");
  ui["contact-strip"].hidden = results.length === 0;
  ui["contact-empty"].hidden = results.length > 0;
  ui["sample-note"].hidden = results.length === 0;
  if (results.length > 0) {
    ui["sample-note"].textContent = `Matching sampled frames${Number.isFinite(step) && step > 0 ? ` · checked every ${step}s` : ""}. Times show observed matches, not exact scene boundaries.`;
    ui["results-list"].setAttribute("aria-busy", "false");
  }
}

async function resumeSearch() {
  if (!state.resume || state.run || state.upload || !state.ready || pendingCleanup.size) return;
  if (state.resume.query !== ui["scene-query"].value.trim()) return;
  const previous = state.resume;
  // Wait for the resume response before cancelling, so DELETE cannot overtake POST.
  const run = { generation: state.generation, id: null, query: previous.query, cancelRequested: false };
  state.resume = null;
  state.run = run;
  notice();
  ui["search-progress-panel"].hidden = false;
  ui["cancel-search"].disabled = false;
  setPhase("Continuing your search…");
  updateControls();
  try {
    await request(`/api/searches/${encodeURIComponent(previous.id)}/resume`, { method: "POST" });
    run.id = previous.id;
    if (!isCurrent(run)) { queueCleanup(run); return; }
    if (run.cancelRequested) { cancelSearch(run); return; }
    pollSearch(run);
  } catch (error) {
    run.id = previous.id;
    if (!isCurrent(run)) { queueCleanup(run); return; }
    if (run.cancelRequested) { cancelSearch(run); return; }
    if (error.status === 404) {
      finishSearch(run, "This search is no longer available. Start a new search.");
      return;
    }
    // A lost response may still have resumed the job: observe its state before retrying.
    pollSearch(run);
  }
}
ui["resume-search"].addEventListener("click", resumeSearch);

async function pollSearch(run) {
  if (!isCurrent(run) || run.cancelRequested) return;
  run.controller = new AbortController();
  try {
    const search = await request(`/api/searches/${encodeURIComponent(run.id)}`, { signal: run.controller.signal });
    if (!isCurrent(run) || run.cancelRequested) return;
    if (search.movieId !== state.movie.id || search.id !== run.id) throw new Error("Invalid search response");
    run.failures = 0;
    const results = validResults(search.results);
    const signature = JSON.stringify(results);
    if (run.resultsSignature !== signature) {
      renderResults(results, search.sampleStepSeconds);
      run.resultsSignature = signature;
    }
    if (search.status === "completed") {
      finishSearch(run, results.length ? `${results.length} matching ${results.length === 1 ? "moment" : "moments"}. Select one to jump there.` : "No matching moments found. Try a different description with visible details from the scene.");
      return;
    }
    if (search.status === "failed") {
      state.resume = run;
      ui["resume-search"].textContent = "Retry remaining frames";
      finishSearch(run, "Search paused. Your matching moments are kept.");
      notice(errorMessage({ code: search.error?.code }, "The scene search could not finish."));
      return;
    }
    if (search.status === "cancelled") { state.resume = run; ui["resume-search"].textContent = "Continue searching"; finishSearch(run, "Search stopped. Your matching moments are kept."); return; }
    const phases = { queued: "Waiting to search…", extracting: "Reading your movie…", searching: "Looking for your scene…" };
    if (!phases[search.status]) throw new Error("Unknown search status");
    setPhase(search.retrying ? "Jev is busy. Retrying shortly…" : phases[search.status]);
    if (results.length) resultStatus(`${results.length} matching ${results.length === 1 ? "moment" : "moments"} so far. You can play or clip one while the search continues.`);
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
  const run = { generation: state.generation, id: null, query, cancelRequested: false };
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
ui["cancel-upload"].addEventListener("click", () => { resetMovie(); resultStatus("Opening cancelled. Choose a movie when you’re ready."); });
ui["search-form"].addEventListener("submit", startSearch);
ui["scene-query"].addEventListener("input", updateControls);
const platform = globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || "";
ui["query-shortcut"].textContent = /mac|iphone|ipad/i.test(platform) ? "⌘ Enter" : "Ctrl Enter";
ui["query-shortcut"].hidden = false;
ui["scene-query"].addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.isComposing && !event.repeat && !ui["search-button"].disabled) {
    event.preventDefault();
    ui["search-form"].requestSubmit();
  }
});
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

if (hasConnectionUpdates) void refreshConnection();
else checkHealth();
