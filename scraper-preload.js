// Runs in the hidden scraper BrowserWindow BEFORE any page code.
// Wraps window.fetch and XMLHttpRequest so every network response
// the carrier page makes gets forwarded to the main process.
const { ipcRenderer } = require('electron')

// ── Intercept fetch ───────────────────────────────────────────────────────────
const _fetch = window.fetch
window.fetch = async function () {
  const res = await _fetch.apply(this, arguments)
  try {
    const clone = res.clone()
    const text  = await clone.text()
    const url   = (arguments[0]?.url || arguments[0] || '').toString()
    if (text && text.length > 30) {
      ipcRenderer.send('scraper:data', { url, text: text.slice(0, 120000) })
    }
  } catch {}
  return res
}

// ── Intercept XMLHttpRequest ──────────────────────────────────────────────────
const _xhrSend = XMLHttpRequest.prototype.send
XMLHttpRequest.prototype.send = function () {
  this.addEventListener('load', () => {
    try {
      if (this.responseText && this.responseText.length > 30) {
        ipcRenderer.send('scraper:data', {
          url:  this.responseURL || '',
          text: this.responseText.slice(0, 120000)
        })
      }
    } catch {}
  }, { once: true })
  _xhrSend.apply(this, arguments)
}
