require('dotenv').config()
const express = require('express') // v2
const jwt     = require('jsonwebtoken')
const fs      = require('fs')
const path    = require('path')
const { Pool } = require('pg')
const { HttpsProxyAgent } = require('https-proxy-agent')

const app = express()
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})
app.use(express.json())

// ── Keys ──────────────────────────────────────────────────────────────────────
const PRIVATE_KEY = process.env.PRIVATE_KEY
  ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n')
  : fs.readFileSync(path.join(__dirname, 'private.pem'), 'utf8')

// Public key used to verify JWTs for admin requests
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqeWoTGLR5pvj3hKVMD4C
ungs8Ux349aFPL06BbTciSfbBI8iCP7IeAIhqMPjCoEOhIFWmIKr0xhCG6moKs/0
cSdvYlD27QGiuDX6NZBaaeMpl3nX2FgrUk2EttoEVmj2u+4L6HQgqMlPhGnmRK+s
mr+3YxzhA5d3ilX1O29IKWvd4MzQUQDD+D4uhF0bjIEsEUT63kn4b6xMYO/TRYyt
PtS9P/qWkLbwKUflavof7vpcIW0N913/nsM32OfNhUy3//ET1qiZwK1gIkhc2605
sNXc/RLbOGf4Pu57lTTQjbJ5zG9rDueD//EzoBVBDECWk2AVMm50x562zFhg9anA
uQIDAQAB
-----END PUBLIC KEY-----`

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS releases (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      date        TEXT NOT NULL,
      image_url    TEXT,
      retail_price TEXT,
      release_time TEXT,
      link         TEXT,
      notes        TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  // Add columns to existing tables that predate them
  await pool.query(`ALTER TABLE releases ADD COLUMN IF NOT EXISTS link TEXT`)
  await pool.query(`ALTER TABLE releases ADD COLUMN IF NOT EXISTS release_time TEXT`)
  await pool.query(`ALTER TABLE releases ADD COLUMN IF NOT EXISTS resale_price TEXT`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pinned_messages (
      id         TEXT PRIMARY KEY,
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS monitors (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      site_url     TEXT NOT NULL,
      keywords     TEXT,
      webhook_url  TEXT NOT NULL,
      ping_role    TEXT,
      active       BOOLEAN DEFAULT true,
      interval_sec INTEGER DEFAULT 60,
      last_pinged  TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS monitor_seen (
      monitor_id   TEXT NOT NULL,
      product_id   TEXT NOT NULL,
      variant_data JSONB DEFAULT '{}',
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (monitor_id, product_id)
    )
  `)
  // New columns for existing deployments
  await pool.query(`ALTER TABLE monitors ADD COLUMN IF NOT EXISTS product_url TEXT`)
  await pool.query(`ALTER TABLE monitors ADD COLUMN IF NOT EXISTS price_alert BOOLEAN DEFAULT false`)
  await pool.query(`ALTER TABLE monitors ADD COLUMN IF NOT EXISTS price_threshold TEXT`)
  await pool.query(`ALTER TABLE monitors ADD COLUMN IF NOT EXISTS site_type TEXT DEFAULT 'shopify'`)
  await pool.query(`ALTER TABLE monitors ADD COLUMN IF NOT EXISTS proxy_url TEXT`)
  startMonitorEngine()
  console.log('Database ready')
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
const tokenStore = new Map()

async function getValidAccessToken(userId) {
  const stored = tokenStore.get(userId)
  if (!stored) return null
  try {
    const res = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        grant_type:    'refresh_token',
        refresh_token: stored.refreshToken,
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) { tokenStore.delete(userId); return null }
    const data = await res.json()
    tokenStore.set(userId, { refreshToken: data.refresh_token || stored.refreshToken })
    return data.access_token
  } catch {
    return null
  }
}

