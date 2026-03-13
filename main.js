const { app, BrowserWindow, ipcMain, dialog, shell, net, session, protocol } = require('electron')
const path   = require('path')
const fs     = require('fs')
const http   = require('http')
const https  = require('https')
const dns    = require('dns')
const crypto = require('crypto')

// DNS-over-HTTPS via Cloudflare 1.1.1.1 — bypasses OS DNS and any UDP/53 blocks
const _nikeIpCache = {}
function resolveViaDoh(hostname) {
  if (_nikeIpCache[hostname]) return Promise.resolve(_nikeIpCache[hostname])
  return new Promise((resolve) => {
    const req = https.get({
      host:    '1.1.1.1',
      path:    `/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
      headers: { 'Accept': 'application/dns-json' }
    }, (res) => {
      let body = ''
      res.on('data', d => body += d)
      res.on('end', () => {
        try {
          const json = JSON.parse(body)
          const record = (json.Answer || []).find(r => r.type === 1)
          const ip = record ? record.data : null
          if (ip) _nikeIpCache[hostname] = ip
          console.log(`[nike-doh] ${hostname} -> ${ip || 'FAILED'}`)
          resolve(ip)
        } catch { resolve(null) }
      })
    })
    req.on('error', (e) => { console.log('[nike-doh] DoH error:', e.message); resolve(null) })
    req.setTimeout(8000, () => { req.destroy(); resolve(null) })
  })
}
const DISCORD = require('./discord-config')
const { autoUpdater } = require('electron-updater')

// ── Supabase sync ──────────────────────────────────────────────────────────────
const SUPABASE_URL      = 'https://lpfoqbmtsxfylkmapxfj.supabase.co'
const SUPABASE_ANON_KEY = 'sb_secret_3bTNKSbIXdTDnHcHKsSQ_Q_tcPMbP6N'
let _sbClient = null
function getSb() {
  if (!_sbClient) {
    const { createClient } = require('@supabase/supabase-js')
    _sbClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  }
  return _sbClient
}
function sbSync(fn) {
  // Fire-and-forget Supabase write — never blocks local operation
  Promise.resolve().then(fn).catch(e => console.log('[supabase] sync error:', e.message))
}

// Only send columns that exist in each Supabase table
const SB_COLUMNS = {
  inventory: ['id','user_id','productName','size','qty','store','buyPrice','estimatedResell','notes','photo','source','createdAt'],
  sales:     ['id','user_id','productName','size','qty','buyPrice','sellPrice','platform','date','notes','fees','createdAt'],
  packages:  ['id','user_id','nickname','trackingNumber','carrier','status','description','createdAt'],
}
function sbPick(name, row) {
  const cols = SB_COLUMNS[name]
  if (!cols) return row
  const out = {}
  for (const k of cols) if (row[k] !== undefined) out[k] = row[k]
  return out
}

async function uploadLocalPhoto(filePath, itemId) {
  try {
    if (!filePath || filePath.startsWith('http')) return filePath // already a URL
    if (!fs.existsSync(filePath)) return filePath
    const fileData = fs.readFileSync(filePath)
    const ext      = path.extname(filePath) || '.jpg'
    const name     = `${itemId}${ext}`
    const uid      = getSettings().supabaseUserId
    const storagePath = `${uid}/${name}`
    const { error } = await getSb().storage.from('inventory-photos').upload(storagePath, fileData, { contentType: 'image/jpeg', upsert: true })
    if (error) { console.log('[photo] upload error:', error.message); return filePath }
    const { data } = getSb().storage.from('inventory-photos').getPublicUrl(storagePath)
    return data.publicUrl
  } catch (e) {
    console.log('[photo] error:', e.message)
    return filePath
  }
}

function startRealtimeSync() {
  const uid = getSettings().supabaseUserId
  if (!uid) return
  // Poll every 15 seconds for changes from web
  setInterval(() => syncFromSupabase(), 15000)
  console.log('[sync] polling every 15s')
}

async function syncFromSupabase() {
  const uid = getSettings().supabaseUserId
  if (!uid) return
  try {
    const data = readData()
    let changed = false
    for (const name of ['inventory', 'sales', 'packages']) {
      const { data: rows, error } = await getSb().from(name).select('*').eq('user_id', uid)
      if (error) { console.log(`[sync] ${name} fetch error:`, error.message); continue }
      const remoteIds = new Set(rows.map(r => r.id))
      const localIds  = new Set(data[name].map(r => r.id))
      // Add new items from Supabase
      const newRows = rows.filter(r => !localIds.has(r.id))
      if (newRows.length) {
        data[name].push(...newRows)
        changed = true
        console.log(`[sync] pulled ${newRows.length} new ${name} from Supabase`)
      }
      // Remove items deleted on web
      const before = data[name].length
      data[name] = data[name].filter(r => remoteIds.has(r.id))
      if (data[name].length !== before) {
        changed = true
        console.log(`[sync] removed ${before - data[name].length} deleted ${name}`)
      }
    }
    if (changed) {
      writeData(data)
      mainWindow?.webContents.send('data:reloaded')
    }
  } catch (e) {
    console.log('[sync] error:', e.message)
  }
}

let mainWindow
let dataPath
let photosDir
let proxiesPath

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    },
    title: 'Resell Tracker',
    backgroundColor: '#f0e6d3',
    frame: false,
    show: false
  })

  mainWindow.setMenuBarVisibility(false)
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindowRef = mainWindow

  const authed = await checkAuth()
  if (authed) {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'))
  }
}

// nike-img:// scheme — proxies Nike CDN images through main process with proper headers
protocol.registerSchemesAsPrivileged([
  { scheme: 'nike-img', privileges: { secure: true, bypassCSP: true, corsEnabled: true, supportFetchAPI: true } }
])

app.whenReady().then(() => {
  protocol.handle('nike-img', async (request) => {
    const url = 'https://' + request.url.slice('nike-img://'.length)
    const parsed = new URL(url)
    const ip = await resolveViaDoh(parsed.hostname)
    if (!ip) return new Response('', { status: 404 })
    return new Promise((resolve) => {
      https.get({
        host:       ip,
        path:       parsed.pathname + parsed.search,
        servername: parsed.hostname,
        headers: {
          'Host':       parsed.hostname,
          'Referer':    'https://www.nike.com/',
          'Origin':     'https://www.nike.com',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        }
      }, (res) => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          resolve(new Response(Buffer.concat(chunks), {
            status: res.statusCode,
            headers: { 'Content-Type': res.headers['content-type'] || 'image/jpeg', 'Cache-Control': 'max-age=86400' }
          }))
        })
        res.on('error', () => resolve(new Response('', { status: 502 })))
      }).on('error', (e) => {
        console.log('[nike-img] fetch error:', e.message)
        resolve(new Response('', { status: 404 }))
      })
    })
  })

  // Inject Referer for Nike CDN so product images load in the feed
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://secure-images.nike.com/*', 'https://images.nike.com/*', 'https://static.nike.com/*', 'https://api.nike.com/*'] },
    (details, callback) => {
      details.requestHeaders['Referer']    = 'https://www.nike.com/'
      details.requestHeaders['Origin']     = 'https://www.nike.com'
      details.requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      callback({ requestHeaders: details.requestHeaders })
    }
  )

  const userDataPath = app.getPath('userData')
  dataPath    = path.join(userDataPath, 'data.json')
  proxiesPath = path.join(userDataPath, 'proxies.json')
  photosDir   = path.join(userDataPath, 'photos')
  if (!fs.existsSync(photosDir)) fs.mkdirSync(photosDir, { recursive: true })
  createWindow()
  // Pull from Supabase on startup then listen for live changes
  syncFromSupabase()
  startRealtimeSync()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // ── Auto-updater (only runs in packaged .exe, not in dev) ──────────────
  if (app.isPackaged) {
    autoUpdater.checkForUpdates()

    autoUpdater.on('update-downloaded', () => {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Ready',
        message: 'A new version of Resell Tracker has been downloaded.',
        detail: 'Restart the app now to apply the update.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall()
      })
    })

    autoUpdater.on('error', err => {
      console.error('Auto-updater error:', err.message)
    })
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── Data helpers ──────────────────────────────────────────────────────────────
function readData() {
  try {
    if (!fs.existsSync(dataPath)) return { sales: [], inventory: [], packages: [] }
    const d = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
    return { sales: d.sales || [], inventory: d.inventory || [], packages: d.packages || [] }
  } catch { return { sales: [], inventory: [], packages: [] } }
}

function writeData(data) {
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8')
}

function genId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

// ── Generic CRUD per collection ───────────────────────────────────────────────
function registerCollection(name) {
  ipcMain.handle(`${name}:getAll`, () => readData()[name])

  ipcMain.handle(`${name}:add`, (_, item) => {
    const data    = readData()
    const newItem = { ...item, id: genId(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    data[name].push(newItem)
    writeData(data)
    sbSync(async () => {
      const uid = getSettings().supabaseUserId
      if (!uid) return
      let row = { ...newItem, user_id: uid }
      if (name === 'inventory' && row.photo && !row.photo.startsWith('http')) {
        const url = await uploadLocalPhoto(row.photo, row.id)
        if (url !== row.photo) {
          row.photo = url
          const d = readData()
          d[name] = d[name].map(x => x.id === row.id ? { ...x, photo: url } : x)
          writeData(d)
          mainWindow?.webContents.send('data:reloaded')
        }
      }
      const { error } = await getSb().from(name).insert(sbPick(name, row))
      if (error) console.log(`[supabase] ${name}:add error:`, error.message)
    })
    return newItem
  })

  ipcMain.handle(`${name}:update`, (_, id, updates) => {
    const data = readData()
    const idx  = data[name].findIndex(i => i.id === id)
    if (idx === -1) return null
    data[name][idx] = { ...data[name][idx], ...updates, updatedAt: new Date().toISOString() }
    writeData(data)
    sbSync(async () => {
      const uid = getSettings().supabaseUserId
      if (!uid) return
      const { error } = await getSb().from(name).update(sbPick(name, { ...updates, updatedAt: new Date().toISOString() })).eq('id', id)
      if (error) console.log(`[supabase] ${name}:update error:`, error.message)
    })
    return data[name][idx]
  })

  ipcMain.handle(`${name}:delete`, (_, id) => {
    const data = readData()
    data[name] = data[name].filter(i => i.id !== id)
    writeData(data)
    sbSync(async () => {
      const uid = getSettings().supabaseUserId
      if (!uid) return
      const { error } = await getSb().from(name).delete().eq('id', id)
      if (error) console.log(`[supabase] ${name}:delete error:`, error.message)
    })
    return true
  })
}

registerCollection('sales')
registerCollection('inventory')
registerCollection('packages')

// ── Releases — fetched from Railway server, not stored locally ────────────────
const SERVER_URL = DISCORD.serverUrl

ipcMain.handle('releases:getAll', async () => {
  try {
    const res = await fetch(`${SERVER_URL}/releases`)
    if (!res.ok) return []
    return await res.json()
  } catch { return [] }
})

function getStoredJWT() {
  try {
    const authPath = path.join(app.getPath('userData'), 'auth.json')
    if (!fs.existsSync(authPath)) return null
    return JSON.parse(fs.readFileSync(authPath, 'utf8'))?.jwt || null
  } catch { return null }
}

ipcMain.handle('releases:add', async (_, item) => {
  try {
    const token = getStoredJWT()
    const res = await fetch(`${SERVER_URL}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(item)
    })
    return res.json()
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('releases:update', async (_, id, updates) => {
  try {
    const token = getStoredJWT()
    const res = await fetch(`${SERVER_URL}/releases/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(updates)
    })
    return res.json()
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('releases:delete', async (_, id) => {
  try {
    const token = getStoredJWT()
    const res = await fetch(`${SERVER_URL}/releases/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    })
    return res.json()
  } catch (err) {
    return { error: err.message }
  }
})

// ── Pinned messages — fetched from Railway server ─────────────────────────────
ipcMain.handle('pinned:getAll', async () => {
  try {
    const res = await fetch(`${SERVER_URL}/pinned`)
    if (!res.ok) return []
    return await res.json()
  } catch { return [] }
})

ipcMain.handle('pinned:add', async (_, item) => {
  try {
    const token = getStoredJWT()
    const res = await fetch(`${SERVER_URL}/pinned`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(item)
    })
    return res.json()
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('pinned:delete', async (_, id) => {
  try {
    const token = getStoredJWT()
    const res = await fetch(`${SERVER_URL}/pinned/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    })
    return res.json()
  } catch (err) {
    return { error: err.message }
  }
})

// ── Monitor handlers — proxied to Railway server ──────────────────────────────
ipcMain.handle('monitors:getAll', async () => {
  try {
    const token = getStoredJWT()
    const res = await fetch(`${SERVER_URL}/monitors`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return []
    return await res.json()
  } catch { return [] }
})

ipcMain.handle('monitors:add', async (_, item) => {
  try {
    const token = getStoredJWT()
    const res = await fetch(`${SERVER_URL}/monitors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(item)
    })
    return res.json()
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('monitors:update', async (_, id, updates) => {
  try {
    const token = getStoredJWT()
    const res = await fetch(`${SERVER_URL}/monitors/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(updates)
    })
    return res.json()
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('monitors:delete', async (_, id) => {
  try {
    const token = getStoredJWT()
    const res = await fetch(`${SERVER_URL}/monitors/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    })
    return res.json()
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('monitors:test', async (_, id) => {
  try {
    const token = getStoredJWT()
    const res = await fetch(`${SERVER_URL}/monitors/${id}/test`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    })
    return res.json()
  } catch (err) { return { error: err.message } }
})

// ── Photo handlers ────────────────────────────────────────────────────────────
ipcMain.handle('photo:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Photo',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }]
  })
  if (result.canceled || !result.filePaths.length) return null
  const src = result.filePaths[0]
  const ext = path.extname(src).toLowerCase()
  const dest = path.join(photosDir, `${Date.now()}${ext}`)
  fs.copyFileSync(src, dest)
  return dest
})

// ── Settings storage ──────────────────────────────────────────────────────────
function getSettings() {
  try {
    const p = path.join(app.getPath('userData'), 'settings.json')
    if (!fs.existsSync(p)) return {}
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch { return {} }
}

function saveSettings(settings) {
  const p = path.join(app.getPath('userData'), 'settings.json')
  fs.writeFileSync(p, JSON.stringify(settings, null, 2), 'utf8')
}

ipcMain.handle('settings:get', () => getSettings())
ipcMain.handle('settings:set', (_, settings) => { saveSettings(settings); return true })

ipcMain.handle('data:migrateToSupabase', async () => {
  console.log('[migrate] handler called')
  const uid = getSettings().supabaseUserId
  console.log('[migrate] uid:', uid)
  if (!uid) return { error: 'No Supabase User ID configured. Add it in Settings → Cloud Sync.' }
  const data    = readData()
  const results = {}
  for (const name of ['inventory', 'sales', 'packages']) {
    const rawRows = (data[name] || [])
    // Upload local photos to Supabase Storage
    if (name === 'inventory') {
      for (const r of rawRows) {
        if (r.photo && !r.photo.startsWith('http')) {
          const url = await uploadLocalPhoto(r.photo, r.id)
          if (url !== r.photo) { r.photo = url; data[name] = data[name].map(x => x.id === r.id ? { ...x, photo: url } : x) }
        }
      }
      writeData(data)
    }
    const rows = rawRows.map(r => sbPick(name, { ...r, user_id: uid }))
    console.log(`[migrate] ${name}: ${rows.length} rows`)
    if (!rows.length) { results[name] = 0; continue }
    const { error } = await getSb().from(name).upsert(rows, { onConflict: 'id' })
    console.log(`[migrate] ${name} result:`, error ? error.message : 'ok')
    results[name] = error ? `error: ${error.message} [${error.code}]` : rows.length
  }
  return results
})

// ── Proxy Manager ─────────────────────────────────────────────────────────────
function getProxies() {
  try { return JSON.parse(fs.readFileSync(proxiesPath, 'utf8')) } catch { return [] }
}
function saveProxies(list) {
  fs.writeFileSync(proxiesPath, JSON.stringify(list, null, 2), 'utf8')
}

function parseProxy(raw) {
  raw = (raw || '').trim()
  if (!raw) return null
  // user:pass@host:port
  let m = raw.match(/^([^:@]+):([^@]+)@([^:]+):(\d+)$/)
  if (m) return { host: m[3], port: m[4], username: m[1], password: m[2] }
  // host:port:user:pass
  m = raw.match(/^([^:]+):(\d+):([^:]+):(.+)$/)
  if (m) return { host: m[1], port: m[2], username: m[3], password: m[4] }
  // host:port
  m = raw.match(/^([^:]+):(\d+)$/)
  if (m) return { host: m[1], port: m[2], username: null, password: null }
  return null
}

function testOneProxy(proxy) {
  return new Promise(resolve => {
    const start = Date.now()
    const timer = setTimeout(() => {
      try { req.destroy() } catch {}
      resolve({ status: 'dead', latency: null })
    }, 10000)

    const headers = { 'User-Agent': 'Mozilla/5.0', 'Connection': 'close' }
    if (proxy.username) {
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')
    }

    const req = http.request({
      host: proxy.host,
      port: parseInt(proxy.port, 10),
      method: 'GET',
      path: 'http://ipv4.icanhazip.com/',
      headers
    }, res => {
      let body = ''
      res.on('data', c => body += c.toString())
      res.on('end', () => {
        clearTimeout(timer)
        resolve(res.statusCode === 200
          ? { status: 'working', latency: Date.now() - start, ip: body.trim() }
          : { status: 'dead', latency: null })
      })
    })
    req.on('error', () => { clearTimeout(timer); resolve({ status: 'dead', latency: null }) })
    req.end()
  })
}

ipcMain.handle('proxies:getAll', () => getProxies())

ipcMain.handle('proxies:add', (_, rawList) => {
  const proxies = getProxies()
  const existing = new Set(proxies.map(p => `${p.host}:${p.port}`))
  let added = 0
  for (const raw of rawList) {
    const p = parseProxy(raw)
    if (!p) continue
    const key = `${p.host}:${p.port}`
    if (existing.has(key)) continue
    existing.add(key)
    proxies.push({ id: crypto.randomUUID(), ...p, status: 'untested', latency: null, lastTested: null })
    added++
  }
  saveProxies(proxies)
  return { added, total: proxies.length }
})

ipcMain.handle('proxies:delete', (_, id) => {
  saveProxies(getProxies().filter(p => p.id !== id))
  return true
})

ipcMain.handle('proxies:test', async (_, id) => {
  const proxies = getProxies()
  const proxy = proxies.find(p => p.id === id)
  if (!proxy) return null
  const result = await testOneProxy(proxy)
  Object.assign(proxy, result, { lastTested: new Date().toISOString() })
  saveProxies(proxies)
  notifyRenderer('proxy:testResult', { id, ...result })
  return { id, ...result }
})

ipcMain.handle('proxies:testAll', async () => {
  const proxies = getProxies()
  await Promise.all(proxies.map(async proxy => {
    const result = await testOneProxy(proxy)
    Object.assign(proxy, result, { lastTested: new Date().toISOString() })
    notifyRenderer('proxy:testResult', { id: proxy.id, ...result })
  }))
  saveProxies(proxies)
  return getProxies()
})

ipcMain.handle('proxies:clear', (_, type) => {
  const list = type === 'all' ? [] : getProxies().filter(p => p.status !== 'dead')
  saveProxies(list)
  return list
})

// ── BrowserWindow scraper ─────────────────────────────────────────────────────
let scrapeQueue = Promise.resolve()

function enqueueScrape(fn) {
  scrapeQueue = scrapeQueue.then(() => fn().catch(() => null))
  return scrapeQueue
}

// ── Parse USPS JSON (intercepted from their internal API) ─────────────────────
function parseUSPSJson(json) {
  // Unwrap common USPS envelope structures
  let summary, details
  const candidates = [
    json,
    json?.TrackResponse,
    json?.TrackResponse?.TrackInfo,
    json?.TrackInfo,
    Array.isArray(json) ? json[0] : null
  ]
  for (const c of candidates) {
    if (!c) continue
    if (c.TrackSummary) { summary = c.TrackSummary; details = c.TrackDetail; break }
  }

  if (!summary) {
    // Last-resort: classify from the raw JSON string
    const status = classifyStatus(JSON.stringify(json))
    return status ? { status, events: [] } : null
  }

  const detailArr = Array.isArray(details) ? details : details ? [details] : []
  const allRows   = [summary, ...detailArr].filter(e => e?.Event || e?.EventDescription)

  const events = allRows.map(e => ({
    description: (e.Event || e.EventDescription || '').trim(),
    location:    [e.EventCity, e.EventState].filter(Boolean).join(', '),
    timestamp:   [e.EventDate, e.EventTime].filter(Boolean).join(' at ')
  })).filter(e => e.description)

  return { status: classifyStatus(events[0]?.description || ''), events }
}

// ── Keyword that signals tracking content has rendered on the page ────────────
const TRACKING_RENDERED_RE = /pre-shipment|shipping label|in transit|out for delivery|delivered|awaiting|accepted|departed|arrived|exception|undeliverable/i

// ── USPS-targeted DOM extraction (checks rendered elements + noscript fallback) ─
const USPS_TARGETED_FN = `(function() {
  // Try rendered DOM elements first
  var selectors = ['.tb-status-detail','.tb-status','[data-testid*="status"]','[class*="tracking-status"]'];
  for (var i = 0; i < selectors.length; i++) {
    var el = document.querySelector(selectors[i]);
    if (el) { var t = (el.innerText||'').trim(); if (t.length > 3 && t.length < 200) return t; }
  }
  // USPS server-renders into noscript blocks — parse those
  var ns = document.querySelectorAll('noscript');
  for (var j = 0; j < ns.length; j++) {
    var c = ns[j].textContent || '';
    var m = c.match(/class="tb-status-detail[^"]*"[^>]*>([^<]+)/i) || c.match(/class="tb-status[^"]*"[^>]*>([^<]+)/i);
    if (m) return m[1].trim();
  }
  return '';
})()`

// ── Extract all visible leaf text from the rendered page ──────────────────────
const DOM_TEXT_FN = `(function() {
  var lines = [], seen = new Set();
  document.querySelectorAll('p,li,span,div,td,h1,h2,h3,h4,strong,b').forEach(function(el) {
    if (el.children.length > 3) return;
    // Skip noscript/template/script parents
    var p = el.parentElement;
    while (p) { if (/^(NOSCRIPT|TEMPLATE|SCRIPT|STYLE)$/.test(p.tagName)) return; p = p.parentElement; }
    var t = (el.innerText || '').trim().replace(/\\s+/g,' ');
    if (!t || t.length < 4 || t.length > 400 || seen.has(t)) return;
    // Skip lines that look like raw HTML
    if (t.includes('<') && t.includes('>') && /<[a-z]/i.test(t)) return;
    seen.add(t); lines.push(t);
  });
  return lines.join('\\n').substring(0, 8000);
})()`

// ── USPS direct HTML fetch (server-rendered page, no BrowserWindow needed) ────
async function scrapeUSPSDirect(trackingNumber) {
  try {
    const url = `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: AbortSignal.timeout(15000)
    })
    const html = await res.text()

    // Extract all tb-status / tb-status-detail text nodes
    const statusTexts = []
    const patterns = [
      /class="tb-status-detail[^"]*"[^>]*>\s*([^<]{3,200})/gi,
      /class="tb-status[^"]*"[^>]*>\s*([^<]{3,200})/gi,
      /class="[^"]*status[^"]*"[^>]*>\s*([^<]{3,200})/gi,
    ]
    for (const pat of patterns) {
      let m
      pat.lastIndex = 0
      while ((m = pat.exec(html)) !== null) {
        const t = m[1].trim()
        if (t && !statusTexts.includes(t)) statusTexts.push(t)
      }
    }
    // Extract expected delivery date
    let expectedDelivery = null
    const edPatterns = [
      /Expected\s+Delivery\s+by[\s\S]{0,400}?(\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b[\s\S]{0,60}?\b\d{4}\b)/i,
      /Expected\s+Delivery[\s\S]{0,400}?(\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,?\s+\d{4})?)/i,
      /Delivery\s+by[\s\S]{0,200}?(\b(?:January|February|March|April|May|June|July|august|september|october|november|december)\s+\d{1,2}(?:,?\s+\d{4})?)/i,
    ]
    for (const pat of edPatterns) {
      const m = html.match(pat)
      if (m) {
        expectedDelivery = m[1].replace(/\s+/g, ' ').trim()
        break
      }
    }

    // Find the first one that classifies to a real status
    for (const t of statusTexts) {
      const s = classifyStatus(t)
      if (s) {
        const events = statusTexts
          .filter(txt => classifyStatus(txt) || /\d{1,2}\/\d{1,2}|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(txt))
          .map(txt => ({ description: txt, location: '', timestamp: '' }))
        return { status: s, events, expectedDelivery }
      }
    }
    return null
  } catch (err) {
    console.log('[usps-direct] error:', err.message)
    return null
  }
}

// ── Core scraper ──────────────────────────────────────────────────────────────
// Uses a preload script to intercept every fetch/XHR the carrier page makes,
// so we get the raw API response before React even touches it.
// Falls back to DOM keyword-polling if no API response is captured.
async function scrapeTrackingPage(url, carrier) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      width: 1280, height: 900,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: false,          // must be false so preload shares window.fetch with page
        preload: path.join(__dirname, 'scraper-preload.js')
      }
    })

    let settled = false
    const finish = (val) => {
      if (settled) return
      settled = true
      clearTimeout(hardTimer)
      ipcMain.removeListener('scraper:data', onData)
      try { win.destroy() } catch {}
      resolve(val)
    }

    const hardTimer = setTimeout(() => finish(null), 50000)

    // ── Primary: intercept every fetch/XHR the carrier page makes ────────
    const onData = (event, { url: reqUrl, text }) => {
      if (event.sender.id !== win.webContents.id) return   // only our window
      // Skip HTML document responses — those are the page shell, not API data
      const trimmed = text?.trimStart() || ''
      if (trimmed.startsWith('<!') || trimmed.startsWith('<html') || trimmed.startsWith('<!--')) return
      if (!text || !TRACKING_RENDERED_RE.test(text)) return

      // Try structured JSON parse first (USPS returns TrackSummary/TrackDetail)
      try {
        const json   = JSON.parse(text)
        const result = carrier === 'USPS' ? parseUSPSJson(json) : null
        if (result?.status || result?.events?.length) { finish(result); return }
      } catch {}

      // Generic: classify status from raw response text (JSON/text API responses only)
      const status = classifyStatus(text)
      if (status) finish({ status, events: extractEventsFromText(text, carrier) })
    }
    ipcMain.on('scraper:data', onData)

    // ── Fallback: poll DOM every second until tracking keywords appear ────
    win.webContents.on('did-fail-load', (e, code) => {
      if (code === -3) return  // ERR_ABORTED = redirect in progress, ignore
      finish(null)
    })
    win.webContents.once('did-finish-load', async () => {
      for (let i = 0; i < 30 && !settled; i++) {
        await new Promise(r => setTimeout(r, 1000))
        try {
          const bodyText = await win.webContents.executeJavaScript(
            `document.body ? document.body.innerText : ''`
          )
          if (!TRACKING_RENDERED_RE.test(bodyText)) continue

          // For USPS: use targeted element extraction to avoid picking up notification text
          if (carrier === 'USPS') {
            const targeted = await win.webContents.executeJavaScript(USPS_TARGETED_FN)

            // Extract expected delivery from rendered DOM
            const expectedDelivery = await win.webContents.executeJavaScript(`(function(){
              var el = document.querySelector('.expected_delivery, [class*="expected"], [class*="delivery-date"], .tb-expected-delivery')
              if (el) return el.innerText.replace(/\\s+/g,' ').trim()
              // Fallback: scan all text for "Expected Delivery" pattern
              var full = document.body ? document.body.innerText : ''
              var m = full.match(/Expected Delivery[^\\n]{0,10}\\n?([^\\n]{5,60})/)
              return m ? m[1].trim() : null
            })()`)

            if (targeted) {
              const status = classifyStatus(targeted)
              if (status) {
                finish({ status, events: [{ description: targeted, location: '', timestamp: '' }], expectedDelivery: expectedDelivery || null })
                return
              }
            }
          }

          const fullText = await win.webContents.executeJavaScript(DOM_TEXT_FN)
          finish({ status: classifyStatus(fullText), events: extractEventsFromText(fullText, carrier) })
          return
        } catch {}
      }
      if (!settled) finish(null)
    })

    win.loadURL(url, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    })
  })
}

// ── Parse rendered page text into tracking event objects ─────────────────────
// Works for USPS and most carriers: looks for lines that pair a status phrase
// with a date/time and an optional location.
function extractEventsFromText(text, carrier) {
  // Strip any raw HTML that leaked through DOM extraction
  const stripped = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  const lines  = stripped.split('\n').map(l => l.trim()).filter(l => l.length > 3)
  const events = []
  const DATE_RE    = /\b(january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}\/\d{1,2})/i
  const STATUS_RE  = TRACKING_RENDERED_RE
  const SKIP_RE    = /tracking|informed delivery|text & email|usps tracking plus|product information|see (more|less)|get more|copy|add to/i

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!STATUS_RE.test(line) || SKIP_RE.test(line)) continue
    if (line.length > 200) continue

    // Look for a date in this line or the next 3 lines
    let timestamp = '', location = ''
    for (let j = i; j < Math.min(i + 4, lines.length); j++) {
      if (DATE_RE.test(lines[j]) && lines[j].length < 80) {
        timestamp = lines[j]; break
      }
    }
    // Look for a location (ALL CAPS city/state pattern) nearby
    for (let j = i; j < Math.min(i + 4, lines.length); j++) {
      if (/^[A-Z ,]+\d{5}/.test(lines[j]) || /^[A-Z]{2,}(,\s*[A-Z]{2})?$/.test(lines[j])) {
        location = lines[j]; break
      }
    }

    events.push({ description: line, location, timestamp })
  }

  return events
}

// ── Tracking handlers ─────────────────────────────────────────────────────────
function carrierTrackingUrl(trackingNumber, carrier) {
  const t = encodeURIComponent(trackingNumber)
  const urls = {
    'USPS':       `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`,
    'UPS':        `https://www.ups.com/track?tracknum=${t}`,
    'FedEx':      `https://www.fedex.com/fedextrack/?trknbr=${t}`,
    'DHL':        `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${t}`,
    'LaserShip':  `https://www.lasership.com/track/${t}`,
    'OnTrac':     `https://www.ontrac.com/tracking/?number=${t}`,
    'Amazon':     `https://track.amazon.com/tracking/${t}`
  }
  return urls[carrier] || `https://t.17track.net/en#nums=${t}`
}

// Map 17track status codes to our status strings
function map17trackStatus(tag) {
  const map = {
    0:  'Awaiting Pickup', // Not Found (label created, carrier hasn't received it yet)
    10: 'Awaiting Pickup', // Info Received
    20: 'In Transit',
    25: 'In Transit',      // Arrived at destination country
    30: 'In Transit',      // Expired / stalled
    35: 'In Transit',      // Picked up
    40: 'Out for Delivery',
    41: 'Out for Delivery',
    42: 'Out for Delivery',
    50: 'Delivered',
    60: 'Exception',
    65: 'Exception',
  }
  return map[tag] ?? null
}

async function fetchWith17track(trackingNumber, apiKey) {
  try {
    // Register tracking number
    await fetch('https://api.17track.net/track/v2.2/register', {
      method: 'POST',
      headers: { '17token': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ number: trackingNumber }]),
      signal: AbortSignal.timeout(12000)
    })

    // Get tracking info
    const res = await fetch('https://api.17track.net/track/v2.2/gettrackinfo', {
      method: 'POST',
      headers: { '17token': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ number: trackingNumber }]),
      signal: AbortSignal.timeout(12000)
    })
    const json = await res.json()
    const accepted = json?.data?.accepted?.[0]
    if (!accepted) return null

    const tag = accepted.track_info?.latest_status?.status
    return map17trackStatus(tag)
  } catch {
    return null
  }
}

