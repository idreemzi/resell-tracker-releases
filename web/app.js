// -- Config --------------------------------------------------------------------
const SUPABASE_URL      = 'https://lpfoqbmtsxfylkmapxfj.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_uqGOOWhBan8ZI4knzZvaVw_OKFiAMRP'
const PHOTO_BUCKET      = 'inventory-photos'
const RELEASES_SERVER   = 'https://welcoming-abundance-production-dd13.up.railway.app'

// -- Supabase ------------------------------------------------------------------
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// -- State ---------------------------------------------------------------------
let currentUser    = null
let currentProfile = null
let inventory      = []
let sales          = []
let packages       = []
let editId         = null        // id being edited, null = new
let editCollection = null        // 'inv' | 'sale' | 'pkg'
let pendingPhoto   = null        // File object waiting to upload
let analyticsYear  = new Date().getFullYear()
let chartMonthly   = null
let chartPlatform  = null
let chartHomeMini  = null
let adminViewUserId = null
let approvalPoller  = null
let _saving         = false  // prevent double-submit
let releases        = []
let relCalMonth     = new Date().getMonth()
let relCalYear      = new Date().getFullYear()
let relSelectedDate = null

// -- Platform colors -----------------------------------------------------------
const PLATFORM_META = {
  stockx:   { bg: '#13cb75', text: '#fff' },
  goat:     { bg: '#000',    text: '#fff' },
  ebay:     { bg: '#e53238', text: '#fff' },
  depop:    { bg: '#ff2300', text: '#fff' },
  grailed:  { bg: '#c82020', text: '#fff' },
  amazon:   { bg: '#ff9900', text: '#fff' },
  facebook: { bg: '#1877f2', text: '#fff' },
  offerup:  { bg: '#008a00', text: '#fff' },
  poshmark: { bg: '#ca1e3e', text: '#fff' },
  mercari:  { bg: '#973ae5', text: '#fff' },
}

// -- Cursor glow ---------------------------------------------------------------
document.addEventListener('mousemove', e => {
  const g = document.getElementById('cursor-glow')
  if (g) { g.style.left = e.clientX + 'px'; g.style.top = e.clientY + 'px' }
})

// -- Card spotlight ------------------------------------------------------------
function initSpotlights() {
  document.querySelectorAll('.stat-card').forEach(card => {
    // Add spin-border element if not present
    if (!card.querySelector('.spin-border')) {
      const sb = document.createElement('div')
      sb.className = 'spin-border'
      card.insertBefore(sb, card.firstChild)
    }
    card.addEventListener('mousemove', e => {
      const r  = card.getBoundingClientRect()
      const sx = ((e.clientX - r.left) / r.width  * 100).toFixed(1) + '%'
      const sy = ((e.clientY - r.top)  / r.height * 100).toFixed(1) + '%'
      const sp = card.querySelector('.spotlight')
      if (sp) sp.style.background = `radial-gradient(circle at ${sx} ${sy}, rgba(255,255,255,0.07) 0%, transparent 55%)`
    })
  })
}