async function checkDiscordRole(accessToken) {
  try {
    const res = await fetch(
      `https://discord.com/api/users/@me/guilds/${process.env.GUILD_ID}/member`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return false
    const member = await res.json()
    return Array.isArray(member.roles) && member.roles.includes(process.env.ROLE_ID)
  } catch {
    return false
  }
}

// ── Admin middleware ───────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })
  const token = auth.slice(7)
  try {
    const payload = jwt.verify(token, PUBLIC_KEY, { algorithms: ['RS256'] })
    if (payload.userId !== process.env.ADMIN_DISCORD_ID) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    req.adminUserId = payload.userId
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid token' })
  }
}

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/auth/exchange', async (req, res) => {
  const { code, deviceId } = req.body
  if (!code || !deviceId) return res.status(400).json({ error: 'Missing params' })

  let tokenData
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  process.env.REDIRECT_URI,
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!tokenRes.ok) {
      console.error('Token exchange failed:', await tokenRes.text())
      return res.status(400).json({ error: 'Token exchange failed' })
    }
    tokenData = await tokenRes.json()
  } catch {
    return res.status(500).json({ error: 'Token exchange error' })
  }

  const hasRole = await checkDiscordRole(tokenData.access_token)
  if (!hasRole) return res.status(403).json({ error: 'no_subscription' })

  let user
  try {
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(8000),
    })
    user = await userRes.json()
  } catch {
    return res.status(500).json({ error: 'Failed to get user info' })
  }

  tokenStore.set(user.id, { refreshToken: tokenData.refresh_token })

  const token = jwt.sign(
    { userId: user.id, username: user.username, deviceId },
    PRIVATE_KEY,
    { algorithm: 'RS256', expiresIn: '30d' }
  )

  const avatar = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
    : null

  res.json({ token, username: user.username, avatar })
})

app.post('/auth/verify', async (req, res) => {
  const { token } = req.body
  if (!token) return res.status(400).json({ valid: false, reason: 'missing_token' })

  const payload = jwt.decode(token)
  if (!payload?.userId) return res.json({ valid: false, reason: 'invalid_token' })

  const { userId } = payload

  const accessToken = await getValidAccessToken(userId)
  if (!accessToken) {
    return res.json({ valid: false, reason: 'reauth' })
  }

  const hasRole = await checkDiscordRole(accessToken)
  if (!hasRole) return res.json({ valid: false, reason: 'no_subscription' })

  res.json({ valid: true })
})

// ── Releases routes ───────────────────────────────────────────────────────────

// GET /releases — public, all users fetch on app launch
app.get('/releases', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM releases ORDER BY date ASC')
    res.json(result.rows.map(r => ({
      id:          r.id,
      name:        r.name,
      date:        r.date,
      imageUrl:    r.image_url,
      retailPrice: r.retail_price,
      resalePrice: r.resale_price,
      releaseTime: r.release_time,
      link:        r.link,
      notes:       r.notes,
      createdAt:   r.created_at,
      updatedAt:   r.updated_at,
    })))
  } catch (err) {
    console.error('GET /releases error:', err)
    res.status(500).json({ error: 'Database error' })
  }
})

// POST /releases — admin only
app.post('/releases', requireAdmin, async (req, res) => {
  const { id, name, date, imageUrl, retailPrice, resalePrice, releaseTime, link, notes } = req.body
  if (!name || !date) return res.status(400).json({ error: 'name and date required' })
  const releaseId = id || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  try {
    await pool.query(
      'INSERT INTO releases (id, name, date, image_url, retail_price, resale_price, release_time, link, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [releaseId, name, date, imageUrl || null, retailPrice || null, resalePrice || null, releaseTime || null, link || null, notes || null]
    )
    res.json({ id: releaseId, name, date, imageUrl: imageUrl || null, retailPrice: retailPrice || null, resalePrice: resalePrice || null, releaseTime: releaseTime || null, link: link || null, notes: notes || null })
  } catch (err) {
    console.error('POST /releases error:', err)
    res.status(500).json({ error: 'Database error' })
  }
})