ipcMain.handle('tracking:open', (_, trackingNumber, carrier) => {
  shell.openExternal(carrierTrackingUrl(trackingNumber, carrier))
})

ipcMain.handle('shell:openExternal', (_, url) => {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      shell.openExternal(url)
    }
  } catch { /* invalid URL, ignore */ }
})

ipcMain.handle('app:version',      () => app.getVersion())
ipcMain.handle('window:minimize',  () => mainWindow.minimize())
ipcMain.handle('window:close',     () => mainWindow.close())
ipcMain.handle('window:flash',     () => { mainWindow.flashFrame(true); mainWindow.once('focus', () => mainWindow.flashFrame(false)) })

ipcMain.handle('tracking:fetchEvents', async (_, trackingNumber, carrier) => {
  // 17track API path (optional, if user has configured a key)
  const { trackingApiKey } = getSettings()
  if (trackingApiKey) {
    try {
      await fetch('https://api.17track.net/track/v2.2/register', {
        method: 'POST',
        headers: { '17token': trackingApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ number: trackingNumber }]),
        signal: AbortSignal.timeout(12000)
      })
      const res = await fetch('https://api.17track.net/track/v2.2/gettrackinfo', {
        method: 'POST',
        headers: { '17token': trackingApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ number: trackingNumber }]),
        signal: AbortSignal.timeout(12000)
      })
      const json = await res.json()
      const accepted = json?.data?.accepted?.[0]
      if (accepted) {
        const tag = accepted.track_info?.latest_status?.status
        const rawEvents = accepted.track_info?.tracking?.providers?.[0]?.events || []
        const events = rawEvents.map(e => ({
          timestamp:   e.time_iso || e.time_utc || '',
          description: e.description || '',
          location:    e.location || ''
        }))
        return { status: map17trackStatus(tag), events }
      }
    } catch {}
  }

  // USPS: use BrowserWindow scraper so we can intercept the API and get expected delivery
  // (scrapeUSPSDirect only gets status from server-rendered HTML, not expected delivery)

  // BrowserWindow scraping path — fully renders carrier SPA pages
  const url = carrierTrackingUrl(trackingNumber, carrier)
  return enqueueScrape(async () => {
    const raw = await scrapeTrackingPage(url, carrier)
    if (!raw) return null
    const events = raw.events || []
    let status = raw.status || null
    if (!status && events.length) status = classifyStatus(events[0].description)
    return { status, events, expectedDelivery: raw.expectedDelivery || null }
  })
})