// -- Number counter animation --------------------------------------------------
function animateCounter(id, to, isCurrency = true, isPercent = false, decimals = 2) {
  const el = document.getElementById(id)
  if (!el) return
  const prev = parseFloat(el.dataset.animVal ?? 'NaN')
  if (!isNaN(prev) && Math.abs(prev - to) < 0.005) return
  el.dataset.animVal = to
  const from     = isNaN(prev) ? 0 : prev
  const start    = performance.now()
  const duration = 900
  const tick = now => {
    const p      = Math.min((now - start) / duration, 1)
    const eased  = 1 - Math.pow(1 - p, 4)           // ease-out quart
    const val    = from + (to - from) * eased
    if (isPercent)       el.textContent = val.toFixed(decimals) + '%'
    else if (isCurrency) el.textContent = (val < 0 ? '-$' : '$') + Math.abs(val).toFixed(decimals)
    else                 el.textContent = Math.round(val)
    if (p < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// -- Live clock ----------------------------------------------------------------
let clockTimer = null
function startClock() {
  clearInterval(clockTimer)
  const tick = () => {
    const t = document.getElementById('hero-time')
    if (t) t.textContent = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  }
  tick()
  clockTimer = setInterval(tick, 1000)
}

// -- 3D Card Tilt --------------------------------------------------------------
function init3DTilt() {
  document.querySelectorAll('.stat-card').forEach(card => {
    card.addEventListener('mouseenter', () => {
      card.style.transition = 'transform 0.08s linear, border-color 0.2s, box-shadow 0.2s'
    })
    card.addEventListener('mousemove', e => {
      const r = card.getBoundingClientRect()
      const x = (e.clientX - r.left) / r.width  - 0.5
      const y = (e.clientY - r.top)  / r.height - 0.5
      card.style.transform = `perspective(700px) rotateY(${x * 14}deg) rotateX(${-y * 14}deg) translateZ(12px) scale(1.01)`
    })
    card.addEventListener('mouseleave', () => {
      card.style.transition = 'transform 0.7s cubic-bezier(0.34,1.56,0.64,1), border-color 0.2s, box-shadow 0.2s'
      card.style.transform = ''
      setTimeout(() => { card.style.transition = '' }, 700)
    })
  })
}

// -- Particle Field ------------------------------------------------------------
function initParticles() {
  const canvas = document.getElementById('particles')
  if (!canvas) return
  const ctx = canvas.getContext('2d')

  const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight }
  resize()
  window.addEventListener('resize', resize)

  const COUNT = 65
  const pts = Array.from({ length: COUNT }, () => ({
    x:  Math.random() * canvas.width,
    y:  Math.random() * canvas.height,
    r:  Math.random() * 1.2 + 0.4,
    vx: (Math.random() - 0.5) * 0.25,
    vy: (Math.random() - 0.5) * 0.25,
    o:  Math.random() * 0.35 + 0.08,
  }))

  const draw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    pts.forEach(p => {
      p.x += p.vx; p.y += p.vy
      if (p.x < 0) p.x = canvas.width
      if (p.x > canvas.width) p.x = 0
      if (p.y < 0) p.y = canvas.height
      if (p.y > canvas.height) p.y = 0
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(165,180,252,${p.o})`
      ctx.fill()
    })
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x
        const dy = pts[i].y - pts[j].y
        const d  = Math.sqrt(dx * dx + dy * dy)
        if (d < 130) {
          ctx.beginPath()
          ctx.moveTo(pts[i].x, pts[i].y)
          ctx.lineTo(pts[j].x, pts[j].y)
          ctx.strokeStyle = `rgba(99,102,241,${0.07 * (1 - d / 130)})`
          ctx.lineWidth = 0.6
          ctx.stroke()
        }
      }
    }
    requestAnimationFrame(draw)
  }
  draw()
}

// -- Typewriter ----------------------------------------------------------------
let greetingTyped = false
function typewrite(el, text, speed = 38) {
  if (!el) return
  el.textContent = ''
  let i = 0
  const go = () => { if (i < text.length) { el.textContent += text[i++]; setTimeout(go, speed) } }
  go()
}

// -- Button Ripple -------------------------------------------------------------
function initRipple() {
  document.addEventListener('click', e => {
    const btn = e.target.closest('.btn-add, .btn-primary, .btn-secondary, .btn-danger, .btn-discord')
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const rip = document.createElement('span')
    rip.className = 'ripple'
    rip.style.left = (e.clientX - r.left) + 'px'
    rip.style.top  = (e.clientY - r.top)  + 'px'
    btn.appendChild(rip)
    setTimeout(() => rip.remove(), 700)
  })
}

// -- Boot ----------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  applyTheme()
  updateThemeIcon()
  setupKeyboard()
  setupPhotoZone()
  initSpotlights()
  init3DTilt()
  initParticles()
  initRipple()

  // Set today as default sale date
  document.getElementById('s-date').value = today()
  document.getElementById('year-label').textContent = analyticsYear

  // Check for existing session first
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) {
      await handleSession(session);
    } else {
      showScreen('screen-login');
    }
  } catch (err) {
    console.error('[auth:init]', err);
    showScreen('screen-login');
  }

  // Listen for future auth changes (sign-in, sign-out)
  sb.auth.onAuthStateChange(async (event, session) => {
    try {
      if (event === 'SIGNED_IN' && session) {
        await handleSession(session);
      }
      if (event === 'SIGNED_OUT') {
        currentUser = currentProfile = null;
        inventory = sales = packages = [];
        clearInterval(approvalPoller);
        showScreen('screen-login');
      }
    } catch (err) {
      console.error('[auth]', err);
      showScreen('screen-login');
    }
  })
})

// -- Auth ----------------------------------------------------------------------
async function loginWithDiscord() {
  const btn = document.getElementById('btn-discord-login')
  btn.disabled = true
  btn.textContent = 'Connecting…'
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'discord',
    options:  { redirectTo: window.location.origin + window.location.pathname }
  })
  if (error) {
    showLoginError(error.message)
    btn.disabled = false
    btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg> Continue with Discord`
  }
}

async function handleSession(session) {
  currentUser = session.user
  const profile = await fetchProfile(currentUser.id)

  if (!profile) {
    // Profile may not exist yet — wait a beat for the trigger and retry
    await new Promise(r => setTimeout(r, 1200))
    const retry = await fetchProfile(currentUser.id)
    if (!retry) {
      showScreen('screen-login')
      showLoginError('Could not load profile. Try refreshing.')
      return
    }
    currentProfile = retry
  } else {
    currentProfile = profile
  }

  if (!currentProfile.is_approved) {
    showPendingScreen()
    startApprovalPoller()
    return
  }

  clearInterval(approvalPoller)
  await bootApp()

  // Show onboarding for first-time users
  const obKey = `onboarded_${currentUser.id}`
  if (!localStorage.getItem(obKey)) {
    document.getElementById('onboarding-overlay').style.display = 'flex'
  }
}

async function fetchProfile(userId) {
  const { data } = await sb.from('profiles').select('*').eq('id', userId).single()
  return data
}

function showPendingScreen() {
  showScreen('screen-pending')
  const avatar = buildAvatarUrl(currentProfile.discord_id, currentProfile.avatar_url)
  document.getElementById('pending-avatar').src = avatar
  document.getElementById('pending-username').textContent = currentProfile.username || 'Unknown'
}

function startApprovalPoller() {
  clearInterval(approvalPoller)
  approvalPoller = setInterval(async () => {
    const p = await fetchProfile(currentUser.id)
    if (p && p.is_approved) {
      clearInterval(approvalPoller)
      currentProfile = p
      await bootApp()
    }
  }, 15000)
}

async function logout() {
  await sb.auth.signOut()
}

function showLoginError(msg) {
  const el = document.getElementById('login-error')
  el.textContent = msg
  el.style.display = 'block'
}

// -- App Boot ------------------------------------------------------------------
async function bootApp() {
  renderUserHeader()
  if (currentProfile.is_admin) {
    document.getElementById('nav-admin').style.display = 'flex'
  }
  await Promise.all([loadAllData(), loadReleases()])
  showScreen('screen-app')
  switchView('home')
  startClock()
  startRealtimeListeners()
}

function renderUserHeader() {
  const avatar = buildAvatarUrl(currentProfile.discord_id, currentProfile.avatar_url)
  document.getElementById('user-avatar').src = avatar
  document.getElementById('user-name').textContent = currentProfile.username || ''
  document.getElementById('sidebar-version').textContent = 'Resell Tracker Web'
  const heroName = document.getElementById('hero-name-text')
  if (heroName) heroName.textContent = currentProfile.username || 'Dashboard'
}

function buildAvatarUrl(discordId, avatarHash) {
  if (!discordId || !avatarHash) return 'https://cdn.discordapp.com/embed/avatars/0.png'
  if (avatarHash.startsWith('http')) return avatarHash
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatarHash}.png?size=64`
}

// -- Releases ------------------------------------------------------------------
async function loadReleases() {
  try {
    const res = await fetch(`${RELEASES_SERVER}/releases`)
    if (res.ok) releases = await res.json()
  } catch {}
}

function renderReleases() {
  const countEl = document.getElementById('web-releases-count')
  if (countEl) countEl.textContent = releases.length

  // --- Calendar ---
  const grid = document.getElementById('web-cal-grid')
  const monthLabel = document.getElementById('web-cal-month')
  if (!grid || !monthLabel) return

  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`

  monthLabel.textContent = new Date(relCalYear, relCalMonth).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  const firstDay = new Date(relCalYear, relCalMonth, 1).getDay()
  const daysInMonth = new Date(relCalYear, relCalMonth + 1, 0).getDate()

  // Set of dates with releases this month
  const relDates = new Set()
  releases.forEach(r => {
    if (r.date) relDates.add(r.date)
  })

  let cells = ''
  for (let i = 0; i < firstDay; i++) cells += '<div class="web-cal-day web-cal-day-empty"></div>'
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${relCalYear}-${String(relCalMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    const isToday = dateStr === todayStr
    const hasRelease = relDates.has(dateStr)
    const isSelected = dateStr === relSelectedDate
    let cls = 'web-cal-day'
    if (isToday) cls += ' web-cal-day-today'
    if (hasRelease) cls += ' web-cal-day-release'
    if (isSelected) cls += ' web-cal-day-selected'
    const clickable = hasRelease ? ` onclick="selectRelDate('${dateStr}')"` : ''
    cells += `<div class="${cls}"${clickable}>${d}</div>`
  }
  grid.innerHTML = cells

  // --- Release Cards ---
  const list = document.getElementById('web-releases-list')
  const dateHeading = document.getElementById('web-releases-date')
  if (!list || !dateHeading) return

  if (!relSelectedDate) {
    // Default: show next upcoming or today
    const upcoming = releases
      .filter(r => r.date >= todayStr)
      .sort((a, b) => a.date.localeCompare(b.date))
    if (upcoming.length) {
      relSelectedDate = upcoming[0].date
      // Re-highlight
      renderReleases()
      return
    }
  }

  const filtered = relSelectedDate ? releases.filter(r => r.date === relSelectedDate) : []
  if (relSelectedDate) {
    const d = new Date(relSelectedDate + 'T12:00:00')
    dateHeading.textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  } else {
    dateHeading.textContent = 'Select a date'
  }

  if (!filtered.length) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px">No releases for this date.</div>'
    return
  }

  list.innerHTML = filtered.map((r, i) => {
    const timeLocal = r.releaseTime ? convertUTCTimeToLocal(r.releaseTime, r.date) : ''
    const links = (r.link || '').split('\n').filter(Boolean)
    const linksHtml = links.map(l => {
      const isPresale = l.startsWith('[PRESALE] ')
      const url = isPresale ? l.replace('[PRESALE] ', '') : l
      let domain = ''
      try { domain = new URL(url).hostname.replace('www.', '') } catch { domain = url }
      return `<div class="web-release-link-row">
        ${isPresale ? '<span class="web-presale-badge">PRESALE</span>' : ''}
        <a href="#" onclick="event.preventDefault();window.open('${esc(url)}','_blank')" class="web-release-link">${esc(domain)}</a>
      </div>`
    }).join('')

    return `<div class="web-release-compact-item" id="web-rel-${i}">
      <div class="web-release-compact-header" onclick="toggleRelAccordion(${i})">
        <img class="web-release-compact-img" src="${esc(r.imageUrl || '')}" alt="" onerror="this.style.display='none'" />
        <div class="web-release-compact-name">${esc(r.name)}</div>
        <svg class="web-rel-chevron" viewBox="0 0 24 24" width="16" height="16"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </div>
      <div class="web-release-compact-details" id="web-rel-details-${i}">
        <div class="web-rel-info-grid">
          ${timeLocal ? `<div class="web-rel-info-item"><span class="web-rel-info-label">Time</span><span>${esc(timeLocal)}</span></div>` : ''}
          ${r.retailPrice ? `<div class="web-rel-info-item"><span class="web-rel-info-label">Retail</span><span>$${esc(r.retailPrice)}</span></div>` : ''}
          ${r.resalePrice ? `<div class="web-rel-info-item"><span class="web-rel-info-label">Resale</span><span>$${esc(r.resalePrice)}</span></div>` : ''}
        </div>
        ${r.notes ? `<div class="web-rel-notes">${esc(r.notes)}</div>` : ''}
        ${links.length ? `<button class="web-rel-sites-btn" onclick="event.stopPropagation();toggleRelSites(${i})">Site List</button>
          <div class="web-rel-sites-panel" id="web-rel-sites-${i}">${linksHtml}</div>` : ''}
      </div>
    </div>`
  }).join('')
}

function convertUTCTimeToLocal(timeStr, dateStr) {
  try {
    const [h, m] = timeStr.split(':').map(Number)
    const d = new Date(dateStr + 'T00:00:00Z')
    d.setUTCHours(h, m || 0)
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  } catch { return timeStr }
}

function selectRelDate(dateStr) {
  relSelectedDate = dateStr
  // Jump calendar to that month if needed
  const d = new Date(dateStr + 'T12:00:00')
  relCalMonth = d.getMonth()
  relCalYear = d.getFullYear()
  renderReleases()
}

function relCalPrev() {
  relCalMonth--
  if (relCalMonth < 0) { relCalMonth = 11; relCalYear-- }
  renderReleases()
}

function relCalNext() {
  relCalMonth++
  if (relCalMonth > 11) { relCalMonth = 0; relCalYear++ }
  renderReleases()
}

function toggleRelAccordion(i) {
  const el = document.getElementById(`web-rel-details-${i}`)
  if (!el) return
  el.classList.toggle('web-rel-expanded')
  const item = document.getElementById(`web-rel-${i}`)
  if (item) item.classList.toggle('web-rel-open')
}

function toggleRelSites(i) {
  const el = document.getElementById(`web-rel-sites-${i}`)
  if (!el) return
  el.classList.toggle('web-rel-sites-visible')
}

// -- Data Loading --------------------------------------------------------------
async function loadAllData() {
  const uid = adminViewUserId || currentUser.id
  const [invRes, salesRes, pkgRes] = await Promise.all([
    sb.from('inventory').select('*').eq('user_id', uid).order('"createdAt"', { ascending: false }),
    sb.from('sales').select('*').eq('user_id', uid).order('"createdAt"', { ascending: false }),
    sb.from('packages').select('*').eq('user_id', uid).order('"createdAt"', { ascending: false }),
  ])
  inventory = invRes.data  || []
  sales     = salesRes.data || []
  packages  = pkgRes.data  || []
}

function startRealtimeListeners() {
  setInterval(async () => {
    await loadAllData()
    renderInventory()
    renderSales()
    renderPackages()
    renderHome()
  }, 15000)
}

// -- Navigation ----------------------------------------------------------------
function switchView(name) {
  document.querySelectorAll('.view').forEach(v => {
    v.style.display = 'none'
    v.classList.remove('active')
  })
  const view = document.getElementById(`view-${name}`)
  if (view) {
    view.style.display = 'block'
    view.style.animation = 'none'
    view.offsetHeight // force reflow so animation retriggers
    view.style.animation = ''
    view.classList.add('active')
  }

  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.view === name)
  })
  document.querySelectorAll('.bnav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.view === name)
  })

  if      (name === 'drops')     renderReleases()
  else if (name === 'home')      renderHome()
  else if (name === 'inventory') renderInventory()
  else if (name === 'sales')     renderSales()
  else if (name === 'packages')  renderPackages()
  else if (name === 'analytics') renderAnalytics()
  else if (name === 'admin')     renderAdmin()
  else if (name === 'profile')   renderProfile()
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar')
  const collapsed = sidebar.classList.toggle('collapsed')
  localStorage.setItem('rt-sidebar', collapsed ? '1' : '0')
}