// PUT /releases/:id — admin only
app.put('/releases/:id', requireAdmin, async (req, res) => {
  const { name, date, imageUrl, retailPrice, resalePrice, releaseTime, link, notes } = req.body
  try {
    await pool.query(
      'UPDATE releases SET name=$1, date=$2, image_url=$3, retail_price=$4, resale_price=$5, release_time=$6, link=$7, notes=$8, updated_at=NOW() WHERE id=$9',
      [name, date, imageUrl || null, retailPrice || null, resalePrice || null, releaseTime || null, link || null, notes || null, req.params.id]
    )
    res.json({ success: true })
  } catch (err) {
    console.error('PUT /releases error:', err)
    res.status(500).json({ error: 'Database error' })
  }
})

// DELETE /releases/:id — admin only
app.delete('/releases/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM releases WHERE id=$1', [req.params.id])
    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /releases error:', err)
    res.status(500).json({ error: 'Database error' })
  }
})

// ── Pinned messages routes ────────────────────────────────────────────────────

// GET /pinned — public
app.get('/pinned', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM pinned_messages ORDER BY created_at DESC')
    res.json(result.rows.map(r => ({ id: r.id, content: r.content, createdAt: r.created_at })))
  } catch (err) {
    console.error('GET /pinned error:', err)
    res.status(500).json({ error: 'Database error' })
  }
})

// POST /pinned — admin only
app.post('/pinned', requireAdmin, async (req, res) => {
  const { content } = req.body
  if (!content) return res.status(400).json({ error: 'content required' })
  const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  try {
    await pool.query('INSERT INTO pinned_messages (id, content) VALUES ($1, $2)', [id, content])
    res.json({ id, content })
  } catch (err) {
    console.error('POST /pinned error:', err)
    res.status(500).json({ error: 'Database error' })
  }
})

// DELETE /pinned/:id — admin only
app.delete('/pinned/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM pinned_messages WHERE id=$1', [req.params.id])
    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /pinned error:', err)
    res.status(500).json({ error: 'Database error' })
  }
})

// ── Monitor Engine ────────────────────────────────────────────────────────────
const monitorTimers = new Map()

async function startMonitorEngine() {
  try {
    const result = await pool.query('SELECT * FROM monitors WHERE active = true')
    for (const monitor of result.rows) scheduleMonitor(monitor)
    console.log(`Monitor engine started: ${result.rows.length} active monitors`)
  } catch (err) {
    console.error('Failed to start monitor engine:', err.message)
  }
}

function scheduleMonitor(monitor) {
  const existing = monitorTimers.get(monitor.id)
  if (existing) clearInterval(existing)
  const interval = (monitor.interval_sec || 60) * 1000
  runMonitor(monitor.id).catch(() => {})
  const timer = setInterval(() => runMonitor(monitor.id).catch(() => {}), interval)
  monitorTimers.set(monitor.id, timer)
}

function stopMonitor(monitorId) {
  const timer = monitorTimers.get(monitorId)
  if (timer) { clearInterval(timer); monitorTimers.delete(monitorId) }
}

// ── Retail site scrapers ──────────────────────────────────────────────────────
const SCRAPE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

// Proxy-aware fetch — routes through proxy if proxyUrl is set
function proxyFetch(url, options = {}, proxyUrl) {
  if (proxyUrl) {
    options.agent = new HttpsProxyAgent(proxyUrl)
  }
  return fetch(url, options)
}

