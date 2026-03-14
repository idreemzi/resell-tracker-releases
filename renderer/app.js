// ── State ─────────────────────────────────────────────────────────────────────
let sales     = []
let inventory = []
let packages  = []
let releases       = []
let pinnedMessages = []
let isAdmin        = false
let monitors = []
let monitorEditId = null
const ADMIN_DISCORD_ID = '313100007551270912'
const LOCAL_SITES = new Set(['bestbuy', 'amazon', 'shopify', 'lego', 'funko', 'nike'])

// Live Shopify feed state
const shopifyFeeds = new Map()  // monitorId → { monitorName, products, baseUrl, updatedAt }
let activeFeedMonitorId = null
let feedInstockOnly = false
let feedSearchQuery  = ''

let chartYear = new Date().getFullYear()
const chartVisible = { spent: true, revenue: true, profit: true }
let editMode  = null   // { collection, id } or null

const PIPELINE_STAGES = ['Ordered', 'Awaiting Pickup', 'In Transit', 'Out for Delivery', 'Delivered']
const expandedPackages = new Set()  // pkg IDs with event history expanded
let deleteTarget  = null
let soldSourceItem = null  // inventory item being marked as sold

// Inventory photo state
let pendingInvPhoto = null  // file path chosen but not yet saved

// ── Platform Logos ────────────────────────────────────────────────────────────
const PLATFORM_META = {
  'ebay':                  { color: '#e43137', abbr: 'eB', domain: 'ebay.com' },
  'stockx':                { color: '#00a046', abbr: 'SX', domain: 'stockx.com' },
  'goat':                  { color: '#1a1a1a', abbr: 'GT', domain: 'goat.com' },
  'depop':                 { color: '#ff2300', abbr: 'Dp', domain: 'depop.com' },
  'poshmark':              { color: '#cf1f3e', abbr: 'Pm', domain: 'poshmark.com' },
  'mercari':               { color: '#e8174c', abbr: 'Mc', domain: 'mercari.com' },
  'facebook':              { color: '#1877f2', abbr: 'FB', domain: 'facebook.com' },
  'facebook marketplace':  { color: '#1877f2', abbr: 'FB', domain: 'facebook.com' },
  'fb marketplace':        { color: '#1877f2', abbr: 'FB', domain: 'facebook.com' },
  'amazon':                { color: '#ff9900', abbr: 'Az', domain: 'amazon.com' },
  'grailed':               { color: '#222',    abbr: 'Gr', domain: 'grailed.com' },
  'flight club':           { color: '#ff5722', abbr: 'FC', domain: 'flightclub.com' },
  'stadium goods':         { color: '#111',    abbr: 'SG', domain: 'stadiumgoods.com' },
  'offerup':               { color: '#00bf5f', abbr: 'OU', domain: 'offerup.com' },
  'craigslist':            { color: '#7c3aed', abbr: 'CL', domain: 'craigslist.org' },
  'hermes':                { color: '#d97706', abbr: 'Hm', domain: 'hermes.com' },
  'vestiaire':             { color: '#1c6e3d', abbr: 'Vs', domain: 'vestiairecollective.com' },
  'tradesy':               { color: '#8b5cf6', abbr: 'Tr', domain: 'tradesy.com' },
  'vinted':                { color: '#097964', abbr: 'Vi', domain: 'vinted.com' },
}

function platformBadge(name) {
  if (!name) return '<span class="cell-muted">—</span>'
  const key  = name.toLowerCase().trim()
  const meta = PLATFORM_META[key]
  const bg   = meta ? meta.color : '#888'
  const abbr = meta ? meta.abbr  : name.slice(0, 2).toUpperCase()
  const fallback = `this.style.display='none';this.nextElementSibling.style.display='inline-flex'`
  const imgHtml = meta
    ? `<img class="platform-logo-img" src="https://www.google.com/s2/favicons?domain=${meta.domain}&sz=32" alt="" onerror="${fallback}" /><span class="platform-chip" style="background:${bg};display:none">${abbr}</span>`
    : `<span class="platform-chip" style="background:${bg}">${abbr}</span>`
  return `<div class="platform-cell">${imgHtml}<span>${esc(name)}</span></div>`
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)

function fmt(n, fallback = '—') {
  const v = parseFloat(n)
  if (n == null || n === '' || isNaN(v)) return fallback
  return '$' + v.toFixed(2)
}

function calcSaleProfit(s) {
  if (s.sellPrice == null || s.sellPrice === '') return null
  return (parseFloat(s.sellPrice) || 0) - (parseFloat(s.buyPrice) || 0) - (parseFloat(s.fees) || 0)
}