function parseStatusFromHtml(html) {
  // Try to extract status from JSON embedded in carrier pages
  const jsonPatterns = [
    /"eventDescription"\s*:\s*"([^"]{3,120})"/i,
    /"statusDescription"\s*:\s*"([^"]{3,120})"/i,
    /"currentStatus"\s*:\s*"([^"]{3,120})"/i,
    /"activity"\s*:\s*"([^"]{3,120})"/i,
    /class="tb-status[^"]*"[^>]*>\s*([^<]{3,120})/i,
    /class="tb-status-detail[^"]*"[^>]*>\s*([^<]{3,120})/i,
  ]
  for (const pat of jsonPatterns) {
    const m = html.match(pat)
    if (m) {
      const s = classifyStatus(m[1])
      if (s) return s
    }
  }
  return classifyStatus(html)
}

function classifyStatus(text) {
  // Only classify short, focused strings — skip long sentences that mention status words in passing
  // (e.g. "Receive a message when your package is out for delivery" should NOT match)
  const t = text.toLowerCase().trim()
  const isLong = t.length > 120  // notification/description sentences tend to be long

  if (!isLong && /out.for.delivery/.test(t)) return 'Out for Delivery'
  // "delivered" — skip notification phrases and long sentences
  if (!isLong && /\bdelivered\b/.test(t) && !/estimated delivery|expected delivery|attempted delivery|failed delivery|notify|message|when.*delivered|after.*delivered/.test(t)) return 'Delivered'
  if (/in.transit|in-transit|picked up|accepted at|arrived at|departed from|processed through|sorting complete|in route|enroute/.test(t)) return 'In Transit'
  if (/arrived usps|departed usps|accepted at usps|processed at|origin acceptance|usps in possession/.test(t)) return 'In Transit'
  if (/awaiting.item|awaiting.package|usps awaiting|pre.shipment|pre-shipment|label created|shipping label created|shipment information sent|electronic shipping info|waiting for pickup|ready to ship|label printed|info received|origin post is preparing|created by sender|usps does not have|a shipping label has been prepared/.test(t)) return 'Awaiting Pickup'
  if (/exception|failed delivery|delivery attempted|undeliverable|return to sender|no such number|insufficient address/.test(t)) return 'Exception'
  return null
}

ipcMain.handle('photo:read', (_, filePath) => {
  if (!filePath) return null
  try {
    if (!fs.existsSync(filePath)) return null
    const ext = path.extname(filePath).toLowerCase().replace('.', '')
    const mime = ext === 'jpg' ? 'jpeg' : (ext || 'jpeg')
    return `data:image/${mime};base64,${fs.readFileSync(filePath).toString('base64')}`
  } catch { return null }
})

// ── Discord Auth ───────────────────────────────────────────────────────────────

const os = require('os')

// Stable machine fingerprint — prevents auth.json from being shared to other devices.
// Uses properties tied to the OS user account and hardware.
function getDeviceId() {
  const data = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model || '',
    os.homedir(),
  ].join('|')
  return crypto.createHash('sha256').update(data).digest('hex')
}

// Verify a JWT signed with RS256 using the embedded public key.
// No external dependencies — uses Node.js built-in crypto.
function verifyJWT(token) {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null

    const [headerB64, payloadB64, sigB64] = parts
    const sigBuf = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    const data   = `${headerB64}.${payloadB64}`

    const verify = crypto.createVerify('SHA256')
    verify.update(data)
    const valid = verify.verify(DISCORD.publicKey, sigBuf)
    if (!valid) return null

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))

    // Check expiry
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null

    return payload
  } catch {
    return null
  }
}

function getAuthPath() {
  return path.join(app.getPath('userData'), 'auth.json')
}

