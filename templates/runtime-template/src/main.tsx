// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// The iframe loads directly from the agent runtime (same origin), so
// fetch('/api/...') and the SSE stream resolve without any proxy rewriting.

// ---------------------------------------------------------------------------
// Update toast — shown when the agent rebuilds; user chooses when to refresh
// ---------------------------------------------------------------------------

const TOAST_ID = '__shogo-update-toast'

function injectToastStyles() {
  if (document.getElementById('__shogo-toast-styles')) return
  const style = document.createElement('style')
  style.id = '__shogo-toast-styles'
  style.textContent = `
    @keyframes __shogo-slide-up {
      from { opacity: 0; transform: translate(-50%, 12px); }
      to   { opacity: 1; transform: translate(-50%, 0); }
    }
    #${TOAST_ID} {
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px 8px 16px;
      border-radius: 999px;
      border: 1px solid var(--border, #e5e5e5);
      background: oklch(from var(--background, #fff) l c h / 0.85);
      color: var(--foreground, #111);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      line-height: 1;
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      box-shadow: 0 4px 24px oklch(0 0 0 / 0.12);
      animation: __shogo-slide-up 0.25s ease-out;
      pointer-events: auto;
    }
    #${TOAST_ID} button {
      border: none;
      cursor: pointer;
      font-family: inherit;
      font-size: 13px;
      line-height: 1;
      border-radius: 999px;
      padding: 6px 14px;
      font-weight: 600;
    }
    #${TOAST_ID} .refresh-btn {
      background: var(--primary, #111);
      color: var(--primary-foreground, #fff);
    }
    #${TOAST_ID} .dismiss-btn {
      background: transparent;
      color: var(--muted-foreground, #888);
      padding: 4px 6px;
      font-size: 15px;
      line-height: 1;
    }
    #${TOAST_ID} .dismiss-btn:hover {
      color: var(--foreground, #111);
    }
  `
  document.head.appendChild(style)
}

let toastEl: HTMLElement | null = null

function showUpdateToast() {
  if (toastEl && document.body.contains(toastEl)) return
  injectToastStyles()

  toastEl = document.createElement('div')
  toastEl.id = TOAST_ID

  const label = document.createElement('span')
  label.textContent = 'Update available'

  const refreshBtn = document.createElement('button')
  refreshBtn.className = 'refresh-btn'
  refreshBtn.textContent = 'Refresh'
  refreshBtn.onclick = () => window.location.reload()

  const dismissBtn = document.createElement('button')
  dismissBtn.className = 'dismiss-btn'
  dismissBtn.textContent = '\u00d7'
  dismissBtn.onclick = () => {
    toastEl?.remove()
    toastEl = null
  }

  toastEl.append(label, refreshBtn, dismissBtn)
  document.body.appendChild(toastEl)
}

// Listen to agent rebuild events via SSE.
const es = new EventSource('/agent/canvas/stream')
let ready = false
es.onmessage = (e) => {
  try {
    const evt = JSON.parse(e.data)
    if (evt.type === 'init') { ready = true; return }
    if (evt.type === 'reload' && ready) showUpdateToast()
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
// Capability detection — report to parent whether the app uses theming
// ---------------------------------------------------------------------------

function detectThemeSupport(): boolean {
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        const text = rule.cssText
        if (
          text.includes('.dark') ||
          text.includes('var(--color-') ||
          text.includes('var(--background') ||
          text.includes('var(--foreground') ||
          text.includes('var(--primary') ||
          text.includes('var(--muted') ||
          text.includes('var(--border') ||
          text.includes('var(--card') ||
          text.includes('var(--accent')
        ) {
          return true
        }
      }
    } catch { /* cross-origin stylesheet — skip */ }
  }
  return !!document.querySelector('[class*="dark:"]')
}

function reportCapabilities() {
  if (window.parent === window) return
  window.parent.postMessage({
    type: 'canvas-capabilities',
    supportsTheme: detectThemeSupport(),
  }, '*')
}

// ---------------------------------------------------------------------------

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(<App />)
}

// Signal the parent that we're ready to receive messages.
if (window.parent !== window) {
  window.parent.postMessage({ type: 'canvas-ready' }, '*')
  // Allow styles to finish loading before detecting capabilities.
  setTimeout(reportCapabilities, 500)
}
