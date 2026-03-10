require('dotenv').config()
const express = require('express')
const jwt     = require('jsonwebtoken')
const fs      = require('fs')
const path    = require('path')

const app = express()
app.use(express.json())

// On Railway: set PRIVATE_KEY env var with the PEM contents.
// Locally: falls back to private.pem file.
const PRIVATE_KEY = process.env.PRIVATE_KEY
  ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n')
  : fs.readFileSync(path.join(__dirname, 'private.pem'), 'utf8')

// In-memory store: userId → { refreshToken }
// Lost on server restart (users just re-login, which re-checks role anyway)
const tokenStore = new Map()

async function getValidAccessToken(userId) {
  const stored = tokenStore.get(userId)
  if (!stored) return null

  // Use refresh token to get a fresh Discord access token
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
    // Update stored refresh token (Discord rotates them)
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

// POST /auth/exchange
// Body: { code, deviceId }
// Returns: { token, username, avatar }
app.post('/auth/exchange', async (req, res) => {
  const { code, deviceId } = req.body
  if (!code || !deviceId) return res.status(400).json({ error: 'Missing params' })

  // 1. Exchange OAuth code for Discord tokens
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

  // 2. Verify subscriber role
  const hasRole = await checkDiscordRole(tokenData.access_token)
  if (!hasRole) return res.status(403).json({ error: 'no_subscription' })

  // 3. Get user info
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

  // 4. Store refresh token for future role checks
  tokenStore.set(user.id, { refreshToken: tokenData.refresh_token })

  // 5. Issue JWT
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

// POST /auth/verify
// Body: { token }
// Returns: { valid: true } or { valid: false, reason }
// Called on every app launch to instantly detect role removal.
app.post('/auth/verify', async (req, res) => {
  const { token } = req.body
  if (!token) return res.status(400).json({ valid: false, reason: 'missing_token' })

  // 1. Decode token to get userId (Discord role check is the real security gate)
  const payload = jwt.decode(token)
  if (!payload?.userId) return res.json({ valid: false, reason: 'invalid_token' })

  const { userId } = payload

  // 2. If we have a stored refresh token, use it to check role right now
  const accessToken = await getValidAccessToken(userId)
  if (!accessToken) {
    // No stored token (server restarted) — tell client to re-login
    return res.json({ valid: false, reason: 'reauth' })
  }

  // 3. Live Discord role check
  const hasRole = await checkDiscordRole(accessToken)
  if (!hasRole) return res.json({ valid: false, reason: 'no_subscription' })

  res.json({ valid: true })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Auth server listening on port ${PORT}`))
