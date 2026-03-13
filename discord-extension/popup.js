const PORT = 7429

chrome.storage.sync.get(['keywords'], (result) => {
  document.getElementById('keywords').value = result.keywords || ''
})

document.getElementById('save').addEventListener('click', () => {
  const val = document.getElementById('keywords').value.trim()
  chrome.storage.sync.set({ keywords: val }, () => {
    const status = document.getElementById('status')
    status.textContent = 'Saved!'
    setTimeout(() => { status.textContent = '' }, 1500)
  })
})

// Check if Resell Tracker app is running
fetch(`http://localhost:${PORT}/ping`)
  .then(r => r.ok ? r.text() : Promise.reject())
  .then(() => {
    document.getElementById('app-dot').classList.add('online')
    document.getElementById('app-label').textContent = 'Resell Tracker is running'
  })
  .catch(() => {
    document.getElementById('app-label').textContent = 'App not detected — open Resell Tracker'
  })
