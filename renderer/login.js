const btn    = document.getElementById('btn-login')
const status = document.getElementById('login-status')

function setStatus(msg, type = 'waiting') {
  status.textContent = msg
  status.className   = `login-status ${type}`
}

btn.addEventListener('click', async () => {
  btn.disabled = true
  setStatus('Opening Discord… approve in your browser.', 'waiting')

  try {
    const result = await window.api.auth.login()

    if (result.success) {
      setStatus('✓ Authorized! Loading…', 'success')
      setTimeout(() => window.api.auth.loadMain(), 800)
      return
    }

    if (result.error === 'no_subscription') {
      setStatus('No active subscription found. Make sure you have the Subscriber role in the Discord server.', 'error')
    } else {
      setStatus(`Login failed: ${result.error || 'unknown error'}`, 'error')
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error')
  }

  btn.disabled = false
})