async function fetchWalmart(productUrl, proxyUrl) {
  try {
    const res = await proxyFetch(productUrl, { headers: SCRAPE_HEADERS, signal: AbortSignal.timeout(15000) }, proxyUrl)
    const html = await res.text()
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/)
    if (!match) return null
    const data = JSON.parse(match[1])
    const p = data?.props?.pageProps?.initialData?.data?.product
    if (!p) return null
    return {
      title: p.name,
      price: p.priceInfo?.currentPrice?.price ?? p.priceInfo?.wasPrice?.price ?? null,
      available: p.availabilityStatus === 'IN_STOCK',
      image: p.imageInfo?.thumbnailUrl || null,
      url: productUrl
    }
  } catch { return null }
}

async function fetchTarget(productUrl, proxyUrl) {
  try {
    const tcinMatch = productUrl.match(/A-(\d+)/)
    if (!tcinMatch) return null
    const tcin = tcinMatch[1]
    const apiUrl = `https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1?tcin=${tcin}&scheduled_delivery_store_id=3991&store_id=3991&zip=10001&state=NY&latitude=40.7128&longitude=-74.0060&country=US&channel=WEB&page=%2Fp%2FA-${tcin}`
    const res = await proxyFetch(apiUrl, {
      headers: { ...SCRAPE_HEADERS, Accept: 'application/json', Referer: productUrl },
      signal: AbortSignal.timeout(15000)
    }, proxyUrl)
    if (!res.ok) return null
    const data = await res.json()
    const p = data?.data?.product
    if (!p) return null
    const avail = p.availability?.availability_status
    return {
      title: p.item?.product_description?.title || null,
      price: p.price?.current_retail ?? null,
      available: avail === 'IN_STOCK' || avail === 'LIMITED_STOCK',
      image: p.item?.enrichment?.images?.primary_image_url || null,
      url: productUrl
    }
  } catch { return null }
}

async function fetchAmazon(productUrl, proxyUrl) {
  try {
    const res = await proxyFetch(productUrl, {
      headers: { ...SCRAPE_HEADERS, 'Cache-Control': 'no-cache', 'Accept-Encoding': 'gzip, deflate, br' },
      signal: AbortSignal.timeout(15000)
    }, proxyUrl)
    if (!res.ok) return null
    const html = await res.text()
    if (html.includes('Type the characters') || html.includes('robot check') || html.includes('CAPTCHA')) {
      console.log('[amazon] Bot detection triggered — try again later')
      return null
    }
    const titleMatch = html.match(/id="productTitle"[^>]*>\s*([\s\S]+?)\s*<\/span>/)
    let price = null
    for (const pat of [
      /"priceAmount":"?([\d.]+)"?/,
      /class="a-price-whole">(\d+)</,
      /id="priceblock_ourprice"[^>]*>\$?([\d,]+\.?\d*)/,
      /id="priceblock_dealprice"[^>]*>\$?([\d,]+\.?\d*)/,
    ]) {
      const m = html.match(pat)
      if (m) { price = parseFloat(m[1].replace(',', '')); break }
    }
    const available = (html.includes('In Stock') || html.includes('Add to Cart') || html.includes('"availabilityType":"now"'))
      && !html.includes('Currently unavailable') && !html.includes('Temporarily out of stock')
    const imageMatch = html.match(/"hiRes":"(https:[^"]+\.jpg[^"]*)"/) || html.match(/"large":"(https:[^"]+\.jpg[^"]*)"/)
    return {
      title: titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : 'Amazon Product',
      price,
      available,
      image: imageMatch ? imageMatch[1].replace(/\\u002F/g, '/') : null,
      url: productUrl
    }
  } catch { return null }
}