function readAuth() {
  try {
    const p = getAuthPath()
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch { return null }
}

function saveAuth(data) {
  fs.writeFileSync(getAuthPath(), JSON.stringify(data, null, 2), 'utf8')
}

function clearAuth() {
  const p = getAuthPath()
  if (fs.existsSync(p)) fs.unlinkSync(p)
}

async function checkAuth() {
  const auth = readAuth()
  if (!auth?.jwt) return false

  // Local checks first (signature + expiry + deviceId)
  const payload = verifyJWT(auth.jwt)
  if (!payload) { clearAuth(); return false }
  if (payload.deviceId !== getDeviceId()) { clearAuth(); return false }

  // Live server check — instantly detects role removal
  try {
    const res = await fetch(`${DISCORD.serverUrl}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: auth.jwt }),
      signal: AbortSignal.timeout(8000),
    })
    const data = await res.json()
    if (!data.valid) {
      if (data.reason !== 'reauth') clearAuth()  // keep jwt if just needs re-login
      return false
    }
  } catch {
    // If server is unreachable, fall back to local JWT check (fail open)
    // Remove this catch block if you want strict online-only enforcement
  }

  return true
}

let callbackServer = null

function startCallbackServer(state) {
  return new Promise((resolve, reject) => {
    if (callbackServer) { try { callbackServer.close() } catch {} }

    callbackServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${DISCORD.callbackPort}`)
      if (url.pathname !== '/callback') { res.end(); return }

      const code     = url.searchParams.get('code')
      const retState = url.searchParams.get('state')

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f2f5">
        <h2 style="color:#16a34a">✓ Authorized!</h2>
        <p style="color:#6b6563">You can close this tab and return to Resell Tracker.</p>
      </body></html>`)

      callbackServer.close()
      callbackServer = null

      if (!code || retState !== state) { reject(new Error('Invalid callback')); return }
      resolve(code)
    })

    callbackServer.listen(DISCORD.callbackPort, '127.0.0.1', () => {})
    callbackServer.on('error', reject)

    setTimeout(() => {
      try { callbackServer?.close() } catch {}
      callbackServer = null
      reject(new Error('Auth timed out'))
    }, 120000)
  })
}

ipcMain.handle('auth:check', () => {
  const auth = readAuth()
  if (!auth?.jwt) return { authenticated: false }
  // Local-only check — full server verify only happens on app startup via checkAuth()
  const payload = verifyJWT(auth.jwt)
  if (!payload) return { authenticated: false }
  return {
    authenticated: true,
    user: {
      userId:   payload.userId  || null,
      username: auth.username   || payload.username || 'User',
      avatar:   auth.avatar     || null,
    },
  }
})

ipcMain.handle('auth:login', async () => {
  const state = crypto.randomBytes(16).toString('hex')

  const authUrl =
    `https://discord.com/api/oauth2/authorize` +
    `?client_id=${DISCORD.clientId}` +
    `&redirect_uri=${encodeURIComponent(DISCORD.redirectUri)}` +
    `&response_type=code` +
    `&scope=identify%20guilds.members.read` +
    `&state=${state}`

  const codePromise = startCallbackServer(state)
  shell.openExternal(authUrl)

  let code
  try {
    code = await codePromise
  } catch (err) {
    return { success: false, error: err.message }
  }

  // Send code to our auth server — it holds the client_secret and does role verification
  let result
  try {
    const res = await fetch(`${DISCORD.serverUrl}/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceId: getDeviceId() }),
      signal: AbortSignal.timeout(15000),
    })
    result = await res.json()
    if (!res.ok) return { success: false, error: result.error || 'Server error' }
  } catch (err) {
    return { success: false, error: 'Could not reach auth server' }
  }

  // Verify the JWT the server gave us before trusting it
  const payload = verifyJWT(result.token)
  if (!payload) return { success: false, error: 'Invalid token from server' }

  saveAuth({
    jwt:      result.token,
    username: result.username,
    avatar:   result.avatar,
  })

  return { success: true, user: { username: result.username, avatar: result.avatar } }
})

// ── Local Monitor Engine (Shopify + Best Buy + Amazon) ──────────────────────
// All monitors run locally — no Railway latency, uses user's real IP.

const localMonitorTimers  = new Map()  // monitorId → intervalId
const localMonitorSeen    = new Map()  // monitorId → { available, price } (BB/Amazon)
const localMonitorWindows = new Map()  // monitorId → persistent BrowserWindow
const shopifyMonitorSeen  = new Map()  // monitorId → Map<productId, variantData>
const funkoMonitorSeen    = new Map()  // monitorId → Map<sku, { available, price }>
const nikeMonitorSeen     = new Map()  // monitorId → Map<pid, { method, launchDate, status }>
const nikeBoostTimers     = new Map()  // monitorId → { timer, stopAt } — fast pre-launch polling
const LOCAL_MONITOR_SITES = new Set(['bestbuy', 'amazon', 'shopify', 'lego', 'funko', 'nike'])

let mainWindowRef = null  // set after mainWindow is created

// ── Discord keyword alert receiver (Chrome extension → Electron) ──────────────
// ── Node.js selfbot (discord.js-selfbot-v13) ──────────────────────────────────
const selfbot = require('./selfbot')

// Selfbot config is stored inside settings.json under the "discord" key
function getSelfbotConfig() {
  const s = getSettings()
  return s.discord || {}
}

function saveSelfbotConfig(discord) {
  const s = getSettings()
  saveSettings({ ...s, discord })
}

// Channel name cache (cleared when token changes)
const _channelNameCache = new Map()
const _guildNameCache   = new Map()

function startSelfbot() {
  if (selfbot.isRunning()) return
  const cfg = getSelfbotConfig()
  if (!cfg.token) return
  selfbot.start(
    { token: cfg.token, keywords: cfg.keywords || [], channelIds: cfg.channelIds || [], feedChannelIds: cfg.feedChannelIds || [], caseSensitive: cfg.caseSensitive || false },
    data    => notifyRenderer('discord:keywordAlert', data),
    running => notifyRenderer('selfbot:statusUpdate', { running }),
    data    => notifyRenderer('discord:feedMessage',  data)
  )
}

function restartSelfbot() {
  selfbot.stop()
  setTimeout(startSelfbot, 800)
}

ipcMain.handle('selfbot:getToken', () => getSelfbotConfig().token || '')

ipcMain.handle('selfbot:setToken', (_, token) => {
  const clean = token.trim()
  if (!clean) return { error: 'Token cannot be empty' }
  const cfg = getSelfbotConfig()
  saveSelfbotConfig({ ...cfg, token: clean })
  _channelNameCache.clear()
  _guildNameCache.clear()
  restartSelfbot()
  return { ok: true }
})

ipcMain.handle('selfbot:getKeywords', () => (getSelfbotConfig().keywords || []).join(', '))

ipcMain.handle('selfbot:setKeywords', (_, keywordsStr) => {
  const keywords = keywordsStr.split(',').map(k => k.trim()).filter(Boolean)
  const cfg = getSelfbotConfig()
  saveSelfbotConfig({ ...cfg, keywords })
  restartSelfbot()
  return { ok: true }
})

ipcMain.handle('selfbot:getChannels', () => getSelfbotConfig().channelIds || [])

ipcMain.handle('selfbot:addChannel', (_, id) => {
  const clean = id.toString().trim().replace(/\D/g, '')
  if (!clean) return { error: 'Invalid ID' }
  const cfg = getSelfbotConfig()
  const ids = cfg.channelIds || []
  if (ids.includes(clean)) return { error: 'Already added' }
  const updated = [...ids, clean]
  saveSelfbotConfig({ ...cfg, channelIds: updated })
  restartSelfbot()
  return { ok: true, ids: updated }
})

ipcMain.handle('selfbot:removeChannel', (_, id) => {
  const clean = id.toString().trim()
  const cfg = getSelfbotConfig()
  const updated = (cfg.channelIds || []).filter(i => i !== clean)
  saveSelfbotConfig({ ...cfg, channelIds: updated })
  restartSelfbot()
  return { ok: true, ids: updated }
})

ipcMain.handle('selfbot:getChannelNames', async () => {
  try {
    const token = getSelfbotConfig().token
    if (!token) return {}
    const ids = getSelfbotConfig().channelIds || []
    const result = {}

    await Promise.all(ids.map(async id => {
      if (_channelNameCache.has(id)) { result[id] = _channelNameCache.get(id); return }
      try {
        const res = await fetch(`https://discord.com/api/v10/channels/${id}`, {
          headers: { Authorization: token, 'Content-Type': 'application/json' }
        })
        if (!res.ok) { result[id] = { channel: id, guild: null }; return }
        const data = await res.json()
        const channelName = data.name || data.recipients?.[0]?.username || id
        let guildName = null
        if (data.guild_id) {
          if (_guildNameCache.has(data.guild_id)) {
            guildName = _guildNameCache.get(data.guild_id)
          } else {
            try {
              const gr = await fetch(`https://discord.com/api/v10/guilds/${data.guild_id}`, {
                headers: { Authorization: token, 'Content-Type': 'application/json' }
              })
              if (gr.ok) {
                const gd = await gr.json()
                guildName = gd.name || null
                _guildNameCache.set(data.guild_id, guildName)
              }
            } catch {}
          }
        }
        const entry = { channel: channelName, guild: guildName }
        _channelNameCache.set(id, entry)
        result[id] = entry
      } catch { result[id] = { channel: id, guild: null } }
    }))
    return result
  } catch { return {} }
})

ipcMain.handle('selfbot:getFeedChannels', () => getSelfbotConfig().feedChannelIds || [])
ipcMain.handle('selfbot:addFeedChannel', (_, id) => {
  const clean = id.toString().trim()
  const cfg = getSelfbotConfig()
  const ids = [...new Set([...(cfg.feedChannelIds || []), clean])]
  saveSelfbotConfig({ ...cfg, feedChannelIds: ids })
  restartSelfbot()
  return { ok: true, ids }
})
ipcMain.handle('selfbot:removeFeedChannel', (_, id) => {
  const clean = id.toString().trim()
  const cfg = getSelfbotConfig()
  const ids = (cfg.feedChannelIds || []).filter(i => i !== clean)
  saveSelfbotConfig({ ...cfg, feedChannelIds: ids })
  restartSelfbot()
  return { ok: true, ids }
})

ipcMain.handle('selfbot:status', () => selfbot.isRunning())
ipcMain.handle('selfbot:start',  () => { startSelfbot(); return true })
ipcMain.handle('selfbot:stop',   () => {
  selfbot.stop()
  notifyRenderer('selfbot:statusUpdate', { running: false })
  return true
})

app.whenReady().then(() => {
  setTimeout(startSelfbot, 2000)
})

app.on('before-quit', () => {
  selfbot.stop()
})

function notifyRenderer(channel, data) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, data)
  }
}

function startLocalMonitors(monitors) {
  for (const m of monitors) {
    if (m.active && LOCAL_MONITOR_SITES.has(m.site_type)) {
      scheduleLocalMonitor(m)  // scheduleLocalMonitor handles replacing existing timer for same id
    }
  }
}

function scheduleLocalMonitor(monitor) {
  const existing = localMonitorTimers.get(monitor.id)
  if (existing) clearInterval(existing)
  const ms = (monitor.interval_sec || 30) * 1000
  runLocalMonitor(monitor).catch(() => {})
  const timer = setInterval(() => runLocalMonitor(monitor).catch(() => {}), ms)
  localMonitorTimers.set(monitor.id, timer)
}

function stopLocalMonitor(monitorId) {
  const t = localMonitorTimers.get(monitorId)
  if (t) { clearInterval(t); localMonitorTimers.delete(monitorId) }
  localMonitorSeen.delete(monitorId)
  shopifyMonitorSeen.delete(monitorId)
  funkoMonitorSeen.delete(monitorId)
  nikeMonitorSeen.delete(monitorId)
  const boost = nikeBoostTimers.get(monitorId)
  if (boost) { clearInterval(boost.timer); nikeBoostTimers.delete(monitorId) }
  const win = localMonitorWindows.get(monitorId)
  if (win) { try { win.destroy() } catch {} localMonitorWindows.delete(monitorId) }
}

function getOrCreateMonitorWindow(monitor) {
  if (localMonitorWindows.has(monitor.id)) {
    const w = localMonitorWindows.get(monitor.id)
    if (!w.isDestroyed()) return w
  }
  const { screen } = require('electron')
  const { width } = screen.getPrimaryDisplay().workAreaSize
  const win = new BrowserWindow({
    show: true, width: 1280, height: 900,
    x: width + 100, y: 0,  // position off-screen to the right
    skipTaskbar: true, frame: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  })
  win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36')
  localMonitorWindows.set(monitor.id, win)
  return win
}