function profitDisplay(p) {
  if (p == null) return { text: '—', cls: 'profit-zero' }
  const sign = p >= 0 ? '+' : '-'
  return { text: `${sign}$${Math.abs(p).toFixed(2)}`, cls: p > 0 ? 'profit-pos' : p < 0 ? 'profit-neg' : 'profit-zero' }
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function today() { return new Date().toISOString().slice(0, 10) }

function playAlertSound(times = 1) {
  try {
    const audio = new Audio('./alert.wav')
    audio.volume = 0.7
    audio.play().catch(() => {})
    for (let i = 1; i < times; i++) {
      setTimeout(() => {
        const a = new Audio('./alert.wav')
        a.volume = 0.7
        a.play().catch(() => {})
      }, i * 600)
    }
  } catch {}
}

// Edit/delete SVG icons (reused in rows)
const EDIT_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="pointer-events:none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`
const DEL_ICON  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="pointer-events:none"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`
const SOLD_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="pointer-events:none"><polyline points="20 6 9 17 4 12"/></svg>`
const REFRESH_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="pointer-events:none"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`
const LINK_ICON    = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="pointer-events:none"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`
const ACTION_BTNS     = `<div class="row-actions"><button class="btn-row btn-edit" title="Edit" style="pointer-events:auto">${EDIT_ICON}</button><button class="btn-row danger btn-delete" title="Delete" style="pointer-events:auto">${DEL_ICON}</button></div>`
const ACTION_BTNS_INV = `<div class="row-actions"><button class="btn-row sold btn-mark-sold" title="Mark as Sold" style="pointer-events:auto">${SOLD_ICON}</button><button class="btn-row btn-edit" title="Edit" style="pointer-events:auto">${EDIT_ICON}</button><button class="btn-row danger btn-delete" title="Delete" style="pointer-events:auto">${DEL_ICON}</button></div>`
const ACTION_BTNS_PKG = `<div class="row-actions"><button class="btn-row btn-refresh-tracking" title="Refresh Status" style="pointer-events:auto">${REFRESH_ICON}</button><button class="btn-row btn-open-tracking" title="Track on Website" style="pointer-events:auto">${LINK_ICON}</button><button class="btn-row btn-edit" title="Edit" style="pointer-events:auto">${EDIT_ICON}</button><button class="btn-row danger btn-delete" title="Delete" style="pointer-events:auto">${DEL_ICON}</button></div>`

// ── Boot ──────────────────────────────────────────────────────────────────────
function init() {
  bindEvents()
  bindProxyEvents()
  loadData()
  // Sync toggle state to match whatever theme localStorage applied on load
  const dark = localStorage.getItem('rt-theme') === 'dark'
  $('dark-mode-track').classList.toggle('on', dark)
  initStatusBar()
  initNavUser()
  initEbayDarkMode()
  initCheckoutWebview()
  initHome()
  initMonitorPush()
  initDiscordKeywords()
  initDiscordFeed()
  initProfileModal()
  startLaunchCountdown()
}

function startLaunchCountdown() {
  setInterval(() => {
    document.querySelectorAll('.feed-launch-badge[data-launch]').forEach(badge => {
      const ms   = parseInt(badge.dataset.launch)
      const diff = ms - Date.now()
      if (diff <= 0) {
        badge.textContent = '🟢 Live Now'
        badge.className = 'feed-launch-badge badge-live'
        badge.removeAttribute('data-launch')
        return
      }
      const days = Math.floor(diff / 864e5)
      const hrs  = Math.floor(diff / 36e5)
      const mins = Math.floor((diff % 36e5) / 60000)
      const secs = Math.floor((diff % 60000) / 1000)
      let label
      if (days >= 1)      label = `in ${days}d ${hrs % 24}h`
      else if (hrs >= 1)  label = `in ${hrs}h ${mins}m`
      else if (mins >= 1) label = `in ${mins}m ${secs}s`
      else                label = `in ${secs}s`
      badge.textContent = `Drops ${label}`
    })
  }, 1000)
}

async function initNavUser() {
  const result = await window.api.auth.check()
  if (!result?.user) return
  const { userId, username, avatar } = result.user

  $('nav-user-name').textContent    = username
  $('nav-user-tooltip').textContent = '@' + username

  // Show admin-only buttons
  isAdmin = userId === ADMIN_DISCORD_ID
  $('btn-add-release').style.display = isAdmin ? '' : 'none'
  $('btn-add-pinned').style.display  = isAdmin ? '' : 'none'

  if (avatar) {
    const img = document.createElement('img')
    img.src = avatar
    img.alt = username
    const circle = document.querySelector('#nav-user-avatar .nav-user')
    circle.innerHTML = ''
    circle.appendChild(img)
  } else {
    $('nav-user-initials').textContent = username.slice(0, 2).toUpperCase()
  }
}

function initStatusBar() {
  // Version
  window.api.getVersion().then(v => { $('status-version').textContent = `Version ${v}` })

  // Live clock
  function tick() {
    const now = new Date()
    $('status-clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }
  tick()
  setInterval(tick, 1000)
}

async function loadData() {
  try {
    const [s, i, p, r, pm] = await Promise.all([
      window.api.sales.getAll(),
      window.api.inventory.getAll(),
      window.api.packages.getAll(),
      window.api.releases.getAll(),
      window.api.pinned.getAll()
    ])
    sales          = Array.isArray(s)  ? s  : []
    inventory      = Array.isArray(i)  ? i  : []
    packages       = Array.isArray(p)  ? p  : []
    releases       = Array.isArray(r)  ? r  : []
    pinnedMessages = Array.isArray(pm) ? pm : []
  } catch (err) {
    console.error('Failed to load data:', err)
    sales = []; inventory = []; packages = []
  }
  if (isAdmin) {
    try { monitors = await window.api.monitors.getAll() } catch { monitors = [] }
    $('tab-monitors').style.display      = ''
    $('tab-discord').style.display       = ''
    $('tab-proxies').style.display       = ''
    $('nav-admin-divider').style.display = ''
    renderMonitors()
    loadProxies()
    // Start local monitors (Best Buy / Amazon) in Electron main process
    const localMonitors = monitors.filter(m => m.active && LOCAL_SITES.has(m.site_type))
    if (localMonitors.length) window.api.localMonitors.start(localMonitors).catch(() => {})
  }
  renderAll()
  autoRefreshPackages()
}

function renderAll() {
  renderSales()
  renderInventory()
  renderPackages()
  renderChart()
  renderHome()
}

// ── Sales ─────────────────────────────────────────────────────────────────────
function renderSales(filter = '') {
  const q    = filter.toLowerCase()
  const rows = q
    ? sales.filter(s => [s.productName, s.platform, s.size].join(' ').toLowerCase().includes(q))
    : sales

  $('sales-count').textContent = `${sales.length} Total`

  const totalSpent   = sales.reduce((a,s) => a + (parseFloat(s.buyPrice)  || 0), 0)
  const totalRevenue = sales.reduce((a,s) => a + (parseFloat(s.sellPrice) || 0), 0)
  const totalProfit  = sales.reduce((a,s) => a + (calcSaleProfit(s)       || 0), 0)

  $('stat-spent').textContent   = fmt(totalSpent,   '$0')
  $('stat-revenue').textContent = fmt(totalRevenue, '$0')
  const pd = profitDisplay(totalProfit)
  $('stat-profit').textContent = pd.text
  $('stat-profit').className   = `stat-value ${pd.cls}`

  const tbody = $('sales-tbody')
  const empty = $('sales-empty')

  if (!rows.length) {
    tbody.innerHTML = ''
    empty.style.display = 'block'
    return
  }
  empty.style.display = 'none'
  tbody.innerHTML = rows.map(s => {
    const p  = calcSaleProfit(s)
    const pd = profitDisplay(p)
    return `<tr>
      <td>${platformBadge(s.platform)}</td>
      <td>${esc(s.productName)}</td>
      <td>${fmt(s.buyPrice)}</td>
      <td>${fmt(s.sellPrice)}</td>
      <td>${fmt(s.fees)}</td>
      <td class="${pd.cls}">${pd.text}</td>
      <td class="cell-muted">${s.date || '—'}</td>
      <td data-id="${esc(s.id)}" data-collection="sales">${ACTION_BTNS}</td>
    </tr>`
  }).join('')
}

// ── Inventory ─────────────────────────────────────────────────────────────────
function renderInventory(filter = '') {
  const q    = filter.toLowerCase()
  const rows = q
    ? inventory.filter(i => [i.productName, i.store, i.size].join(' ').toLowerCase().includes(q))
    : inventory

  $('inv-count').textContent = `${inventory.length} Total`

  const tbody = $('inv-tbody')
  const empty = $('inv-empty')

  if (!rows.length) {
    tbody.innerHTML = ''
    empty.style.display = 'block'
    return
  }
  empty.style.display = 'none'
  tbody.innerHTML = rows.map(i => {
    const buy    = parseFloat(i.buyPrice)       || 0
    const resell = parseFloat(i.estimatedResell)
    const estP   = (i.estimatedResell != null && i.estimatedResell !== '') ? resell - buy : null
    const pd     = profitDisplay(estP)
    const qty    = i.qty ?? 1
    const thumb  = i.photo
      ? `<img class="inv-thumb" data-photo="${esc(i.photo)}" src="data:," alt="" />`
      : `<div class="inv-thumb-placeholder">📦</div>`
    return `<tr>
      <td>${thumb}</td>
      <td>${esc(i.productName)}</td>
      <td>${qty}</td>
      <td>${esc(i.store || '—')}</td>
      <td>${fmt(i.buyPrice)}</td>
      <td>${fmt(i.estimatedResell)}</td>
      <td class="${pd.cls}">${pd.text}</td>
      <td data-id="${esc(i.id)}" data-collection="inventory">${ACTION_BTNS_INV}</td>
    </tr>`
  }).join('')

  // Load thumbnails async
  document.querySelectorAll('.inv-thumb[data-photo]').forEach(async img => {
    const photo = img.dataset.photo
    if (isUrl(photo)) {
      img.src = photo
      img.onclick = () => openLightbox(photo)
    } else {
      const dataUrl = await window.api.readPhoto(photo)
      if (dataUrl) {
        img.src = dataUrl
        img.onclick = () => openLightbox(dataUrl)
      }
    }
  })
}

// ── Packages ──────────────────────────────────────────────────────────────────
const CHECK_ICON = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="pointer-events:none"><polyline points="20 6 9 17 4 12"/></svg>`

function getStageIndex(status) {
  const idx = PIPELINE_STAGES.indexOf(status)
  return idx !== -1 ? idx : 0
}

function buildPipelineHtml(status) {
  const isException = status === 'Exception'
  const stageIdx = getStageIndex(status)
  return PIPELINE_STAGES.map((label, i) => {
    let cls = isException ? 'error' : i < stageIdx ? 'done' : i === stageIdx ? 'active' : ''
    const dotContent = (cls === 'done') ? CHECK_ICON : ''
    return `<div class="pipeline-stage ${cls}">
      <div class="pipeline-dot">${dotContent}</div>
      <span class="pipeline-label">${label === 'Awaiting Pickup' ? 'Awaiting' : label === 'Out for Delivery' ? 'Out for Del.' : label}</span>
    </div>`
  }).join('')
}

function buildPkgCard(p) {
  const events   = p.events || []
  const latest   = events[0] || null
  const isExpanded = expandedPackages.has(p.id)
  const status   = p.status || 'Ordered'

  const latestAccentCls = status === 'Delivered' ? 'delivered' : status === 'Exception' ? 'exception' : ''
  const latestHtml = latest
    ? `<div class="pkg-latest-event ${latestAccentCls}">
        <div class="pkg-event-desc">${esc(latest.description)}</div>
        <div class="pkg-event-meta">
          ${latest.location  ? `<span>${esc(latest.location)}</span>`  : ''}
          ${latest.timestamp ? `<span>${esc(latest.timestamp)}</span>` : ''}
        </div>
       </div>`
    : status !== 'Ordered'
      ? `<div class="pkg-latest-event ${latestAccentCls}"><div class="pkg-event-desc">${esc(status)}</div></div>`
      : ''

  const eventsHtml = events.length > 1
    ? `<div class="pkg-events-list ${isExpanded ? 'open' : ''}">
        ${events.map((e, idx) => `
          <div class="pkg-event-item">
            <div class="pkg-event-dot" style="${idx === 0 ? '' : ''}"></div>
            <div class="pkg-event-body">
              <div class="pkg-event-desc">${esc(e.description)}</div>
              <div class="pkg-event-meta">
                ${e.location  ? `<span>${esc(e.location)}</span>`  : ''}
                ${e.timestamp ? `<span>${esc(e.timestamp)}</span>` : ''}
              </div>
            </div>
          </div>`).join('')}
       </div>`
    : ''

  const chevronSvg = `<svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="pointer-events:none"><polyline points="6 9 12 15 18 9"/></svg>`
  const toggleHtml = events.length > 1
    ? `<button class="pkg-toggle-events ${isExpanded ? 'open' : ''}" data-pkg-toggle="${esc(p.id)}">
        ${isExpanded ? 'Hide' : events.length - 1 + ' more event' + (events.length > 2 ? 's' : '')} ${chevronSvg}
       </button>`
    : '<span></span>'

  return `<div class="pkg-card" data-id="${esc(p.id)}">
    <div class="pkg-card-header">
      <div style="min-width:0">
        <div class="pkg-card-title">${esc(p.nickname || p.trackingNumber)}</div>
        <div class="pkg-card-meta">
          <span class="pkg-carrier-badge">${esc(p.carrier || '?')}</span>
          <span class="pkg-tracking-num">${esc(p.trackingNumber)}</span>
          ${p.expectedDelivery && p.status !== 'Delivered' ? `<span style="font-size:11px;font-weight:700;color:var(--accent);background:rgba(var(--accent-rgb,99,102,241),.1);padding:2px 7px;border-radius:10px">📦 Est. ${esc(p.expectedDelivery)}</span>` : ''}
        </div>
      </div>
      <div class="row-actions" style="flex-shrink:0">
        <button class="btn-row btn-refresh-tracking" data-id="${esc(p.id)}" title="Refresh tracking">${REFRESH_ICON}</button>
        <button class="btn-row btn-open-tracking"    data-id="${esc(p.id)}" title="Open on carrier site">${LINK_ICON}</button>
        <button class="btn-row btn-edit"             data-id="${esc(p.id)}" title="Edit">${EDIT_ICON}</button>
        <button class="btn-row danger btn-delete"    data-id="${esc(p.id)}" title="Delete">${DEL_ICON}</button>
      </div>
    </div>
    <div class="pkg-pipeline">${buildPipelineHtml(status)}</div>
    ${latestHtml}
    ${eventsHtml}
    <div class="pkg-card-footer">${toggleHtml}</div>
  </div>`
}

function renderPackages(filter = '') {
  const q    = filter.toLowerCase()
  const rows = q
    ? packages.filter(p => [p.trackingNumber, p.carrier, p.nickname, p.status].join(' ').toLowerCase().includes(q))
    : packages

  $('pkg-count').textContent = `${packages.length} Total`

  const container = $('pkg-cards-container')
  const empty     = $('pkg-empty')

  if (!rows.length) {
    container.innerHTML = ''
    empty.style.display = 'block'
    return
  }
  empty.style.display = 'none'
  container.innerHTML = `<div class="pkg-cards-grid">${rows.map(buildPkgCard).join('')}</div>`
}

// ── Tracking Status ───────────────────────────────────────────────────────────
async function refreshTrackingStatus(pkg) {
  // Disable refresh button while loading
  const card = document.querySelector(`.pkg-card[data-id="${pkg.id}"]`)
  const btn  = card?.querySelector('.btn-refresh-tracking')
  if (btn) { btn.disabled = true; btn.style.opacity = '0.4' }

  try {
    const result = await window.api.fetchTrackingEvents(pkg.trackingNumber, pkg.carrier)
    if (result) {
      const updates = { lastFetchedAt: new Date().toISOString() }
      if (result.status)            updates.status           = result.status
      if (result.events?.length)    updates.events           = result.events
      if (result.expectedDelivery)  updates.expectedDelivery = result.expectedDelivery
      const updated = await window.api.packages.update(pkg.id, updates)
      packages = packages.map(p => p.id === pkg.id ? updated : p)
      renderPackages()
    }
  } finally {
    // renderPackages() recreates the DOM — no need to reset button
  }
}

// ── Chart ─────────────────────────────────────────────────────────────────────
function renderChart() {
  const svgEl = $('sales-chart')
  if (!svgEl) return

  $('chart-title').textContent = `Sales History for ${chartYear}`

  const W  = (svgEl.parentElement ? svgEl.parentElement.clientWidth : 0) || 600
  const H  = 150
  const PL = 42, PR = 12, PT = 10, PB = 28
  const cW = W - PL - PR
  const cH = H - PT - PB

  // Aggregate monthly data
  const months = []
  for (let idx = 0; idx < 12; idx++) months.push({ spent: 0, revenue: 0, profit: 0 })

  for (let si = 0; si < sales.length; si++) {
    const s = sales[si]
    if (!s || !s.date) continue
    const d = new Date(s.date)
    if (isNaN(d.getTime()) || d.getFullYear() !== chartYear) continue
    const mo   = d.getMonth()
    const buy  = parseFloat(s.buyPrice)  || 0
    const sell = parseFloat(s.sellPrice) || 0
    const fees = parseFloat(s.fees)      || 0
    months[mo].spent   += buy
    months[mo].revenue += sell
    months[mo].profit  += (sell - buy - fees)
  }

  // Find max value (only from visible series)
  let maxVal = 10
  for (let idx = 0; idx < 12; idx++) {
    if (chartVisible.spent   && months[idx].spent   > maxVal) maxVal = months[idx].spent
    if (chartVisible.revenue && months[idx].revenue > maxVal) maxVal = months[idx].revenue
    if (chartVisible.profit  && months[idx].profit  > maxVal) maxVal = months[idx].profit
  }
  const yStep = maxVal <= 50 ? 10 : maxVal <= 200 ? 50 : maxVal <= 500 ? 100 : maxVal <= 2000 ? 500 : 1000
  const yMax  = Math.ceil(maxVal / yStep) * yStep || 10

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const slotW  = cW / 12
  const barW   = Math.max(4, slotW / 5)
  const gap    = barW * 0.4
  const BAR_COLORS = ['#ef4444', '#f97316', '#22c55e']

  let grid = '', bars = '', labels = ''

  // Y-axis gridlines
  for (let gi = 0; gi <= 5; gi++) {
    const v = (yMax / 5) * gi
    const y = PT + cH - (v / yMax) * cH
    grid += `<line x1="${PL}" y1="${y.toFixed(1)}" x2="${W - PR}" y2="${y.toFixed(1)}" stroke="#e0d4c0" stroke-width="1"/>`
    const label = v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v)
    grid += `<text x="${(PL - 5).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#a09890">${label}</text>`
  }

  // Bars + X labels
  for (let mo = 0; mo < 12; mo++) {
    const x0   = PL + mo * slotW + (slotW - 3 * barW - 2 * gap) / 2
    const keys = ['spent', 'revenue', 'profit']
    const vals = [months[mo].spent, months[mo].revenue, months[mo].profit]
    for (let bi = 0; bi < 3; bi++) {
      if (!chartVisible[keys[bi]]) continue
      const v = vals[bi]
      const h = Math.max(0, (v / yMax) * cH)
      const bx = x0 + bi * (barW + gap)
      const by = PT + cH - h
      bars += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${BAR_COLORS[bi]}" rx="2" opacity="0.85"/>`
    }
    const lx = PL + mo * slotW + slotW / 2
    const ly = PT + cH + 18
    labels += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="10" fill="#a09890">${MONTHS[mo]}</text>`
  }

  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svgEl.setAttribute('height', String(H))
  svgEl.innerHTML = grid + bars + labels
}

// ── Inventory Photo ───────────────────────────────────────────────────────────
function isUrl(str) {
  return typeof str === 'string' && (str.startsWith('http://') || str.startsWith('https://'))
}

async function pickInvPhoto() {
  const filePath = await window.api.pickPhoto()
  if (!filePath) return
  pendingInvPhoto = filePath
  $('inv-photo-url').value = ''
  const dataUrl = await window.api.readPhoto(filePath)
  if (dataUrl) showInvPhotoPreview(dataUrl)
}

async function applyPhotoUrl(url) {
  if (!url) return
  url = url.trim()
  if (!isUrl(url)) return
  pendingInvPhoto = url
  showInvPhotoPreview(url)
}

function showInvPhotoPreview(src) {
  const box = $('inv-photo-box')
  box.innerHTML = `<img src="${src}" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='<span class=\\'photo-ph\\'>❌</span>'" />`
  $('btn-inv-remove-photo').style.display = 'block'
}

function clearInvPhotoPreview() {
  $('inv-photo-box').innerHTML = `<span class="photo-ph">📷</span>`
  $('btn-inv-remove-photo').style.display = 'none'
  $('inv-photo-url').value = ''
  pendingInvPhoto = null
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
function openLightbox(src) {
  $('lightbox-img').src = src
  $('lightbox').style.display = 'flex'
}

// ── Modal: Sale ───────────────────────────────────────────────────────────────
function openSaleModal(item = null) {
  editMode = item ? { collection: 'sales', id: item.id } : null
  $('modal-sale-title').textContent = item ? 'Edit Sale' : 'Add Sale'
  $('btn-sale-save').textContent    = item ? 'Save'      : 'Add'
  $('s-product').value  = item?.productName ?? ''
  $('s-size').value     = item?.size        ?? ''
  $('s-platform').value = item?.platform    ?? ''
  $('s-buy').value      = item?.buyPrice    ?? ''
  $('s-sell').value     = item?.sellPrice   ?? ''
  $('s-fees').value     = item?.fees        ?? ''
  $('s-date').value     = item?.date        || today()
  updateSaleProfitPreview()
  $('modal-sale').style.display = 'flex'
  setTimeout(() => $('s-product').focus(), 50)
}

function closeSaleModal() { $('modal-sale').style.display = 'none'; editMode = null }

function updateSaleProfitPreview() {
  const p  = calcSaleProfit({ buyPrice: $('s-buy').value, sellPrice: $('s-sell').value, fees: $('s-fees').value })
  const el = $('s-profit-preview')
  if (p == null) { el.textContent = '—'; el.style.color = ''; return }
  const pd = profitDisplay(p)
  el.textContent = pd.text
  el.style.color = p >= 0 ? 'var(--green-text)' : 'var(--red)'
}

async function saveSale() {
  const name = $('s-product').value.trim()
  const buy  = $('s-buy').value.trim()
  if (!name) { $('s-product').focus(); return }
  if (!buy)  { $('s-buy').focus();     return }

  const item = {
    productName: name,
    size:        $('s-size').value.trim(),
    platform:    $('s-platform').value.trim(),
    buyPrice:    parseFloat($('s-buy').value)  || 0,
    sellPrice:   $('s-sell').value !== '' ? parseFloat($('s-sell').value) : null,
    fees:        parseFloat($('s-fees').value) || 0,
    date:        $('s-date').value || today()
  }

  if (editMode) {
    const updated = await window.api.sales.update(editMode.id, item)
    sales = sales.map(s => s.id === editMode.id ? updated : s)
  } else {
    const created = await window.api.sales.add(item)
    sales.push(created)
  }
  closeSaleModal()
  renderSales()
  renderChart()
}

// ── Modal: Inventory ──────────────────────────────────────────────────────────
function openInvModal(item = null) {
  editMode = item ? { collection: 'inventory', id: item.id } : null
  pendingInvPhoto = item?.photo ?? null

  $('modal-inv-title').textContent = item ? 'Edit Product' : 'Add Product'
  $('btn-inv-save').textContent    = item ? 'Save'         : 'Add'
  $('i-product').value = item?.productName     ?? ''
  $('i-size').value    = item?.size            ?? ''
  $('i-qty').value     = item?.qty             ?? 1
  $('i-store').value   = item?.store           ?? ''
  $('i-buy').value     = item?.buyPrice        ?? ''
  $('i-resell').value  = item?.estimatedResell ?? ''

  clearInvPhotoPreview()
  if (item?.photo) {
    if (isUrl(item.photo)) {
      $('inv-photo-url').value = item.photo
      showInvPhotoPreview(item.photo)
    } else {
      window.api.readPhoto(item.photo).then(url => { if (url) showInvPhotoPreview(url) })
    }
  }

  $('modal-inv').style.display = 'flex'
  setTimeout(() => $('i-product').focus(), 50)
}

function closeInvModal() { $('modal-inv').style.display = 'none'; editMode = null; clearInvPhotoPreview() }

async function saveInv() {
  const name = $('i-product').value.trim()
  const buy  = $('i-buy').value.trim()
  if (!name) { $('i-product').focus(); return }
  if (!buy)  { $('i-buy').focus();     return }

  const item = {
    productName:     name,
    size:            $('i-size').value.trim(),
    qty:             parseInt($('i-qty').value) || 1,
    store:           $('i-store').value.trim(),
    buyPrice:        parseFloat($('i-buy').value) || 0,
    estimatedResell: $('i-resell').value !== '' ? parseFloat($('i-resell').value) : null,
    photo:           $('inv-photo-url').value.trim() || pendingInvPhoto || null
  }

  if (editMode) {
    const updated = await window.api.inventory.update(editMode.id, item)
    inventory = inventory.map(i => i.id === editMode.id ? updated : i)
  } else {
    const created = await window.api.inventory.add(item)
    inventory.push(created)
  }
  closeInvModal()
  renderInventory()
}

// ── Carrier Auto-Detection ────────────────────────────────────────────────────
function guessCarrier(raw) {
  const t = raw.replace(/\s|-/g, '').toUpperCase()
  if (!t) return ''

  // UPS: starts with 1Z + 16 alphanumeric
  if (/^1Z[A-Z0-9]{16}$/.test(t)) return 'UPS'

  // USPS: 20-22 digit starting with 94/93/92/91/90, or letter+9digits+US
  if (/^(94|93|92|91|90)\d{18,20}$/.test(t)) return 'USPS'
  if (/^(70|14|23|03)\d{18}$/.test(t))       return 'USPS'
  if (/^[A-Z]{2}\d{9}US$/i.test(t))           return 'USPS'

  // FedEx: 12 or 15 digits, or starts with 96 (22 digits)
  if (/^96\d{18,20}$/.test(t))  return 'FedEx'
  if (/^61\d{18}$/.test(t))     return 'FedEx'
  if (/^\d{15}$/.test(t))       return 'FedEx'
  if (/^\d{12}$/.test(t))       return 'FedEx'

  // DHL: JD/GM prefix or 10 digits
  if (/^(JD|GM)\d{18}$/.test(t)) return 'DHL'
  if (/^\d{10}$/.test(t))        return 'DHL'

  // LaserShip: 1LS or LSO prefix
  if (/^1LS\d+$/.test(t))  return 'LaserShip'
  if (/^LSO\d+$/.test(t))  return 'LaserShip'
  if (/^L[A-Z]\d{8,}$/.test(t)) return 'LaserShip'

  // OnTrac: C + 14 digits
  if (/^C\d{14}$/.test(t)) return 'OnTrac'

  // Amazon: TBA + 12 digits
  if (/^TBA\d{12}$/.test(t)) return 'Amazon'

  return ''
}

// ── Modal: Packages ───────────────────────────────────────────────────────────
function openPkgModal(item = null) {
  editMode = item ? { collection: 'packages', id: item.id } : null
  $('modal-pkg-title').textContent = item ? 'Edit Package' : 'Add Package'
  $('btn-pkg-save').textContent    = item ? 'Save'         : 'Add'
  $('p-tracking').value  = item?.trackingNumber   ?? ''
  $('p-nickname').value  = item?.nickname         ?? ''
  $('p-carrier').value   = item?.carrier          ?? ''
  $('p-delivery').value  = item?.expectedDelivery ?? ''
  $('carrier-hint').style.display = 'none'
  $('modal-pkg').style.display = 'flex'
  setTimeout(() => $('p-tracking').focus(), 50)
}

function closePkgModal() { $('modal-pkg').style.display = 'none'; editMode = null }

async function savePkg() {
  const tracking = $('p-tracking').value.trim()
  const carrier  = $('p-carrier').value
  if (!tracking) { $('p-tracking').focus(); return }
  if (!carrier)  { $('p-carrier').focus();  return }

  const item = {
    trackingNumber:   tracking,
    nickname:         $('p-nickname').value.trim(),
    carrier,
    expectedDelivery: $('p-delivery').value || ''
  }

  let savedPkg
  if (editMode) {
    // Preserve existing status + events when editing
    const existing = packages.find(p => p.id === editMode.id)
    item.status       = existing?.status       || 'Ordered'
    item.events       = existing?.events       || []
    item.lastFetchedAt = existing?.lastFetchedAt || null
    savedPkg = await window.api.packages.update(editMode.id, item)
    packages = packages.map(p => p.id === editMode.id ? savedPkg : p)
  } else {
    item.status = 'Ordered'
    item.events = []
    savedPkg = await window.api.packages.add(item)
    packages.push(savedPkg)
  }
  closePkgModal()
  renderPackages()

  // Auto-fetch real status right away (unless already delivered)
  if (savedPkg.status !== 'Delivered') {
    refreshTrackingStatus(savedPkg)
  }
}

// ── Auto-refresh all non-delivered packages ───────────────────────────────────
async function autoRefreshPackages() {
  const pending = packages.filter(p => p.status !== 'Delivered')
  for (const pkg of pending) {
    await refreshTrackingStatus(pkg)
    // Small delay between requests
    await new Promise(r => setTimeout(r, 600))
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────
function openDeleteModal(collection, id, name) {
  deleteTarget = { collection, id }
  $('del-item-name').textContent = name
  $('modal-delete').style.display = 'flex'
}

function closeDeleteModal() { $('modal-delete').style.display = 'none'; deleteTarget = null }

async function confirmDelete() {
  if (!deleteTarget) return
  const { collection, id } = deleteTarget
  await window.api[collection].delete(id)
  if (collection === 'sales')     { sales     = sales.filter(s => s.id !== id);     renderSales();     renderChart() }
  if (collection === 'inventory') { inventory = inventory.filter(i => i.id !== id); renderInventory() }
  if (collection === 'packages')  { packages  = packages.filter(p => p.id !== id);  renderPackages() }
  if (collection === 'monitors')  {
    const mon = monitors.find(m => m.id === id)
    if (mon && LOCAL_SITES.has(mon.site_type)) {
      window.api.localMonitors.stop(id).catch(() => {})
    }
    monitors = monitors.filter(m => m.id !== id)
    renderMonitors()
  }
  closeDeleteModal()
}

// ── Mark as Sold ──────────────────────────────────────────────────────────────
function openMarkAsSoldModal(item) {
  soldSourceItem = item
  const qty = item.qty ?? 1
  $('ms-product').value  = item.productName ?? ''
  $('ms-size').value     = item.size        ?? ''
  $('ms-buy').value      = item.buyPrice    ?? ''
  $('ms-sell').value     = ''
  $('ms-fees').value     = ''
  $('ms-platform').value = ''
  $('ms-date').value     = today()
  $('ms-qty').value      = 1
  $('ms-qty').max        = qty
  $('ms-qty-max').textContent = qty > 1 ? `of ${qty} in stock` : 'in stock'
  updateSoldProfitPreview()
  $('modal-sold').style.display = 'flex'
  setTimeout(() => $('ms-sell').focus(), 50)
}

function closeMarkAsSoldModal() { $('modal-sold').style.display = 'none'; soldSourceItem = null }

function updateSoldProfitPreview() {
  const buy  = parseFloat($('ms-buy').value)  || 0
  const sell = parseFloat($('ms-sell').value) || 0
  const fees = parseFloat($('ms-fees').value) || 0
  const el   = $('ms-profit-preview')
  if (!$('ms-sell').value) { el.textContent = '—'; el.style.color = ''; return }
  const p  = sell - buy - fees
  const pd = profitDisplay(p)
  el.textContent = pd.text
  el.style.color = p >= 0 ? 'var(--green-text)' : 'var(--red)'
}

async function confirmMarkAsSold() {
  if (!soldSourceItem) return
  const sellVal = $('ms-sell').value.trim()
  if (!sellVal) { $('ms-sell').focus(); return }

  const totalQty = soldSourceItem.qty ?? 1
  const sellQty  = Math.min(Math.max(parseInt($('ms-qty').value) || 1, 1), totalQty)

  const saleItem = {
    productName: soldSourceItem.productName,
    size:        soldSourceItem.size ?? '',
    platform:    $('ms-platform').value.trim(),
    buyPrice:    parseFloat($('ms-buy').value)  || 0,
    sellPrice:   parseFloat($('ms-sell').value) || 0,
    fees:        parseFloat($('ms-fees').value) || 0,
    date:        $('ms-date').value || today()
  }

  // Add to sales
  const created = await window.api.sales.add(saleItem)
  sales.push(created)

  const remaining = totalQty - sellQty

  if (remaining <= 0) {
    // All units sold — remove from inventory
    await window.api.inventory.delete(soldSourceItem.id)
    inventory = inventory.filter(i => i.id !== soldSourceItem.id)
  } else {
    // Some units remaining — reduce qty
    const updated = await window.api.inventory.update(soldSourceItem.id, { qty: remaining })
    inventory = inventory.map(i => i.id === soldSourceItem.id ? updated : i)
  }

  closeMarkAsSoldModal()
  renderInventory()
  renderSales()
  renderChart()
}

// ── View switch ───────────────────────────────────────────────────────────────
function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'))
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
  $(`view-${view}`).classList.add('active')
  document.querySelector(`.tab-btn[data-view="${view}"]`)?.classList.add('active')
  if (view === 'sales')    renderChart()
  if (view === 'home')     renderHome()
  if (view === 'monitors') renderShopifyFeed()
}

// ── Event Binding ─────────────────────────────────────────────────────────────
function bindEvents() {
  // Tabs
  document.querySelectorAll('.tab-btn[data-view]').forEach(btn =>
    btn.addEventListener('click', () => switchView(btn.dataset.view))
  )

  // Add buttons
  $('btn-add-sale').addEventListener('click', () => openSaleModal())
  $('btn-add-inv').addEventListener('click',  () => openInvModal())
  $('btn-add-pkg').addEventListener('click',  () => openPkgModal())

  // Discord settings modal
  $('btn-discord-settings').addEventListener('click', async () => {
    $('modal-discord-settings').style.display = 'flex'
    // Load current token (masked)
    try {
      const tok = await window.api.selfbot.getToken()
      $('discord-token-input').value = tok || ''
      $('discord-token-status').textContent = ''
    } catch {}
  })
  $('modal-discord-settings-close').addEventListener('click', () => {
    $('modal-discord-settings').style.display = 'none'
  })
  $('modal-discord-settings').addEventListener('click', e => {
    if (e.target.id === 'modal-discord-settings') $('modal-discord-settings').style.display = 'none'
  })

  // Token save
  $('btn-discord-token-save').addEventListener('click', async () => {
    const token = $('discord-token-input').value.trim()
    if (!token) return
    const statusEl = $('discord-token-status')
    statusEl.textContent = 'Saving…'
    statusEl.style.color = 'var(--text-dim)'
    const res = await window.api.selfbot.setToken(token)
    if (res?.ok) {
      statusEl.textContent = '✓ Saved — selfbot restarting…'
      statusEl.style.color = 'var(--green, #22c55e)'
      $('discord-bot-status').textContent = '🟡 Restarting...'
    } else {
      statusEl.textContent = '✗ ' + (res?.error || 'Failed')
      statusEl.style.color = 'var(--red, #ef4444)'
    }
  })
  $('discord-token-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('btn-discord-token-save').click()
  })

  // Reveal toggle for token field
  document.querySelector('[data-target="discord-token-input"]')?.addEventListener('click', () => {
    const inp = $('discord-token-input')
    inp.type = inp.type === 'password' ? 'text' : 'password'
  })

  // Discord alert log clear
  $('btn-discord-clear')?.addEventListener('click', () => {
    const log = $('discord-alert-log')
    log.innerHTML = '<div id="discord-log-empty" style="font-size:13px;color:var(--text-dim);text-align:center;padding:20px 0">No alerts yet</div>'
  })

  // Feed in-stock filter + search
  $('btn-feed-instock')?.addEventListener('click', () => {
    feedInstockOnly = !feedInstockOnly
    renderShopifyFeed()
  })
  $('feed-search')?.addEventListener('input', e => {
    feedSearchQuery = e.target.value
    renderShopifyFeed()
  })

  // Market Lookup
  $('btn-market-search').addEventListener('click', runMarketSearch)
  $('market-query').addEventListener('keydown', e => { if (e.key === 'Enter') runMarketSearch() })
  document.querySelectorAll('.market-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.market-mode-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      if ($('market-query').value.trim()) runMarketSearch()
    })
  })

  // Modal closes
  $('modal-sale-close').addEventListener('click', closeSaleModal)
  $('modal-inv-close').addEventListener('click',  closeInvModal)
  $('modal-pkg-close').addEventListener('click',  closePkgModal)
  $('modal-del-close').addEventListener('click',  closeDeleteModal)
  $('btn-del-cancel').addEventListener('click',   closeDeleteModal)
  $('btn-del-confirm').addEventListener('click',  confirmDelete)
  $('modal-sold-close').addEventListener('click', closeMarkAsSoldModal)
  $('btn-sold-cancel').addEventListener('click',  closeMarkAsSoldModal)
  $('btn-sold-confirm').addEventListener('click', confirmMarkAsSold)

  // Mark as Sold profit preview
  ;['ms-sell','ms-fees'].forEach(id => $(id).addEventListener('input', updateSoldProfitPreview))

  // Save
  $('btn-sale-save').addEventListener('click', saveSale)
  $('btn-inv-save').addEventListener('click',  saveInv)
  $('btn-pkg-save').addEventListener('click',  savePkg)

  // Profit preview
  ;['s-buy','s-sell','s-fees'].forEach(id => $(id).addEventListener('input', updateSaleProfitPreview))

  // Search
  $('sales-search').addEventListener('input', e => renderSales(e.target.value))
  $('inv-search').addEventListener('input',   e => renderInventory(e.target.value))
  $('pkg-search').addEventListener('input',   e => renderPackages(e.target.value))

  // Chart year
  $('chart-prev').addEventListener('click', () => { chartYear--; renderChart() })
  $('chart-next').addEventListener('click', () => { chartYear++; renderChart() })

  // Legend toggles
  ;['spent', 'revenue', 'profit'].forEach(key => {
    $(`legend-${key}`).addEventListener('click', () => {
      chartVisible[key] = !chartVisible[key]
      $(`legend-${key}`).classList.toggle('legend-off', !chartVisible[key])
      renderChart()
    })
  })

  // Package carrier auto-detection
  $('p-tracking').addEventListener('input', e => {
    const detected = guessCarrier(e.target.value)
    const hint = $('carrier-hint')
    if (detected && !$('p-carrier').value) {
      $('p-carrier').value = detected
      hint.style.display = 'block'
    } else if (!detected) {
      hint.style.display = 'none'
    }
  })
  $('p-carrier').addEventListener('change', () => {
    $('carrier-hint').style.display = 'none'
  })

  // Inventory photo
  $('btn-inv-pick-photo').addEventListener('click',   pickInvPhoto)
  $('btn-inv-remove-photo').addEventListener('click', clearInvPhotoPreview)
  $('inv-photo-box').addEventListener('click', () => {
    if (pendingInvPhoto) return
    pickInvPhoto()
  })
  $('inv-photo-url').addEventListener('input', e => {
    const url = e.target.value.trim()
    if (isUrl(url)) {
      pendingInvPhoto = null  // clear file path since URL takes priority
      showInvPhotoPreview(url)
    } else if (!url) {
      clearInvPhotoPreview()
    }
  })

  // Window controls
  $('btn-minimize').addEventListener('click', () => window.api.windowMinimize())
  $('btn-close').addEventListener('click',    () => window.api.windowClose())

  // Settings
  $('btn-open-settings').addEventListener('click', openSettingsModal)
  $('modal-settings-close').addEventListener('click', closeSettingsModal)
  $('btn-settings-cancel').addEventListener('click', closeSettingsModal)
  $('btn-settings-save').addEventListener('click', saveSettings)

  $('btn-migrate-cloud').addEventListener('click', async () => {
    const uid = ($('settings-supabase-uid')?.value || '').trim()
    if (!uid) { alert('Please enter your Supabase User ID first.'); return }
    // Save the UID first so the main process can use it
    const existing = await window.api.getSettings()
    await window.api.setSettings({ ...existing, supabaseUserId: uid })
    const btn = $('btn-migrate-cloud')
    btn.disabled = true
    btn.textContent = 'Migrating…'
    const result = await window.api.migrateToSupabase()
    btn.disabled = false
    btn.textContent = 'Migrate Existing Data →'
    if (result.error) {
      alert(result.error)
    } else {
      const inv  = result.inventory || 0
      const sal  = result.sales     || 0
      const pkg  = result.packages  || 0
      alert(`Synced: ${inv} inventory, ${sal} sales, ${pkg} packages`)
      $('sync-status').textContent = '✓ Sync enabled'
      $('sync-status').style.color = 'var(--green)'
    }
  })

  $('btn-show-features').addEventListener('click', () => { $('modal-features').style.display = 'flex' })
  $('modal-features-close').addEventListener('click', () => { $('modal-features').style.display = 'none' })
  $('modal-features').addEventListener('click', e => { if (e.target === $('modal-features')) $('modal-features').style.display = 'none' })

  $('btn-show-whats-new').addEventListener('click', () => { $('modal-whats-new').style.display = 'flex' })
  $('modal-whats-new-close').addEventListener('click', () => { $('modal-whats-new').style.display = 'none' })
  $('modal-whats-new').addEventListener('click', e => { if (e.target === $('modal-whats-new')) $('modal-whats-new').style.display = 'none' })

  $('btn-logout').addEventListener('click', async () => {
    await window.api.auth.logout()
    window.location.href = 'login.html'
  })

  $('btn-dashboard').addEventListener('click', () => {
    window.api.openExternal('https://discord.com/channels/@me')
  })
  $('btn-open-profile').addEventListener('click', () => { closeSettingsModal(); openProfileModal() })
  $('modal-profile-close').addEventListener('click', closeProfileModal)
  $('btn-profile-cancel').addEventListener('click', closeProfileModal)
  $('btn-profile-save').addEventListener('click', saveProfile)
  $('modal-profile').addEventListener('click', e => { if (e.target.id === 'modal-profile') closeProfileModal() })
  document.querySelectorAll('.af-reveal').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.target)
      input.type = input.type === 'password' ? 'text' : 'password'
    })
  })
  $('modal-settings').addEventListener('click', e => { if (e.target.id === 'modal-settings') closeSettingsModal() })

  // Dark mode toggle — apply and save immediately on click
  $('dark-mode-track').addEventListener('click', async () => {
    const nowDark = !$('dark-mode-track').classList.contains('on')
    applyTheme(nowDark)
    const existing = await window.api.getSettings()
    await window.api.setSettings({ ...existing, darkMode: nowDark })
  })

  // Lightbox close
  $('lightbox').addEventListener('click', () => { $('lightbox').style.display = 'none' })

  // ── Delegated: package event history toggle ───────────────────────────
  document.addEventListener('click', e => {
    const toggle = e.target.closest('[data-pkg-toggle]')
    if (toggle) {
      const id = toggle.dataset.pkgToggle
      if (expandedPackages.has(id)) expandedPackages.delete(id)
      else expandedPackages.add(id)
      renderPackages()
      return
    }
  })

  // ── Delegated: edit / delete / mark-as-sold / tracking buttons ────────
  document.addEventListener('click', e => {
    const btn = e.target.closest('.btn-edit, .btn-delete, .btn-mark-sold, .btn-refresh-tracking, .btn-open-tracking')
    if (!btn) return

    // Packages use data-id directly on the button; sales/inventory use a parent <td>
    const td    = btn.closest('td[data-id]')
    const card  = btn.closest('.pkg-card')

    let id, collection
    if (td) {
      id = td.dataset.id; collection = td.dataset.collection
    } else if (card) {
      id = btn.dataset.id || card.dataset.id; collection = 'packages'
    } else return

    const list = collection === 'sales' ? sales : collection === 'inventory' ? inventory : packages
    const item = list.find(x => x.id === id)
    if (!item) return

    if (btn.classList.contains('btn-refresh-tracking')) {
      refreshTrackingStatus(item)
    } else if (btn.classList.contains('btn-open-tracking')) {
      window.api.openTracking(item.trackingNumber, item.carrier)
    } else if (btn.classList.contains('btn-mark-sold')) {
      openMarkAsSoldModal(item)
    } else if (btn.classList.contains('btn-edit')) {
      if (collection === 'sales')     openSaleModal(item)
      if (collection === 'inventory') openInvModal(item)
      if (collection === 'packages')  openPkgModal(item)
    } else {
      const name = item.productName || item.nickname || item.trackingNumber || id
      openDeleteModal(collection, id, name)
    }
  })

  // Close modals on overlay click
  ;['modal-sale','modal-inv','modal-pkg','modal-delete','modal-sold'].forEach(id => {
    $(id).addEventListener('click', e => {
      if (e.target.id === id) {
        closeSaleModal(); closeInvModal(); closePkgModal(); closeDeleteModal(); closeMarkAsSoldModal()
      }
    })
  })

  // Keyboard
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if ($('lightbox').style.display !== 'none')        { $('lightbox').style.display = 'none'; return }
      if ($('modal-sold').style.display !== 'none')      { closeMarkAsSoldModal(); return }
      if ($('modal-settings').style.display !== 'none')  { closeSettingsModal(); return }
      if ($('modal-release').style.display !== 'none')   { closeReleaseModal(); return }
      closeSaleModal(); closeInvModal(); closePkgModal(); closeDeleteModal()
    }
    if (e.key === 'Enter' && e.ctrlKey) {
      if ($('modal-sale').style.display    !== 'none') saveSale()
      if ($('modal-inv').style.display     !== 'none') saveInv()
      if ($('modal-pkg').style.display     !== 'none') savePkg()
      if ($('modal-release').style.display !== 'none') saveRelease()
      if ($('modal-pinned').style.display  !== 'none') savePinnedMessage()
    }
  })

  // Release modal
  $('btn-add-release').addEventListener('click', () => openReleaseModal())
  $('modal-release-close').addEventListener('click', closeReleaseModal)
  $('btn-release-save').addEventListener('click', saveRelease)
  $('modal-release').addEventListener('click', e => { if (e.target.id === 'modal-release') closeReleaseModal() })

  // Pinned modal
  $('btn-add-pinned').addEventListener('click', openPinnedModal)
  $('modal-pinned-close').addEventListener('click', closePinnedModal)
  $('btn-pinned-save').addEventListener('click', savePinnedMessage)
  $('modal-pinned').addEventListener('click', e => { if (e.target.id === 'modal-pinned') closePinnedModal() })

  // Monitors
  $('btn-add-monitor').addEventListener('click', () => openMonitorModal())
  $('btn-test-nike-alert').addEventListener('click', () => showNikeAlert({
    isNike: true,
    type: 'live',
    title: 'Air Jordan 13 Retro — White/True Red',
    variant: 'DJ3004-102',
    url: 'https://www.nike.com/launch/t/air-jordan-13-retro',
    image: '',
    sizes: ['7','7.5','8','8.5','9','9.5','10','10.5','11','12','13']
  }))
  $('modal-monitor-close').addEventListener('click', () => { $('modal-monitor').style.display = 'none' })
  $('modal-monitor').addEventListener('click', e => { if (e.target === $('modal-monitor')) $('modal-monitor').style.display = 'none' })

  // Site type picker
  document.querySelectorAll('.mon-site-btn').forEach(btn => {
    btn.addEventListener('click', () => setMonitorSiteType(btn.dataset.site))
  })

  // Monitor type toggle (Shopify only)
  $('mon-type-site').addEventListener('click',    () => setMonitorType('site'))
  $('mon-type-product').addEventListener('click', () => setMonitorType('product'))

  // Price alert toggle
  $('mon-price-alert-track').addEventListener('click', () => {
    const track = $('mon-price-alert-track')
    const on = track.classList.toggle('on')
    $('mon-price-threshold').style.display = on ? '' : 'none'
  })
  $('mon-price-alert-label').addEventListener('click', () => $('mon-price-alert-track').click())

  $('btn-monitor-save').addEventListener('click', async () => {
    const name           = $('mon-name').value.trim()
    const webhookUrl     = $('mon-webhook').value.trim()
    const pingRole       = $('mon-role').value.trim()
    const intervalSec    = parseInt($('mon-interval').value) || 60
    const priceAlert     = $('mon-price-alert-track').classList.contains('on')
    const priceThreshold = $('mon-price-threshold').value.trim()

    let siteUrl, productUrl, keywords
    if (monitorSiteType === 'shopify') {
      siteUrl    = $('mon-url').value.trim()
      const isProduct = $('mon-type-product').classList.contains('active')
      productUrl = isProduct ? $('mon-product-url').value.trim() : null
      keywords   = !isProduct ? $('mon-keywords').value.trim() : null
      if (!siteUrl) { $('mon-url').focus(); return }
      if (isProduct && !productUrl) { $('mon-product-url').focus(); return }
    } else if (monitorSiteType === 'funko') {
      siteUrl    = $('mon-url').value.trim() || 'https://funko.com/new-featured/new-releases/'
      productUrl = null
      keywords   = $('mon-keywords').value.trim()
    } else if (monitorSiteType === 'nike') {
      siteUrl    = $('mon-url').value.trim() || 'https://api.nike.com/product_feed/threads/v2/?anchor=0&count=60&filter=marketplace(US)&filter=language(en)&filter=channelId(010794e5-35fe-4e32-aaff-cd2c74f89d61)'
      productUrl = null
      keywords   = $('mon-keywords').value.trim()
    } else {
      const retailUrl = $('mon-retail-url').value.trim()
      if (!retailUrl) { $('mon-retail-url').focus(); return }
      siteUrl    = retailUrl
      productUrl = retailUrl
      keywords   = null
    }

    if (!name || !webhookUrl) { $('mon-name').focus(); return }

    const proxyUrl = $('mon-proxy').value.trim()

    const payload = {
      name, siteUrl,
      productUrl: productUrl || null,
      keywords: keywords || null,
      webhookUrl,
      pingRole: pingRole || null,
      intervalSec,
      priceAlert,
      priceThreshold: priceThreshold || null,
      siteType: monitorSiteType,
      proxyUrl: proxyUrl || null
    }

    if (monitorEditId) {
      const existing = monitors.find(m => m.id === monitorEditId)
      const updated = await window.api.monitors.update(monitorEditId, { ...payload, active: existing?.active !== false })
      if (!updated?.error) {
        const idx = monitors.findIndex(m => m.id === monitorEditId)
        if (idx !== -1) monitors[idx] = updated
        if (LOCAL_SITES.has(updated.site_type)) {
          window.api.localMonitors.stop(updated.id).catch(() => {})
          if (updated.active) window.api.localMonitors.start([updated]).catch(() => {})
        }
      }
    } else {
      const created = await window.api.monitors.add(payload)
      if (!created?.error) {
        monitors.unshift(created)
if (LOCAL_SITES.has(created.site_type) && created.active) window.api.localMonitors.start([created]).catch(() => {})
      }
    }

    $('modal-monitor').style.display = 'none'
    renderMonitors()
  })

  $('monitors-grid').addEventListener('click', async e => {
    const toggleBtn = e.target.closest('.btn-monitor-toggle')
    const testBtn   = e.target.closest('.btn-monitor-test')
    const editBtn   = e.target.closest('.btn-monitor-edit')
    const deleteBtn = e.target.closest('.btn-monitor-delete')

    if (toggleBtn) {
      const id = toggleBtn.dataset.id
      const isActive = toggleBtn.dataset.active === 'true'
      const monitor = monitors.find(m => m.id === id)
      if (!monitor) return
      const updated = await window.api.monitors.update(id, {
        name: monitor.name, siteUrl: monitor.site_url, productUrl: monitor.product_url,
        keywords: monitor.keywords, webhookUrl: monitor.webhook_url, pingRole: monitor.ping_role,
        intervalSec: monitor.interval_sec, active: !isActive,
        siteType: monitor.site_type, priceAlert: monitor.price_alert,
        priceThreshold: monitor.price_threshold, proxyUrl: monitor.proxy_url
      })
      if (!updated?.error) {
        const idx = monitors.findIndex(m => m.id === id)
        if (idx !== -1) monitors[idx] = updated
        renderMonitors()
        if (LOCAL_SITES.has(updated.site_type)) {
          if (updated.active) window.api.localMonitors.start([updated]).catch(() => {})
          else window.api.localMonitors.stop(updated.id).catch(() => {})
        }
      }
      return
    }

    if (testBtn) {
      const id  = testBtn.dataset.id
      const btn = testBtn
      btn.disabled = true
      btn.style.opacity = '0.5'
      try {
        await window.api.monitors.test(id)
      } finally {
        btn.disabled = false
        btn.style.opacity = ''
      }
      return
    }

    if (editBtn) {
      const id = editBtn.dataset.id
      const monitor = monitors.find(m => m.id === id)
      if (monitor) openMonitorModal(monitor)
      return
    }

    if (deleteBtn) {
      const id = deleteBtn.dataset.id
      const monitor = monitors.find(m => m.id === id)
      if (!monitor) return
      deleteTarget = { collection: 'monitors', id }
      $('del-item-name').textContent = monitor.name
      $('modal-delete').style.display = 'flex'
    }
  })

  // Delegated: release edit / delete + pinned delete
  document.addEventListener('click', e => {
    const editBtn    = e.target.closest('.btn-edit-release')
    const delBtn     = e.target.closest('.btn-del-release')
    const pinDelBtn  = e.target.closest('.btn-pinned-delete')
    const linkBtn    = e.target.closest('.btn-release-link')
    if (linkBtn?.dataset.url) window.api.openExternal(linkBtn.dataset.url)
    if (editBtn) {
      const card = editBtn.closest('.home-release-card')
      const r = releases.find(x => x.id === card?.dataset.id)
      if (r) openReleaseModal(r)
    }
    if (delBtn) {
      const card = delBtn.closest('.home-release-card')
      if (card?.dataset.id) deleteRelease(card.dataset.id)
    }
    if (pinDelBtn) {
      const id = pinDelBtn.dataset.id
      if (id) deletePinnedMessage(id)
    }
  })

  window.addEventListener('resize', renderChart)

  // Feed tab switching + ATC size click
  document.addEventListener('click', e => {
    const atcBtn = e.target.closest('[data-atc]')
    if (atcBtn) { e.stopPropagation(); openCheckoutWebview(atcBtn.dataset.atc); return }
    const copyBtn = e.target.closest('.feed-copy-btn')
    if (copyBtn) {
      e.stopPropagation()
      navigator.clipboard.writeText(copyBtn.dataset.copy)
      copyBtn.textContent = '✓'
      setTimeout(() => { copyBtn.textContent = '⎘' }, 1500)
      return
    }
    const resellBtn = e.target.closest('.feed-resell-btn')
    if (resellBtn) { e.stopPropagation(); window.api.openExternal(resellBtn.dataset.ext); return }
    const styleColor = e.target.closest('.feed-style-color')
    if (styleColor) {
      e.stopPropagation()
      navigator.clipboard.writeText(styleColor.dataset.copy)
      const orig = styleColor.textContent
      styleColor.textContent = '✓ copied'
      setTimeout(() => { styleColor.textContent = orig }, 1500)
      return
    }
    const btn = e.target.closest('.feed-tab-btn')
    if (btn?.dataset.feedId) { activeFeedMonitorId = btn.dataset.feedId; renderShopifyFeed() }
    const card = e.target.closest('.feed-product-card')
    if (card?.dataset.url) window.api.openExternal(card.dataset.url)
  })
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : '')
  localStorage.setItem('rt-theme', dark ? 'dark' : 'light')
  $('dark-mode-track').classList.toggle('on', dark)
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function openSettingsModal() {
  const [settings, authResult] = await Promise.all([
    window.api.getSettings(),
    window.api.auth.check()
  ])
  $('settings-api-status').style.display = 'none'
  const dark = settings.darkMode || false
  $('dark-mode-track').classList.toggle('on', dark)


  // Populate Discord profile card
  const user = authResult?.user
  if (user) {
    $('settings-username').textContent = '@' + user.username
    if (user.avatar) {
      $('settings-avatar-img').src = user.avatar
      $('settings-avatar-img').style.display = 'block'
      $('settings-avatar-initials').style.display = 'none'
    } else {
      $('settings-avatar-initials').textContent = user.username.slice(0, 2).toUpperCase()
      $('settings-avatar-initials').style.display = 'flex'
      $('settings-avatar-img').style.display = 'none'
    }
  }

  // Pre-fill Supabase UID
  if ($('settings-supabase-uid')) {
    $('settings-supabase-uid').value = settings.supabaseUserId || ''
    const status = $('sync-status')
    if (settings.supabaseUserId) {
      status.textContent = '✓ Sync enabled'
      status.style.color = 'var(--green)'
    } else {
      status.textContent = 'Not configured'
      status.style.color = 'var(--text-dim)'
    }
  }


  $('modal-settings').style.display = 'flex'
}