// -- Sparkline helpers ---------------------------------------------------------
function getLast6MonthKeys() {
  const keys = []
  const d = new Date()
  for (let i = 5; i >= 0; i--) {
    const t = new Date(d.getFullYear(), d.getMonth() - i, 1)
    keys.push(`${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}`)
  }
  return keys
}

function setSparkline(id, values, color) {
  const el = document.getElementById(id)
  if (!el) return
  if (!values || values.length < 2) { el.innerHTML = ''; return }
  const W = 120, H = 36
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W
    const y = H - 2 - ((v - min) / range) * (H - 4)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const polyPts = pts.join(' ')
  const fill = `0,${H} ${polyPts} ${W},${H}`
  const uid  = id + Math.random().toString(36).slice(2,6)
  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.4"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <polygon points="${fill}" fill="url(#${uid})"/>
      <polyline points="${polyPts}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`
}

// -- Table Sorting -------------------------------------------------------------
let sortState = { inventory: { col: null, dir: null }, sales: { col: null, dir: null } }

function sortTable(table, col) {
  const s = sortState[table]
  if (s.col === col) {
    s.dir = s.dir === 'asc' ? 'desc' : s.dir === 'desc' ? null : 'asc'
  } else {
    s.col = col; s.dir = 'asc'
  }
  if (!s.dir) s.col = null

  // Update sort icons
  document.querySelectorAll(`[id^="sort-${table === 'inventory' ? 'inv' : table}-"]`).forEach(el => { el.className = 'sort-icon' })
  if (s.col && s.dir) {
    const icon = document.getElementById(`sort-${table === 'inventory' ? 'inv' : table}-${col}`)
    if (icon) icon.className = `sort-icon ${s.dir}`
  }

  if (table === 'inventory') renderInventory()
  else renderSales()
}

function applySorting(table, data) {
  const s = sortState[table]
  if (!s.col || !s.dir) return data
  const sorted = [...data]
  const col = s.col
  sorted.sort((a, b) => {
    let va, vb
    if (col === '_profit') {
      va = calcProfit(a); vb = calcProfit(b)
    } else {
      va = a[col]; vb = b[col]
    }
    if (va == null) va = ''
    if (vb == null) vb = ''
    if (typeof va === 'string') { va = va.toLowerCase(); vb = (vb + '').toLowerCase() }
    if (va < vb) return s.dir === 'asc' ? -1 : 1
    if (va > vb) return s.dir === 'asc' ? 1 : -1
    return 0
  })
  return sorted
}

// -- Sales Filters -------------------------------------------------------------
function applySalesFilters(data) {
  const platform = document.getElementById('filter-platform')?.value || ''
  const pl       = document.getElementById('filter-profitloss')?.value || ''
  const from     = document.getElementById('filter-date-from')?.value || ''
  const to       = document.getElementById('filter-date-to')?.value || ''

  let filtered = data
  if (platform) filtered = filtered.filter(s => (s.platform || '').toLowerCase() === platform.toLowerCase())
  if (pl === 'profit') filtered = filtered.filter(s => calcProfit(s) > 0)
  if (pl === 'loss')   filtered = filtered.filter(s => calcProfit(s) < 0)
  if (from) filtered = filtered.filter(s => (s.date || '') >= from)
  if (to)   filtered = filtered.filter(s => (s.date || '') <= to)
  return filtered
}

function clearSalesFilters() {
  document.getElementById('filter-platform').value    = ''
  document.getElementById('filter-profitloss').value  = ''
  document.getElementById('filter-date-from').value   = ''
  document.getElementById('filter-date-to').value     = ''
  renderSales()
}

function populatePlatformFilter() {
  const sel = document.getElementById('filter-platform')
  if (!sel) return
  const current = sel.value
  const platforms = [...new Set(sales.map(s => s.platform).filter(Boolean))].sort()
  sel.innerHTML = '<option value="">All Platforms</option>' +
    platforms.map(p => `<option value="${p}" ${p === current ? 'selected' : ''}>${p}</option>`).join('')
}

// -- CSV Export ----------------------------------------------------------------
function exportCSV(table) {
  let rows = [], headers = []
  if (table === 'inventory') {
    headers = ['Product','Size','Qty','Store','Buy Price','Est. Resell','Notes','Date Added']
    rows = inventory.map(i => [
      i.productName, i.size || '', i.qty || 1, i.store || '',
      i.buyPrice || 0, i.estimatedResell || '', i.notes || '', i.createdAt || ''
    ])
  } else if (table === 'sales') {
    headers = ['Product','Size','Platform','Qty','Buy Price','Sell Price','Fees','Profit','Date']
    rows = sales.map(s => [
      s.productName, s.size || '', s.platform || '', s.qty || 1,
      s.buyPrice || 0, s.sellPrice || 0, s.fees || 0, calcProfit(s).toFixed(2), s.date || ''
    ])
  }
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${table}_${new Date().toISOString().slice(0,10)}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

function setTrend(id, values) {
  const el = document.getElementById(id)
  if (!el || values.length < 2) return
  const prev = values[values.length - 2]
  const curr = values[values.length - 1]
  if (curr === 0 && prev === 0) { el.className = 'stat-trend flat'; el.textContent = '—'; return }
  const pct = prev !== 0 ? ((curr - prev) / Math.abs(prev) * 100) : 100
  if (pct > 1)       { el.className = 'stat-trend up';   el.textContent = `↑ ${pct.toFixed(0)}%` }
  else if (pct < -1) { el.className = 'stat-trend down'; el.textContent = `↓ ${Math.abs(pct).toFixed(0)}%` }
  else               { el.className = 'stat-trend flat'; el.textContent = '—' }
}

// -- HOME ----------------------------------------------------------------------
function renderHome() {
  // Hero section
  const now  = new Date()
  const hour = now.getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const name = currentProfile?.username || ''
  const el = document.getElementById('hero-greeting')
  if (el) {
    const full = name ? `${greeting}, ${name}` : greeting
    if (!greetingTyped) { greetingTyped = true; typewrite(el, full) }
    else el.textContent = full
  }
  const dateEl = document.getElementById('hero-date')
  if (dateEl) dateEl.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  const timeEl = document.getElementById('hero-time')
  if (timeEl) timeEl.textContent = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

  const invValue  = inventory.reduce((s, i) => s + (i.buyPrice || 0) * (i.qty || 1), 0)
  const spent     = sales.reduce((s, s2) => s + (s2.buyPrice || 0) * (s2.qty || 1), 0)
  const revenue   = sales.reduce((s, s2) => s + (s2.sellPrice || 0) * (s2.qty || 1), 0)
  const fees      = sales.reduce((s, s2) => s + (s2.fees || 0), 0)
  const profit    = revenue - spent - fees
  const sold      = sales.reduce((s, s2) => s + (s2.qty || 1), 0)
  const roi       = spent > 0 ? (profit / spent * 100) : 0

  animateCounter('stat-inv-value', invValue,  true,  false, 2)
  animateCounter('stat-profit',   profit,     true,  false, 2)
  animateCounter('stat-sold',     sold,       false, false, 0)
  animateCounter('stat-roi',      roi,        false, true,  1)
  document.getElementById('stat-inv-count').textContent  = `${inventory.length} item${inventory.length !== 1 ? 's' : ''}`
  document.getElementById('stat-profit-sub').textContent = `${sales.length} sale${sales.length !== 1 ? 's' : ''}`
  document.getElementById('stat-sold-sub').textContent   = `units across ${sales.length} sale${sales.length !== 1 ? 's' : ''}`

  // Sparklines + trends (last 6 months)
  const monthly = getLast6MonthKeys()
  const monthlyProfit = monthly.map(m => {
    const ms = sales.filter(s => (s.createdAt || s.date || '').slice(0,7) === m)
    return ms.reduce((a,s) => a + calcProfit(s), 0)
  })
  const monthlySold = monthly.map(m =>
    sales.filter(s => (s.createdAt || s.date || '').slice(0,7) === m)
         .reduce((a,s) => a + (s.qty || 1), 0)
  )
  const monthlyROI = monthly.map(m => {
    const ms = sales.filter(s => (s.createdAt || s.date || '').slice(0,7) === m)
    const sp = ms.reduce((a,s) => a + (s.buyPrice||0)*(s.qty||1), 0)
    const pr = ms.reduce((a,s) => a + calcProfit(s), 0)
    return sp > 0 ? (pr/sp*100) : 0
  })

  const invCounts = monthly.map(m =>
    inventory.filter(i => (i.createdAt||'').slice(0,7) <= m).length
  )

  setSparkline('spark-inv',    invCounts,    '#818cf8')
  setSparkline('spark-profit', monthlyProfit,'#10b981')
  setSparkline('spark-sold',   monthlySold,  '#f59e0b')
  setSparkline('spark-roi',    monthlyROI,   '#06b6d4')

  setTrend('trend-inv',    invCounts)
  setTrend('trend-profit', monthlyProfit)
  setTrend('trend-sold',   monthlySold)
  setTrend('trend-roi',    monthlyROI)

  // Animate ROI ring
  const roiPath = document.getElementById('roi-ring-path')
  if (roiPath) {
    const pct = Math.min(Math.max(roi, 0), 150) / 150
    roiPath.style.strokeDashoffset = (175.9 * (1 - pct)).toFixed(2)
  }

  // Recent inventory
  const recentInv = document.getElementById('home-recent-inv')
  if (!inventory.length) {
    recentInv.innerHTML = `<div class="recent-item"><span class="cell-muted">No items yet.</span></div>`
  } else {
    recentInv.innerHTML = inventory.slice(0, 5).map(i => `
      <div class="recent-item">
        ${i.photo ? `<img src="${esc(i.photo)}" class="inv-thumb" style="width:32px;height:32px" />` : `<div class="thumb-placeholder" style="width:32px;height:32px;font-size:14px">📦</div>`}
        <span class="recent-name">${esc(i.productName)}${i.size ? ` <span class="cell-dim">· ${esc(i.size)}</span>` : ''}</span>
        <span class="recent-meta">${esc(i.store || '—')}</span>
        <span class="recent-val">${fmt(i.buyPrice)}</span>
      </div>`).join('')
  }

  // Recent sales
  const recentSales = document.getElementById('home-recent-sales')
  if (!sales.length) {
    recentSales.innerHTML = `<div class="recent-item"><span class="cell-muted">No sales yet.</span></div>`
  } else {
    recentSales.innerHTML = sales.slice(0, 5).map(s => {
      const p = calcProfit(s)
      return `
        <div class="recent-item">
          <span class="recent-name">${esc(s.productName)}${s.size ? ` <span class="cell-dim">· ${esc(s.size)}</span>` : ''}</span>
          <span class="recent-meta">${esc(s.platform || '—')}</span>
          <span class="recent-val ${p > 0 ? 'profit-pos' : p < 0 ? 'profit-neg' : 'profit-zero'}">${fmt(p)}</span>
        </div>`
    }).join('')
  }

  // Mini monthly chart on home
  const homeCtx = document.getElementById('chart-home-monthly')
  if (homeCtx) {
    const yr = new Date().getFullYear()
    const labels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const yrSales = sales.filter(s => {
      const d = s.date || s.createdAt || ''
      return d && new Date(d).getFullYear() === yr
    })
    const mSpent = Array.from({ length: 12 }, (_, m) =>
      yrSales.filter(s => new Date(s.date || s.createdAt).getMonth() === m)
             .reduce((a, s) => a + (s.buyPrice || 0) * (s.qty || 1), 0))
    const mRevenue = Array.from({ length: 12 }, (_, m) =>
      yrSales.filter(s => new Date(s.date || s.createdAt).getMonth() === m)
             .reduce((a, s) => a + (s.sellPrice || 0) * (s.qty || 1), 0))
    const mProfit = Array.from({ length: 12 }, (_, m) => {
      const ms = yrSales.filter(s => new Date(s.date || s.createdAt).getMonth() === m)
      return ms.reduce((a, s) => a + calcProfit(s), 0)
    })

    if (chartHomeMini) chartHomeMini.destroy()
    chartHomeMini = new Chart(homeCtx.getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Spent',
            data: mSpent,
            backgroundColor: 'rgba(244,63,94,0.35)',
            borderColor: '#f43f5e',
            borderWidth: 1.5,
            borderRadius: 6,
          },
          {
            label: 'Revenue',
            data: mRevenue,
            backgroundColor: 'rgba(99,102,241,0.35)',
            borderColor: '#6366f1',
            borderWidth: 1.5,
            borderRadius: 6,
          },
          {
            label: 'Profit',
            data: mProfit,
            backgroundColor: 'rgba(16,185,129,0.35)',
            borderColor: '#10b981',
            borderWidth: 1.5,
            borderRadius: 6,
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: { labels: { color: '#6060a0', font: { size: 11, weight: '600', family: 'Inter' } } }
        },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#6060a0', font: { size: 10 } } },
          y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#6060a0', font: { size: 10 }, callback: v => `$${v}` } }
        }
      }
    })
  }
}