const BB_EXTRACT = `(async function(){
  try {
    // Try BB's internal priceBlocks API first — most reliable
    const skuMatch = location.href.match(/skuId=(\d+)/) || location.href.match(/\/(\d+)\.p/)
    if (skuMatch) {
      const sku = skuMatch[1]
      try {
        const res  = await fetch('/api/3.0/priceBlocks?skus=' + sku, { headers: { Accept: 'application/json' } })
        const data = await res.json()
        const item = Array.isArray(data) ? data[0] : data
        if (item) {
          const state     = item.sku?.buttonState?.buttonState || item.sku?.addToCartButton?.buttonState || ''
          const available = state === 'ADD_TO_CART' || state === 'PRE_ORDER'
          const price     = item.sku?.customerPrice?.currentPrice ?? null
          const title     = item.sku?.names?.title ?? null
          return { available, price, title, _via: 'api' }
        }
      } catch {}
    }
    // DOM fallback — only check the actual product button, not body text
    const btn   = document.querySelector('.add-to-cart-button[data-button-state]')
                || document.querySelector('[data-button-state="ADD_TO_CART"]')
                || document.querySelector('[data-button-state="SOLD_OUT"]')
                || document.querySelector('[data-button-state]')
    const state = btn?.getAttribute('data-button-state') || ''
    const available = state === 'ADD_TO_CART' || state === 'PRE_ORDER'
    const priceEl = document.querySelector('.priceView-customer-price span') || document.querySelector('[class*="priceView"] span')
    const price   = priceEl ? parseFloat(priceEl.innerText.replace(/[^0-9.]/g,'')) : null
    const titleEl = document.querySelector('.sku-title h1') || document.querySelector('h1[class*="heading"]') || document.querySelector('h1')
    if (!state) return null  // page not loaded yet
    return { available, price, title: titleEl ? titleEl.innerText.trim() : null, _via: 'dom' }
  } catch(e) { return null }
})()`

const LEGO_EXTRACT = `(function(){
  try {
    // Try to find the add-to-bag / sold-out button
    const addBtn = document.querySelector('[data-test="add-to-bag"]')
                || Array.from(document.querySelectorAll('button')).find(b => /add to bag/i.test(b.innerText))
    const soldOut = document.querySelector('[data-test="sold-out"]')
                 || Array.from(document.querySelectorAll('button,span')).find(el => /sold.?out|out.?of.?stock/i.test(el.innerText) && el.innerText.trim().length < 30)
    if (!addBtn && !soldOut) return null  // page not loaded yet
    const available = !!addBtn && !addBtn.disabled && !soldOut
    const priceEl = document.querySelector('[data-test="product-price"]')
                 || document.querySelector('[class*="ProductPrice"]')
                 || document.querySelector('[class*="price"]')
    const price = priceEl ? parseFloat(priceEl.innerText.replace(/[^0-9.]/g,'')) || null : null
    const titleEl = document.querySelector('h1')
    return { available, price, title: titleEl ? titleEl.innerText.trim() : null }
  } catch(e) { return null }
})()`

const AMZN_EXTRACT = `(function(){
  try {
    const addBtn   = document.getElementById('add-to-cart-button')
    const buyBtn   = document.getElementById('buy-now-button')
    const oosEl    = document.getElementById('outOfStock')
    const available = (!!addBtn || !!buyBtn) && !oosEl
    const priceEl  = document.querySelector('.a-price .a-offscreen') || document.querySelector('#priceblock_ourprice') || document.querySelector('#priceblock_dealprice')
    const price    = priceEl ? parseFloat(priceEl.innerText.replace(/[^0-9.]/g,'')) : null
    const titleEl  = document.getElementById('productTitle')
    return { available, price, title: titleEl ? titleEl.innerText.trim() : null }
  } catch(e) { return null }
})()`

const localMonitorScraping = new Map()  // monitorId → Promise (prevents concurrent scrapes)

function extractSkuFromUrl(url) {
  const m = url.match(/skuId=(\d+)/) || url.match(/\/(\d+)\.p/) || url.match(/\/(\d+)\?/)
  return m ? m[1] : null
}

async function fetchBBAvailability(sku, ses) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.bestbuy.com/',
    'Origin': 'https://www.bestbuy.com'
  }
  // Try priceBlocks API
  try {
    const res = await ses.fetch(`https://www.bestbuy.com/api/3.0/priceBlocks?skus=${sku}`, { headers })
    if (res.ok) {
      const data = await res.json()
      const item = Array.isArray(data) ? data[0] : data
      if (item?.sku) {
        const state     = item.sku?.buttonState?.buttonState || item.sku?.addToCartButton?.buttonState || ''
        const available = state === 'ADD_TO_CART' || state === 'PRE_ORDER'
        const price     = item.sku?.customerPrice?.currentPrice ?? null
        const title     = item.sku?.names?.title ?? null
            return { available, price, title }
      }
    }
  } catch (e) { console.log(`[local-monitor] BB fetch error: ${e.message}`) }
  return null
}

async function fetchLegoAvailability(url) {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
    if (!res.ok) return null
    const html = await res.text()

    // Extract embedded Apollo state from Next.js SSR
    const match = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});\s*(?:<\/script>|window\.)/)
    if (!match) return null
    const state = JSON.parse(match[1])

    // Find the first ProductVariant with canAddToBag defined
    let available = null, price = null, title = null
    for (const val of Object.values(state)) {
      if (val && typeof val.canAddToBag === 'boolean') {
        available = val.canAddToBag
        if (val.price?.centAmount != null) price = val.price.centAmount / 100
        if (val.name) title = val.name
        break
      }
    }

    // Fallback: check __NEXT_DATA__ if Apollo state had no variants
    if (available === null) {
      const ndMatch = html.match(/window\.__NEXT_DATA__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/)
      if (ndMatch) {
        const nd = JSON.parse(ndMatch[1])
        const variants = nd?.props?.pageProps?.productData?.variants || []
        if (variants.length > 0) {
          available = variants.some(v => v.canAddToBag === true)
          const priceInfo = variants[0]?.price
          if (priceInfo?.centAmount != null) price = priceInfo.centAmount / 100
          title = nd?.props?.pageProps?.productData?.name || null
        }
      }
    }

    if (available === null) return null
    console.log(`[lego-monitor] Fast fetch OK — available:${available} price:${price}`)
    return { available, price, title }
  } catch (e) {
    console.log(`[lego-monitor] fetchLegoAvailability error: ${e.message}`)
    return null
  }
}

async function scrapeLocalProduct(monitor, url) {
  if (localMonitorScraping.has(monitor.id)) return null
  const ses = session.defaultSession

  const p = (async () => {
    if (monitor.site_type === 'bestbuy') {
      const sku = extractSkuFromUrl(url)
      if (!sku) { console.log(`[local-monitor] Could not extract SKU from: ${url}`); return null }
      return fetchBBAvailability(sku, ses)
    }
    // Lego — fast HTML fetch (parse __APOLLO_STATE__), fallback to BrowserWindow
    if (monitor.site_type === 'lego') {
      const legoResult = await fetchLegoAvailability(url)
      if (legoResult) return legoResult
      console.log(`[lego-monitor] HTML fetch failed for ${monitor.name}, falling back to BrowserWindow`)
    }

    // Amazon / Lego fallback — BrowserWindow scraper
    const extractScript = monitor.site_type === 'lego' ? LEGO_EXTRACT : AMZN_EXTRACT
    const win = getOrCreateMonitorWindow(monitor)
    return new Promise((resolve) => {
      let done = false
      const finish = (val) => { if (!done) { done = true; clearTimeout(timer); resolve(val) } }
      const timer = setTimeout(() => { console.log(`[local-monitor] timeout for ${monitor.name}`); finish(null) }, 30000)
      const onFail = (e, code, desc) => { console.log(`[local-monitor] load failed code=${code} desc=${desc}`); finish(null) }
      const onLoad = async () => {
        if (done) return
        for (let i = 0; i < 20 && !done; i++) {
          await new Promise(r => setTimeout(r, 1000))
          try {
            const result = await win.webContents.executeJavaScript(extractScript)
            if (result && result.available !== undefined) { finish(result); return }
          } catch (e) { break }
        }
        finish(null)
      }
      win.webContents.once('did-fail-load', onFail)
      win.webContents.once('dom-ready', onLoad)
      win.loadURL(url)
    })
  })()

  localMonitorScraping.set(monitor.id, p)
  try { return await p } finally { localMonitorScraping.delete(monitor.id) }
}

// ── Shopify Local Monitor ────────────────────────────────────────────────────

async function fetchShopifyProductsBrowser(url, baseUrl) {
  return new Promise(resolve => {
    const win = new BrowserWindow({
      show: false, width: 1280, height: 900,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    })
    win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36')
    let done = false
    const finish = val => { if (!done) { done = true; clearTimeout(timer); try { win.destroy() } catch {} ; resolve(val) } }
    const timer = setTimeout(() => { console.log(`[shopify-monitor] browser fetch timeout ${url}`); finish(null) }, 25000)
    win.webContents.on('did-fail-load', (e, code) => { if (code !== -3) finish(null) })
    win.webContents.on('did-finish-load', async () => {
      try {
        const text = await win.webContents.executeJavaScript(`document.body.innerText`)
        const data = JSON.parse(text)
        if (data.products) finish({ products: data.products, baseUrl })
        else if (data.product) finish({ products: [data.product], baseUrl })
        else finish(null)
      } catch { finish(null) }
    })
    win.loadURL(url)
  })
}

async function fetchShopifyProducts(monitor) {
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
  try {
    if (monitor.product_url) {
      const pu = monitor.product_url.trim().replace(/\/$/, '')
      const fetchUrl = pu.endsWith('.json') ? pu : `${pu}.json`
      let baseUrl = (monitor.site_url || '').trim().replace(/\/$/, '')
      if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl

      const res = await fetch(fetchUrl, { headers, signal: AbortSignal.timeout(15000) })
      if (res.ok) {
        const ct = res.headers.get('content-type') || ''
        if (ct.includes('application/json')) {
          const data = await res.json()
          if (data.product) {
            const parsed = new URL(fetchUrl)
            return { products: [data.product], baseUrl: `${parsed.protocol}//${parsed.hostname}` }
          }
        }
      }
      // Fallback to browser (Cloudflare-protected sites)
      console.log(`[shopify-monitor] fetch blocked for product URL, trying browser`)
      return fetchShopifyProductsBrowser(fetchUrl, baseUrl)
    } else {
      let baseUrl = (monitor.site_url || '').trim().replace(/\/$/, '')
      if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl

      // Try /products.json first, then common collection fallbacks for stores that disable it
      const candidateUrls = [
        `${baseUrl}/products.json?limit=250`,
        `${baseUrl}/collections/all/products.json?limit=250`,
        `${baseUrl}/collections/new/products.json?limit=250`,
        `${baseUrl}/collections/shop-all/products.json?limit=250`,
      ]

      for (const jsonUrl of candidateUrls) {
        const res = await fetch(jsonUrl, { headers, signal: AbortSignal.timeout(15000) })
        console.log(`[shopify-monitor] ${jsonUrl} status=${res.status}`)
        if (res.status === 404) continue  // endpoint disabled — try next
        if (res.ok) {
          const ct = res.headers.get('content-type') || ''
          if (ct.includes('application/json')) {
            const data = await res.json()
            if (Array.isArray(data.products)) return { products: data.products, baseUrl }
          }
          // Got a response but not JSON — likely a Cloudflare challenge page
          console.log(`[shopify-monitor] non-JSON response for ${jsonUrl}, trying browser`)
          return fetchShopifyProductsBrowser(jsonUrl, baseUrl)
        }
        // Non-404 error (403 Cloudflare block, etc.) — use browser
        console.log(`[shopify-monitor] fetch blocked for ${monitor.name} (status ${res.status}), trying browser`)
        return fetchShopifyProductsBrowser(jsonUrl, baseUrl)
      }

      console.log(`[shopify-monitor] all endpoints 404 for ${monitor.name}`)
      return null
    }
  } catch (e) { console.log(`[shopify-monitor] fetchShopifyProducts error: ${e.message}`); return null }
}

