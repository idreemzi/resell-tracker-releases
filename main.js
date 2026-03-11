const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
// Force HTTP/1.1 — avoids Akamai HTTP/2 fingerprint detection on BB/Amazon
app.commandLine.appendSwitch('disable-http2')
const path   = require('path')
const fs     = require('fs')
const http   = require('http')
const crypto = require('crypto')
const DISCORD = require('./discord-config')
const { autoUpdater } = require('electron-updater')

let mainWindow
let dataPath
let photosDir

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

  const authed = await checkAuth()
  if (authed) {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'))
  }
}

app.whenReady().then(() => {
  const userDataPath = app.getPath('userData')
  dataPath = path.join(userDataPath, 'data.json')
  photosDir = path.join(userDataPath, 'photos')
  if (!fs.existsSync(photosDir)) fs.mkdirSync(photosDir, { recursive: true })
  createWindow()
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
    const data = readData()
    const newItem = { ...item, id: genId(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    data[name].push(newItem)
    writeData(data)
    return newItem
  })

  ipcMain.handle(`${name}:update`, (_, id, updates) => {
    const data = readData()
    const idx = data[name].findIndex(i => i.id === id)
    if (idx === -1) return null
    data[name][idx] = { ...data[name][idx], ...updates, updatedAt: new Date().toISOString() }
    writeData(data)
    return data[name][idx]
  })

  ipcMain.handle(`${name}:delete`, (_, id) => {
    const data = readData()
    data[name] = data[name].filter(i => i.id !== id)
    writeData(data)
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
  shell.openExternal(url)
})

ipcMain.handle('app:version',      () => app.getVersion())
ipcMain.handle('window:minimize',  () => mainWindow.minimize())
ipcMain.handle('window:close',     () => mainWindow.close())

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

// ── Local Monitor Engine (Best Buy + Amazon — bypass bot detection via real Chromium) ──
// Runs in-app, uses the user's real IP and browser fingerprint.
// Server handles Shopify/Walmart/Target; this handles BB/Amazon.

const localMonitorTimers  = new Map()  // monitorId → intervalId
const localMonitorSeen    = new Map()  // monitorId → { available, price }
const localMonitorWindows = new Map()  // monitorId → persistent BrowserWindow
const LOCAL_MONITOR_SITES = new Set(['bestbuy', 'amazon'])

function startLocalMonitors(monitors) {
  // Stop any existing timers first
  for (const [id, timer] of localMonitorTimers) clearInterval(timer)
  localMonitorTimers.clear()

  for (const m of monitors) {
    if (m.active && LOCAL_MONITOR_SITES.has(m.site_type)) {
      scheduleLocalMonitor(m)
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

async function scrapeLocalProduct(monitor, url) {
  const win = getOrCreateMonitorWindow(monitor)
  const siteType = monitor.site_type
  return new Promise((resolve) => {
    let done = false
    const finish = (val) => { if (!done) { done = true; clearTimeout(timer); resolve(val) } }
    const timer = setTimeout(() => finish(null), 30000)

    const onFail = (e, code) => { if (code !== -3) finish(null) }
    const onLoad = async () => {
      if (done) return
      const extractFn = siteType === 'amazon' ? AMZN_EXTRACT : BB_EXTRACT
      for (let i = 0; i < 20 && !done; i++) {
        await new Promise(r => setTimeout(r, 1000))
        try {
          const result = await win.webContents.executeJavaScript(extractFn)
          if (result && result.available !== undefined) { finish(result); return }
        } catch {}
      }
      finish(null)
    }

    win.webContents.once('did-fail-load', onFail)
    win.webContents.once('did-finish-load', onLoad)
    win.loadURL(url)
  })
}

async function runLocalMonitor(monitor) {
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
  const SITE_LABELS = { bestbuy: 'Best Buy', amazon: 'Amazon' }
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

