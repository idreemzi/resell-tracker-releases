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
      image_url   TEXT,
      retail_price TEXT,
      link        TEXT,
      notes       TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  // Add link column to existing tables that predate it
  await pool.query(`ALTER TABLE releases ADD COLUMN IF NOT EXISTS link TEXT`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pinned_messages (
      id         TEXT PRIMARY KEY,
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
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
  const { id, name, date, imageUrl, retailPrice, link, notes } = req.body
  if (!name || !date) return res.status(400).json({ error: 'name and date required' })
  const releaseId = id || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  try {
    await pool.query(
      'INSERT INTO releases (id, name, date, image_url, retail_price, link, notes) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [releaseId, name, date, imageUrl || null, retailPrice || null, link || null, notes || null]
    )
    res.json({ id: releaseId, name, date, imageUrl: imageUrl || null, retailPrice: retailPrice || null, link: link || null, notes: notes || null })
  } catch (err) {
    console.error('POST /releases error:', err)
    res.status(500).json({ error: 'Database error' })
  }
})

// PUT /releases/:id — admin only
app.put('/releases/:id', requireAdmin, async (req, res) => {
  const { name, date, imageUrl, retailPrice, link, notes } = req.body
  try {
    await pool.query(
      'UPDATE releases SET name=$1, date=$2, image_url=$3, retail_price=$4, link=$5, notes=$6, updated_at=NOW() WHERE id=$7',
      [name, date, imageUrl || null, retailPrice || null, link || null, notes || null, req.params.id]
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