async function runShopifyMonitor(monitor) {
  console.log(`[shopify-monitor] Running ${monitor.name} site_url=${monitor.site_url} product_url=${monitor.product_url}`)
  const fetched = await fetchShopifyProducts(monitor)
  if (!fetched) { console.log(`[shopify-monitor] fetch failed for ${monitor.name}`); return }
  const { products, baseUrl } = fetched

  const keywords = monitor.keywords
    ? monitor.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
    : []

  const isFirstRun = !shopifyMonitorSeen.has(monitor.id)
  if (isFirstRun) shopifyMonitorSeen.set(monitor.id, new Map())
  const seen = shopifyMonitorSeen.get(monitor.id)

  for (const product of products) {
    const productId = String(product.id)
    if (!monitor.product_url && keywords.length > 0) {
      if (!keywords.some(kw => (product.title || '').toLowerCase().includes(kw))) continue
    }

    const currentVariants = {}
    for (const v of (product.variants || [])) {
      currentVariants[String(v.id)] = { available: v.available, price: v.price || null }
    }

    if (isFirstRun) { seen.set(productId, currentVariants); continue }

    if (!seen.has(productId)) {
      seen.set(productId, currentVariants)
      const availableVariants = (product.variants || []).filter(v => v.available).map(v => v.title)
      if (availableVariants.length > 0) {
        await sendShopifyDiscordPing(monitor, product, baseUrl, 'new', availableVariants)
        notifyRenderer('monitor:alert', { type: 'new', monitorName: monitor.name, product: { title: product.title, handle: product.handle, image: product.images?.[0]?.src }, baseUrl, variants: availableVariants })
      }
      continue
    }

    const prevVariants = seen.get(productId)
    const restockedVariants = []
    let priceDropped = false, oldPrice = null, newPrice = null

    for (const [varId, curr] of Object.entries(currentVariants)) {
      const prev = prevVariants[varId] || {}
      if (curr.available && !prev.available) {
        const v = (product.variants || []).find(v => String(v.id) === varId)
        if (v) restockedVariants.push(v.title)
      }
      if (monitor.price_alert && curr.price && prev.price) {
        const cp = parseFloat(curr.price), pp = parseFloat(prev.price)
        if (cp < pp) {
          const threshold = monitor.price_threshold ? parseFloat(monitor.price_threshold) : null
          if (!threshold || cp <= threshold) { priceDropped = true; oldPrice = pp; newPrice = cp }
        }
      }
    }
    seen.set(productId, currentVariants)

    if (restockedVariants.length > 0) {
      await sendShopifyDiscordPing(monitor, product, baseUrl, 'restock', restockedVariants)
      notifyRenderer('monitor:alert', { type: 'restock', monitorName: monitor.name, product: { title: product.title, handle: product.handle, image: product.images?.[0]?.src }, baseUrl, variants: restockedVariants })
    }
    if (priceDropped) {
      await sendShopifyDiscordPing(monitor, product, baseUrl, 'price_drop', [], { oldPrice, newPrice })
    }
  }

  // Push live feed to renderer
  notifyRenderer('shopify:feedUpdate', { monitorId: monitor.id, monitorName: monitor.name, products, baseUrl })
}

async function sendShopifyDiscordPing(monitor, product, baseUrl, type, variants = [], extra = {}) {
  const productUrl = `${baseUrl}/products/${product.handle}`
  const image = product.images?.[0]?.src || null
  const firstVariant = (product.variants || []).find(v => v.available) || product.variants?.[0]
  const currentPrice = firstVariant?.price ? `$${parseFloat(firstVariant.price).toFixed(2)}` : 'N/A'
  let color, title, fields

  if (type === 'price_drop') {
    color = 0xff9500
    title = `💰 Price Drop: ${product.title}`
    fields = [
      { name: 'Was', value: `$${extra.oldPrice.toFixed(2)}`, inline: true },
      { name: 'Now', value: `$${extra.newPrice.toFixed(2)}`, inline: true },
      { name: 'Saved', value: `$${(extra.oldPrice - extra.newPrice).toFixed(2)}`, inline: true },
      { name: 'Site', value: monitor.name, inline: false }
    ]
  } else {
    color = type === 'restock' ? 0x00ff7f : 0x5865f2
    title = `${type === 'restock' ? '🔄 Restock' : '🆕 New Product'}: ${product.title}`
    const variantText = variants.length > 0
      ? variants.slice(0, 15).join(', ') + (variants.length > 15 ? ` +${variants.length - 15} more` : '')
      : 'Available'
    fields = [
      { name: 'Price', value: currentPrice, inline: true },
      { name: 'Site', value: monitor.name, inline: true },
      { name: type === 'restock' ? 'Restocked Sizes' : 'Available Sizes', value: variantText, inline: false }
    ]
  }

  const payload = {
    content: monitor.ping_role ? `<@&${monitor.ping_role}>` : undefined,
    embeds: [{ title, url: productUrl, color, fields, footer: { text: `Resell Tracker Monitor • ${monitor.name}` }, timestamp: new Date().toISOString() }]
  }
  if (image) payload.embeds[0].thumbnail = { url: image }
  if (!payload.content) delete payload.content

  try {
    await fetch(monitor.webhook_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) })
  } catch (err) { console.error('[shopify-monitor] Discord ping failed:', err.message) }
}

// ── Funko (SFCC) Monitor ──────────────────────────────────────────────────────

function loadOneFunkoPage(url) {
  return new Promise(resolve => {
    const win = new BrowserWindow({
      show: false, width: 1280, height: 900,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    })
    win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36')
    let done = false
    const finish = val => { if (!done) { done = true; clearTimeout(timer); try { win.destroy() } catch {}; resolve(val) } }
    const timer = setTimeout(() => { console.log(`[funko-monitor] browser timeout: ${url}`); finish(null) }, 35000)
    win.webContents.on('did-fail-load', (e, code) => { if (code !== -3) finish(null) })
    win.webContents.on('did-finish-load', async () => {
      try {
        const result = await win.webContents.executeJavaScript(`
          (function() {
            const scripts = document.querySelectorAll('script[type="application/ld+json"]')
            for (const s of scripts) {
              try {
                const data = JSON.parse(s.textContent)
                const list = data['@type'] === 'ItemList' ? data
                  : (Array.isArray(data['@graph']) ? data['@graph'].find(n => n['@type'] === 'ItemList') : null)
                if (list && Array.isArray(list.itemListElement)) {
                  const products = list.itemListElement.map(item => ({
                    name: item.item?.name || '',
                    sku: item.item?.sku || item.item?.mpn || '',
                    url: item.item?.offers?.url || item.item?.['@id'] || '',
                    price: item.item?.offers?.price ?? null,
                    image: Array.isArray(item.item?.image) ? item.item.image[0] : (item.item?.image || ''),
                    available: (item.item?.offers?.availability || '').includes('InStock')
                  }))
                  // Try to get total count from DOM (SFCC pagination patterns)
                  let total = list.numberOfItems || null
                  if (!total) {
                    const selectors = [
                      '[data-count]',
                      '.results-hits',
                      '.product-count',
                      '.items-count',
                      '.search-results-count',
                      '[data-total]',
                    ]
                    for (const sel of selectors) {
                      const el = document.querySelector(sel)
                      if (el) {
                        const val = parseInt(el.getAttribute('data-count') || el.getAttribute('data-total') || el.textContent, 10)
                        if (!isNaN(val) && val > 0) { total = val; break }
                      }
                    }
                  }
                  if (!total) {
                    // Last resort: look for any text like "80 results" or "1-20 of 80"
                    const body = document.body.innerText
                    const m = body.match(/\bof\s+(\d+)\s+results?\b/i) || body.match(/(\d+)\s+results?\b/i)
                    if (m) total = parseInt(m[1], 10)
                  }
                  return { products, total: total || null, pageSize: products.length }
                }
              } catch {}
            }
            return null
          })()
        `)
        if (result && result.products && result.products.length > 0) finish(result)
        else finish(null)
      } catch (e) { console.log(`[funko-monitor] JS extract error: ${e.message}`); finish(null) }
    })
    win.loadURL(url)
  })
}

async function fetchFunkoProducts(url) {
  // Strip any existing start/sz params so we always start from page 1
  const baseUrl = url.replace(/[?&](start|sz)=[^&]*/g, '').replace(/[?&]$/, '')
  const sep = baseUrl.includes('?') ? '&' : '?'

  const MAX_PAGES = 4  // cap at 4 pages (80 products for sz=20)

  const first = await loadOneFunkoPage(`${baseUrl}${sep}start=0&sz=24`)
  if (!first) return null

  const { products, total, pageSize } = first
  const sz = pageSize || 24

  // If we know the total, use it; otherwise speculatively fetch up to MAX_PAGES
  const totalCount = total || 0
  const pageUrls = []
  if (totalCount > sz) {
    for (let start = sz; start < totalCount; start += sz)
      pageUrls.push(`${baseUrl}${sep}start=${start}&sz=${sz}`)
  } else {
    // No total available — speculatively fetch remaining pages in parallel
    for (let p = 1; p < MAX_PAGES; p++)
      pageUrls.push(`${baseUrl}${sep}start=${p * sz}&sz=${sz}`)
  }

  if (pageUrls.length === 0) {
    console.log(`[funko-monitor] Page 1: ${products.length} products (1 page)`)
    return products
  }

  console.log(`[funko-monitor] Page 1: ${products.length} products, fetching ${pageUrls.length} more page(s) in parallel`)
  const rest = await Promise.all(pageUrls.map(u => loadOneFunkoPage(u)))
  for (const page of rest) {
    if (page && page.products && page.products.length > 0) products.push(...page.products)
  }

  // Deduplicate by SKU
  const seen = new Map()
  for (const p of products) {
    const key = p.sku || p.url || p.name
    if (!seen.has(key)) seen.set(key, p)
  }
  console.log(`[funko-monitor] Total after all pages: ${seen.size} products`)
  return [...seen.values()]
}

async function runFunkoMonitor(monitor) {
  const url = (monitor.site_url || 'https://funko.com/new-featured/new-releases/').trim()
  console.log(`[funko-monitor] Running ${monitor.name} url=${url}`)
  const products = await fetchFunkoProducts(url)
  if (!products) { console.log(`[funko-monitor] fetch failed for ${monitor.name}`); return }
  console.log(`[funko-monitor] Got ${products.length} products`)

  // Push to live feed (reuse shopify feed UI)
  const feedProducts = products.map(p => ({
    id: p.sku || p.name,
    title: p.name,
    handle: p.url || null,  // full URL — renderer will use directly if it starts with http
    images: p.image ? [{ src: p.image }] : [],
    variants: [{ id: p.sku, title: 'Default', available: p.available, price: p.price != null ? String(p.price) : null }]
  }))
  notifyRenderer('shopify:feedUpdate', { monitorId: monitor.id, monitorName: monitor.name, products: feedProducts, baseUrl: 'https://funko.com' })

  const keywords = monitor.keywords
    ? monitor.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
    : []

  const isFirstRun = !funkoMonitorSeen.has(monitor.id)
  if (isFirstRun) funkoMonitorSeen.set(monitor.id, new Map())
  const seen = funkoMonitorSeen.get(monitor.id)

  for (const product of products) {
    const id = product.sku || product.name
    if (!id) continue
    if (keywords.length > 0 && !keywords.some(kw => product.name.toLowerCase().includes(kw))) continue

    const curr = { available: product.available, price: product.price }

    if (isFirstRun) { seen.set(id, curr); continue }

    if (!seen.has(id)) {
      seen.set(id, curr)
      if (product.available) {
        await sendFunkoDiscordPing(monitor, product, 'new')
        notifyRenderer('monitor:alert', { type: 'new', monitorName: monitor.name, product: { title: product.name, image: product.image } })
      }
      continue
    }

    const prev = seen.get(id)
    seen.set(id, curr)

    if (product.available && !prev.available) {
      await sendFunkoDiscordPing(monitor, product, 'restock')
      notifyRenderer('monitor:alert', { type: 'restock', monitorName: monitor.name, product: { title: product.name, image: product.image } })
    }
    if (monitor.price_alert && curr.price != null && prev.price != null && curr.price < prev.price) {
      const threshold = monitor.price_threshold ? parseFloat(monitor.price_threshold) : null
      if (!threshold || curr.price <= threshold) {
        await sendFunkoDiscordPing(monitor, product, 'price_drop', { oldPrice: prev.price, newPrice: curr.price })
      }
    }
  }
}

async function sendFunkoDiscordPing(monitor, product, type, extra = {}) {
  const color = type === 'price_drop' ? 0xff9500 : type === 'restock' ? 0x00ff7f : 0x5865f2
  let title, fields

  if (type === 'price_drop') {
    title = `💰 Price Drop: ${product.name}`
    fields = [
      { name: 'Was', value: `$${parseFloat(extra.oldPrice).toFixed(2)}`, inline: true },
      { name: 'Now', value: `$${parseFloat(extra.newPrice).toFixed(2)}`, inline: true },
      { name: 'Saved', value: `$${(extra.oldPrice - extra.newPrice).toFixed(2)}`, inline: true },
      { name: 'Site', value: 'Funko', inline: false }
    ]
  } else {
    title = `${type === 'restock' ? '🔄 Restock' : '🆕 New Product'}: ${product.name}`
    fields = [
      { name: 'Price', value: product.price != null ? `$${parseFloat(product.price).toFixed(2)}` : 'N/A', inline: true },
      { name: 'Site', value: 'Funko', inline: true },
      { name: 'Status', value: product.available ? 'In Stock' : 'Out of Stock', inline: true }
    ]
  }

  const payload = {
    content: monitor.ping_role ? `<@&${monitor.ping_role}>` : undefined,
    embeds: [{
      title, url: product.url || 'https://funko.com/new-featured/new-releases/',
      color, fields,
      footer: { text: `Resell Tracker Monitor • ${monitor.name}` },
      timestamp: new Date().toISOString()
    }]
  }
  if (product.image) payload.embeds[0].thumbnail = { url: product.image }
  if (!payload.content) delete payload.content

  try {
    await fetch(monitor.webhook_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) })
  } catch (err) { console.error('[funko-monitor] Discord ping failed:', err.message) }
}

