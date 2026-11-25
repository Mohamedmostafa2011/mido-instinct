const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('midoNative', {
  platform: 'windows',
  flash: () => ipcRenderer.send('mido:flash'),
  show: () => ipcRenderer.send('mido:show'),
  setBadge: (n) => ipcRenderer.send('mido:badge', n | 0),
});