function closeSettingsModal() { $('modal-settings').style.display = 'none' }

// ── Shipping Profiles ─────────────────────────────────────────────────────────
let _profileSettings = null   // cache settings while modal is open
let _activeProfileIdx = 0

function profileFieldsFromForm() {
  return {
    name:      $('af-profile-name').value.trim() || 'Profile 1',
    firstName: $('af-first').value.trim(),
    lastName:  $('af-last').value.trim(),
    email:     $('af-email').value.trim(),
    phone:     $('af-phone').value.trim(),
    address1:  $('af-addr1').value.trim(),
    address2:  $('af-addr2').value.trim(),
    city:      $('af-city').value.trim(),
    state:     $('af-state').value.trim(),
    zip:       $('af-zip').value.trim(),
    country:   $('af-country').value.trim(),
    ccName:    $('af-cc-name').value.trim(),
    ccNumber:  $('af-cc-number').value.trim(),
    ccExpiry:  $('af-cc-expiry').value.trim(),
    ccCvv:     $('af-cc-cvv').value.trim(),
  }
}

function fillFormFromProfile(p) {
  p = p || {}
  $('af-profile-name').value = p.name      || ''
  $('af-first').value        = p.firstName || ''
  $('af-last').value         = p.lastName  || ''
  $('af-email').value        = p.email     || ''
  $('af-phone').value        = p.phone     || ''
  $('af-addr1').value        = p.address1  || ''
  $('af-addr2').value        = p.address2  || ''
  $('af-city').value         = p.city      || ''
  $('af-state').value        = p.state     || ''
  $('af-zip').value          = p.zip       || ''
  $('af-country').value      = p.country   || ''
  $('af-cc-name').value      = p.ccName    || ''
  $('af-cc-number').value    = p.ccNumber  || ''
  $('af-cc-expiry').value    = p.ccExpiry  || ''
  $('af-cc-cvv').value       = p.ccCvv     || ''
}

