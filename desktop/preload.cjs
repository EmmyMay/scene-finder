const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('sceneFinderDesktop', {
  openMovie: (file, requestId) => {
    // Derive a path only from a genuine OS-backed File selected or dropped by the user.
    const filePath = webUtils.getPathForFile(file);
    if (!filePath) throw new Error('Choose a movie from this device.');
    return ipcRenderer.invoke('movies:open', filePath, requestId);
  },
  cancelOpenMovie: requestId => ipcRenderer.invoke('movies:cancel', requestId),
  onMovieProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('movies:progress', listener);
    return () => ipcRenderer.removeListener('movies:progress', listener);
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveApiKey: (key) => ipcRenderer.invoke('settings:save', key),
  clearApiKey: () => ipcRenderer.invoke('settings:clear'),
  getAppearance: () => ipcRenderer.invoke('appearance:get'),
  setAppearance: (theme) => ipcRenderer.invoke('appearance:set', theme),
  onConnectionChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },
});
