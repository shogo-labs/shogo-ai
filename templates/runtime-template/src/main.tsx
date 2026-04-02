// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// The iframe loads directly from the agent runtime (same origin), so
// fetch('/api/...') and the SSE stream resolve without any proxy rewriting.

// Auto-reload when the agent rebuilds the app.
const es = new EventSource('/agent/canvas/stream')
let ready = false
es.onmessage = (e) => {
  try {
    const evt = JSON.parse(e.data)
    if (evt.type === 'init') { ready = true; return }
    if (evt.type === 'reload' && ready) window.location.reload()
  } catch {}
}

// ---------------------------------------------------------------------------
// Parent bridge — receive theme + other messages from the host app
// ---------------------------------------------------------------------------

function applyCanvasTheme(variables: Record<string, string>, isDark: boolean) {
  const el = document.documentElement

  el.classList.toggle('dark', isDark)

  for (const [key, triplet] of Object.entries(variables)) {
    const value = `rgb(${triplet})`
    el.style.setProperty(key, value)
    // Also set the base variable (e.g. --background for --color-background)
    // so Tailwind v4's @theme inline mapping stays consistent.
    if (key.startsWith('--color-')) {
      el.style.setProperty(`--${key.slice(8)}`, value)
    }
  }
}

window.addEventListener('message', (e) => {
  const msg = e.data
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'canvas-theme') {
    applyCanvasTheme(msg.variables, msg.isDark)
  }
})

// ---------------------------------------------------------------------------

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(<App />)
}

// Signal the parent that we're ready to receive messages.
if (window.parent !== window) {
  window.parent.postMessage({ type: 'canvas-ready' }, '*')
}