// -- INVENTORY -----------------------------------------------------------------
function renderInventory() {
  const q    = (document.getElementById('inv-search')?.value || '').toLowerCase()
  let data = q
    ? inventory.filter(i => [i.productName, i.store, i.size].join(' ').toLowerCase().includes(q))
    : [...inventory]
  data = applySorting('inventory', data)

  document.getElementById('inv-count').textContent = `${inventory.length} Total`

  const tbody = document.getElementById('inv-tbody')
  const empty = document.getElementById('inv-empty')

  if (!data.length) {
    tbody.innerHTML = ''
    empty.style.display = 'flex'
    return
  }

  empty.style.display = 'none'
  tbody.innerHTML = data.map(i => {
    const thumb = i.photo
      ? `<img src="${esc(i.photo)}" class="inv-thumb" onclick="openLightbox('${esc(i.photo)}')" />`
      : `<div class="thumb-placeholder">📦</div>`
    return `
      <tr>
        <td>${thumb}</td>
        <td><strong>${esc(i.productName)}</strong></td>
        <td class="hide-sm cell-muted">${esc(i.size || '—')}</td>
        <td class="hide-sm cell-muted">${i.qty || 1}</td>
        <td class="hide-sm cell-muted">${esc(i.store || '—')}</td>
        <td><strong>${fmt(i.buyPrice)}</strong></td>
        <td class="hide-sm cell-muted">${i.estimatedResell ? fmt(i.estimatedResell) : '—'}</td>
        <td>
          <div style="display:flex;gap:4px;justify-content:flex-end">
            <button class="btn-icon" title="Edit" onclick="openInvModal(${JSON.stringify(i).replace(/"/g,'&quot;')})">✏️</button>
            <button class="btn-icon" title="Mark Sold" onclick="markSold(${JSON.stringify(i).replace(/"/g,'&quot;')})">💰</button>
            <button class="btn-icon danger" title="Delete" onclick="confirmDelete('inventory','${i.id}','${esc(i.productName)}')">🗑️</button>
          </div>
        </td>
      </tr>`
  }).join('')
}

