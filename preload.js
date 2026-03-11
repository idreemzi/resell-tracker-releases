const { contextBridge, ipcRenderer } = require('electron')

function collection(name) {
  return {
    getAll:  ()           => ipcRenderer.invoke(`${name}:getAll`),
    add:     item         => ipcRenderer.invoke(`${name}:add`, item),
    update:  (id, updates)=> ipcRenderer.invoke(`${name}:update`, id, updates),
    delete:  id           => ipcRenderer.invoke(`${name}:delete`, id)
  }
}

contextBridge.exposeInMainWorld('api', {
  sales:          collection('sales'),
  inventory:      collection('inventory'),
  packages:       collection('packages'),
  releases:       collection('releases'),
  pinned:         collection('pinned'),
  pickPhoto:      ()                     => ipcRenderer.invoke('photo:pick'),
  readPhoto:      filePath               => ipcRenderer.invoke('photo:read', filePath),
  openTracking:   (trackingNum, carrier) => ipcRenderer.invoke('tracking:open', trackingNum, carrier),
  fetchTrackingEvents: (trackingNum, carrier) => ipcRenderer.invoke('tracking:fetchEvents', trackingNum, carrier),
  getSettings:    ()                     => ipcRenderer.invoke('settings:get'),
  setSettings:    settings               => ipcRenderer.invoke('settings:set', settings),
  openExternal:   url                    => ipcRenderer.invoke('shell:openExternal', url),
  getVersion:     ()                     => ipcRenderer.invoke('app:version'),
  windowMinimize: ()                     => ipcRenderer.invoke('window:minimize'),
  windowClose:    ()                     => ipcRenderer.invoke('window:close'),
  auth: {
    check:        ()  => ipcRenderer.invoke('auth:check'),
    login:        ()  => ipcRenderer.invoke('auth:login'),
    logout:       ()  => ipcRenderer.invoke('auth:logout'),
    loadMain:     ()  => ipcRenderer.invoke('auth:loadMain'),
  }
})