async function fetchBestBuy(productUrl, proxyUrl) {
  try {
    const skuMatch = productUrl.match(/\/(\d{7,})\.p/) || productUrl.match(/skuId=(\d+)/)
    if (!skuMatch) return null
    const sku = skuMatch[1]
    const res = await proxyFetch(`https://www.bestbuy.com/api/3.0/priceBlocks?skus=${sku}`, {
      headers: { ...SCRAPE_HEADERS, Accept: 'application/json', Referer: 'https://www.bestbuy.com/' },
      signal: AbortSignal.timeout(15000)
    }, proxyUrl)
    if (!res.ok) return null
    const data = await res.json()
    const item = Array.isArray(data) ? data[0] : data
    if (!item) return null
    const btnState = item.buttonState?.buttonState
    const available = btnState !== 'SOLD_OUT' && btnState !== 'COMING_SOON' && btnState !== 'PRE_ORDER_ONLY'
    return {
      title: item.names?.shortName || item.names?.name || `Best Buy SKU ${sku}`,
      price: item.priceBlock?.customerPrice?.currentPrice ?? null,
      available,
      image: null,
      url: productUrl
    }
  } catch { return null }
}

const RETAIL_FETCHERS = { walmart: fetchWalmart, target: fetchTarget, amazon: fetchAmazon, bestbuy: fetchBestBuy }

async function runRetailMonitor(monitor) {
  const fetcher = RETAIL_FETCHERS[monitor.site_type]
  if (!fetcher) return
  const productUrl = (monitor.product_url || monitor.site_url).trim()
  const product = await fetcher(productUrl, monitor.proxy_url || null)
  if (!product) return

  const seenCount = await pool.query('SELECT COUNT(*) FROM monitor_seen WHERE monitor_id = $1', [monitor.id])
  const isFirstRun = parseInt(seenCount.rows[0].count) === 0
  const currentState = { available: product.available, price: product.price != null ? String(product.price) : null }

  if (isFirstRun) {
    await pool.query(
      `INSERT INTO monitor_seen (monitor_id, product_id, variant_data, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING`,
      [monitor.id, productUrl, JSON.stringify({ _: currentState })]
    )
    return
  }

  const seen = await pool.query(
    'SELECT variant_data FROM monitor_seen WHERE monitor_id = $1 AND product_id = $2',
    [monitor.id, productUrl]
  )
  let prevState = { available: false, price: null }
  if (seen.rows.length === 0) {
    await pool.query(
      `INSERT INTO monitor_seen (monitor_id, product_id, variant_data, updated_at) VALUES ($1, $2, $3, NOW())`,
      [monitor.id, productUrl, JSON.stringify({ _: currentState })]
    )
    if (currentState.available) await sendRetailPing(monitor, product, 'restock', {})
    return
  }
  prevState = parseVariantState(seen.rows[0].variant_data?._)

  await pool.query(
    `UPDATE monitor_seen SET variant_data = $1, updated_at = NOW() WHERE monitor_id = $2 AND product_id = $3`,
    [JSON.stringify({ _: currentState }), monitor.id, productUrl]
  )

  if (currentState.available && !prevState.available) {
    await sendRetailPing(monitor, product, 'restock', {})
  }
  if (monitor.price_alert && currentState.price && prevState.price) {
    const currP = parseFloat(currentState.price)
    const prevP = parseFloat(prevState.price)
    if (currP < prevP) {
      const threshold = monitor.price_threshold ? parseFloat(monitor.price_threshold) : null
      if (!threshold || currP <= threshold) {
        await sendRetailPing(monitor, product, 'price_drop', { oldPrice: prevP, newPrice: currP })
      }
    }
  }
}

