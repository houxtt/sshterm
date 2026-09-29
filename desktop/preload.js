'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sshtermDesktop', Object.freeze({
  openSocket: (id, url) => ipcRenderer.invoke('sshterm:open-socket', id, url),
  sendSocket: (id, data) => ipcRenderer.send('sshterm:socket-send', id, data),
  closeSocket: id => ipcRenderer.send('sshterm:socket-close', id),
  onSocketEvent: listener => {
    const handler = (_event, message) => listener(message);
    ipcRenderer.on('sshterm:socket-event', handler);
    return () => ipcRenderer.removeListener('sshterm:socket-event', handler);
  },
}));