function openInvModal(item) {
  editId         = item?.id ?? null
  editCollection = 'inv'
  pendingPhoto   = null

  document.getElementById('modal-inv-title').textContent = item ? 'Edit Item' : 'Add Item'
  document.getElementById('i-product').value  = item?.productName     ?? ''
  document.getElementById('i-size').value     = item?.size            ?? ''
  document.getElementById('i-qty').value      = item?.qty             ?? 1
  document.getElementById('i-store').value    = item?.store           ?? ''
  document.getElementById('i-buy').value      = item?.buyPrice        ?? ''
  document.getElementById('i-resell').value   = item?.estimatedResell ?? ''
  document.getElementById('i-notes').value    = item?.notes           ?? ''

  const preview  = document.getElementById('inv-photo-preview')
  const zone     = document.getElementById('inv-photo-zone')
  const photoUrl = item?.photo ?? null
  if (photoUrl) {
    preview.src          = photoUrl
    preview.style.display = 'block'
    zone.classList.add('has-photo')
  } else {
    preview.src           = ''
    preview.style.display = 'none'
    zone.classList.remove('has-photo')
  }
  document.getElementById('inv-photo-input').value = ''

  openModal('modal-inv')
  setTimeout(() => document.getElementById('i-product').focus(), 100)
}

async function saveInv() {
  if (_saving) return; _saving = true
  try { await _saveInv() } finally { _saving = false }
}
async function _saveInv() {
  const name = document.getElementById('i-product').value.trim()
  const buy  = document.getElementById('i-buy').value.trim()
  if (!name) { document.getElementById('i-product').focus(); return }
  if (!buy)  { document.getElementById('i-buy').focus(); return }

  const btn = document.querySelector('#modal-inv .btn-primary')
  btn.disabled = true

  try {
    let photoUrl = document.getElementById('inv-photo-preview').src || null
    if (photoUrl && photoUrl.startsWith('blob:')) photoUrl = null
    if (pendingPhoto) {
      photoUrl = await uploadPhoto(pendingPhoto)
    }

    const payload = {
      productName:     name,
      size:            document.getElementById('i-size').value.trim()   || null,
      qty:             parseInt(document.getElementById('i-qty').value)  || 1,
      store:           document.getElementById('i-store').value.trim()  || null,
      buyPrice:        parseFloat(buy) || 0,
      estimatedResell: document.getElementById('i-resell').value !== ''  ? parseFloat(document.getElementById('i-resell').value) : null,
      notes:           document.getElementById('i-notes').value.trim()  || null,
      photo:           photoUrl,
      updatedAt:       new Date().toISOString(),
    }

    if (editId) {
      const { error } = await sb.from('inventory').update({ ...payload, user_id: currentUser.id }).eq('id', editId)
      if (error) { console.error('inventory update error:', JSON.stringify(error), 'user:', currentUser?.id, 'editId:', editId); throw error }
      const idx = inventory.findIndex(i => i.id === editId)
      if (idx !== -1) inventory[idx] = { ...inventory[idx], ...payload }
    } else {
      payload.user_id   = currentUser.id
      payload.source    = 'web'
      payload.createdAt = new Date().toISOString()
      const { data, error } = await sb.from('inventory').insert(payload).select().single()
      if (error) throw error
      inventory.unshift(data)
    }

    closeModal('modal-inv')
    renderInventory()
    renderHome()
    showToast('success', editId ? 'Item updated' : 'Item added', name)
  } catch (e) {
    showToast('error', 'Save failed', e.message)
  } finally {
    btn.disabled = false
  }
}

function markSold(item) {
  openSaleModal(null)
  document.getElementById('s-product').value = item.productName
  document.getElementById('s-size').value    = item.size || ''
  document.getElementById('s-buy').value     = item.buyPrice || ''
  document.getElementById('s-qty').value     = item.qty || 1
}

