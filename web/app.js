// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL      = 'https://lpfoqbmtsxfylkmapxfj.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_uqGOOWhBan8ZI4knzZvaVw_OKFiAMRP'
const PHOTO_BUCKET      = 'inventory-photos'

// ── Supabase ──────────────────────────────────────────────────────────────────
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// ── State ─────────────────────────────────────────────────────────────────────
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
let adminViewUserId = null
let approvalPoller  = null

// ── Platform colors ───────────────────────────────────────────────────────────
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

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  applyTheme()
  updateThemeIcon()
  setupKeyboard()
  setupPhotoZone()

  // Set today as default sale date
  document.getElementById('s-date').value = today()
  document.getElementById('year-label').textContent = analyticsYear

  sb.auth.onAuthStateChange(async (event, session) => {
    if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
      if (session) {
        await handleSession(session)
      } else {
        showScreen('screen-login')
      }
    }
    if (event === 'SIGNED_OUT') {
      currentUser = currentProfile = null
      inventory = sales = packages = []
      clearInterval(approvalPoller)
      showScreen('screen-login')
    }
  })
})

// ── Auth ──────────────────────────────────────────────────────────────────────
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

// ── App Boot ──────────────────────────────────────────────────────────────────
async function bootApp() {
  renderUserHeader()
  if (currentProfile.is_admin) {
    document.getElementById('nav-admin').style.display = 'flex'
  }
  await loadAllData()
  showScreen('screen-app')
  switchView('home')
  startRealtimeListeners()
}

function renderUserHeader() {
  const avatar = buildAvatarUrl(currentProfile.discord_id, currentProfile.avatar_url)
  document.getElementById('user-avatar').src = avatar
  document.getElementById('user-name').textContent = currentProfile.username || ''
  document.getElementById('sidebar-version').textContent = 'Resell Tracker Web'
}

