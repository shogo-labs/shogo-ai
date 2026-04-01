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

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(<App />)
}
