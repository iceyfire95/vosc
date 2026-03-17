const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig:       ()                    => ipcRenderer.invoke('get-config'),
  saveConfig:      (config)              => ipcRenderer.invoke('save-config', config),
  openOverlay:     ()                    => ipcRenderer.invoke('open-overlay'),
  openEditOverlay: ()                    => ipcRenderer.invoke('open-edit-overlay'),
  getLog:          (connId)              => ipcRenderer.invoke('get-log', connId),
  getTcpStatus:    ()                    => ipcRenderer.invoke('get-tcp-status'),
  sendTcpRequest:  (connId, addr, args)  => ipcRenderer.invoke('send-tcp-request', connId, addr, args),
  onOscMessage:    (callback) => { ipcRenderer.on('osc-message',  (_, d) => callback(d)); },
  onTcpStatus:     (callback) => { ipcRenderer.on('tcp-status',   (_, d) => callback(d)); }
});