async function sendRetailPing(monitor, product, type, extra) {
  const SITE_LABELS = { walmart: 'Walmart', target: 'Target', amazon: 'Amazon', bestbuy: 'Best Buy' }
  const siteLabel = SITE_LABELS[monitor.site_type] || monitor.name
  const color = type === 'price_drop' ? 0xff9500 : 0x00ff7f
  let title, fields

  if (type === 'price_drop') {
    title = `💰 Price Drop: ${product.title}`
    fields = [
      { name: 'Was', value: `$${extra.oldPrice.toFixed(2)}`, inline: true },
      { name: 'Now', value: `$${extra.newPrice.toFixed(2)}`, inline: true },
      { name: 'Saved', value: `$${(extra.oldPrice - extra.newPrice).toFixed(2)}`, inline: true },
      { name: 'Site', value: siteLabel, inline: false }
    ]
  } else {
    title = `🔄 Back In Stock: ${product.title}`
    fields = [
      { name: 'Price', value: product.price != null ? `$${parseFloat(product.price).toFixed(2)}` : 'N/A', inline: true },
      { name: 'Site', value: siteLabel, inline: true },
      { name: 'Status', value: '✅ In Stock', inline: true }
    ]
  }

  const payload = {
    content: monitor.ping_role ? `<@&${monitor.ping_role}>` : undefined,
    embeds: [{ title, url: product.url, color, fields, footer: { text: `Resell Tracker Monitor • ${monitor.name}` }, timestamp: new Date().toISOString() }]
  }
  if (product.image) payload.embeds[0].thumbnail = { url: product.image }
  if (!payload.content) delete payload.content

  try {
    const res = await fetch(monitor.webhook_url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(10000)
    })
    if (res.ok) {
      await pool.query('UPDATE monitors SET last_pinged = NOW() WHERE id = $1', [monitor.id])
      console.log(`[monitor] Pinged: ${type} on "${product.title}" (${monitor.name})`)
    }
  } catch (err) { console.error(`[monitor] Discord ping failed:`, err.message) }
}

// Parse stored variant state — handles old boolean format and new {available, price} format
function parseVariantState(stored) {
  if (stored === null || stored === undefined) return { available: false, price: null }
  if (typeof stored === 'boolean') return { available: stored, price: null }
  return { available: stored.available ?? false, price: stored.price ?? null }
}

