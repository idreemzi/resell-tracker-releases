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
  monitors: {
    getAll:  ()            => ipcRenderer.invoke('monitors:getAll'),
    add:     item          => ipcRenderer.invoke('monitors:add', item),
    update:  (id, updates) => ipcRenderer.invoke('monitors:update', id, updates),
    delete:  id            => ipcRenderer.invoke('monitors:delete', id),
    test:    id            => ipcRenderer.invoke('monitors:test', id),
  },
  localMonitors: {
    start: monitors  => ipcRenderer.invoke('localMonitors:start', monitors),
    stop:  monitorId => ipcRenderer.invoke('localMonitors:stop', monitorId),
  },
  pickPhoto:      ()                     => ipcRenderer.invoke('photo:pick'),
  readPhoto:      filePath               => ipcRenderer.invoke('photo:read', filePath),
  openTracking:   (trackingNum, carrier) => ipcRenderer.invoke('tracking:open', trackingNum, carrier),
  fetchTrackingEvents: (trackingNum, carrier) => ipcRenderer.invoke('tracking:fetchEvents', trackingNum, carrier),
  getSettings:         ()         => ipcRenderer.invoke('settings:get'),
  setSettings:         settings  => ipcRenderer.invoke('settings:set', settings),
  migrateToSupabase:   ()        => ipcRenderer.invoke('data:migrateToSupabase'),
  openExternal:   url                    => ipcRenderer.invoke('shell:openExternal', url),
  getVersion:     ()                     => ipcRenderer.invoke('app:version'),
  windowMinimize: ()                     => ipcRenderer.invoke('window:minimize'),
  windowClose:    ()                     => ipcRenderer.invoke('window:close'),
  windowFlash:    ()                     => ipcRenderer.invoke('window:flash'),
  auth: {
    check:        ()  => ipcRenderer.invoke('auth:check'),
    login:        ()  => ipcRenderer.invoke('auth:login'),
    logout:       ()  => ipcRenderer.invoke('auth:logout'),
    loadMain:     ()  => ipcRenderer.invoke('auth:loadMain'),
  },
  onDataReloaded:      cb => ipcRenderer.on('data:reloaded',        ()     => cb()),
  onMonitorAlert:      cb => ipcRenderer.on('monitor:alert',        (_, d) => cb(d)),
  onShopifyFeed:       cb => ipcRenderer.on('shopify:feedUpdate',   (_, d) => cb(d)),
  onDiscordKeyword:    cb => ipcRenderer.on('discord:keywordAlert', (_, d) => cb(d)),
  selfbot: {
    getToken:       ()     => ipcRenderer.invoke('selfbot:getToken'),
    setToken:       (t)    => ipcRenderer.invoke('selfbot:setToken', t),
    getKeywords:    ()     => ipcRenderer.invoke('selfbot:getKeywords'),
    setKeywords:    (kws)  => ipcRenderer.invoke('selfbot:setKeywords', kws),
    status:         ()     => ipcRenderer.invoke('selfbot:status'),
    start:          ()     => ipcRenderer.invoke('selfbot:start'),
    stop:           ()     => ipcRenderer.invoke('selfbot:stop'),
    getChannels:    ()     => ipcRenderer.invoke('selfbot:getChannels'),
    addChannel:     (id)   => ipcRenderer.invoke('selfbot:addChannel', id),
    removeChannel:  (id)   => ipcRenderer.invoke('selfbot:removeChannel', id),
    getChannelNames:    ()    => ipcRenderer.invoke('selfbot:getChannelNames'),
    getFeedChannels:    ()    => ipcRenderer.invoke('selfbot:getFeedChannels'),
    addFeedChannel:     (id)  => ipcRenderer.invoke('selfbot:addFeedChannel', id),
    removeFeedChannel:  (id)  => ipcRenderer.invoke('selfbot:removeFeedChannel', id),
  },
  onSelfbotStatus:  cb => ipcRenderer.on('selfbot:statusUpdate', (_, d) => cb(d)),
  onDiscordFeed:    cb => ipcRenderer.on('discord:feedMessage',  (_, d) => cb(d)),
  advisor: {
    chat: (messages, apiKey) => ipcRenderer.invoke('advisor:chat', messages, apiKey),
  },
  proxies: {
    getAll:  ()      => ipcRenderer.invoke('proxies:getAll'),
    add:     list    => ipcRenderer.invoke('proxies:add', list),
    delete:  id      => ipcRenderer.invoke('proxies:delete', id),
    test:    id      => ipcRenderer.invoke('proxies:test', id),
    testAll: ()      => ipcRenderer.invoke('proxies:testAll'),
    clear:   (type)  => ipcRenderer.invoke('proxies:clear', type),
  },
  onProxyTestResult: cb => ipcRenderer.on('proxy:testResult',   (_, d) => cb(d)),
  onNikeBoost:       cb => ipcRenderer.on('monitor:nikeBoost',  (_, d) => cb(d)),
})
