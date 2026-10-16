const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sceneFinderDesktop', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveApiKey: (key) => ipcRenderer.invoke('settings:save', key),
  clearApiKey: () => ipcRenderer.invoke('settings:clear'),
  getAppearance: () => ipcRenderer.invoke('appearance:get'),
  setAppearance: (theme) => ipcRenderer.invoke('appearance:set', theme),
});