// -- SALES ---------------------------------------------------------------------
function renderSales() {
  populatePlatformFilter()
  const q    = (document.getElementById('sales-search')?.value || '').toLowerCase()
  let data = q
    ? sales.filter(s => [s.productName, s.platform, s.size].join(' ').toLowerCase().includes(q))
    : [...sales]
  data = applySalesFilters(data)
  data = applySorting('sales', data)

  document.getElementById('sales-count').textContent = `${data.length}${data.length !== sales.length ? ` / ${sales.length}` : ''} Total`

  const spent   = data.reduce((a, s) => a + (s.buyPrice  || 0) * (s.qty || 1), 0)
  const revenue = data.reduce((a, s) => a + (s.sellPrice || 0) * (s.qty || 1), 0)
  const fees    = data.reduce((a, s) => a + (s.fees      || 0), 0)
  const profit  = revenue - spent - fees

  document.getElementById('ss-spent').textContent   = fmt(spent)
  document.getElementById('ss-revenue').textContent = fmt(revenue)
  document.getElementById('ss-fees').textContent    = fmt(fees)
  const profitEl = document.getElementById('ss-profit')
  profitEl.textContent  = fmt(profit)
  profitEl.className    = `mini-val ${profit > 0 ? 'profit-pos' : profit < 0 ? 'profit-neg' : 'profit-zero'}`

  const tbody = document.getElementById('sales-tbody')
  const empty = document.getElementById('sales-empty')

  if (!data.length) {
    tbody.innerHTML = ''
    empty.style.display = 'flex'
    return
  }

  empty.style.display = 'none'
  tbody.innerHTML = data.map(s => {
    const p = calcProfit(s)
    const meta = PLATFORM_META[(s.platform || '').toLowerCase()]
    const chip = s.platform
      ? `<span class="platform-chip" style="${meta ? `background:${meta.bg};color:${meta.text}` : 'background:var(--surface2);color:var(--text-muted)'}">${esc(s.platform)}</span>`
      : '—'
    return `
      <tr>
        <td><strong>${esc(s.productName)}</strong></td>
        <td class="hide-sm cell-muted">${esc(s.size || '—')}</td>
        <td class="hide-sm">${chip}</td>
        <td class="cell-muted">${fmt(s.buyPrice)}</td>
        <td><strong>${fmt(s.sellPrice)}</strong></td>
        <td class="hide-sm cell-muted">${fmt(s.fees)}</td>
        <td class="${p > 0 ? 'profit-pos' : p < 0 ? 'profit-neg' : 'profit-zero'}">${fmt(p)}</td>
        <td class="hide-sm cell-dim">${s.date ? new Date(s.date).toLocaleDateString() : '—'}</td>
        <td>
          <div style="display:flex;gap:4px;justify-content:flex-end">
            <button class="btn-icon" onclick="openSaleModal(${JSON.stringify(s).replace(/"/g,'&quot;')})">✏️</button>
            <button class="btn-icon danger" onclick="confirmDelete('sales','${s.id}','${esc(s.productName)}')">🗑️</button>
          </div>
        </td>
      </tr>`
  }).join('')
}

function openSaleModal(item) {
  editId         = item?.id ?? null
  editCollection = 'sale'
  document.getElementById('modal-sale-title').textContent = item ? 'Edit Sale' : 'Add Sale'
  document.getElementById('s-product').value  = item?.productName ?? ''
  document.getElementById('s-size').value     = item?.size        ?? ''
  document.getElementById('s-platform').value = item?.platform    ?? ''
  document.getElementById('s-qty').value      = item?.qty         ?? 1
  document.getElementById('s-buy').value      = item?.buyPrice    ?? ''
  document.getElementById('s-sell').value     = item?.sellPrice   ?? ''
  document.getElementById('s-fees').value     = item?.fees        ?? ''
  document.getElementById('s-date').value     = item?.date        ?? today()
  openModal('modal-sale')
  setTimeout(() => document.getElementById('s-product').focus(), 100)
}

async function saveSale() {
  if (_saving) return; _saving = true
  try { await _saveSale() } finally { _saving = false }
}
async function _saveSale() {
  const name = document.getElementById('s-product').value.trim()
  const sell = document.getElementById('s-sell').value.trim()
  if (!name) { document.getElementById('s-product').focus(); return }
  if (!sell) { document.getElementById('s-sell').focus(); return }

  const btn = document.querySelector('#modal-sale .btn-primary')
  btn.disabled = true

  try {
    const payload = {
      productName: name,
      size:        document.getElementById('s-size').value.trim()     || null,
      platform:    document.getElementById('s-platform').value.trim() || null,
      qty:         parseInt(document.getElementById('s-qty').value)   || 1,
      buyPrice:    parseFloat(document.getElementById('s-buy').value) || 0,
      sellPrice:   parseFloat(sell) || 0,
      fees:        parseFloat(document.getElementById('s-fees').value) || 0,
      date:        document.getElementById('s-date').value || today(),
    }

    if (editId) {
      const { error } = await sb.from('sales').update({ ...payload, user_id: currentUser.id }).eq('id', editId)
      if (error) throw error
      const idx = sales.findIndex(s => s.id === editId)
      if (idx !== -1) sales[idx] = { ...sales[idx], ...payload }
    } else {
      payload.user_id   = currentUser.id
      payload.createdAt = new Date().toISOString()
      const { data, error } = await sb.from('sales').insert(payload).select().single()
      if (error) throw error
      sales.unshift(data)
    }

    closeModal('modal-sale')
    renderSales()
    renderHome()
    showToast('success', editId ? 'Sale updated' : 'Sale recorded', name)
  } catch (e) {
    showToast('error', 'Save failed', e.message)
  } finally {
    btn.disabled = false
  }
}

// -- PACKAGES ------------------------------------------------------------------
function renderPackages() {
  document.getElementById('pkg-count').textContent = `${packages.length} Total`

  const list  = document.getElementById('pkg-list')
  const empty = document.getElementById('pkg-empty')

  if (!packages.length) {
    list.innerHTML     = ''
    empty.style.display = 'flex'
    return
  }

  empty.style.display = 'none'

  const statusClass = {
    'Ordered':          'pkg-status-ordered',
    'Shipped':          'pkg-status-shipped',
    'In Transit':       'pkg-status-transit',
    'Out for Delivery': 'pkg-status-delivery',
    'Delivered':        'pkg-status-delivered',
  }

  list.innerHTML = packages.map(p => `
    <div class="pkg-card">
      <div class="pkg-header">
        <div>
          <div class="pkg-name">${esc(p.nickname || p.trackingNumber)}</div>
          ${p.nickname ? `<div class="pkg-tracking">${esc(p.trackingNumber)}</div>` : ''}
        </div>
        <span class="pkg-status ${statusClass[p.status] || 'pkg-status-ordered'}">${esc(p.status || 'Ordered')}</span>
      </div>
      <div class="pkg-footer">
        <span>${p.carrier || 'Unknown carrier'}${p.deliveryDate ? ` · Est. ${new Date(p.deliveryDate).toLocaleDateString()}` : ''}</span>
        <div class="pkg-actions">
          <button class="btn-icon" onclick="openCarrierSite('${esc(p.trackingNumber)}','${esc(p.carrier || '')}')" title="Track on carrier site">🔗</button>
          <button class="btn-icon" onclick="openPkgModal(${JSON.stringify(p).replace(/"/g,'&quot;')})">✏️</button>
          <button class="btn-icon danger" onclick="confirmDelete('packages','${p.id}','${esc(p.nickname || p.trackingNumber)}')">🗑️</button>
        </div>
      </div>
    </div>`).join('')
}

function openPkgModal(item) {
  editId         = item?.id ?? null
  editCollection = 'pkg'
  document.getElementById('modal-pkg-title').textContent = item ? 'Edit Package' : 'Add Package'
  document.getElementById('p-tracking').value  = item?.trackingNumber ?? ''
  document.getElementById('p-nickname').value  = item?.nickname       ?? ''
  document.getElementById('p-carrier').value   = item?.carrier        ?? ''
  document.getElementById('p-status').value    = item?.status         ?? 'Ordered'
  document.getElementById('p-delivery').value  = item?.deliveryDate   ?? ''
  openModal('modal-pkg')
  setTimeout(() => document.getElementById('p-tracking').focus(), 100)
}

async function savePkg() {
  if (_saving) return; _saving = true
  try { await _savePkg() } finally { _saving = false }
}
async function _savePkg() {
  const tracking = document.getElementById('p-tracking').value.trim()
  if (!tracking) { document.getElementById('p-tracking').focus(); return }

  const btn = document.querySelector('#modal-pkg .btn-primary')
  btn.disabled = true

  try {
    const payload = {
      trackingNumber: tracking,
      nickname:       document.getElementById('p-nickname').value.trim() || null,
      carrier:        document.getElementById('p-carrier').value         || null,
      status:         document.getElementById('p-status').value          || 'Ordered',
      deliveryDate:   document.getElementById('p-delivery').value        || null,
    }

    if (editId) {
      const { error } = await sb.from('packages').update({ ...payload, user_id: currentUser.id }).eq('id', editId)
      if (error) throw error
      const idx = packages.findIndex(p => p.id === editId)
      if (idx !== -1) packages[idx] = { ...packages[idx], ...payload }
    } else {
      payload.user_id   = currentUser.id
      payload.createdAt = new Date().toISOString()
      const { data, error } = await sb.from('packages').insert(payload).select().single()
      if (error) throw error
      packages.unshift(data)
    }

    closeModal('modal-pkg')
    renderPackages()
    showToast('success', editId ? 'Package updated' : 'Package added', payload.nickname || tracking)
  } catch (e) {
    showToast('error', 'Save failed', e.message)
  } finally {
    btn.disabled = false
  }
}

