const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  showOnScreenKeyboard: () => ipcRenderer.send('show-keyboard'),
  hideOnScreenKeyboard: () => ipcRenderer.send('hide-keyboard'),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  restoreWindow: () => ipcRenderer.send('restore-window'),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  onFullscreenChanged: (callback) => ipcRenderer.on('fullscreen-changed', (_event, isFull) => callback(isFull)),
  updateTraySettings: () => ipcRenderer.send('update-tray-settings'),
});