function renderProfileSwitcher(profiles, activeIdx) {
  const sel = $('profile-switcher')
  sel.innerHTML = profiles.map((p, i) =>
    `<option value="${i}" ${i === activeIdx ? 'selected' : ''}>${esc(p.name || `Profile ${i+1}`)}</option>`
  ).join('')
  $('btn-profile-delete').style.display = profiles.length > 1 ? '' : 'none'
}

async function openProfileModal() {
  _profileSettings = await window.api.getSettings()
  // Migrate legacy autofill → profiles array
  if (!_profileSettings.profiles) {
    const legacy = _profileSettings.autofill || {}
    _profileSettings.profiles = [{ name: 'Default', ...legacy }]
    _profileSettings.activeProfile = 0
  }
  _activeProfileIdx = _profileSettings.activeProfile || 0
  if (_activeProfileIdx >= _profileSettings.profiles.length) _activeProfileIdx = 0

  renderProfileSwitcher(_profileSettings.profiles, _activeProfileIdx)
  fillFormFromProfile(_profileSettings.profiles[_activeProfileIdx])
  $('modal-profile').style.display = 'flex'
}

function closeProfileModal() { $('modal-profile').style.display = 'none' }

async function saveProfile() {
  if (!_profileSettings) return
  _profileSettings.profiles[_activeProfileIdx] = profileFieldsFromForm()
  _profileSettings.activeProfile = _activeProfileIdx
  // Keep autofill pointing at active profile for backwards compat with runAutofill
  _profileSettings.autofill = _profileSettings.profiles[_activeProfileIdx]
  await window.api.setSettings(_profileSettings)
  closeProfileModal()
}