// -- Carrier tracking URLs -----------------------------------------------------
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

function openCarrierSite(trackingNumber, carrier) {
  window.open(carrierTrackingUrl(trackingNumber, carrier), '_blank')
}

// -- DELETE --------------------------------------------------------------------
function confirmDelete(table, id, name) {
  document.getElementById('modal-delete-msg').textContent =
    `Are you sure you want to delete "${name}"? This cannot be undone.`
  openModal('modal-delete')
  document.getElementById('btn-confirm-delete').onclick = () => doDelete(table, id)
}

async function doDelete(table, id) {
  if (_saving) return; _saving = true
  try { await _doDelete(table, id) } finally { _saving = false }
}
async function _doDelete(table, id) {
  const { error } = await sb.from(table).delete().eq('id', id).eq('user_id', currentUser.id)
  if (error) { showToast('error', 'Delete failed', error.message); return }

  if (table === 'inventory') inventory = inventory.filter(i => i.id !== id)
  if (table === 'sales')     sales     = sales.filter(s => s.id !== id)
  if (table === 'packages')  packages  = packages.filter(p => p.id !== id)

  closeModal('modal-delete')
  renderHome()
  if (table === 'inventory') renderInventory()
  if (table === 'sales')     renderSales()
  if (table === 'packages')  renderPackages()
  showToast('success', 'Deleted', 'Item removed.')
}

// -- ANALYTICS -----------------------------------------------------------------
function renderAnalytics() {
  document.getElementById('year-label').textContent = analyticsYear

  const months    = Array.from({ length: 12 }, (_, i) => i)
  const labels    = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const yearSales = sales.filter(s => s.date && new Date(s.date).getFullYear() === analyticsYear)

  const spent   = months.map(m => yearSales.filter(s => new Date(s.date).getMonth() === m).reduce((a, s) => a + (s.buyPrice  || 0) * (s.qty || 1), 0))
  const revenue = months.map(m => yearSales.filter(s => new Date(s.date).getMonth() === m).reduce((a, s) => a + (s.sellPrice || 0) * (s.qty || 1), 0))
  const profit  = months.map((_, i) => revenue[i] - spent[i] - yearSales.filter(s => new Date(s.date).getMonth() === i).reduce((a, s) => a + (s.fees || 0), 0))

  const gridC = 'rgba(255,255,255,0.06)'
  const textC = '#7878a0'

  // Monthly chart
  if (chartMonthly) chartMonthly.destroy()
  const ctxM = document.getElementById('chart-monthly').getContext('2d')
  chartMonthly = new Chart(ctxM, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Spent',   data: spent,   backgroundColor: 'rgba(244,63,94,0.4)',   borderColor: '#f43f5e', borderWidth: 1.5, borderRadius: 6 },
        { label: 'Revenue', data: revenue, backgroundColor: 'rgba(245,158,11,0.4)', borderColor: '#f59e0b', borderWidth: 1.5, borderRadius: 6 },
        { label: 'Profit',  data: profit,  backgroundColor: 'rgba(16,185,129,0.4)', borderColor: '#10b981', borderWidth: 1.5, borderRadius: 6 },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: { legend: { labels: { color: textC, font: { size: 12, weight: '600' } } } },
      scales: {
        x: { grid: { color: gridC }, ticks: { color: textC, font: { size: 11 } } },
        y: { grid: { color: gridC }, ticks: { color: textC, font: { size: 11 }, callback: v => `$${v}` } }
      }
    }
  })

  // Platform doughnut
  const platMap = {}
  yearSales.forEach(s => {
    const p = s.platform || 'Other'
    platMap[p] = (platMap[p] || 0) + calcProfit(s)
  })
  const platLabels = Object.keys(platMap)
  const platData   = Object.values(platMap)

  const empty = document.getElementById('chart-platform-empty')
  if (!platLabels.length) {
    empty.style.display = 'flex'
    document.getElementById('chart-platform').style.display = 'none'
  } else {
    empty.style.display = 'none'
    document.getElementById('chart-platform').style.display = 'block'
    if (chartPlatform) chartPlatform.destroy()
    const ctxP = document.getElementById('chart-platform').getContext('2d')
    const colors = platLabels.map((l, i) => {
      const m = PLATFORM_META[l.toLowerCase()]
      return m ? m.bg : `hsl(${(i * 47) % 360},65%,55%)`
    })
    chartPlatform = new Chart(ctxP, {
      type: 'doughnut',
      data: {
        labels: platLabels,
        datasets: [{ data: platData, backgroundColor: colors, borderWidth: 2, borderColor: '#111118' }]
      },
      options: {
        responsive: true,
        cutout: '60%',
        plugins: {
          legend: { position: 'bottom', labels: { color: textC, font: { size: 12 }, padding: 12 } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${fmt(ctx.raw)}` } }
        }
      }
    })
  }
}

function changeYear(delta) {
  analyticsYear += delta
  renderAnalytics()
}

// -- ADMIN ---------------------------------------------------------------------
async function renderAdmin() {
  if (!currentProfile?.is_admin) { showToast('error', 'Access denied', 'Admin only'); return }
  const tbody = document.getElementById('admin-users-tbody')
  tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px"><div class="spinner"></div></td></tr>`

  const { data: users, error } = await sb.from('profiles').select('*').order('created_at', { ascending: false })
  if (error) { tbody.innerHTML = `<tr><td colspan="5" class="cell-muted">Failed to load users.</td></tr>`; return }

  tbody.innerHTML = users.map(u => {
    const avatar = buildAvatarUrl(u.discord_id, u.avatar_url)
    let statusBadge = ''
    if (u.is_admin)    statusBadge += `<span class="status-badge badge-admin">Admin</span> `
    if (u.is_approved) statusBadge += `<span class="status-badge badge-approved">Approved</span>`
    else               statusBadge += `<span class="status-badge badge-pending">Pending</span>`

    const isSelf = u.id === currentUser.id
    return `
      <tr>
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            <img src="${esc(avatar)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover" />
            <strong>${esc(u.username || 'Unknown')}</strong>
          </div>
        </td>
        <td class="cell-dim">${esc(u.discord_id || '—')}</td>
        <td class="cell-dim">${u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
        <td>${statusBadge}</td>
        <td>
          <div style="display:flex;gap:6px;align-items:center">
            ${!isSelf ? `
              <button class="btn-icon" title="${u.is_approved ? 'Revoke' : 'Approve'}"
                onclick="toggleApproval('${u.id}', ${!u.is_approved})">
                ${u.is_approved ? '🚫' : '✅'}
              </button>
              <button class="btn-icon" title="View Data" onclick="viewClientData('${u.id}','${esc(u.username || 'Unknown')}')">👁️</button>
            ` : '<span class="cell-dim">You</span>'}
          </div>
        </td>
      </tr>`
  }).join('')
}

async function toggleApproval(userId, approve) {
  if (!currentProfile?.is_admin) { showToast('error', 'Access denied', 'Admin only'); return }
  const { error } = await sb.from('profiles').update({ is_approved: approve }).eq('id', userId)
  if (error) { showToast('error', 'Failed', error.message); return }
  showToast('success', approve ? 'User approved' : 'Access revoked', '')
  renderAdmin()
}

async function viewClientData(userId, username) {
  if (!currentProfile?.is_admin) { showToast('error', 'Access denied', 'Admin only'); return }
  adminViewUserId = userId
  document.getElementById('admin-viewing-name').textContent = username
  document.getElementById('admin-viewing-banner').style.display = 'block'
  document.getElementById('btn-back-admin').style.display = 'inline-flex'
  await loadAllData()
  switchView('inventory')
}

async function resetAdminView() {
  adminViewUserId = null
  document.getElementById('admin-viewing-banner').style.display = 'none'
  document.getElementById('btn-back-admin').style.display = 'none'
  await loadAllData()
  switchView('admin')
}

// -- PROFILE / SETTINGS --------------------------------------------------------
function renderProfile() {
  const avatar = buildAvatarUrl(currentProfile.discord_id, currentProfile.avatar_url)
  document.getElementById('profile-avatar').src = avatar
  document.getElementById('profile-username').textContent = currentProfile.username || 'Unknown'
  document.getElementById('profile-discord-id').textContent = currentProfile.discord_id ? `Discord ID: ${currentProfile.discord_id}` : ''
  document.getElementById('profile-joined').textContent = currentProfile.created_at ? `Joined ${new Date(currentProfile.created_at).toLocaleDateString()}` : ''
  document.getElementById('set-username').value = currentProfile.username || ''
  document.getElementById('set-dark-mode').checked = document.documentElement.getAttribute('data-theme') !== 'light'
  const obKey = `onboarded_${currentUser.id}`
  document.getElementById('set-replay-onboarding').checked = !localStorage.getItem(obKey)
}

async function saveUsername() {
  const name = document.getElementById('set-username').value.trim()
  if (!name) return
  const { error } = await sb.from('profiles').update({ username: name }).eq('id', currentUser.id)
  if (error) { showToast('error', 'Save failed', error.message); return }
  currentProfile.username = name
  renderUserHeader()
  document.getElementById('profile-username').textContent = name
  showToast('success', 'Saved', 'Display name updated')
}

function toggleReplayOnboarding() {
  const obKey = `onboarded_${currentUser.id}`
  if (document.getElementById('set-replay-onboarding').checked) {
    localStorage.removeItem(obKey)
  } else {
    localStorage.setItem(obKey, '1')
  }
}

// -- ONBOARDING ----------------------------------------------------------------
let obStep = 0
const OB_TOTAL = 6

function nextOnboardingStep() {
  obStep++
  if (obStep >= OB_TOTAL) { closeOnboarding(); return }
  showOnboardingStep()
}

function showOnboardingStep() {
  document.querySelectorAll('.onboarding-step').forEach(el => {
    el.style.display = el.dataset.step == obStep ? 'flex' : 'none'
  })
  document.querySelectorAll('.ob-dot').forEach(el => {
    el.classList.toggle('active', el.dataset.dot == obStep)
  })
  const nextBtn = document.getElementById('ob-next')
  nextBtn.textContent = obStep === OB_TOTAL - 1 ? "Let's Go!" : 'Next'
  const skipBtn = document.getElementById('ob-skip')
  skipBtn.style.display = obStep === OB_TOTAL - 1 ? 'none' : ''
}

function closeOnboarding() {
  const overlay = document.getElementById('onboarding-overlay')
  overlay.style.opacity = '0'
  setTimeout(() => { overlay.style.display = 'none'; overlay.style.opacity = ''; }, 300)
  if (currentUser) localStorage.setItem(`onboarded_${currentUser.id}`, '1')
  obStep = 0
}

// -- PHOTO ---------------------------------------------------------------------
function setupPhotoZone() {
  const input   = document.getElementById('inv-photo-input')
  const preview = document.getElementById('inv-photo-preview')
  const zone    = document.getElementById('inv-photo-zone')

  input.addEventListener('change', e => {
    const file = e.target.files[0]
    if (!file) return
    pendingPhoto = file
    const reader = new FileReader()
    reader.onload = ev => {
      preview.src           = ev.target.result
      preview.style.display = 'block'
      zone.classList.add('has-photo')
    }
    reader.readAsDataURL(file)
  })
}

function removeInvPhoto(e) {
  e.stopPropagation()
  e.preventDefault()
  pendingPhoto  = null
  const preview = document.getElementById('inv-photo-preview')
  preview.src           = ''
  preview.style.display = 'none'
  document.getElementById('inv-photo-zone').classList.remove('has-photo')
  document.getElementById('inv-photo-input').value = ''
}

function compressImage(file, maxWidth = 900, quality = 0.82) {
  return new Promise(resolve => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale  = Math.min(1, maxWidth / img.width)
      const canvas = document.createElement('canvas')
      canvas.width  = Math.round(img.width  * scale)
      canvas.height = Math.round(img.height * scale)
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      canvas.toBlob(resolve, 'image/jpeg', quality)
    }
    img.src = url
  })
}

async function uploadPhoto(file) {
  const compressed = await compressImage(file)
  const name = `${currentUser.id}/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`
  const { error } = await sb.storage.from(PHOTO_BUCKET).upload(name, compressed, { contentType: 'image/jpeg' })
  if (error) throw error
  const { data: { publicUrl } } = sb.storage.from(PHOTO_BUCKET).getPublicUrl(name)
  return publicUrl
}

// -- MODALS --------------------------------------------------------------------
function openModal(id) {
  document.getElementById(id).style.display = 'flex'
  document.body.style.overflow = 'hidden'
}

function closeModal(id) {
  document.getElementById(id).style.display = 'none'
  document.body.style.overflow = ''
  pendingPhoto = null
}

function modalOverlayClick(e, id) {
  if (e.target.id === id) closeModal(id)
}

function setupKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      ['modal-inv','modal-sale','modal-pkg','modal-delete'].forEach(id => {
        if (document.getElementById(id).style.display !== 'none') closeModal(id)
      })
    }
  })
}