// ── Nike SNKRS Monitor ────────────────────────────────────────────────────────
const NIKE_SNKRS_URL = 'https://api.nike.com/product_feed/threads/v2/?anchor=0&count=60&filter=marketplace(US)&filter=language(en)&filter=channelId(010794e5-35fe-4e32-aaff-cd2c74f89d61)'


function fetchNikeProducts(url) {
  return new Promise((resolve) => {
    const req = https.request(url, {
      headers: {
        'User-Agent':  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept':      'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'nike-api-caller-id': 'com.nike.commerce.snkrs.web',
      }
    }, res => {
      let body = ''
      res.on('data', c => body += c)
      res.on('end', () => {
        try {
          const json = JSON.parse(body)
          const products = []
          let loggedImageUrls = false
          for (const thread of (json.objects || [])) {
            for (const info of (thread.productInfo || [])) {
              const content  = info.productContent || {}
              const merch    = info.merchProduct   || {}
              const launch   = info.launchView     || {}
              const price    = info.merch_price?.currentPrice
                            ?? info.skus?.[0]?.msrp
                            ?? info.skus?.[0]?.localizedSpecialPrice
                            ?? info.skus?.[0]?.price
                            ?? info.pricing?.currentPrice
                            ?? null
              const slug     = content.slug || ''
              const launchDate = launch.startEntryDate || null
              const method   = launch.method || null // DAN=draw, LEO/FLOW=FCFS
              const now      = Date.now()
              const launchMs = launchDate ? new Date(launchDate).getTime() : null
              // status: upcoming = not live yet, live = FCFS window open, draw_open = draw accepting entries
              // Skip products Nike itself has marked inactive/sold out
              if (merch.status !== 'ACTIVE') continue
              // Only show products with an actual SNKRS launch event (draw or FCFS window)
              // Products with no launchDate are just regular browseable items in the SNKRS app
              if (!launchDate) continue
              const launchAge = launchMs ? Date.now() - launchMs : 0
              // Hide drops that launched more than 2 hours ago — already sold out
              if (launchMs && launchAge > 2 * 60 * 60 * 1000) continue
              // Hide upcoming drops more than 14 days away (too far out to be useful)
              const msUntilLaunch = launchMs ? launchMs - Date.now() : 0
              if (launchMs && msUntilLaunch > 14 * 24 * 60 * 60 * 1000) continue
              let status = 'upcoming'
              if (launchMs && launchMs <= now) {
                status = (method === 'DAN') ? 'draw_open' : 'live'
              }
              // Use static.nike.com image from publishedContent (different CDN, resolves fine)
              // Walk all nodes recursively to find squarishURL / portraitURL on static.nike.com
              function findNikeImg(nodes) {
                if (!Array.isArray(nodes)) return ''
                for (const n of nodes) {
                  const url = n.properties?.squarishURL || n.properties?.portraitURL || n.properties?.landscapeURL || ''
                  if (url && url.startsWith('https://static.nike.com')) return url
                  const deep = findNikeImg(n.nodes)
                  if (deep) return deep
                }
                return ''
              }
              const allPubNodes = thread.publishedContent?.nodes || []
              let image = findNikeImg(allPubNodes)
              if (!image) {
                // Fall back to wsrv.nl proxy for Scene7 URL
                const rawImg = info.imageUrls?.productImageUrl || ''
                const originUrl = rawImg || (merch.styleColor ? `https://secure-images.nike.com/is/image/DotCom/${merch.styleColor.replace('-', '_')}?wid=440&hei=440` : '')
                image = originUrl ? `https://wsrv.nl/?url=${encodeURIComponent(originUrl)}&w=440&h=440&output=jpg&q=85` : ''
              }
              if (!loggedImageUrls) {
                console.log('[nike-monitor] final image URL:', image)
                loggedImageUrls = true
              }
              // Collect available sizes from skus
              const sizes = (info.skus || [])
                .map(s => s.nikeSize)
                .filter(Boolean)
                .sort((a, b) => parseFloat(a) - parseFloat(b))
              products.push({
                id:        `${thread.id}::${merch.pid || slug}`,
                pid:       merch.pid || slug,
                name:      [content.title, content.colorDescription].filter(Boolean).join(' — '),
                styleColor: merch.styleColor || '',
                url:       slug ? (thread.publishType === 'LAUNCH' ? `https://www.nike.com/launch/t/${slug}` : `https://www.nike.com/t/${slug}`) : 'https://www.nike.com/snkrs',
                image,
                price,
                method,
                launchDate,
                status,
                sizes,
              })
            }
          }
          resolve(products)
        } catch (e) { console.log(`[nike-monitor] parse error: ${e.message}`); resolve(null) }
      })
    })
    req.setTimeout(15000, () => { req.destroy(); resolve(null) })
    req.on('error', (e) => { console.log(`[nike-monitor] fetch error: ${e.message}`); resolve(null) })
    req.end()
  })
}

async function runNikeMonitor(monitor) {
  const url = (monitor.site_url || NIKE_SNKRS_URL).trim()
  console.log(`[nike-monitor] Running ${monitor.name}`)

  const products = await fetchNikeProducts(url)
  if (!products) { console.log(`[nike-monitor] fetch failed for ${monitor.name}`); return }
  console.log(`[nike-monitor] Got ${products.length} products`)

  const isFirstRun = !nikeMonitorSeen.has(monitor.id)
  if (isFirstRun) nikeMonitorSeen.set(monitor.id, new Map())
  const seen = nikeMonitorSeen.get(monitor.id)

  // Push all products to live feed
  const feedProducts = products.map(p => ({
    id: p.id, title: p.name, handle: p.url,
    images: p.image ? [{ src: p.image }] : [],
    launchDate: p.launchDate,
    status: p.status,
    styleColor: p.styleColor,
    variants: [{ id: p.pid, title: p.method === 'DAN' ? 'Draw' : 'FCFS', available: p.status === 'live' || p.status === 'draw_open', price: p.price != null ? String(p.price) : null }]
  }))
  notifyRenderer('shopify:feedUpdate', { monitorId: monitor.id, monitorName: monitor.name, products: feedProducts, baseUrl: 'https://www.nike.com' })


  if (isFirstRun) {
    for (const p of products) seen.set(p.id, { status: p.status, launchDate: p.launchDate, method: p.method })
    return
  }

  // Build keyword filter if set on this monitor
  const kws = monitor.keywords
    ? monitor.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
    : []
  const matchesKeywords = (name) => kws.length === 0 || kws.some(k => name.toLowerCase().includes(k))

  for (const p of products) {
    const prev = seen.get(p.id)
    if (!prev) {
      // New product announced
      seen.set(p.id, { status: p.status, launchDate: p.launchDate, method: p.method })
      if (!matchesKeywords(p.name)) continue
      if (monitor.webhook_url) await sendNikeDiscordPing(monitor, p, 'new')
      notifyRenderer('monitor:alert', { isNike: true, monitorId: monitor.id, monitorName: monitor.name, type: 'new', title: p.name, variant: p.styleColor, price: p.price, url: p.url, image: p.image, sizes: p.sizes })
    } else {
      const statusChanged = p.status !== prev.status
      const methodChanged = p.method !== prev.method
      seen.set(p.id, { status: p.status, launchDate: p.launchDate, method: p.method })
      if (!matchesKeywords(p.name)) continue
      if (statusChanged) {
        const alertType = p.status === 'live' ? 'live' : p.status === 'draw_open' ? 'draw_open' : null
        if (alertType) {
          if (monitor.webhook_url) await sendNikeDiscordPing(monitor, p, alertType)
          notifyRenderer('monitor:alert', { isNike: true, monitorId: monitor.id, monitorName: monitor.name, type: alertType, title: p.name, variant: p.styleColor, price: p.price, url: p.url, image: p.image, sizes: p.sizes })
        }
      }
      if (methodChanged && prev.method === 'DAN' && p.method !== 'DAN') {
        if (monitor.webhook_url) await sendNikeDiscordPing(monitor, p, 'method_change')
        notifyRenderer('monitor:alert', { isNike: true, monitorId: monitor.id, monitorName: monitor.name, type: 'method_change', title: p.name, variant: p.styleColor, price: p.price, url: p.url, image: p.image, sizes: p.sizes })
      }
    }
  }

  // ── Auto-boost: poll at 10s when a launch is within 5 minutes ──────────────
  const BOOST_WINDOW   = 5  * 60 * 1000  // start boost 5 min before launch
  const BOOST_DURATION = 10 * 60 * 1000  // stop boost 10 min after launch
  const BOOST_INTERVAL = 10 * 1000       // 10s fast poll

  const now = Date.now()
  const existingBoost = nikeBoostTimers.get(monitor.id)

  // Clear expired boost
  if (existingBoost && now > existingBoost.stopAt) {
    clearInterval(existingBoost.timer)
    nikeBoostTimers.delete(monitor.id)
    console.log(`[nike-monitor] Boost mode ended for ${monitor.name}`)
    notifyRenderer('monitor:nikeBoost', { monitorId: monitor.id, active: false })
  }

  // Check if any upcoming drop is imminent
  if (!nikeBoostTimers.has(monitor.id)) {
    const imminent = products.find(p => {
      if (!p.launchDate || p.status !== 'upcoming') return false
      const msUntil = new Date(p.launchDate).getTime() - now
      return msUntil > 0 && msUntil <= BOOST_WINDOW
    })
    if (imminent) {
      const stopAt = new Date(imminent.launchDate).getTime() + BOOST_DURATION
      const timer  = setInterval(() => runNikeMonitor(monitor).catch(() => {}), BOOST_INTERVAL)
      nikeBoostTimers.set(monitor.id, { timer, stopAt })
      console.log(`[nike-monitor] Boost mode ON for ${monitor.name} — ${imminent.name} drops soon`)
      notifyRenderer('monitor:nikeBoost', { monitorId: monitor.id, active: true, productName: imminent.name, launchDate: imminent.launchDate })
    }
  }
}

async function sendNikeDiscordPing(monitor, product, type) {
  const colors   = { new: 0x5865f2, live: 0x00d26a, draw_open: 0xff9500, method_change: 0xff3c3c }
  const labels   = { new: '🆕 New Drop Announced', live: '⚡ Drop Live Now', draw_open: '🎟 Draw Now Open', method_change: '🔄 Draw → FCFS' }
  const methodLabel = product.method === 'DAN' ? 'Draw' : product.method === 'LEO' ? 'FCFS (Queue)' : product.method === 'FLOW' ? 'FCFS' : product.method || 'N/A'

  const searchQ = encodeURIComponent(product.styleColor || product.name)
  const stockxUrl = `https://stockx.com/search?s=${searchQ}`
  const goatUrl   = `https://www.goat.com/search?query=${searchQ}`
  const launchTs  = product.launchDate ? `<t:${Math.floor(new Date(product.launchDate).getTime()/1000)}:F> (<t:${Math.floor(new Date(product.launchDate).getTime()/1000)}:R>)` : 'TBA'

  const payload = {
    content: monitor.ping_role ? `<@&${monitor.ping_role}>` : undefined,
    embeds: [{
      title:  `${labels[type] || '👟 Nike'}: ${product.name}`,
      url:    product.url,
      color:  colors[type] || 0x5865f2,
      fields: [
        { name: 'Style Color', value: product.styleColor || 'N/A', inline: true },
        { name: 'Retail',      value: product.price != null ? `$${parseFloat(product.price).toFixed(2)}` : 'TBA', inline: true },
        { name: 'Method',      value: methodLabel, inline: true },
        { name: 'Launch',      value: launchTs, inline: false },
        ...(product.sizes?.length ? [{
          name: `Sizes (${product.sizes.length}) — click to open product page`,
          value: product.sizes.map(s => `[${s}](${product.url})`).join(' · '),
          inline: false
        }] : []),
        { name: 'Resell Research', value: `[StockX](${stockxUrl}) • [GOAT](${goatUrl})`, inline: false },
      ],
      thumbnail: product.image ? { url: product.image } : undefined,
      footer:    { text: `Resell Tracker • ${monitor.name}` },
      timestamp: new Date().toISOString(),
    }]
  }
  if (!payload.content) delete payload.content
  try {
    await fetch(monitor.webhook_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) })
  } catch (err) { console.error('[nike-monitor] Discord ping failed:', err.message) }
}

// ── BB / Amazon Local Monitor ────────────────────────────────────────────────

