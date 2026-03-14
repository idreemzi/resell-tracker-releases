// selfbot.js — Discord selfbot using discord.js-selfbot-v13
// ⚠️  Self-botting violates Discord ToS. Use at your own risk.

const { Client } = require('discord.js-selfbot-v13')

let client = null
let _onAlert = null   // callback(data) → sent to renderer
let _running = false
let _starting = false  // true while login is in progress (prevents duplicate logins)

const ATC_RE      = /atc|add.?to.?cart|cop|buy|checkout/i
const MD_LINK_RE  = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g
const BARE_URL_RE = /https?:\/\/\S+/g

function containsKeyword(text, keywords, caseSensitive) {
  const hay = caseSensitive ? text : text.toLowerCase()
  for (const kw of keywords) {
    const k = caseSensitive ? kw : kw.toLowerCase()
    if (!k) continue
    if (k.length <= 6) {
      const pattern = new RegExp('(?<![a-z0-9])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])', caseSensitive ? '' : 'i')
      if (pattern.test(hay)) return kw
    } else {
      if (hay.includes(k)) return kw
    }
  }
  return null
}

function extractEmbedData(embeds) {
  const embedUrls = []
  const atcUrls   = []
  const parts     = []

  for (const e of embeds) {
    if (e.title)       parts.push(e.title)
    if (e.description) parts.push(e.description)
    if (e.url)         embedUrls.push(e.url)

    for (const f of (e.fields || [])) {
      parts.push(f.name || '', f.value || '')
      const fieldIsAtc = ATC_RE.test(f.name || '')
      const val = f.value || ''

      // Markdown links [text](url)
      let m
      MD_LINK_RE.lastIndex = 0
      while ((m = MD_LINK_RE.exec(val)) !== null) {
        const [, linkText, linkUrl] = m
        embedUrls.push(linkUrl)
        if (fieldIsAtc || ATC_RE.test(linkText)) atcUrls.push(linkUrl)
      }

      // Bare URLs (strip markdown links first)
      const stripped = val.replace(/\[[^\]]*\]\([^)]*\)/g, '')
      BARE_URL_RE.lastIndex = 0
      while ((m = BARE_URL_RE.exec(stripped)) !== null) {
        const u = m[0].replace(/[)>.,]+$/, '')
        embedUrls.push(u)
        if (fieldIsAtc) atcUrls.push(u)
      }
    }

    if (e.footer?.text) parts.push(e.footer.text)
    if (e.author?.name) parts.push(e.author.name)
  }

  return { embedText: parts.join(' '), embedUrls, atcUrls }
}

function start(config, onAlert, onStatusChange, onFeedMessage) {
  if (_running || _starting) return
  _starting = true

  const { token, keywords = [], channelIds = [], feedChannelIds = [], caseSensitive = false } = config
  if (!token) { onStatusChange(false); return }

  client = new Client({ checkUpdate: false })
  const allowedIds = new Set(channelIds.map(String))
  const feedIds    = new Set(feedChannelIds.map(String))

  client.on('ready', () => {
    _running = true
    _starting = false
    onStatusChange(true)
    const u = client.user
    console.log(`[selfbot] Logged in as ${u ? (u.tag || u.username || u.id) : 'unknown'}`)
  })

  client.on('messageCreate', msg => {
    if (!client || !client.user) return
    if (msg.author.id === client.user.id) return
    if (msg.author.bot || msg.webhookId) return

    const chanId  = String(msg.channelId || msg.channel?.id || '')
    const content = msg.content || ''
    const { embedText, embedUrls, atcUrls } = extractEmbedData(msg.embeds || [])
    const haystack = `${content} ${embedText}`

    // ── Feed channels: forward every message regardless of keywords ──
    if (feedIds.has(chanId) && onFeedMessage) {
      const embeds = (msg.embeds || []).map(e => ({
        title:       e.title || '',
        description: e.description || '',
        image:       e.image?.url || e.thumbnail?.url || '',
        url:         e.url || '',
        color:       e.color || null,
      }))
      const images = (msg.attachments || []).filter(a => /\.(png|jpg|jpeg|gif|webp)/i.test(a.url)).map(a => a.url)
      onFeedMessage({
        id:        msg.id,
        channelId: chanId,
        guildId:   msg.guildId || msg.channel?.guildId || '',
        guild:     msg.guild?.name || '',
        channel:   msg.channel?.name || 'unknown',
        author:    msg.author?.username || 'Unknown',
        content:   content.slice(0, 1000),
        embeds,
        images,
        urls:      embedUrls,
        atc_urls:  atcUrls,
        jumpUrl:   msg.url || '',
        timestamp: new Date().toISOString(),
      })
    }

    // ── Keyword alerts ───────────────────────────────────────────────
    const matchedKw  = containsKeyword(haystack, keywords, caseSensitive)
    const chanAllowed = allowedIds.size === 0 || allowedIds.has(chanId)

    if (!matchedKw || !chanAllowed) return

    const chName = msg.channel?.name || msg.channel?.type || 'DM'
    const jumpUrl = msg.url || ''
    const firstEmbedTitle = (msg.embeds || []).find(e => e.title)?.title
    const previewText = firstEmbedTitle || content || embedText || '(no text)'

    onAlert({
      keyword:    matchedKw,
      text:       previewText.trim().slice(0, 300),
      channel:    chName,
      url:        jumpUrl,
      embed_urls: embedUrls,
      atc_urls:   atcUrls,
      timestamp:  new Date().toISOString()
    })
  })

  client.on('error', err => {
    console.error('[selfbot] error:', err.message)
  })

  client.on('disconnect', () => {
    _running = false
    onStatusChange(false)
  })

  // Timeout: if ready doesn't fire within 20s, treat as failed
  const loginTimeout = setTimeout(() => {
    if (!_running && client) {
      console.error('[selfbot] login timed out — token may be invalid')
      try { client.destroy() } catch {}
      client = null
      _starting = false
      onStatusChange(false)
    }
  }, 20000)

  client.on('ready', () => clearTimeout(loginTimeout))

  client.login(token).catch(err => {
    clearTimeout(loginTimeout)
    console.error('[selfbot] login failed:', err.message)
    _running = false
    _starting = false
    client = null
    onStatusChange(false)
  })
}

function stop() {
  if (client) {
    try { client.destroy() } catch {}
    client = null
  }
  _running = false
  _starting = false
}

function isRunning() { return _running }

module.exports = { start, stop, isRunning }