async function runMonitor(monitorId) {
  let monitor
  try {
    const result = await pool.query('SELECT * FROM monitors WHERE id = $1 AND active = true', [monitorId])
    if (!result.rows.length) return
    monitor = result.rows[0]
  } catch { return }

  // Dispatch to retail scraper for non-Shopify sites
  if (monitor.site_type && monitor.site_type !== 'shopify') {
    return runRetailMonitor(monitor)
  }

  let baseUrl = monitor.site_url.trim().replace(/\/$/, '')
  if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl

  // ── Fetch products (specific product URL or full site) ────────────────────
  let products
  try {
    if (monitor.product_url) {
      // Specific product monitor — extract handle from URL
      const productUrl = monitor.product_url.trim().replace(/\/$/, '')
      const fetchUrl = productUrl.endsWith('.json') ? productUrl : `${productUrl}.json`
      const res = await fetch(fetchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(15000)
      })
      if (!res.ok) return
      const data = await res.json()
      if (!data.product) return
      products = [data.product]
      // Override baseUrl from the product URL
      const parsed = new URL(fetchUrl)
      baseUrl = `${parsed.protocol}//${parsed.hostname}`
    } else {
      // Whole site monitor
      const res = await fetch(`${baseUrl}/products.json?limit=250`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(15000)
      })
      if (!res.ok) return
      const data = await res.json()
      products = data.products
      if (!Array.isArray(products)) return
    }
  } catch { return }

  const seenCount = await pool.query('SELECT COUNT(*) FROM monitor_seen WHERE monitor_id = $1', [monitorId])
  const isFirstRun = parseInt(seenCount.rows[0].count) === 0

  const keywords = monitor.keywords
    ? monitor.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
    : []

  for (const product of products) {
    const productId = String(product.id)

    if (!monitor.product_url && keywords.length > 0) {
      const title = (product.title || '').toLowerCase()
      if (!keywords.some(kw => title.includes(kw))) continue
    }

    // Build current variant state: {variantId: {available, price}}
    const currentVariants = {}
    for (const v of (product.variants || [])) {
      currentVariants[String(v.id)] = { available: v.available, price: v.price || null }
    }

    try {
      if (isFirstRun) {
        await pool.query(
          `INSERT INTO monitor_seen (monitor_id, product_id, variant_data, updated_at)
           VALUES ($1, $2, $3, NOW()) ON CONFLICT (monitor_id, product_id) DO NOTHING`,
          [monitorId, productId, JSON.stringify(currentVariants)]
        )
      } else {
        const seen = await pool.query(
          'SELECT variant_data FROM monitor_seen WHERE monitor_id = $1 AND product_id = $2',
          [monitorId, productId]
        )
        if (seen.rows.length === 0) {
          // New product
          await pool.query(
            `INSERT INTO monitor_seen (monitor_id, product_id, variant_data, updated_at) VALUES ($1, $2, $3, NOW())`,
            [monitorId, productId, JSON.stringify(currentVariants)]
          )
          const anyAvailable = Object.values(currentVariants).some(v => v.available)
          if (anyAvailable) {
            const availableVariants = (product.variants || []).filter(v => v.available).map(v => v.title)
            await sendDiscordPing(monitor, product, baseUrl, 'new', availableVariants)
          }
        } else {
          const prevVariants = seen.rows[0].variant_data || {}
          const restockedVariants = []
          let priceDropped = false
          let oldPrice = null
          let newPrice = null

          for (const [varId, curr] of Object.entries(currentVariants)) {
            const prev = parseVariantState(prevVariants[varId])
            const currState = parseVariantState(curr)

            // Restock check
            if (currState.available && !prev.available) {
              const variant = (product.variants || []).find(v => String(v.id) === varId)
              if (variant) restockedVariants.push(variant.title)
            }

            // Price drop check
            if (monitor.price_alert && currState.price && prev.price) {
              const currP = parseFloat(currState.price)
              const prevP = parseFloat(prev.price)
              if (currP < prevP) {
                const threshold = monitor.price_threshold ? parseFloat(monitor.price_threshold) : null
                if (!threshold || currP <= threshold) {
                  priceDropped = true
                  oldPrice = prevP
                  newPrice = currP
                }
              }
            }
          }

          await pool.query(
            `UPDATE monitor_seen SET variant_data = $1, updated_at = NOW() WHERE monitor_id = $2 AND product_id = $3`,
            [JSON.stringify(currentVariants), monitorId, productId]
          )

          if (restockedVariants.length > 0) {
            await sendDiscordPing(monitor, product, baseUrl, 'restock', restockedVariants)
          }
          if (priceDropped) {
            await sendDiscordPing(monitor, product, baseUrl, 'price_drop', [], { oldPrice, newPrice })
          }
        }
      }
    } catch (err) {
      console.error(`[monitor] product ${productId} error:`, err.message)
    }
  }
}

async function sendDiscordPing(monitor, product, baseUrl, type, variants = [], extra = {}) {
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
    embeds: [{
      title,
      url: productUrl,
      color,
      fields,
      footer: { text: `Resell Tracker Monitor • ${monitor.name}` },
      timestamp: new Date().toISOString()
    }]
  }
  if (image) payload.embeds[0].thumbnail = { url: image }
  if (!payload.content) delete payload.content

  try {
    const res = await fetch(monitor.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    })
    if (res.ok) {
      await pool.query('UPDATE monitors SET last_pinged = NOW() WHERE id = $1', [monitor.id])
      console.log(`[monitor] Pinged: ${type} on "${product.title}" (${monitor.name})`)
    }
  } catch (err) {
    console.error(`[monitor] Discord ping failed:`, err.message)
  }
}

// ── Monitor CRUD routes ───────────────────────────────────────────────────────

app.get('/monitors', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM monitors ORDER BY created_at DESC')
    res.json(result.rows)
  } catch (err) {
    console.error('GET /monitors error:', err)
    res.status(500).json({ error: 'Database error' })
  }
})