async function runLocalMonitor(monitor) {
  console.log(`[local-monitor] runLocalMonitor called: ${monitor.name} site_type=${monitor.site_type}`)
  if (monitor.site_type === 'shopify') return runShopifyMonitor(monitor)
  if (monitor.site_type === 'funko')   return runFunkoMonitor(monitor)
  if (monitor.site_type === 'nike')    return runNikeMonitor(monitor)
  const url = (monitor.product_url || monitor.site_url || '').trim()
  if (!url) return

  const result = await scrapeLocalProduct(monitor, url)
  if (!result) {
    console.log(`[local-monitor] No result for ${monitor.name}`)
    return
  }

  const prev = localMonitorSeen.get(monitor.id)
  const curr = { available: !!result.available, price: result.price ?? null }

  if (!prev) {
    // First run — seed without pinging
    localMonitorSeen.set(monitor.id, curr)
    console.log(`[local-monitor] Seeded ${monitor.name} — available:${curr.available} price:${curr.price}`)
    return
  }

  localMonitorSeen.set(monitor.id, curr)

  // Restock
  if (curr.available && !prev.available) {
    console.log(`[local-monitor] RESTOCK: ${monitor.name}`)
    await sendLocalDiscordPing(monitor, result, 'restock', {})
    notifyRenderer('monitor:alert', { type: 'restock', monitorName: monitor.name, product: { title: result.title || monitor.name }, variants: [] })
  }

  // Price drop
  if (monitor.price_alert && curr.price && prev.price && curr.price < prev.price) {
    const threshold = monitor.price_threshold ? parseFloat(monitor.price_threshold) : null
    if (!threshold || curr.price <= threshold) {
      console.log(`[local-monitor] PRICE DROP: ${monitor.name} $${prev.price} → $${curr.price}`)
      await sendLocalDiscordPing(monitor, result, 'price_drop', { oldPrice: prev.price, newPrice: curr.price })
    }
  }
}

async function sendLocalDiscordPing(monitor, product, type, extra) {
  const SITE_LABELS = { bestbuy: 'Best Buy', amazon: 'Amazon', lego: 'LEGO' }
  const siteLabel = SITE_LABELS[monitor.site_type] || monitor.name
  const url = (monitor.product_url || monitor.site_url || '').trim()
  const color = type === 'price_drop' ? 0xff9500 : 0x00ff7f
  let title, fields

  if (type === 'price_drop') {
    title = `💰 Price Drop: ${product.title || monitor.name}`
    fields = [
      { name: 'Was', value: `$${extra.oldPrice.toFixed(2)}`, inline: true },
      { name: 'Now', value: `$${extra.newPrice.toFixed(2)}`, inline: true },
      { name: 'Saved', value: `$${(extra.oldPrice - extra.newPrice).toFixed(2)}`, inline: true },
      { name: 'Site', value: siteLabel, inline: false }
    ]
  } else {
    const price = product.price != null ? `$${product.price.toFixed(2)}` : 'N/A'
    title = `🔄 Back In Stock: ${product.title || monitor.name}`
    fields = [
      { name: 'Price', value: price, inline: true },
      { name: 'Site', value: siteLabel, inline: true },
      { name: 'Status', value: '✅ In Stock', inline: true }
    ]
  }

  const payload = {
    content: monitor.ping_role ? `<@&${monitor.ping_role}>` : undefined,
    embeds: [{ title, url, color, fields, footer: { text: `Resell Tracker Monitor • ${monitor.name}` }, timestamp: new Date().toISOString() }]
  }
  if (!payload.content) delete payload.content

  try {
    await fetch(monitor.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    })
  } catch (err) {
    console.error('[local-monitor] Discord ping failed:', err.message)
  }
}

// IPC — renderer tells main to (re)start local monitors after loading them
ipcMain.handle('localMonitors:start', (_, monitors) => {
  startLocalMonitors(monitors)
  return true
})
ipcMain.handle('localMonitors:stop', (_, monitorId) => {
  stopLocalMonitor(monitorId)
  return true
})

ipcMain.handle('auth:logout', () => {
  clearAuth()
  return true
})

ipcMain.handle('auth:loadMain', () => {
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
})

// ── Market Lookup ──────────────────────────────────────────────────────────────
const EBAY_EXTRACT = `(function(){
  var items = Array.from(document.querySelectorAll('.s-item'));
  var out = [];
  for(var i=0; i<items.length && out.length<20; i++){
    var el = items[i];
    var titleEl = el.querySelector('.s-item__title');
    var priceEl = el.querySelector('.s-item__price');
    var imgEl   = el.querySelector('img');
    var linkEl  = el.querySelector('a.s-item__link') || el.querySelector('a[href*="/itm/"]');
    if(!titleEl || !priceEl) continue;
    var t = (titleEl.innerText||titleEl.textContent).replace(/^New listing\\s*/i,'').trim();
    if(!t || t==='Shop on eBay') continue;
    var imgSrc = imgEl ? (imgEl.src||imgEl.getAttribute('data-src')||'') : '';
    // skip placeholder 1px images
    if(imgSrc.includes('s-l140') || imgSrc.length < 10) imgSrc = '';
    out.push({ title:t, price:(priceEl.innerText||priceEl.textContent).trim(), image:imgSrc, url:linkEl?linkEl.href:'' });
  }
  return out;
})()`

async function scrapeMarketPlatform(url, extractFn, readySelector, timeout) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false, width: 1280, height: 900,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    })
    win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36')

    let done = false
    const finish = (val) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { win.destroy() } catch {}
      resolve(val || [])
    }

    const timer = setTimeout(() => finish([]), timeout)

    win.webContents.on('did-fail-load', (e, code) => { if (code !== -3) finish([]) })

    win.webContents.on('did-finish-load', async () => {
      for (let i = 0; i < 20 && !done; i++) {
        await new Promise(r => setTimeout(r, 1000))
        try {
          const check = readySelector
            ? await win.webContents.executeJavaScript(`!!document.querySelector(${JSON.stringify(readySelector)})`)
            : await win.webContents.executeJavaScript(`document.querySelectorAll('img').length > 3`)
          if (!check) continue
          const results = await win.webContents.executeJavaScript(extractFn)
          if (results && results.length) { finish(results); return }
        } catch {}
      }
      finish([])
    })

    win.loadURL(url)
  })
}

async function fetchEbay(query, sold) {
  return new Promise((resolve) => {
    const q = encodeURIComponent(query)
    const url = sold
      ? `https://www.ebay.com/sch/i.html?_nkw=${q}&_sacat=0&_from=R40&rt=nc&LH_Sold=1&LH_Complete=1`
      : `https://www.ebay.com/sch/i.html?_nkw=${q}&_sacat=0`

    // Use a persistent session so eBay cookies are kept between searches
    const { session } = require('electron')
    const ebaySess = session.fromPartition('persist:ebay')

    const win = new BrowserWindow({
      show: false,
      width: 1280, height: 900,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: ebaySess,
      }
    })
    win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36')

    let done = false
    const finish = (val) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { win.destroy() } catch {}
      resolve(val || [])
    }

    const timer = setTimeout(() => finish([]), 30000)

    const wc = win.webContents
    const safe = (fn) => { try { if (!win.isDestroyed()) return fn() } catch {} return Promise.resolve(null) }

    wc.on('did-finish-load', async () => {
      if (done) return
      try {
        const title = await safe(() => wc.getTitle()) || ''
        if (title.includes('Pardon') || title.includes('Interruption')) {
          // Show window so user can solve the one-time bot challenge
          safe(() => win.show())
          await new Promise(r => setTimeout(r, 20000))
          if (done) return
          safe(() => win.hide())
          await new Promise(r => setTimeout(r, 3000))
          if (done) return
        }
        // Poll for results
        for (let i = 0; i < 15 && !done; i++) {
          await new Promise(r => setTimeout(r, 1000))
          if (done) return
          const count = await safe(() => wc.executeJavaScript(`document.querySelectorAll('.s-item').length`))
          if (!count || count < 2) continue
          const results = await safe(() => wc.executeJavaScript(EBAY_EXTRACT))
          if (results?.length) { finish(results); return }
        }
      } catch {}
      finish([])
    })

    win.loadURL(url)
  })
}

// ── Deal Scanner ──────────────────────────────────────────────────────────────
const EBAY_DEAL_EXTRACT = `(function(){
  var items = Array.from(document.querySelectorAll('.s-item'));
  var out = [];
  for(var i=0; i<items.length && out.length<40; i++){
    var el = items[i];
    var titleEl = el.querySelector('.s-item__title');
    var priceEl = el.querySelector('.s-item__price');
    if(!titleEl || !priceEl) continue;
    var t = (titleEl.innerText||'').replace(/^New listing\\s*/i,'').trim();
    if(!t || t==='Shop on eBay') continue;
    var priceText = (priceEl.innerText||'').trim();
    var priceNum = parseFloat(priceText.replace(/[^0-9.]/g,'')) || 0;
    var imgEl = el.querySelector('img');
    var imgSrc = imgEl ? (imgEl.src||imgEl.getAttribute('data-src')||'') : '';
    if(imgSrc.includes('s-l140')||imgSrc.length<10) imgSrc='';
    var linkEl = el.querySelector('a.s-item__link') || el.querySelector('a[href*="/itm/"]');
    var sellerEl = el.querySelector('.s-item__seller-info-text, .s-item__seller-info');
    var seller = sellerEl ? sellerEl.innerText.trim() : '';
    var shippingEl = el.querySelector('.s-item__shipping, .s-item__freeXDays');
    var shipping = shippingEl ? shippingEl.innerText.trim() : '';
    var timeEl = el.querySelector('.s-item__time-left, .s-item__listingDate, .s-item__ended-date');
    var timeInfo = timeEl ? timeEl.innerText.trim() : '';
    out.push({ title:t, price:priceText, priceNum:priceNum, image:imgSrc,
               url:linkEl?linkEl.href:'', seller:seller, shipping:shipping, timeInfo:timeInfo });
  }
  return out;
})()`

function fetchEbayDeals(query, sold) {
  return new Promise((resolve) => {
    const q = encodeURIComponent(query)
    const url = sold
      ? `https://www.ebay.com/sch/i.html?_nkw=${q}&_sacat=0&_from=R40&rt=nc&LH_Sold=1&LH_Complete=1`
      : `https://www.ebay.com/sch/i.html?_nkw=${q}&_sacat=0`

    const { session: sess } = require('electron')
    const ebaySess = sess.fromPartition('persist:ebay')

    const win = new BrowserWindow({
      show: false, width: 1280, height: 900,
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: ebaySess }
    })
    win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36')

    let done = false
    const finish = (val) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { win.destroy() } catch {}
      resolve(val || [])
    }

    const timer = setTimeout(() => finish([]), 30000)
    const wc = win.webContents
    const safe = (fn) => { try { if (!win.isDestroyed()) return fn() } catch {} return Promise.resolve(null) }

    wc.on('did-finish-load', async () => {
      if (done) return
      try {
        const title = await safe(() => wc.getTitle()) || ''
        if (title.includes('Pardon') || title.includes('Interruption')) {
          safe(() => win.show())
          await new Promise(r => setTimeout(r, 20000))
          if (done) return
          safe(() => win.hide())
          await new Promise(r => setTimeout(r, 3000))
          if (done) return
        }
        for (let i = 0; i < 15 && !done; i++) {
          await new Promise(r => setTimeout(r, 1000))
          if (done) return
          const count = await safe(() => wc.executeJavaScript(`document.querySelectorAll('.s-item').length`))
          if (!count || count < 2) continue
          const results = await safe(() => wc.executeJavaScript(EBAY_DEAL_EXTRACT))
          if (results?.length) { finish(results); return }
        }
      } catch {}
      finish([])
    })

    win.loadURL(url)
  })
}

ipcMain.handle('deals:scan', async (_, query) => {
  // Run sold first, then active (sequential to avoid double bot challenge)
  const soldRaw = await fetchEbayDeals(query, true)
  const activeRaw = await fetchEbayDeals(query, false)

  const soldPrices = soldRaw.map(r => r.priceNum).filter(p => p > 0)
  if (!soldPrices.length) return { error: 'No sold data found', deals: [], avgSold: 0, soldCount: 0, activeCount: activeRaw.length }

  soldPrices.sort((a, b) => a - b)
  const median = soldPrices[Math.floor(soldPrices.length / 2)]
  const mean = soldPrices.reduce((a, b) => a + b, 0) / soldPrices.length
  const avgSold = (median + mean) / 2

  const deals = activeRaw
    .filter(r => r.priceNum > 0)
    .map(r => {
      const pctBelow = ((avgSold - r.priceNum) / avgSold) * 100
      const dealScore = Math.min(100, Math.max(0, Math.round(pctBelow * 2)))
      return { ...r, avgSold: Math.round(avgSold * 100) / 100, pctBelow: Math.round(pctBelow), dealScore }
    })
    .filter(r => r.pctBelow >= 15)
    .sort((a, b) => b.pctBelow - a.pctBelow)

  return { deals, avgSold: Math.round(avgSold * 100) / 100, soldCount: soldPrices.length, activeCount: activeRaw.length }
})