function buildAvatarUrl(discordId, avatarHash) {
  if (!discordId || !avatarHash) return 'https://cdn.discordapp.com/embed/avatars/0.png'
  if (avatarHash.startsWith('http')) return avatarHash
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatarHash}.png?size=64`
}

// ── Data Loading ──────────────────────────────────────────────────────────────
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

// ── Navigation ────────────────────────────────────────────────────────────────
function switchView(name) {
  document.querySelectorAll('.view').forEach(v => {
    v.style.display = 'none'
    v.classList.remove('active')
  })
  const view = document.getElementById(`view-${name}`)
  if (view) { view.style.display = 'block'; view.classList.add('active') }

  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.view === name)
  })
  document.querySelectorAll('.bnav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.view === name)
  })

  if      (name === 'home')      renderHome()
  else if (name === 'inventory') renderInventory()
  else if (name === 'sales')     renderSales()
  else if (name === 'packages')  renderPackages()
  else if (name === 'analytics') renderAnalytics()
  else if (name === 'admin')     renderAdmin()
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar')
  const collapsed = sidebar.classList.toggle('collapsed')
  localStorage.setItem('rt-sidebar', collapsed ? '1' : '0')
}

// ── HOME ──────────────────────────────────────────────────────────────────────
function renderHome() {
  const invValue  = inventory.reduce((s, i) => s + (i.buyPrice || 0) * (i.qty || 1), 0)
  const spent     = sales.reduce((s, s2) => s + (s2.buyPrice || 0) * (s2.qty || 1), 0)
  const revenue   = sales.reduce((s, s2) => s + (s2.sellPrice || 0) * (s2.qty || 1), 0)
  const fees      = sales.reduce((s, s2) => s + (s2.fees || 0), 0)
  const profit    = revenue - spent - fees
  const sold      = sales.reduce((s, s2) => s + (s2.qty || 1), 0)
  const roi       = spent > 0 ? (profit / spent * 100) : 0

  document.getElementById('stat-inv-value').textContent  = fmt(invValue)
  document.getElementById('stat-inv-count').textContent  = `${inventory.length} item${inventory.length !== 1 ? 's' : ''}`
  document.getElementById('stat-profit').textContent     = fmt(profit)
  document.getElementById('stat-profit-sub').textContent = `${sales.length} sale${sales.length !== 1 ? 's' : ''}`
  document.getElementById('stat-sold').textContent       = sold
  document.getElementById('stat-sold-sub').textContent   = `units across ${sales.length} sale${sales.length !== 1 ? 's' : ''}`
  document.getElementById('stat-roi').textContent        = `${roi.toFixed(1)}%`

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
}

// ── INVENTORY ─────────────────────────────────────────────────────────────────
function renderInventory() {
  const q    = (document.getElementById('inv-search')?.value || '').toLowerCase()
  const data = q
    ? inventory.filter(i => [i.productName, i.store, i.size].join(' ').toLowerCase().includes(q))
    : inventory

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

// ── SALES ─────────────────────────────────────────────────────────────────────
function renderSales() {
  const q    = (document.getElementById('sales-search')?.value || '').toLowerCase()
  const data = q
    ? sales.filter(s => [s.productName, s.platform, s.size].join(' ').toLowerCase().includes(q))
    : sales

  document.getElementById('sales-count').textContent = `${sales.length} Total`

  const spent   = sales.reduce((a, s) => a + (s.buyPrice  || 0) * (s.qty || 1), 0)
  const revenue = sales.reduce((a, s) => a + (s.sellPrice || 0) * (s.qty || 1), 0)
  const fees    = sales.reduce((a, s) => a + (s.fees      || 0), 0)
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

// ── PACKAGES ──────────────────────────────────────────────────────────────────
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

// ── DELETE ────────────────────────────────────────────────────────────────────
function confirmDelete(table, id, name) {
  document.getElementById('modal-delete-msg').textContent =
    `Are you sure you want to delete "${name}"? This cannot be undone.`
  openModal('modal-delete')
  document.getElementById('btn-confirm-delete').onclick = () => doDelete(table, id)
}

async function doDelete(table, id) {
  const { error } = await sb.from(table).delete().eq('id', id)
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

// ── ANALYTICS ─────────────────────────────────────────────────────────────────
function renderAnalytics() {
  document.getElementById('year-label').textContent = analyticsYear

  const months    = Array.from({ length: 12 }, (_, i) => i)
  const labels    = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const yearSales = sales.filter(s => s.date && new Date(s.date).getFullYear() === analyticsYear)

  const spent   = months.map(m => yearSales.filter(s => new Date(s.date).getMonth() === m).reduce((a, s) => a + (s.buyPrice  || 0) * (s.qty || 1), 0))
  const revenue = months.map(m => yearSales.filter(s => new Date(s.date).getMonth() === m).reduce((a, s) => a + (s.sellPrice || 0) * (s.qty || 1), 0))
  const profit  = months.map((_, i) => revenue[i] - spent[i] - yearSales.filter(s => new Date(s.date).getMonth() === i).reduce((a, s) => a + (s.fees || 0), 0))

  const dark  = document.documentElement.getAttribute('data-theme') === 'dark'
  const gridC = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)'
  const textC = dark ? '#7878a0' : '#6b6563'

  // Monthly chart
  if (chartMonthly) chartMonthly.destroy()
  const ctxM = document.getElementById('chart-monthly').getContext('2d')
  chartMonthly = new Chart(ctxM, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Spent',   data: spent,   backgroundColor: dark ? 'rgba(255,51,102,0.5)' : 'rgba(239,68,68,0.5)',  borderColor: dark ? '#ff3366' : '#ef4444', borderWidth: 1.5, borderRadius: 4 },
        { label: 'Revenue', data: revenue, backgroundColor: dark ? 'rgba(255,149,0,0.5)'  : 'rgba(249,115,22,0.5)', borderColor: dark ? '#ff9500' : '#f97316', borderWidth: 1.5, borderRadius: 4 },
        { label: 'Profit',  data: profit,  backgroundColor: dark ? 'rgba(0,255,136,0.5)'  : 'rgba(34,197,94,0.5)',  borderColor: dark ? '#00ff88' : '#22c55e', borderWidth: 1.5, borderRadius: 4 },
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
        datasets: [{ data: platData, backgroundColor: colors, borderWidth: 2, borderColor: dark ? '#0f0f1a' : '#ffffff' }]
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

// ── ADMIN ─────────────────────────────────────────────────────────────────────
async function renderAdmin() {
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
  const { error } = await sb.from('profiles').update({ is_approved: approve }).eq('id', userId)
  if (error) { showToast('error', 'Failed', error.message); return }
  showToast('success', approve ? 'User approved' : 'Access revoked', '')
  renderAdmin()
}

async function viewClientData(userId, username) {
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

// ── PHOTO ─────────────────────────────────────────────────────────────────────
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

// ── MODALS ────────────────────────────────────────────────────────────────────
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

// ── TOAST ─────────────────────────────────────────────────────────────────────
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

// ── LIGHTBOX ──────────────────────────────────────────────────────────────────
function openLightbox(src) {
  const lb = document.createElement('div')
  lb.className = 'lightbox'
  lb.innerHTML = `<img src="${esc(src)}" />`
  lb.onclick   = () => lb.remove()
  document.body.appendChild(lb)
}

// ── SCREEN MANAGEMENT ─────────────────────────────────────────────────────────
function showScreen(id) {
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

// ── THEME ─────────────────────────────────────────────────────────────────────
function applyTheme() {
  const saved = localStorage.getItem('rt-theme')
  if (saved) document.documentElement.setAttribute('data-theme', saved)
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

// ── HELPERS ───────────────────────────────────────────────────────────────────
function fmt(n)     { return `$${(parseFloat(n) || 0).toFixed(2)}` }
function esc(s)     { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }
function today()    { return new Date().toISOString().slice(0,10) }
function calcProfit(s) { return ((s.sellPrice || 0) - (s.buyPrice || 0)) * (s.qty || 1) - (s.fees || 0) }
