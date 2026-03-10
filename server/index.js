require('dotenv').config()
const express = require('express')
const jwt     = require('jsonwebtoken')
const fs      = require('fs')
const path    = require('path')

const app = express()
app.use(express.json())

const PRIVATE_KEY = fs.readFileSync(path.join(__dirname, 'private.pem'), 'utf8')

// POST /auth/exchange
// Body: { code: string, deviceId: string }
// Returns: { token, username, avatar } or { error }
app.post('/auth/exchange', async (req, res) => {
  const { code, deviceId } = req.body
  if (!code || !deviceId) return res.status(400).json({ error: 'Missing params' })

  // 1. Exchange Discord OAuth code for access token
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
      const err = await tokenRes.text()
      console.error('Token exchange failed:', err)
      return res.status(400).json({ error: 'Token exchange failed' })
    }
    tokenData = await tokenRes.json()
  } catch (err) {
    return res.status(500).json({ error: 'Token exchange error' })
  }

  // 2. Verify the user has the subscriber role in your Discord server
  let member
  try {
    const memberRes = await fetch(
      `https://discord.com/api/users/@me/guilds/${process.env.GUILD_ID}/member`,
      { headers: { Authorization: `Bearer ${tokenData.access_token}` }, signal: AbortSignal.timeout(8000) }
    )
    if (!memberRes.ok) return res.status(403).json({ error: 'no_subscription' })
    member = await memberRes.json()
  } catch {
    return res.status(500).json({ error: 'Discord API error' })
  }

  if (!Array.isArray(member.roles) || !member.roles.includes(process.env.ROLE_ID)) {
    return res.status(403).json({ error: 'no_subscription' })
  }

  // 3. Get Discord user info
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

  // 4. Issue a signed JWT — private key never leaves this server
  const token = jwt.sign(
    { userId: user.id, username: user.username, deviceId },
    PRIVATE_KEY,
    { algorithm: 'RS256', expiresIn: '7d' }
  )

  const avatar = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
    : null

  res.json({ token, username: user.username, avatar })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Auth server listening on port ${PORT}`))