app.post('/monitors', requireAdmin, async (req, res) => {
  const { name, siteUrl, productUrl, keywords, webhookUrl, pingRole, intervalSec, priceAlert, priceThreshold, siteType, proxyUrl } = req.body
  if (!name || !siteUrl || !webhookUrl) return res.status(400).json({ error: 'name, siteUrl, webhookUrl required' })
  const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  try {
    await pool.query(
      `INSERT INTO monitors (id, name, site_url, product_url, keywords, webhook_url, ping_role, interval_sec, price_alert, price_threshold, site_type, proxy_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, name, siteUrl, productUrl || null, keywords || null, webhookUrl,
       pingRole || null, parseInt(intervalSec) || 60, !!priceAlert, priceThreshold || null, siteType || 'shopify', proxyUrl || null]
    )
    const result = await pool.query('SELECT * FROM monitors WHERE id = $1', [id])
    const monitor = result.rows[0]
    scheduleMonitor(monitor)
    res.json(monitor)
  } catch (err) {
    console.error('POST /monitors error:', err)
    res.status(500).json({ error: 'Database error' })
  }
})

app.put('/monitors/:id', requireAdmin, async (req, res) => {
  const { name, siteUrl, productUrl, keywords, webhookUrl, pingRole, intervalSec, active, priceAlert, priceThreshold, siteType, proxyUrl } = req.body
  try {
    await pool.query(
      `UPDATE monitors SET name=$1, site_url=$2, product_url=$3, keywords=$4, webhook_url=$5,
       ping_role=$6, interval_sec=$7, active=$8, price_alert=$9, price_threshold=$10, site_type=$11, proxy_url=$12 WHERE id=$13`,
      [name, siteUrl, productUrl || null, keywords || null, webhookUrl,
       pingRole || null, parseInt(intervalSec) || 60, active !== false,
       !!priceAlert, priceThreshold || null, siteType || 'shopify', proxyUrl || null, req.params.id]
    )
    const result = await pool.query('SELECT * FROM monitors WHERE id = $1', [req.params.id])
    const monitor = result.rows[0]
    if (monitor.active) scheduleMonitor(monitor)
    else stopMonitor(monitor.id)
    res.json(monitor)
  } catch (err) {
    console.error('PUT /monitors error:', err)
    res.status(500).json({ error: 'Database error' })
  }
})

app.delete('/monitors/:id', requireAdmin, async (req, res) => {
  try {
    stopMonitor(req.params.id)
    await pool.query('DELETE FROM monitor_seen WHERE monitor_id = $1', [req.params.id])
    await pool.query('DELETE FROM monitors WHERE id = $1', [req.params.id])
    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /monitors error:', err)
    res.status(500).json({ error: 'Database error' })
  }
})

// POST /monitors/:id/test — sends a fake ping to verify webhook works
app.post('/monitors/:id/test', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM monitors WHERE id = $1', [req.params.id])
    if (!result.rows.length) return res.status(404).json({ error: 'Monitor not found' })
    const monitor = result.rows[0]

    const fakeProduct = {
      title: 'Test Product — Monitor is Working!',
      handle: 'test-product',
      images: [{ src: 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-product-1_large.png' }],
      variants: [{ id: '1', price: '199.99', available: true, title: 'Size 10' }]
    }
    const baseUrl = monitor.site_url.trim().replace(/\/$/, '')
    await sendDiscordPing(monitor, fakeProduct, baseUrl, 'restock', ['Size 10', 'Size 11'])
    res.json({ success: true })
  } catch (err) {
    console.error('POST /monitors/test error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Auth server listening on port ${PORT}`))

// Init DB with retries — server stays up even if DB isn't ready immediately
async function initDBWithRetry(attempts = 10, delay = 3000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await initDB()
      return
    } catch (err) {
      console.error(`DB init attempt ${i}/${attempts} failed:`, err.message)
      if (i < attempts) await new Promise(r => setTimeout(r, delay))
    }
  }
  console.error('Could not connect to database after all retries.')
}
initDBWithRetry()
