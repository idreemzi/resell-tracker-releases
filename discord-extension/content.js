window.__resellTrackerInjected = true
console.log('[ResellTracker] content script loaded')

const PORT = 7429
let keywords = []
const alerted = new Set() // prevent duplicate alerts for same message

chrome.storage.sync.get(['keywords'], (result) => {
  keywords = parseKeywords(result.keywords || '')
})

chrome.storage.onChanged.addListener((changes) => {
  if (changes.keywords) keywords = parseKeywords(changes.keywords.newValue || '')
})

function parseKeywords(str) {
  return str.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
}

function extractMessageText(el) {
  const parts = []

  // Regular message text
  const msgContent = el.querySelector('[class*="messageContent"]')
  if (msgContent) parts.push(msgContent.innerText)

  // Embeds — title, description, field names+values, footer
  el.querySelectorAll('[class*="embedWrapper"], [class*="embed"]').forEach(embed => {
    embed.querySelectorAll([
      '[class*="embedTitle"]',
      '[class*="embedDescription"]',
      '[class*="embedFieldName"]',
      '[class*="embedFieldValue"]',
      '[class*="embedFooterText"]',
      '[class*="embedProvider"]',
      '[class*="embedAuthorName"]',
      'a[class*="anchor"]',         // linked titles inside embeds
    ].join(',')).forEach(node => parts.push(node.innerText))
  })

  return parts.join(' ')
}

function checkMessage(el) {
  if (!keywords.length) return
  const id = el.id || el.getAttribute('data-message-id')
  if (id && alerted.has(id)) return

  const text = extractMessageText(el)
  if (!text.trim()) return
  const lower = text.toLowerCase()
  const matched = keywords.find(kw => lower.includes(kw))
  if (!matched) return

  if (id) alerted.add(id)
  if (alerted.size > 500) {
    const first = alerted.values().next().value
    alerted.delete(first)
  }

  const channelEl = document.querySelector('[class*="channelName"]')
                 || document.querySelector('h2[class*="title"]')
                 || document.querySelector('[class*="header"] h1')
                 || document.querySelector('[class*="titleWrapper"] h1')
  const channel = channelEl ? channelEl.innerText.trim() : 'Discord'

  // Build a clean preview from embed fields if present
  const embedTitle = el.querySelector('[class*="embedTitle"]')?.innerText || ''
  const preview = embedTitle || text.slice(0, 300)

  fetch(`http://localhost:${PORT}/discord-alert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      keyword: matched,
      text: preview.slice(0, 500),
      channel,
      url: window.location.href,
      timestamp: new Date().toISOString()
    })
  }).catch(() => {})
}

let observer = null

function startObserver() {
  if (observer) observer.disconnect()
  const root = document.querySelector('[class*="messagesWrapper"]')
            || document.querySelector('[class*="chatContent"]')
            || document.querySelector('main')
            || document.body

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue
        const items = node.matches?.('[id^="chat-messages-"]')
          ? [node]
          : (node.querySelectorAll?.('[id^="chat-messages-"]') || [])
        for (const item of items) checkMessage(item)
      }
    }
  })

  observer.observe(root, { childList: true, subtree: true })
}

// Start after Discord has rendered
setTimeout(startObserver, 2000)

// Re-attach observer when navigating between channels
let lastUrl = location.href
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href
    setTimeout(startObserver, 1500)
  }
}).observe(document, { subtree: true, childList: true })
