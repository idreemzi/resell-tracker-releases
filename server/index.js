require('dotenv').config()
const express = require('express')
const jwt     = require('jsonwebtoken')
const fs      = require('fs')
const path    = require('path')
const { Pool } = require('pg')

const app = express()
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
  const { id, name, date, imageUrl, retailPrice, releaseTime, link, notes } = req.body
  if (!name || !date) return res.status(400).json({ error: 'name and date required' })
  const releaseId = id || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  try {
    await pool.query(
      'INSERT INTO releases (id, name, date, image_url, retail_price, release_time, link, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [releaseId, name, date, imageUrl || null, retailPrice || null, releaseTime || null, link || null, notes || null]
    )
    res.json({ id: releaseId, name, date, imageUrl: imageUrl || null, retailPrice: retailPrice || null, releaseTime: releaseTime || null, link: link || null, notes: notes || null })
  } catch (err) {
    console.error('POST /releases error:', err)
    res.status(500).json({ error: 'Database error' })
  }
})

// PUT /releases/:id — admin only
app.put('/releases/:id', requireAdmin, async (req, res) => {
  const { name, date, imageUrl, retailPrice, releaseTime, link, notes } = req.body
  try {
    await pool.query(
      'UPDATE releases SET name=$1, date=$2, image_url=$3, retail_price=$4, release_time=$5, link=$6, notes=$7, updated_at=NOW() WHERE id=$8',
      [name, date, imageUrl || null, retailPrice || null, releaseTime || null, link || null, notes || null, req.params.id]
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

async function runMonitor(monitorId) {
  let monitor
  try {
    const result = await pool.query('SELECT * FROM monitors WHERE id = $1 AND active = true', [monitorId])
    if (!result.rows.length) return
    monitor = result.rows[0]
  } catch { return }

  let baseUrl = monitor.site_url.trim().replace(/\/$/, '')
  if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl

  let products
  try {
    const res = await fetch(`${baseUrl}/products.json?limit=250`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) return
    const data = await res.json()
    products = data.products
    if (!Array.isArray(products)) return
  } catch { return }

  const seenCount = await pool.query('SELECT COUNT(*) FROM monitor_seen WHERE monitor_id = $1', [monitorId])
  const isFirstRun = parseInt(seenCount.rows[0].count) === 0

  const keywords = monitor.keywords
    ? monitor.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
    : []

  for (const product of products) {
    const productId = String(product.id)

    if (keywords.length > 0) {
      const title = (product.title || '').toLowerCase()
      if (!keywords.some(kw => title.includes(kw))) continue
    }

    const currentVariants = {}
    for (const v of (product.variants || [])) currentVariants[String(v.id)] = v.available

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
          await pool.query(
            `INSERT INTO monitor_seen (monitor_id, product_id, variant_data, updated_at) VALUES ($1, $2, $3, NOW())`,
            [monitorId, productId, JSON.stringify(currentVariants)]
          )
          const anyAvailable = Object.values(currentVariants).some(v => v)
          if (anyAvailable) {
            const availableVariants = (product.variants || []).filter(v => v.available).map(v => v.title)
            await sendDiscordPing(monitor, product, baseUrl, 'new', availableVariants)
          }
        } else {
          const prevVariants = seen.rows[0].variant_data || {}
          const restockedVariants = []
          for (const [varId, available] of Object.entries(currentVariants)) {
            if (available && prevVariants[varId] === false) {
              const variant = (product.variants || []).find(v => String(v.id) === varId)
              if (variant) restockedVariants.push(variant.title)
            }
          }
          await pool.query(
            `UPDATE monitor_seen SET variant_data = $1, updated_at = NOW() WHERE monitor_id = $2 AND product_id = $3`,
            [JSON.stringify(currentVariants), monitorId, productId]
          )
          if (restockedVariants.length > 0) {
            await sendDiscordPing(monitor, product, baseUrl, 'restock', restockedVariants)
          }
        }
      }
    } catch (err) {
      console.error(`[monitor] product ${productId} error:`, err.message)
    }
  }
}

async function sendDiscordPing(monitor, product, baseUrl, type, variants) {
  const isRestock = type === 'restock'
  const color = isRestock ? 0x00ff7f : 0x5865f2
  const productUrl = `${baseUrl}/products/${product.handle}`
  const image = product.images?.[0]?.src || null
  const firstVariant = (product.variants || []).find(v => v.available) || product.variants?.[0]
  const price = firstVariant?.price ? `$${parseFloat(firstVariant.price).toFixed(2)}` : 'N/A'
  const variantText = variants.length > 0
    ? variants.slice(0, 15).join(', ') + (variants.length > 15 ? ` +${variants.length - 15} more` : '')
    : 'Available'

  const payload = {
    content: monitor.ping_role ? `<@&${monitor.ping_role}>` : undefined,
    embeds: [{
      title: `${isRestock ? '🔄 Restock' : '🆕 New Product'}: ${product.title}`,
      url: productUrl,
      color,
      fields: [
        { name: 'Price', value: price, inline: true },
        { name: 'Site', value: monitor.name, inline: true },
        { name: isRestock ? 'Restocked Sizes' : 'Available Sizes', value: variantText, inline: false }
      ],
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
  const { name, siteUrl, keywords, webhookUrl, pingRole, intervalSec } = req.body
  if (!name || !siteUrl || !webhookUrl) return res.status(400).json({ error: 'name, siteUrl, webhookUrl required' })
  const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  try {
    await pool.query(
      `INSERT INTO monitors (id, name, site_url, keywords, webhook_url, ping_role, interval_sec)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, name, siteUrl, keywords || null, webhookUrl, pingRole || null, parseInt(intervalSec) || 60]
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
  const { name, siteUrl, keywords, webhookUrl, pingRole, intervalSec, active } = req.body
  try {
    await pool.query(
      `UPDATE monitors SET name=$1, site_url=$2, keywords=$3, webhook_url=$4, ping_role=$5,
       interval_sec=$6, active=$7 WHERE id=$8`,
      [name, siteUrl, keywords || null, webhookUrl, pingRole || null,
       parseInt(intervalSec) || 60, active !== false, req.params.id]
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
