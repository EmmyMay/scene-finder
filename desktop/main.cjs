const { app, BrowserWindow, ipcMain, session, dialog, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');
const settings = require('./settings.cjs');

app.setName('Scene Finder');
let window, backend, origin, quitting = false;
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(start).catch(() => {
    dialog.showErrorBox('Scene Finder could not start', 'The local movie service could not start. Close Scene Finder and try again. If this continues, reinstall the app.');
    app.quit();
  });
}

function isOwnUrl(value) {
  try { return new URL(value).origin === origin; } catch { return false; }
}

async function start() {
  const root = app.getAppPath();
  await settings.initialize(app.getPath('userData'));
  const { startServer } = await import(pathToFileURL(path.join(root, 'dist/server.js')).href);
  const extension = process.platform === 'win32' ? '.exe' : '';
  const mediaDirectory = app.isPackaged ? path.join(process.resourcesPath, 'media') : path.join(root, '.data/media');
  const ffmpegPath = path.join(mediaDirectory, `ffmpeg${extension}`);
  const ffprobePath = path.join(mediaDirectory, `ffprobe${extension}`);
  const token = randomBytes(32).toString('hex');
  backend = await startServer({
    host: '127.0.0.1', port: 0, apiToken: token,
    getApiKey: settings.getApiKey, getJevModel: () => settings.getSettings().model,
    dataDir: path.join(app.getPath('userData'), 'movies'),
    publicDir: path.join(root, 'public'), ffmpegPath, ffprobePath,
  });
  origin = backend.url;
  const browserSession = session.fromPartition('scene-finder');
  browserSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, 'X-Scene-Finder-Token': token } });
  });
  browserSession.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders,
      'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'"],
    } });
  });
  browserSession.setPermissionRequestHandler((_contents, permission, callback, details) => callback(permission === 'fullscreen' && isOwnUrl(details.requestingUrl)));
  browserSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => permission === 'fullscreen' && isOwnUrl(requestingOrigin));
  browserSession.on('will-download', (event, item, contents) => {
    if (contents !== window?.webContents || item.getInitiatorOrigin() !== origin) { event.preventDefault(); return; }
    item.setSaveDialogOptions({ title: 'Save your scene', defaultPath: item.getFilename(), filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
  });

  for (const [channel, handler] of Object.entries({ 'settings:get': settings.getSettings, 'settings:save': settings.saveApiKey, 'settings:clear': settings.clearApiKey, 'appearance:get': settings.getAppearance, 'appearance:set': settings.setAppearance })) {
    ipcMain.handle(channel, async (event, value) => {
      if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !isOwnUrl(event.senderFrame.url)) throw new Error('This action is unavailable.');
      return handler(value);
    });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  createWindow(browserSession);
  app.on('activate', () => { if (!window && !quitting) createWindow(browserSession); });
}

function createWindow(browserSession) {
  window = new BrowserWindow({
    title: 'Scene Finder', width: 1280, height: 900, minWidth: 760, minHeight: 640,
    backgroundColor: settings.getAppearance() === 'light' ? '#f5f5f8' : '#111217', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), session: browserSession, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!isOwnUrl(url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('ready-to-show', () => {
    window?.show();
    // OS keychain access can require user interaction; always show the app first.
    void settings.unlockSavedKey().catch(() => {}).finally(() => window?.webContents.send('settings:changed'));
  });
  window.on('closed', () => { window = null; });
  void window.loadURL(origin);
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quitting || !backend) return;
  event.preventDefault(); quitting = true;
  backend.close().finally(() => app.quit());
});