function initProfileModal() {
  $('profile-switcher').addEventListener('change', e => {
    // Save current edits before switching
    if (_profileSettings) _profileSettings.profiles[_activeProfileIdx] = profileFieldsFromForm()
    _activeProfileIdx = parseInt(e.target.value, 10)
    fillFormFromProfile(_profileSettings.profiles[_activeProfileIdx])
  })

  $('btn-profile-new').addEventListener('click', () => {
    if (!_profileSettings) return
    const newP = { name: `Profile ${_profileSettings.profiles.length + 1}` }
    _profileSettings.profiles.push(newP)
    _activeProfileIdx = _profileSettings.profiles.length - 1
    renderProfileSwitcher(_profileSettings.profiles, _activeProfileIdx)
    fillFormFromProfile(newP)
    $('af-profile-name').focus()
  })

  $('btn-profile-delete').addEventListener('click', () => {
    if (!_profileSettings || _profileSettings.profiles.length <= 1) return
    _profileSettings.profiles.splice(_activeProfileIdx, 1)
    _activeProfileIdx = Math.max(0, _activeProfileIdx - 1)
    renderProfileSwitcher(_profileSettings.profiles, _activeProfileIdx)
    fillFormFromProfile(_profileSettings.profiles[_activeProfileIdx])
  })
}

async function saveSettings() {
  const existing = await window.api.getSettings()
  const uid = ($('settings-supabase-uid')?.value || '').trim()
  await window.api.setSettings({ ...existing, supabaseUserId: uid || existing.supabaseUserId || '' })
  closeSettingsModal()
}

// ── Home / Calendar ───────────────────────────────────────────────────────────
let calMonth = new Date().getMonth()
let calYear  = new Date().getFullYear()

const MONTH_NAMES = ['January','February','March','April','May','June',
  'July','August','September','October','November','December']
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']

function ordinal(d) {
  if (d > 3 && d < 21) return 'th'
  switch (d % 10) { case 1: return 'st'; case 2: return 'nd'; case 3: return 'rd'; default: return 'th' }
}

function renderHome() {
  const now = new Date()
  const td = now.getDate(), tm = now.getMonth(), ty = now.getFullYear()
  const todayStr = now.toISOString().slice(0, 10)

  // Left panel — always shows today
  $('home-big-day').textContent       = td
  $('home-day-name').textContent      = DAY_NAMES[now.getDay()]
  $('home-cal-monthyear').textContent = MONTH_NAMES[tm] + ' ' + ty

  // Calendar header
  $('home-cal-title').textContent = MONTH_NAMES[calMonth]
  $('home-cal-year').textContent  = calYear

  // Collect release dates
  const releaseDates = new Set(releases.map(r => r.date).filter(Boolean))

  // Build grid
  const firstDow    = new Date(calYear, calMonth, 1).getDay()
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate()
  const daysInPrev  = new Date(calYear, calMonth, 0).getDate()
  const totalCells  = Math.ceil((firstDow + daysInMonth) / 7) * 7

  let html = '', day = 1, nextDay = 1
  for (let i = 0; i < totalCells; i++) {
    if (i < firstDow) {
      html += `<div class="cal-day cal-day-other">${daysInPrev - firstDow + 1 + i}</div>`
    } else if (day <= daysInMonth) {
      const dateStr   = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`
      const isToday   = day === td && calMonth === tm && calYear === ty
      const isRelease = releaseDates.has(dateStr)
      let cls = 'cal-day'
      if (isToday && isRelease) cls += ' cal-day-today cal-day-release'
      else if (isToday)         cls += ' cal-day-today'
      else if (isRelease)       cls += ' cal-day-release'
      html += `<div class="${cls}">${day}</div>`
      day++
    } else {
      html += `<div class="cal-day cal-day-other">${nextDay++}</div>`
    }
  }
  $('home-cal-grid').innerHTML = html

  // Today heading
  $('home-today-title').textContent = `${MONTH_NAMES[tm]} ${td}${ordinal(td)}, ${ty}`

  // Upcoming releases (sorted by date, past releases shown at the bottom)
  const sorted = [...releases].sort((a, b) => (a.date || '') < (b.date || '') ? -1 : 1)

  $('home-release-count').textContent = releases.length ? `${releases.length} Release${releases.length > 1 ? 's' : ''}` : ''

  const list = $('home-releases-list')
  if (!sorted.length) {
    list.innerHTML = '<div class="home-upcoming-empty">No releases yet — add one above</div>'
  } else {
    list.innerHTML = sorted.map(r => {
      const isToday = r.date === todayStr
      const isPast  = r.date && r.date < todayStr
      const dateObj = r.date ? new Date(r.date + 'T12:00:00') : null
      const dateLabel = isToday ? 'Today' :
        dateObj ? dateObj.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '—'

      const imgHtml = r.imageUrl
        ? `<img class="home-release-img" src="${esc(r.imageUrl)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="home-release-img-placeholder" style="display:none">👟</div>`
        : `<div class="home-release-img-placeholder">👟</div>`

      const localTimeDisplay = utcTimeToLocalDisplay(r.date, r.releaseTime)

      return `<div class="home-release-card${isPast ? ' release-past' : ''}" data-id="${esc(r.id)}">
        ${imgHtml}
        <div class="home-release-info">
          <div class="home-release-name">${esc(r.name)}</div>
          <div class="home-release-meta">
            <span class="home-release-date${isToday ? ' today' : ''}">${dateLabel}</span>
            ${localTimeDisplay ? `<span class="home-release-time">⏰ ${localTimeDisplay}</span>` : ''}
            ${r.retailPrice ? `<span class="home-release-price">Retail: $${parseFloat(r.retailPrice).toFixed(2)}</span>` : ''}
          </div>
          ${r.notes ? `<div class="home-release-notes">${esc(r.notes)}</div>` : ''}
          ${r.link ? `<a class="home-release-link btn-release-link" data-url="${esc(r.link)}" title="${esc(r.link)}">🔗 Buy / Release Page</a>` : ''}
        </div>
        <div class="home-release-actions">
          <button class="btn-row btn-edit-release" title="Edit" style="pointer-events:auto">${EDIT_ICON}</button>
          <button class="btn-row danger btn-del-release" title="Delete" style="pointer-events:auto">${DEL_ICON}</button>
        </div>
      </div>`
    }).join('')
  }

  renderPinnedMessages()
}

function initHome() {
  $('cal-prev').addEventListener('click', () => {
    calMonth--
    if (calMonth < 0) { calMonth = 11; calYear-- }
    renderHome()
  })
  $('cal-next').addEventListener('click', () => {
    calMonth++
    if (calMonth > 11) { calMonth = 0; calYear++ }
    renderHome()
  })
}