// -- TOAST ---------------------------------------------------------------------
let toastTimer = null
function showToast(type, title, msg) {
  const toast = document.getElementById('toast')
  toast.className = `toast ${type}`
  document.getElementById('toast-title').textContent = title
  document.getElementById('toast-msg').textContent   = msg || ''
  const icon = document.getElementById('toast-icon')
  icon.innerHTML = type === 'success'
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
  toast.classList.remove('show')
  void toast.offsetWidth
  toast.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500)
}

// -- LIGHTBOX ------------------------------------------------------------------
function openLightbox(src) {
  const lb = document.createElement('div')
  lb.className = 'lightbox'
  lb.innerHTML = `<img src="${esc(src)}" />`
  lb.onclick   = () => lb.remove()
  document.body.appendChild(lb)
}

// -- SCREEN MANAGEMENT ---------------------------------------------------------
function showScreen(id) {
  const loading = document.getElementById('screen-loading')
  if (loading) loading.style.display = 'none';
  ['screen-login','screen-pending','screen-app'].forEach(s => {
    const el = document.getElementById(s)
    if (el) el.style.display = s === id ? (s === 'screen-app' ? 'flex' : 'flex') : 'none'
  })
  // screen-app uses flex column layout
  if (id === 'screen-app') {
    const app = document.getElementById('screen-app')
    app.style.display = 'flex'
    app.style.flexDirection = 'column'
  }
}

// -- THEME ---------------------------------------------------------------------
function applyTheme() {
  document.documentElement.setAttribute('data-theme', 'dark')
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme')
  const next    = current === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', next)
  localStorage.setItem('rt-theme', next)
  updateThemeIcon()
  // Re-render analytics charts with new colors
  if (document.getElementById('view-analytics').classList.contains('active')) {
    renderAnalytics()
  }
}

function updateThemeIcon() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark'
  document.getElementById('icon-moon').style.display = dark  ? 'none'  : 'block'
  document.getElementById('icon-sun').style.display  = dark  ? 'block' : 'none'
}

// -- HELPERS -------------------------------------------------------------------
function fmt(n)     { return `$${(parseFloat(n) || 0).toFixed(2)}` }
function esc(s)     { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }
function today()    { return new Date().toISOString().slice(0,10) }
function calcProfit(s) { return ((s.sellPrice || 0) - (s.buyPrice || 0)) * (s.qty || 1) - (s.fees || 0) }
