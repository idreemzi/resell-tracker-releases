// ── State ─────────────────────────────────────────────────────────────────────
let sales     = []
let inventory = []
let packages  = []
let releases       = []
let pinnedMessages = []
let isAdmin        = false
const ADMIN_DISCORD_ID = '313100007551270912'

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
  loadData()
  // Sync toggle state to match whatever theme localStorage applied on load
  const dark = localStorage.getItem('rt-theme') === 'dark'
  $('dark-mode-track').classList.toggle('on', dark)
  initStatusBar()
  initNavUser()
  initEbayDarkMode()
  initHome()
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
  if (view === 'sales') renderChart()
  if (view === 'home')  renderHome()
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

  $('btn-logout').addEventListener('click', async () => {
    await window.api.auth.logout()
    window.location.href = 'login.html'
  })

  $('btn-dashboard').addEventListener('click', () => {
    window.api.openExternal('https://discord.com/channels/@me')
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

  // Delegated: release edit / delete + pinned delete
  document.addEventListener('click', e => {
    const editBtn    = e.target.closest('.btn-edit-release')
    const delBtn     = e.target.closest('.btn-del-release')
    const pinDelBtn  = e.target.closest('.btn-pinned-delete')
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

  $('modal-settings').style.display = 'flex'
}

function closeSettingsModal() { $('modal-settings').style.display = 'none' }

function saveSettings() {
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

      return `<div class="home-release-card${isPast ? ' release-past' : ''}" data-id="${esc(r.id)}">
        ${imgHtml}
        <div class="home-release-info">
          <div class="home-release-name">${esc(r.name)}</div>
          <div class="home-release-meta">
            <span class="home-release-date${isToday ? ' today' : ''}">${dateLabel}</span>
            ${r.retailPrice ? `<span class="home-release-price">Retail: $${parseFloat(r.retailPrice).toFixed(2)}</span>` : ''}
          </div>
          ${r.notes ? `<div class="home-release-notes">${esc(r.notes)}</div>` : ''}
        </div>
        <div class="home-release-actions">
          <button class="btn-row btn-edit-release" title="Edit" style="pointer-events:auto">${EDIT_ICON}</button>
          <button class="btn-row danger btn-del-release" title="Delete" style="pointer-events:auto">${DEL_ICON}</button>
        </div>
      </div>`
    }).join('')
  }

  // Stats
  const monthProfit = sales
    .filter(s => { const d = s.date || ''; const [y, m] = d.split('-'); return +y === ty && +m - 1 === tm })
    .reduce((a, s) => a + (calcSaleProfit(s) || 0), 0)
  const pd = profitDisplay(monthProfit)
  $('home-stat-profit').textContent = pd.text
  $('home-stat-profit').className   = `home-stat-value ${pd.cls}`
  $('home-stat-inv').textContent    = inventory.length
  $('home-stat-transit').textContent = packages.filter(p =>
    ['In Transit', 'Out for Delivery', 'Awaiting Pickup'].includes(p.status)
  ).length

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

  const payload = {
    name,
    date,
    imageUrl:    $('rl-image').value.trim()  || null,
    retailPrice: $('rl-retail').value        || null,
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

// ── Start ─────────────────────────────────────────────────────────────────────
init()