// ── Timezone helpers ──────────────────────────────────────────────────────────
// Convert local time string (HH:MM) + date (YYYY-MM-DD) → UTC time string (HH:MM)
function localTimeToUtc(dateStr, localTime) {
  if (!localTime || !dateStr) return null
  const dt = new Date(`${dateStr}T${localTime}:00`)
  const h = String(dt.getUTCHours()).padStart(2, '0')
  const m = String(dt.getUTCMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

// Convert UTC time string (HH:MM) + date → local time string (HH:MM) for input
function utcTimeToLocalInput(dateStr, utcTime) {
  if (!utcTime || !dateStr) return ''
  const dt = new Date(`${dateStr}T${utcTime}:00Z`)
  const h = String(dt.getHours()).padStart(2, '0')
  const m = String(dt.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

// Convert UTC time string (HH:MM) + date → human-readable local time (e.g. "10:00 AM EDT")
function utcTimeToLocalDisplay(dateStr, utcTime) {
  if (!utcTime || !dateStr) return null
  const dt = new Date(`${dateStr}T${utcTime}:00Z`)
  return dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
}

// ── Release CRUD ──────────────────────────────────────────────────────────────
let releaseEditId = null

function openReleaseModal(release = null) {
  releaseEditId = release ? release.id : null
  $('modal-release-title').textContent = release ? 'Edit Release' : 'Add Release'
  $('btn-release-save').textContent    = release ? 'Save'         : 'Add'
  $('rl-name').value   = release?.name        || ''
  $('rl-date').value   = release?.date        || today()
  $('rl-image').value  = release?.imageUrl    || ''
  $('rl-retail').value = release?.retailPrice || ''
  $('rl-time').value   = release?.releaseTime ? utcTimeToLocalInput(release.date, release.releaseTime) : ''
  $('rl-link').value   = release?.link        || ''
  $('rl-notes').value  = release?.notes       || ''
  $('modal-release').style.display = 'flex'
  $('rl-name').focus()
}

function closeReleaseModal() {
  $('modal-release').style.display = 'none'
  releaseEditId = null
}

async function saveRelease() {
  try {
  const name = $('rl-name').value.trim()
  const date = $('rl-date').value.trim()
  if (!name || !date) return

  const localTime = $('rl-time').value
  const payload = {
    name,
    date,
    imageUrl:    $('rl-image').value.trim()  || null,
    retailPrice: $('rl-retail').value        || null,
    releaseTime: localTimeToUtc(date, localTime),
    link:        $('rl-link').value.trim()   || null,
    notes:       $('rl-notes').value.trim()  || null
  }

  if (releaseEditId) {
    const updated = await window.api.releases.update(releaseEditId, payload)
    if (updated?.error) { alert('Server error: ' + updated.error); return }
    const idx = releases.findIndex(r => r.id === releaseEditId)
    if (idx !== -1) releases[idx] = { ...releases[idx], ...payload }
  } else {
    const added = await window.api.releases.add(payload)
    if (added?.error) { alert('Server error: ' + added.error); return }
    releases.push(added)
  }

  closeReleaseModal()
  renderHome()
  } catch (err) {
    alert('Unexpected error: ' + err.message)
  }
}

async function deleteRelease(id) {
  await window.api.releases.delete(id)
  releases = releases.filter(r => r.id !== id)
  renderHome()
}

// ── Pinned Messages CRUD ───────────────────────────────────────────────────────
function renderPinnedMessages() {
  const container = $('home-pinned-messages')
  if (!container) return
  if (!pinnedMessages.length) {
    container.innerHTML = '<p style="color:var(--text-muted,#888);font-size:13px;margin:0">No pinned messages yet.</p>'
    return
  }
  container.innerHTML = pinnedMessages.map(msg => `
    <div class="home-pinned-msg" data-id="${msg.id}">
      <p class="home-pinned-msg-text">${msg.content.replace(/\n/g, '<br>')}</p>
      ${isAdmin ? `<div class="home-pinned-msg-actions">
        <button class="btn-pinned-delete" data-id="${msg.id}" title="Delete">✕</button>
      </div>` : ''}
    </div>
  `).join('')
}

function openPinnedModal() {
  $('pm-content').value = ''
  $('modal-pinned').style.display = 'flex'
  $('pm-content').focus()
}

function closePinnedModal() {
  $('modal-pinned').style.display = 'none'
}

async function savePinnedMessage() {
  const content = $('pm-content').value.trim()
  if (!content) return
  try {
    const added = await window.api.pinned.add({ content })
    if (added?.error) { alert('Server error: ' + added.error); return }
    pinnedMessages.unshift(added)
    closePinnedModal()
    renderPinnedMessages()
  } catch (err) {
    alert('Unexpected error: ' + err.message)
  }
}

async function deletePinnedMessage(id) {
  await window.api.pinned.delete(id)
  pinnedMessages = pinnedMessages.filter(m => m.id !== id)
  renderPinnedMessages()
}

// ── Monitors ──────────────────────────────────────────────────────────────────
function renderMonitors() {
  const grid  = $('monitors-grid')
  const empty = $('monitors-empty')
  $('monitors-count').textContent = monitors.length ? `${monitors.length} Total` : ''

  if (!monitors.length) {
    grid.innerHTML = ''
    empty.style.display = ''
    return
  }
  empty.style.display = 'none'

  grid.innerHTML = monitors.map(m => {
    const active    = m.active
    const lastPing  = m.last_pinged ? timeAgo(m.last_pinged) : 'Never'
    const keywords  = m.keywords || '—'
    const interval  = m.interval_sec >= 60
      ? `${Math.round(m.interval_sec / 60)}m`
      : `${m.interval_sec}s${m.interval_sec <= 10 ? ' ⚡' : ''}`
    const siteHost  = (() => { try { return new URL(m.site_url.startsWith('http') ? m.site_url : 'https://' + m.site_url).hostname } catch { return m.site_url } })()

    return `
    <div class="monitor-card ${active ? 'monitor-active' : 'monitor-paused'}" data-id="${esc(m.id)}">
      <div class="monitor-card-top">
        <div class="monitor-status-dot ${active ? 'dot-active' : 'dot-paused'}"></div>
        <span class="monitor-name">${esc(m.name)}</span>
        <span class="monitor-badge ${active ? 'badge-active' : 'badge-paused'}">${active ? 'Active' : 'Paused'}</span>
        ${m.site_type && m.site_type !== 'shopify' ? `<span class="monitor-badge monitor-site-badge monitor-site-${esc(m.site_type)}">${({walmart:'Walmart',target:'Target',amazon:'Amazon',bestbuy:'Best Buy',lego:'LEGO',funko:'Funko',nike:'Nike'})[m.site_type]||m.site_type}</span>` : ''}
        ${m.product_url && m.site_type === 'shopify' ? `<span class="monitor-badge" style="background:var(--teal-light);color:var(--teal)">Product</span>` : ''}
        ${m.price_alert ? `<span class="monitor-badge" style="background:var(--orange-light);color:var(--orange)">💰 Price</span>` : ''}
        <div class="monitor-actions">
          <button class="btn-row btn-monitor-toggle" title="${active ? 'Pause' : 'Resume'}" data-id="${esc(m.id)}" data-active="${active}">
            ${active
              ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="pointer-events:none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
              : `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="pointer-events:none"><polygon points="5 3 19 12 5 21 5 3"/></svg>`}
          </button>
          <button class="btn-row btn-monitor-test" title="Send test ping" data-id="${esc(m.id)}" style="pointer-events:auto;color:var(--teal)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="pointer-events:none"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
          <button class="btn-row btn-edit btn-monitor-edit" title="Edit" data-id="${esc(m.id)}" style="pointer-events:auto">${EDIT_ICON}</button>
          <button class="btn-row danger btn-monitor-delete" title="Delete" data-id="${esc(m.id)}" style="pointer-events:auto">${DEL_ICON}</button>
        </div>
      </div>
      <div class="monitor-card-body">
        <div class="monitor-field"><span class="monitor-label">Site</span><span class="monitor-val">${esc(siteHost)}</span></div>
        <div class="monitor-field"><span class="monitor-label">Keywords</span><span class="monitor-val">${esc(keywords)}</span></div>
        <div class="monitor-field"><span class="monitor-label">Interval</span><span class="monitor-val">Every ${interval}</span></div>
        <div class="monitor-field"><span class="monitor-label">Last ping</span><span class="monitor-val">${esc(lastPing)}</span></div>
        ${m.ping_role ? `<div class="monitor-field"><span class="monitor-label">Role</span><span class="monitor-val">${esc(m.ping_role)}</span></div>` : ''}
      </div>
    </div>`
  }).join('')
}

// ── Shopify Live Feed ─────────────────────────────────────────────────────────

function renderShopifyFeed() {
  const section = $('shopify-feed-section')
  const shopifyOnly = [...shopifyFeeds.entries()].filter(([, f]) => f.products?.length > 0)
  if (shopifyOnly.length === 0) { section.style.display = 'none'; return }
  section.style.display = ''

  if (!activeFeedMonitorId || !shopifyFeeds.has(activeFeedMonitorId)) {
    activeFeedMonitorId = shopifyOnly[0][0]
  }

  $('shopify-feed-tabs').innerHTML = shopifyOnly.map(([id, f]) =>
    `<button class="feed-tab-btn ${id === activeFeedMonitorId ? 'active' : ''}" data-feed-id="${esc(id)}">${esc(f.monitorName)}</button>`
  ).join('')

  const feed = shopifyFeeds.get(activeFeedMonitorId)
  if (!feed) return
  const ago = feed.updatedAt ? Math.round((Date.now() - feed.updatedAt) / 1000) : null
  $('feed-updated').textContent = ago !== null ? `Updated ${ago < 5 ? 'just now' : ago + 's ago'}` : ''

  let products = feed.products || []
  if (feedInstockOnly) products = products.filter(p => (p.variants || []).some(v => v.available))
  if (feedSearchQuery)  products = products.filter(p => p.title.toLowerCase().includes(feedSearchQuery.toLowerCase()))

  $('btn-feed-instock').classList.toggle('active', feedInstockOnly)

  $('shopify-feed-grid').innerHTML = products.map(p => {
    const image = p.images?.[0]?.src || ''
    const price = p.variants?.[0]?.price ? `$${parseFloat(p.variants[0].price).toFixed(2)}` : ''
    const variantBtns = (p.variants || []).map(v =>
      `<span class="feed-variant-btn ${v.available ? 'variant-instock' : 'variant-oos'}"
        ${v.available ? `data-atc="${esc(feed.baseUrl)}/cart/${v.id}:1" title="Click to ATC"` : ''}
      >${esc(v.title)}</span>`
    ).join('')
    const productUrl = (p.handle && p.handle.startsWith('http')) ? p.handle : `${feed.baseUrl}/products/${p.handle}`
    let launchBadge = ''
    if (p.launchDate) {
      const ms = new Date(p.launchDate).getTime()
      const diff = ms - Date.now()
      const status = p.status
      if (status === 'upcoming') {
        const days = Math.floor(diff / 864e5)
        const hrs  = Math.round(diff / 36e5)
        const label = days >= 1 ? `in ${days}d` : hrs >= 1 ? `in ${hrs}h` : 'soon'
        launchBadge = `<span class="feed-launch-badge badge-upcoming" data-launch="${ms}">Drops ${label}</span>`
      } else if (status === 'live') {
        launchBadge = `<span class="feed-launch-badge badge-live">🟢 Live Now</span>`
      } else if (status === 'draw_open') {
        launchBadge = `<span class="feed-launch-badge badge-live">🎟 Draw Open</span>`
      } else {
        const d = new Date(p.launchDate)
        launchBadge = `<span class="feed-launch-badge badge-past">${d.toLocaleDateString([], {month:'short',day:'numeric'})}</span>`
      }
    }
    const styleColor = p.styleColor || ''
    const methodLabel = p.variants?.[0]?.title || ''
    const HYPE_KEYWORDS = ['travis scott','off-white','fragment','union','fear of god','fog','sacai','acronym','stussy','supreme','cactus jack','j balvin','drake','nocta','cpfm','comme des','atmos','patta','bodega','kaws','pigalle','undercover']
    const titleLower = p.title.toLowerCase()
    const isHyped = methodLabel === 'Draw' || HYPE_KEYWORDS.some(k => titleLower.includes(k))
    const searchQ = encodeURIComponent(styleColor || p.title)
    const stockxUrl = `https://stockx.com/search?s=${searchQ}`
    const goatUrl   = `https://www.goat.com/search?query=${searchQ}`
    return `<div class="feed-product-card" data-url="${esc(productUrl)}">
      ${image ? `<img class="feed-product-img" src="${esc(image)}" loading="lazy" />` : '<div class="feed-product-img feed-img-placeholder"></div>'}
      ${launchBadge}
      <button class="feed-copy-btn" data-copy="${esc(p.title)}" title="Copy name">⎘</button>
      <div class="feed-product-info">
        <span class="feed-product-title">${isHyped ? '🔥 ' : ''}${esc(p.title)}</span>
        ${styleColor ? `<span class="feed-style-color" data-copy="${esc(styleColor)}" title="Click to copy style color">${esc(styleColor)}</span>` : ''}
        <div class="feed-resell-links">
          <a class="feed-resell-btn" data-ext="${esc(stockxUrl)}" title="Check StockX">StockX</a>
          <a class="feed-resell-btn" data-ext="${esc(goatUrl)}" title="Check GOAT">GOAT</a>
        </div>
        <div class="feed-drop-info">
          <span class="feed-drop-platform">SNKRS</span>
          ${methodLabel ? `<span class="feed-drop-method">${esc(methodLabel)}</span>` : ''}
        </div>
      </div>
      <div class="feed-variants">${variantBtns}</div>
    </div>`
  }).join('')

}

// ── Toast Notifications ───────────────────────────────────────────────────────

function showMonitorToast({ type, monitorName, product, variants }) {
  const container = $('toast-container')
  const toast = document.createElement('div')
  toast.className = `monitor-toast monitor-toast-${type === 'restock' ? 'restock' : 'new'}`
  const icon  = type === 'restock' ? '🔄' : '🆕'
  const label = type === 'restock' ? 'Restock' : 'New Drop'
  const variantText = (variants || []).slice(0, 5).join(', ')
  toast.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-body">
      <div class="toast-label">${esc(label)} · ${esc(monitorName || '')}</div>
      <div class="toast-title">${esc(product?.title || 'Unknown')}</div>
      ${variantText ? `<div class="toast-sizes">${esc(variantText)}</div>` : ''}
    </div>
    <button class="toast-close">✕</button>`
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove())
  container.appendChild(toast)
  setTimeout(() => { toast.classList.add('toast-exit'); setTimeout(() => toast.remove(), 400) }, 8000)
}

// Register push channels from main process (called once at init)
function setSelfbotStatus(running) {
  const status = $('discord-bot-status')
  const toggle = $('btn-selfbot-toggle')
  if (!status) return
  status.textContent = running ? '🟢 Online' : '🔴 Offline'
  if (toggle) {
    toggle.textContent = running ? 'Stop' : 'Start'
    toggle.style.color = running ? 'var(--red,#ef4444)' : 'var(--green,#22c55e)'
  }
}

async function initDiscordKeywords() {
  const input  = $('discord-keywords-input')
  if (!input || !window.api.selfbot) return

  // Load saved keywords as chips
  const kws = await window.api.selfbot.getKeywords()
  let keywordList = kws ? kws.split(',').map(k => k.trim()).filter(Boolean) : []
  renderKeywordList(keywordList)

  // Initial status — poll until online (selfbot starts after 3s delay)
  const running = await window.api.selfbot.status()
  setSelfbotStatus(running)
  if (!running) {
    const poll = setInterval(async () => {
      const r = await window.api.selfbot.status()
      if (r) { setSelfbotStatus(true); clearInterval(poll) }
    }, 2000)
    setTimeout(() => clearInterval(poll), 15000)
  }

  // Live status updates from main process
  window.api.onSelfbotStatus(({ running }) => setSelfbotStatus(running))

  // Toggle button
  $('btn-selfbot-toggle').addEventListener('click', async () => {
    const running = await window.api.selfbot.status()
    if (running) {
      await window.api.selfbot.stop()
      setSelfbotStatus(false)
    } else {
      setSelfbotStatus(false)
      $('discord-bot-status').textContent = '🟡 Starting...'
      await window.api.selfbot.start()
    }
  })

  // Add keyword
  const addKeyword = async () => {
    const val = input.value.trim()
    if (!val || keywordList.includes(val)) { input.value = ''; return }
    keywordList.push(val)
    input.value = ''
    const res = await window.api.selfbot.setKeywords(keywordList.join(', '))
    if (res?.ok) { $('discord-bot-status').textContent = '🟡 Restarting...'; renderKeywordList(keywordList) }
  }
  $('btn-discord-keywords-save').addEventListener('click', addKeyword)
  input.addEventListener('keydown', e => { if (e.key === 'Enter') addKeyword() })

  // Channel management
  const channelIds = await window.api.selfbot.getChannels()
  let channelNames = {}
  try { channelNames = await window.api.selfbot.getChannelNames() } catch {}
  renderChannelList(channelIds, channelNames)

  $('btn-discord-channel-add').addEventListener('click', async () => {
    const inp = $('discord-channel-input')
    const id = inp.value.trim()
    if (!id) return
    const res = await window.api.selfbot.addChannel(id)
    if (res?.ok) {
      inp.value = ''
      let names = {}
      try { names = await window.api.selfbot.getChannelNames() } catch {}
      renderChannelList(res.ids, names)
    } else if (res?.error) showToast(res.error)
  })

  $('discord-channel-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('btn-discord-channel-add').click()
  })
}

function renderKeywordList(keywords) {
  const list = $('discord-keyword-list')
  if (!list) return
  if (!keywords || keywords.length === 0) {
    list.innerHTML = '<span style="font-size:12px;color:var(--text-dim)">No keywords added yet</span>'
    return
  }
  list.innerHTML = keywords.map(kw => `
    <div class="channel-chip" style="background:rgba(34,197,94,.1);border-color:rgba(34,197,94,.3);color:#22c55e">
      <span>${esc(kw)}</span>
      <button class="channel-chip-remove" data-kw="${esc(kw)}" style="color:#22c55e">✕</button>
    </div>`).join('')
  list.querySelectorAll('.channel-chip-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const kw = btn.dataset.kw
      const input = $('discord-keywords-input')
      const kws = await window.api.selfbot.getKeywords()
      const updated = kws.split(',').map(k => k.trim()).filter(k => k && k !== kw)
      const res = await window.api.selfbot.setKeywords(updated.join(', '))
      if (res?.ok) { renderKeywordList(updated); $('discord-bot-status').textContent = '🟡 Restarting...' }
    })
  })
}

function renderChannelList(ids, names = {}) {
  const list = $('discord-channel-list')
  if (!list) return
  if (!ids || ids.length === 0) {
    list.innerHTML = '<span style="font-size:12px;color:var(--text-dim)">No channels added yet</span>'
    return
  }
  list.innerHTML = ids.map(id => {
    const info = names[id]
    const channelName = info?.channel || id
    const guildName   = info?.guild   || null
    const label = guildName
      ? `${esc(guildName)} / #${esc(channelName)}`
      : `#${esc(channelName)}`
    return `
    <div class="channel-chip" title="ID: ${esc(id)}">
      ${guildName
        ? `<span style="font-size:11px;opacity:.6;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(guildName)}</span>
           <span style="font-size:11px;opacity:.35">/</span>
           <span style="font-size:11px;opacity:.55">#</span><span class="channel-chip-id">${esc(channelName)}</span>`
        : `<span style="font-size:11px;opacity:.55">#</span><span class="channel-chip-id">${esc(channelName)}</span>`
      }
      <button class="channel-chip-remove" data-id="${esc(id)}">✕</button>
    </div>`
  }).join('')
  list.querySelectorAll('.channel-chip-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const res = await window.api.selfbot.removeChannel(btn.dataset.id)
      if (res?.ok) {
        let names = {}
        try { names = await window.api.selfbot.getChannelNames() } catch {}
        renderChannelList(res.ids, names)
      }
    })
  })
}

// ── Discord Cook Group Feed ───────────────────────────────────────────────────

function feedTimeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1)  return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function appendFeedMessage(data) {
  const log   = $('discord-feed-log')
  const empty = $('discord-feed-empty')
  if (empty) empty.style.display = 'none'

  const el = document.createElement('div')
  el.className = 'feed-msg-card'

  const urlMatches = (data.content || '').match(/https?:\/\/\S+/g) || []
  const allUrls    = [...new Set([...urlMatches, ...(data.urls || [])])]
  const atcUrls    = data.atc_urls || []

  const linksHtml = allUrls.length ? `<div class="feed-msg-links">${allUrls.map(u => {
    const isAtc = atcUrls.includes(u)
    const label = isAtc ? 'ATC' : 'Link'
    const cls   = isAtc ? 'feed-msg-link-btn atc' : 'feed-msg-link-btn'
    return `<button class="${cls}" data-ext="${esc(u)}">${label} →</button>`
  }).join('')}</div>` : ''

  const embedsHtml = (data.embeds || []).filter(e => e.title || e.description || e.image).map(e => `
    <div class="feed-msg-embed" ${e.color ? `style="border-left-color:#${e.color.toString(16).padStart(6,'0')}"` : ''}>
      ${e.image ? `<img class="feed-msg-embed-img" src="${esc(e.image)}" loading="lazy" onerror="this.style.display='none'" />` : ''}
      ${e.title ? `<div class="feed-msg-embed-title">${esc(e.title)}</div>` : ''}
      ${e.description ? `<div class="feed-msg-embed-desc">${esc(e.description).slice(0, 200)}</div>` : ''}
    </div>`).join('')

  const imagesHtml = (data.images || []).map(src =>
    `<img class="feed-msg-image" src="${esc(src)}" loading="lazy" onerror="this.style.display='none'" />`
  ).join('')

  const contentText = (data.content || '').replace(/https?:\/\/\S+/g, '').trim()

  el.innerHTML = `
    <div class="feed-msg-header">
      <span class="feed-msg-author">${esc(data.author)}</span>
      <span class="feed-msg-channel">#${esc(data.channel)}</span>
      <span class="feed-msg-time">${feedTimeAgo(data.timestamp)}</span>
    </div>
    ${contentText ? `<div class="feed-msg-content">${esc(contentText)}</div>` : ''}
    ${embedsHtml}
    ${imagesHtml}
    ${linksHtml}`

  el.querySelectorAll('[data-ext]').forEach(btn =>
    btn.addEventListener('click', () => window.api.openExternal(btn.dataset.ext))
  )

  log.insertBefore(el, log.firstChild)

  // cap at 100 messages
  while (log.children.length > 101) log.removeChild(log.lastChild)
}

async function renderFeedChannelList() {
  const list = $('discord-feed-channel-list')
  if (!list) return
  const ids = await window.api.selfbot.getFeedChannels()
  if (!ids || ids.length === 0) {
    list.innerHTML = '<span style="font-size:12px;color:var(--text-dim)">No feed channels yet</span>'
    return
  }
  list.innerHTML = ids.map(id => `
    <div class="channel-chip">
      <span class="channel-chip-id">${esc(id)}</span>
      <button class="channel-chip-remove" data-id="${esc(id)}">✕</button>
    </div>`).join('')
  list.querySelectorAll('.channel-chip-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      await window.api.selfbot.removeFeedChannel(btn.dataset.id)
      renderFeedChannelList()
    })
  })
}

function initDiscordFeed() {
  window.api.onDiscordFeed(data => appendFeedMessage(data))

  $('btn-feed-clear').addEventListener('click', () => {
    const log = $('discord-feed-log')
    log.innerHTML = '<div id="discord-feed-empty" style="font-size:13px;color:var(--text-dim);text-align:center;padding:20px 0">No feed channels added yet — add a channel ID in Discord Settings</div>'
  })

  const addBtn   = $('btn-discord-feed-channel-add')
  const addInput = $('discord-feed-channel-input')
  if (addBtn && addInput) {
    addBtn.addEventListener('click', async () => {
      const id = addInput.value.trim()
      if (!id) return
      await window.api.selfbot.addFeedChannel(id)
      addInput.value = ''
      renderFeedChannelList()
    })
    addInput.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click() })
  }

  // Load feed channel list whenever settings modal opens
  const settingsBtn = $('btn-discord-settings')
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => renderFeedChannelList(), { capture: true })
  }
}

function showNikeAlert(data) {
  const isLive      = data.type === 'live' || data.type === 'draw_open' || data.type === 'method_change'
  const container   = $('toast-container')

  // Sound — 3x for live/draw, 1x for new announcement
  playAlertSound(isLive ? 3 : 1)

  // Flash window via main process
  window.api.windowFlash?.()

  // Auto-switch to monitors tab so feed is visible
  if (isLive) switchView('monitors')

  // Build toast
  const toast = document.createElement('div')
  toast.className = 'monitor-toast nike-alert' + (isLive ? ' nike-alert-live' : '')

  const icons   = { live: '⚡', draw_open: '🎟', method_change: '🔄', new: '🆕' }
  const labels  = { live: 'LIVE NOW', draw_open: 'DRAW OPEN', method_change: 'DRAW → FCFS', new: 'New Drop Announced' }
  const sizes   = data.sizes || []
  const sizeLinks = sizes.length
    ? `<div class="nike-alert-sizes">${sizes.map(s =>
        `<a class="nike-size-btn" data-ext="${esc(data.url)}">${esc(s)}</a>`
      ).join('')}</div>`
    : ''

  toast.innerHTML = `
    <div class="nike-alert-header">
      <span class="nike-alert-icon">${icons[data.type] || '👟'}</span>
      <span class="nike-alert-label">${labels[data.type] || 'Nike'}</span>
      <button class="toast-close">✕</button>
    </div>
    <div class="nike-alert-title">${esc(data.title || 'Nike Drop')}</div>
    ${data.variant ? `<div class="nike-alert-style">${esc(data.variant)}</div>` : ''}
    ${sizeLinks}
    <a class="nike-alert-cta" data-ext="${esc(data.url)}">Open Product Page →</a>`

  toast.querySelectorAll('[data-ext]').forEach(el =>
    el.addEventListener('click', e => { e.stopPropagation(); window.api.openExternal(el.dataset.ext) })
  )
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove())

  // Persistent for live alerts — stays until manually closed
  if (!isLive) setTimeout(() => { toast.classList.add('toast-exit'); setTimeout(() => toast.remove(), 400) }, 10000)

  container.appendChild(toast)
}

function initMonitorPush() {
  if (window.api.onDataReloaded) {
    window.api.onDataReloaded(() => loadData())
  }
  if (!window.api.onMonitorAlert) return
  window.api.onMonitorAlert(data => {
    if (data.isNike) showNikeAlert(data)
    else showMonitorToast(data)
  })
  window.api.onNikeBoost(({ active, productName, launchDate }) => {
    if (!active) return
    const mins = launchDate ? Math.max(1, Math.round((new Date(launchDate) - Date.now()) / 60000)) : '?'
    const container = $('toast-container')
    const toast = document.createElement('div')
    toast.className = 'monitor-toast monitor-toast-restock'
    toast.style.borderLeftColor = '#f05223'
    toast.innerHTML = `
      <div class="toast-icon">⚡</div>
      <div class="toast-body">
        <div class="toast-label">Nike · Boost Mode Active</div>
        <div class="toast-title">${esc(productName)}</div>
        <div class="toast-sizes">Drops in ~${mins} min · polling every 10s</div>
      </div>
      <button class="toast-close">✕</button>`
    toast.querySelector('.toast-close').addEventListener('click', () => toast.remove())
    container.appendChild(toast)
    setTimeout(() => { toast.classList.add('toast-exit'); setTimeout(() => toast.remove(), 400) }, 10000)
  })
  window.api.onShopifyFeed(data => {
    shopifyFeeds.set(data.monitorId, { monitorName: data.monitorName, products: data.products, baseUrl: data.baseUrl, updatedAt: Date.now() })
    if (document.getElementById('view-monitors')?.classList.contains('active')) renderShopifyFeed()
  })
  window.api.onDiscordKeyword(data => {
    showDiscordKeywordToast(data)
    playAlertSound()
    ;(data.atc_urls || []).forEach((url, i) =>
      setTimeout(() => window.api.openExternal(url), i * 400)
    )
  })
}

function showDiscordKeywordToast(data) {
  const container = $('toast-container')
  if (!container) return
  const toast = document.createElement('div')
  toast.className = 'monitor-toast monitor-toast-new'
  toast.style.setProperty('--toast-accent', '#5865f2')
  toast.innerHTML = `
    <div class="toast-icon">💬</div>
    <div class="toast-body">
      <div class="toast-label">Discord · #${esc(data.channel)} · <em>${esc(data.keyword)}</em></div>
      <div class="toast-title">${esc(data.text.slice(0, 80))}</div>
    </div>
    <button class="toast-close">✕</button>`
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove())
  const openDiscord = () => {
    const url = data.url || ''
    const appUrl = url.includes('/channels/')
      ? 'discord://-/channels/' + url.split('/channels/')[1].split('?')[0]
      : url
    if (appUrl) window.api.openExternal(appUrl)
  }
  toast.addEventListener('click', e => {
    if (e.target.classList.contains('toast-close')) return
    openDiscord()
  })
  container.appendChild(toast)
  setTimeout(() => { toast.classList.add('toast-exit'); setTimeout(() => toast.remove(), 400) }, 10000)

  // Add to alert history log
  const log = $('discord-alert-log')
  if (log) {
    $('discord-log-empty')?.remove()
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const entry = document.createElement('div')
    entry.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--card-bg);border-radius:8px;border:1px solid var(--border);cursor:pointer'
    entry.innerHTML = `
      <div style="font-size:18px">💬</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:700;color:#5865f2">#${esc(data.channel)} · <em style="font-style:normal">${esc(data.keyword)}</em></div>
        <div style="font-size:12px;color:var(--text);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(data.text.slice(0, 120))}</div>
      </div>
      <div style="font-size:11px;color:var(--text-dim);white-space:nowrap">${time}</div>`
    entry.addEventListener('click', openDiscord)
    log.insertBefore(entry, log.firstChild)
  }
}

function timeAgo(isoString) {
  const diff = Date.now() - new Date(isoString).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'Just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const RETAIL_HINTS = {
  walmart: 'e.g. https://www.walmart.com/ip/product-name/123456789',
  target:  'e.g. https://www.target.com/p/product-name/-/A-12345678',
  amazon:  'e.g. https://www.amazon.com/dp/B09XYZ1234 (may be unreliable due to bot detection)',
  bestbuy: 'e.g. https://www.bestbuy.com/site/product-name/1234567.p',
  lego:    'e.g. https://www.lego.com/en-us/product/set-name-12345',
}

let monitorSiteType = 'shopify'

function openMonitorModal(monitor = null) {
  monitorEditId = monitor ? monitor.id : null
  $('modal-monitor-title').textContent = monitor ? 'Edit Monitor' : 'Add Monitor'
  $('btn-monitor-save').textContent    = monitor ? 'Save' : 'Add Monitor'
  $('mon-name').value            = monitor?.name || ''
  $('mon-url').value             = monitor?.site_url || ''
  $('mon-product-url').value     = monitor?.product_url || ''
  $('mon-retail-url').value      = monitor?.product_url || monitor?.site_url || ''
  $('mon-keywords').value        = monitor?.keywords || ''
  $('mon-webhook').value         = monitor?.webhook_url || ''
  $('mon-role').value            = monitor?.ping_role || ''
  $('mon-interval').value        = String(monitor?.interval_sec || 60)
  $('mon-price-threshold').value = monitor?.price_threshold || ''
  $('mon-proxy').value           = monitor?.proxy_url || ''

  // Set site type
  setMonitorSiteType(monitor?.site_type || 'shopify')

  // Set shopify monitor type
  const isProduct = !!(monitor?.product_url)
  setMonitorType(isProduct ? 'product' : 'site')

  // Set price alert toggle
  const priceOn = !!(monitor?.price_alert)
  $('mon-price-alert-track').classList.toggle('on', priceOn)
  $('mon-price-threshold').style.display = priceOn ? '' : 'none'

  $('modal-monitor').style.display = 'flex'
  $('mon-name').focus()
}

function setMonitorSiteType(type) {
  monitorSiteType = type
  document.querySelectorAll('.mon-site-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.site === type)
  })
  const isShopify = type === 'shopify'
  const isFunko   = type === 'funko'
  const isNike    = type === 'nike'
  $('mon-shopify-fields').style.display = (isShopify || isFunko || isNike) ? '' : 'none'
  $('mon-retail-fields').style.display  = (isShopify || isFunko || isNike) ? 'none' : ''
  // Hide Whole Site / Specific Product toggle for Funko and Nike (whole-site only)
  $('mon-shopify-fields').querySelector('.monitor-type-toggle').style.display = (isFunko || isNike) ? 'none' : ''
  if (isFunko) {
    $('mon-url').placeholder = 'Funko collection URL (e.g. https://funko.com/new-featured/new-releases/)'
    if (!$('mon-url').value) $('mon-url').value = 'https://funko.com/new-featured/new-releases/'
  } else if (isNike) {
    $('mon-url').placeholder = 'Leave blank for SNKRS feed, or paste custom Nike API URL'
    $('mon-url').value = ''
  } else if (isShopify) {
    $('mon-url').placeholder = 'Shopify Site URL * (e.g. https://kith.com)'
  }
  if (!isShopify && !isFunko) {
    const hint = RETAIL_HINTS[type] || ''
    $('mon-retail-hint').textContent = hint
    $('mon-retail-hint-row').style.display = hint ? '' : 'none'
  }
}

function setMonitorType(type) {
  const isSite = type === 'site'
  $('mon-type-site').classList.toggle('active', isSite)
  $('mon-type-product').classList.toggle('active', !isSite)
  $('mon-product-row').style.display  = isSite ? 'none' : ''
  $('mon-keywords-row').style.display = isSite ? '' : 'none'
}

// ── Market Lookup ─────────────────────────────────────────────────────────────
const EBAY_DARK_CSS = `
  * { background-color: inherit; color: inherit; }
  html { background: #0f0f0f !important; color: #e0e0e0 !important; }
  body, div, section, article, aside, header, footer, nav, main,
  [class], [id] {
    background-color: #0f0f0f !important;
    border-color: #2a2a2a !important;
    color: #e0e0e0 !important;
  }
  img, video, canvas, svg, picture, iframe { background-color: #1a1a1a !important; }
  a { color: #a78bfa !important; }
  a:hover { color: #c4b5fd !important; }
  input, select, textarea, button {
    background-color: #1e1e1e !important;
    color: #e0e0e0 !important;
    border-color: #333 !important;
  }
  .s-item__price, [class*="price"], [class*="Price"] { color: #4ade80 !important; }
  [class*="sold-price"], [class*="POSITIVE"] { color: #4ade80 !important; }
  [class*="negative"], [class*="NEGATIVE"] { color: #f87171 !important; }
  [style*="background-color: rgb(255"] { background-color: #0f0f0f !important; }
  [style*="background: white"], [style*="background: #fff"], [style*="background:#fff"] { background: #0f0f0f !important; }
  [style*="color: black"], [style*="color:#000"] { color: #e0e0e0 !important; }
`

// ── Checkout Webview ──────────────────────────────────────────────────────────
let _checkoutUrl = ''

function openCheckoutWebview(url) {
  _checkoutUrl = url
  const wv    = $('checkout-webview')
  const modal = $('modal-checkout')
  const label = $('checkout-site-label')
  const favicon = $('checkout-favicon')

  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    label.textContent = host
    favicon.src = `https://www.google.com/s2/favicons?sz=32&domain=${host}`
    favicon.style.display = ''
    favicon.onerror = () => { favicon.style.display = 'none' }
  } catch { label.textContent = url }

  wv.src = url
  modal.style.display = 'flex'
}

async function runAutofill(wv) {
  const settings = await window.api.getSettings()
  const profiles = settings.profiles
  const af = profiles
    ? (profiles[settings.activeProfile || 0] || profiles[0] || {})
    : (settings.autofill || {})
  if (!Object.values(af).some(Boolean)) return

  const script = `(async function() {
    if (window.__rtAutofillActive) return
    window.__rtAutofillActive = true

    const d = ${JSON.stringify(af)}
    const wait = ms => new Promise(r => setTimeout(r, ms))

    function setVal(el, val) {
      if (!el || val === undefined || val === '') return false
      try {
        const proto = el.tagName === 'SELECT'
          ? window.HTMLSelectElement.prototype
          : window.HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(el, val)
      } catch { el.value = val }
      ;['input','change','blur'].forEach(t =>
        el.dispatchEvent(new Event(t, { bubbles: true }))
      )
      return true
    }

    function fill(selectors, val) {
      if (!val) return false
      for (const s of selectors) {
        try { const el = document.querySelector(s); if (el && setVal(el, val)) return true } catch {}
      }
      return false
    }

    // For custom React combobox dropdowns (Shopify new checkout)
    async function fillCombobox(triggerSels, val) {
      if (!val) return false
      for (const s of triggerSels) {
        try {
          const el = document.querySelector(s)
          if (!el) continue
          // Native select (old Shopify / other sites)
          if (el.tagName === 'SELECT') {
            const opts = [...el.options]
            const match = opts.find(o =>
              o.value.toLowerCase() === val.toLowerCase() ||
              o.text.toLowerCase() === val.toLowerCase() ||
              o.text.toLowerCase().startsWith(val.toLowerCase())
            )
            if (match) { setVal(el, match.value); return true }
          }
          // Custom combobox — click to open, then pick option
          el.click(); el.focus()
          await wait(350)
          const opts = [...document.querySelectorAll('[role="option"],[data-value]')]
          if (opts.length === 0) { document.body.click(); continue }
          const match = opts.find(o =>
            o.textContent.trim().toLowerCase() === val.toLowerCase() ||
            o.textContent.trim().toLowerCase().startsWith(val.slice(0,3).toLowerCase()) ||
            (o.dataset.value || '').toLowerCase() === val.toLowerCase()
          )
          if (match) { match.click(); await wait(200); return true }
          document.body.click()
        } catch {}
      }
      return false
    }

    function fillText() {
      fill(['[name="email"]','[autocomplete="email"]','[type="email"]','#checkout_email'], d.email)
      fill(['[name="firstName"]','[autocomplete="given-name"]','#checkout_shipping_address_first_name','[placeholder*="First" i]'], d.firstName)
      fill(['[name="lastName"]','[autocomplete="family-name"]','#checkout_shipping_address_last_name','[placeholder*="Last" i]'], d.lastName)
      fill(['[name="address1"]','[autocomplete="address-line1"]','#checkout_shipping_address_address1','[placeholder*="Address" i]'], d.address1)
      fill(['[name="address2"]','[autocomplete="address-line2"]','#checkout_shipping_address_address2','[placeholder*="Apartment" i]'], d.address2)
      fill(['[name="city"]','[autocomplete="address-level2"]','#checkout_shipping_address_city','[placeholder="City"]'], d.city)
      fill(['[name="postalCode"]','[name*="zip"]','[autocomplete="postal-code"]','#checkout_shipping_address_zip','[placeholder*="ZIP" i]','[placeholder*="Postal" i]'], d.zip)
      fill(['[name="phone"]','[autocomplete="tel"]','#checkout_shipping_address_phone','[placeholder="Phone"]'], d.phone)
      // Card fields (only works on sites without payment iframes)
      fill(['[autocomplete="cc-name"]','[name="cardName"]','[name="name_on_card"]','[placeholder*="Name on card" i]'], d.ccName)
      fill(['[autocomplete="cc-number"]','[name="cardNumber"]','[name="card_number"]','[name="number"]','[placeholder*="Card number" i]'], d.ccNumber)
      fill(['[autocomplete="cc-exp"]','[name="cardExpiry"]','[name="expiry"]','[name="exp"]','[placeholder*="MM" i]'], d.ccExpiry)
      fill(['[autocomplete="cc-csc"]','[name="cvv"]','[name="cvc"]','[name="securityCode"]','[name="security_code"]','[placeholder*="CVV" i]','[placeholder*="CVC" i]'], d.ccCvv)
    }

    // Fill text fields immediately, then handle dropdowns sequentially
    fillText()

    // Country first (triggers state list to render)
    await fillCombobox(
      ['[name="countryCode"]','[name*="country"]','[autocomplete="country"]','#checkout_shipping_address_country',
       '[aria-label*="Country" i]','[id*="country" i]'],
      d.country
    )
    await wait(400)

    // State after country is set
    await fillCombobox(
      ['[name="zone"]','[name*="province"]','[autocomplete="address-level1"]','#checkout_shipping_address_province',
       '[aria-label*="State" i]','[aria-label*="Province" i]','[id*="zone" i]'],
      d.state
    )

    // Watch for form re-renders and re-fill text fields
    const obs = new MutationObserver(() => fillText())
    obs.observe(document.body, { childList: true, subtree: true })
    setTimeout(() => obs.disconnect(), 15000)
  })()`

  await new Promise(r => setTimeout(r, 600))
  try { await wv.executeJavaScript(script) } catch {}
}

const CHECKOUT_DARK_CSS = `
  html, body { background: #111 !important; color: #e0e0e0 !important; }
  *, *::before, *::after { background-color: inherit; border-color: #2a2a2a !important; }
  [class],[id] { background-color: #111 !important; color: #e0e0e0 !important; }
  input, select, textarea { background: #1e1e1e !important; color: #e0e0e0 !important; border-color: #333 !important; }
  button:not([class*="pay"]):not([class*="btn-pay"]) { background: #1e1e1e !important; color: #e0e0e0 !important; }
  a { color: #a78bfa !important; }
  img, svg, iframe { background: #1a1a1a !important; }
  [style*="background:#fff"],[style*="background: #fff"],[style*="background:white"],[style*="background: white"] { background: #111 !important; }
`

function initCheckoutWebview() {
  const wv = $('checkout-webview')

  wv.addEventListener('dom-ready', () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark'
    if (dark) wv.insertCSS(CHECKOUT_DARK_CSS).catch(() => {})
    runAutofill(wv)
  })

  $('btn-checkout-close').addEventListener('click', () => {
    $('modal-checkout').style.display = 'none'
    wv.src = 'about:blank'
  })
  $('btn-checkout-external').addEventListener('click', () => {
    if (_checkoutUrl) window.api.openExternal(_checkoutUrl)
  })
  $('modal-checkout').addEventListener('click', e => {
    if (e.target === $('modal-checkout')) {
      $('modal-checkout').style.display = 'none'
      wv.src = 'about:blank'
    }
  })
}

// Wire up eBay dark mode injection once on startup
function initEbayDarkMode() {
  const wv = $('market-webview')
  wv.addEventListener('dom-ready', () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark'
    if (dark) wv.insertCSS(EBAY_DARK_CSS)
  })
}

function runMarketSearch() {
  const query = $('market-query').value.trim()
  if (!query) return
  const sold = $('btn-mode-sold').classList.contains('active')

  const q = encodeURIComponent(query)
  const url = sold
    ? `https://www.ebay.com/sch/i.html?_nkw=${q}&_sacat=0&_from=R40&rt=nc&LH_Sold=1&LH_Complete=1`
    : `https://www.ebay.com/sch/i.html?_nkw=${q}&_sacat=0`

  $('market-idle').style.display    = 'none'
  $('market-webview').style.display = 'flex'
  $('market-webview').src           = url
}

// ── Proxy Manager ─────────────────────────────────────────────────────────────
let proxies = []

async function loadProxies() {
  proxies = await window.api.proxies.getAll()
  renderProxies()
}

function renderProxies() {
  const tbody = $('proxy-table-body')
  const empty = $('proxy-empty')
  const working  = proxies.filter(p => p.status === 'working').length
  const dead     = proxies.filter(p => p.status === 'dead').length
  const untested = proxies.filter(p => p.status === 'untested').length
  $('proxy-count-working').textContent  = working
  $('proxy-count-dead').textContent     = dead
  $('proxy-count-untested').textContent = untested
  $('proxy-total-badge').textContent    = proxies.length ? `${proxies.length}` : ''
  if (!proxies.length) {
    tbody.innerHTML = ''
    empty.style.display = ''
    return
  }
  empty.style.display = 'none'
  tbody.innerHTML = proxies.map(p => `
    <tr id="proxy-row-${p.id}">
      <td><span class="proxy-host">${esc(p.host)}:${esc(p.port)}</span></td>
      <td>${p.username ? `<span class="proxy-auth-yes">Auth</span>` : `<span class="proxy-auth-no">None</span>`}</td>
      <td><span class="proxy-status-badge proxy-status-${p.status}">${p.status}</span></td>
      <td>${p.latency != null ? `${p.latency}ms` : '<span style="color:var(--text-dim)">—</span>'}</td>
      <td style="color:var(--text-dim);font-size:12px">${p.lastTested ? new Date(p.lastTested).toLocaleTimeString() : '—'}</td>
      <td>
        <div class="row-actions">
          <button class="btn-row" title="Test" onclick="testProxy('${p.id}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          </button>
          <button class="btn-row btn-row-del" title="Delete" onclick="deleteProxy('${p.id}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `).join('')
}

function updateProxyRow(id, result) {
  const row = document.getElementById(`proxy-row-${id}`)
  if (!row) return
  const p = proxies.find(x => x.id === id)
  if (!p) return
  Object.assign(p, result, { lastTested: new Date().toISOString() })
  const cells = row.querySelectorAll('td')
  cells[2].innerHTML = `<span class="proxy-status-badge proxy-status-${p.status}">${p.status}</span>`
  cells[3].textContent = p.latency != null ? `${p.latency}ms` : '—'
  cells[4].textContent = new Date(p.lastTested).toLocaleTimeString()
  // Update stat chips
  $('proxy-count-working').textContent  = proxies.filter(x => x.status === 'working').length
  $('proxy-count-dead').textContent     = proxies.filter(x => x.status === 'dead').length
  $('proxy-count-untested').textContent = proxies.filter(x => x.status === 'untested').length
}

async function testProxy(id) {
  const row = document.getElementById(`proxy-row-${id}`)
  if (row) row.querySelector('.proxy-status-badge').className = 'proxy-status-badge proxy-status-testing'
  row.querySelector('.proxy-status-badge').textContent = 'testing…'
  await window.api.proxies.test(id)
}

async function deleteProxy(id) {
  await window.api.proxies.delete(id)
  proxies = proxies.filter(p => p.id !== id)
  renderProxies()
}

function bindProxyEvents() {
  $('btn-proxies-import-open').addEventListener('click', () => {
    $('proxy-import-textarea').value = ''
    $('proxy-import-status').textContent = ''
    $('modal-proxy-import').style.display = 'flex'
  })
  const closeImport = () => { $('modal-proxy-import').style.display = 'none' }
  $('modal-proxy-import-close').addEventListener('click', closeImport)
  $('modal-proxy-import-cancel').addEventListener('click', closeImport)

  $('btn-proxy-import-submit').addEventListener('click', async () => {
    const lines = $('proxy-import-textarea').value.split('\n').map(l => l.trim()).filter(Boolean)
    if (!lines.length) return
    $('btn-proxy-import-submit').textContent = 'Importing…'
    const result = await window.api.proxies.add(lines)
    $('btn-proxy-import-submit').textContent = 'Import'
    $('proxy-import-status').textContent = `Added ${result.added} proxies (${result.total} total, dupes skipped)`
    await loadProxies()
    if (result.added > 0) setTimeout(closeImport, 1200)
  })

  $('btn-proxies-test-all').addEventListener('click', async () => {
    $('btn-proxies-test-all').textContent = 'Testing…'
    $('btn-proxies-test-all').disabled = true
    await window.api.proxies.testAll()
    $('btn-proxies-test-all').textContent = 'Test All'
    $('btn-proxies-test-all').disabled = false
  })

  $('btn-proxies-clear-dead').addEventListener('click', async () => {
    const dead = proxies.filter(p => p.status === 'dead').length
    if (!dead) return
    proxies = await window.api.proxies.clear('dead')
    renderProxies()
  })

  window.api.onProxyTestResult(result => updateProxyRow(result.id, result))
}

// ── Start ─────────────────────────────────────────────────────────────────────
init()
