// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Shogo Canvas Bridge
// ---------------------------------------------------------------------------
// Served live by the agent-runtime at GET /agent/canvas/bridge.js and
// injected into every workspace HTML response. Owns all iframe-side infra:
//   - update toast (with animated glowing outline)
//   - SSE listener for agent rebuild events (-> show toast)
//   - parent <-> iframe theme + capability bridge
//   - async error forwarding to the parent
//   - canvas-ready handshake
//
// User workspaces ship a slim `src/main.tsx` that ONLY renders <App />.
// Updating this file is enough to push iframe behavior to every project on
// next page load — no template re-seed, no per-project rebuild required.
//
// Plain JS (no TS, no JSX, no build step) so the runtime can serve it
// verbatim. IIFE + global flag guards against double execution.
// ---------------------------------------------------------------------------

(function () {
  if (window.__shogoCanvasBridgeLoaded) return
  window.__shogoCanvasBridgeLoaded = true

  // -------------------------------------------------------------------------
  // Update toast
  // -------------------------------------------------------------------------

  var TOAST_ID = '__shogo-update-toast'
  var TOAST_STYLE_ID = '__shogo-toast-styles'

  function injectToastStyles() {
    if (document.getElementById(TOAST_STYLE_ID)) return
    var style = document.createElement('style')
    style.id = TOAST_STYLE_ID
    style.textContent = [
      '@property --__shogo-toast-angle {',
      "  syntax: '<angle>';",
      '  initial-value: 0deg;',
      '  inherits: false;',
      '}',
      '@keyframes __shogo-slide-up {',
      '  from { opacity: 0; transform: translate(-50%, 12px); }',
      '  to   { opacity: 1; transform: translate(-50%, 0); }',
      '}',
      '@keyframes __shogo-rotate-angle {',
      '  to { --__shogo-toast-angle: 360deg; }',
      '}',
      '@keyframes __shogo-pulse-glow {',
      '  0%, 100% {',
      '    box-shadow:',
      '      0 4px 24px oklch(0 0 0 / 0.18),',
      '      0 0 18px oklch(0.7 0.22 280 / 0.45),',
      '      0 0 36px oklch(0.72 0.22 320 / 0.25);',
      '  }',
      '  50% {',
      '    box-shadow:',
      '      0 4px 24px oklch(0 0 0 / 0.18),',
      '      0 0 28px oklch(0.72 0.24 280 / 0.7),',
      '      0 0 56px oklch(0.74 0.24 320 / 0.4);',
      '  }',
      '}',
      '#' + TOAST_ID + ' {',
      '  position: fixed;',
      '  bottom: 16px;',
      '  left: 50%;',
      '  transform: translateX(-50%);',
      '  z-index: 2147483647;',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 10px;',
      '  padding: 8px 12px 8px 16px;',
      '  border-radius: 999px;',
      '  border: 2px solid transparent;',
      '  background:',
      '    linear-gradient(',
      '      oklch(from var(--background, #fff) l c h / 0.88),',
      '      oklch(from var(--background, #fff) l c h / 0.88)',
      '    ) padding-box,',
      '    conic-gradient(',
      '      from var(--__shogo-toast-angle),',
      '      oklch(0.7 0.22 280),',
      '      oklch(0.75 0.22 320),',
      '      oklch(0.78 0.2 30),',
      '      oklch(0.82 0.2 80),',
      '      oklch(0.78 0.18 180),',
      '      oklch(0.7 0.22 240),',
      '      oklch(0.7 0.22 280)',
      '    ) border-box;',
      '  color: var(--foreground, #111);',
      "  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;",
      '  font-size: 13px;',
      '  line-height: 1;',
      '  backdrop-filter: blur(16px);',
      '  -webkit-backdrop-filter: blur(16px);',
      '  box-shadow:',
      '    0 4px 24px oklch(0 0 0 / 0.18),',
      '    0 0 18px oklch(0.7 0.22 280 / 0.45),',
      '    0 0 36px oklch(0.72 0.22 320 / 0.25);',
      '  animation:',
      '    __shogo-slide-up 0.25s ease-out,',
      '    __shogo-rotate-angle 3s linear infinite,',
      '    __shogo-pulse-glow 2s ease-in-out infinite;',
      '  pointer-events: auto;',
      '}',
      '#' + TOAST_ID + ' button {',
      '  border: none;',
      '  cursor: pointer;',
      '  font-family: inherit;',
      '  font-size: 13px;',
      '  line-height: 1;',
      '  border-radius: 999px;',
      '  padding: 6px 14px;',
      '  font-weight: 600;',
      '}',
      '#' + TOAST_ID + ' .refresh-btn {',
      '  background: var(--primary, #111);',
      '  color: var(--primary-foreground, #fff);',
      '}',
      '#' + TOAST_ID + ' .dismiss-btn {',
      '  background: transparent;',
      '  color: var(--muted-foreground, #888);',
      '  padding: 4px 6px;',
      '  font-size: 15px;',
      '  line-height: 1;',
      '}',
      '#' + TOAST_ID + ' .dismiss-btn:hover {',
      '  color: var(--foreground, #111);',
      '}',
    ].join('\n')
    document.head.appendChild(style)
  }

  // Transient "Updating…" pill shown *while* the auto-reload is in flight.
  // We deliberately no longer expose a manual "Refresh" button — the canvas
  // is agent-driven, so the moment a rebuild lands the user expects to see
  // it. The pill exists purely for affordance so the swap isn't a
  // mysterious flash.
  function showUpdatingPill() {
    if (document.getElementById(TOAST_ID)) return
    injectToastStyles()
    var toastEl = document.createElement('div')
    toastEl.id = TOAST_ID
    var label = document.createElement('span')
    label.textContent = 'Updating\u2026'
    toastEl.appendChild(label)
    document.body.appendChild(toastEl)
  }

  // -------------------------------------------------------------------------
  // SSE listener — rebuild events from the agent runtime
  // -------------------------------------------------------------------------
  //
  // Behavior:
  //   1. Server replays an `init` event on connect — gate live updates on it
  //      so the very first message can't double-reload.
  //   2. On `reload`, debounce ~250ms (a single rebuild can fan out into
  //      multiple file-watcher events) then `window.location.reload()`.
  //   3. If the tab is hidden (e.g. user is on a different IDE tab inside
  //      the canvas), defer the reload until visibility returns so we don't
  //      thrash backgrounded previews.
  //   4. Show a transient "Updating…" pill while the reload is in flight so
  //      the swap has an affordance and doesn't feel like a random flash.
  //
  // This is the source of truth for live-refresh — the parent <CanvasWebView />
  // explicitly does NOT remount the iframe on rebuild (see comment in
  // CanvasWebView.tsx). All other refresh paths (tab switch unmounting the
  // iframe, manual page refresh) were workarounds for this handler showing a
  // manual "Refresh" toast instead of actually reloading. They still work,
  // but should no longer be necessary.

  var RELOAD_DEBOUNCE_MS = 250
  var reloadTimer = null
  var reloadPending = false
  var reloadInFlight = false

  function scheduleReload() {
    if (reloadInFlight) return
    reloadPending = true
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(performReloadIfVisible, RELOAD_DEBOUNCE_MS)
  }

  function performReloadIfVisible() {
    if (!reloadPending) return
    if (typeof document !== 'undefined' && document.hidden) {
      // Wait for the tab to come back into focus — visibilitychange handler
      // below will call us again.
      return
    }
    reloadPending = false
    reloadInFlight = true
    showUpdatingPill()
    // Defer one frame so the pill paints before the navigation tears down
    // the document.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { window.location.reload() })
    } else {
      window.location.reload()
    }
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && reloadPending) performReloadIfVisible()
    })
  }

  try {
    var es = new EventSource('/agent/canvas/stream')
    var ready = false
    es.onmessage = function (e) {
      try {
        var evt = JSON.parse(e.data)
        if (evt && evt.type === 'init') { ready = true; return }
        if (evt && evt.type === 'reload' && ready) scheduleReload()
      } catch (_err) { /* ignore malformed events */ }
    }
  } catch (_err) {
    // Older browsers without EventSource: degrade gracefully (no live reload).
  }

  // -------------------------------------------------------------------------
  // Parent bridge — receive theme + other messages from the host app
  // -------------------------------------------------------------------------

  function applyCanvasTheme(variables, isDark) {
    var el = document.documentElement
    el.classList.toggle('dark', !!isDark)
    if (!variables || typeof variables !== 'object') return
    var keys = Object.keys(variables)
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i]
      var triplet = variables[key]
      var value = 'rgb(' + triplet + ')'
      el.style.setProperty(key, value)
      // Also set the base variable (e.g. --background for --color-background)
      // so Tailwind v4's @theme inline mapping stays consistent.
      if (key.indexOf('--color-') === 0) {
        el.style.setProperty('--' + key.slice(8), value)
      }
    }
  }

  window.addEventListener('message', function (e) {
    var msg = e.data
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'canvas-theme') {
      applyCanvasTheme(msg.variables, msg.isDark)
    }
  })

  // -------------------------------------------------------------------------
  // Capability detection — report to parent whether the app uses theming
  // -------------------------------------------------------------------------

  function detectThemeSupport() {
    var sheets = document.styleSheets
    for (var i = 0; i < sheets.length; i++) {
      var sheet = sheets[i]
      try {
        var rules = sheet.cssRules
        for (var j = 0; j < rules.length; j++) {
          var text = rules[j].cssText
          if (
            text.indexOf('.dark') !== -1 ||
            text.indexOf('var(--color-') !== -1 ||
            text.indexOf('var(--background') !== -1 ||
            text.indexOf('var(--foreground') !== -1 ||
            text.indexOf('var(--primary') !== -1 ||
            text.indexOf('var(--muted') !== -1 ||
            text.indexOf('var(--border') !== -1 ||
            text.indexOf('var(--card') !== -1 ||
            text.indexOf('var(--accent') !== -1
          ) {
            return true
          }
        }
      } catch (_err) { /* cross-origin stylesheet — skip */ }
    }
    return !!document.querySelector('[class*="dark:"]')
  }

  function reportCapabilities() {
    if (window.parent === window) return
    try {
      window.parent.postMessage({
        type: 'canvas-capabilities',
        supportsTheme: detectThemeSupport(),
      }, '*')
    } catch (_err) { /* ignore */ }
  }

  // -------------------------------------------------------------------------
  // Recent-action breadcrumb buffer — captures the last few user
  // interactions (clicks, form submits/changes, route navigations) so an
  // error report can show what the user did immediately before the
  // crash. Lives only in iframe memory and is shipped only as part of a
  // canvas-error postMessage. Input *values* are deliberately omitted to
  // avoid leaking passwords / PII into the chat seed.
  // -------------------------------------------------------------------------

  var RECENT_ACTIONS_CAP = 10
  var ACTION_TARGET_MAX = 120
  var recentActions = []
  var lastRoute = (function () {
    try { return location.pathname + location.search + location.hash }
    catch (_err) { return '' }
  })()

  function currentRoute() {
    try { return location.pathname + location.search + location.hash }
    catch (_err) { return '' }
  }

  function truncateAction(s) {
    if (typeof s !== 'string') return ''
    if (s.length <= ACTION_TARGET_MAX) return s
    return s.slice(0, ACTION_TARGET_MAX - 1) + '\u2026'
  }

  function pushAction(entry) {
    if (!entry) return
    entry.ts = Date.now()
    entry.route = currentRoute()
    if (entry.target) entry.target = truncateAction(entry.target)
    recentActions.push(entry)
    if (recentActions.length > RECENT_ACTIONS_CAP) {
      recentActions.splice(0, recentActions.length - RECENT_ACTIONS_CAP)
    }
  }

  function describeClickTarget(el) {
    // Walk up to the closest interactive ancestor so a click on an icon
    // inside a button reports the button.
    var node = el
    var depth = 0
    while (node && node !== document.body && depth < 8) {
      var tag = node.tagName ? node.tagName.toLowerCase() : ''
      var role = node.getAttribute && node.getAttribute('role')
      var isInteractive =
        tag === 'button' ||
        tag === 'a' ||
        tag === 'input' ||
        tag === 'select' ||
        tag === 'textarea' ||
        tag === 'label' ||
        tag === 'summary' ||
        role === 'button' ||
        role === 'link' ||
        role === 'menuitem' ||
        role === 'tab' ||
        role === 'option'
      if (isInteractive) {
        var label =
          (node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('title'))) ||
          (node.textContent || '').trim().replace(/\s+/g, ' ') ||
          (node.getAttribute && node.getAttribute('name')) ||
          (node.id ? '#' + node.id : '')
        var descriptor = label ? '"' + label + '"' : ''
        var typeAttr = tag === 'input' && node.getAttribute ? node.getAttribute('type') : ''
        var tagDesc = typeAttr ? tag + '[' + typeAttr + ']' : tag
        return (descriptor ? descriptor + ' (' + tagDesc + ')' : tagDesc)
      }
      node = node.parentNode
      depth++
    }
    return null
  }

  function describeFormTarget(form) {
    if (!form) return null
    var id = form.id ? '#' + form.id : ''
    var name = form.getAttribute && form.getAttribute('name')
    var action = form.getAttribute && form.getAttribute('action')
    return id || (name ? '[name=' + name + ']' : '') || (action ? action : 'form')
  }

  function describeFieldTarget(field) {
    if (!field) return null
    var tag = field.tagName ? field.tagName.toLowerCase() : 'field'
    var name = field.getAttribute && field.getAttribute('name')
    var id = field.id ? '#' + field.id : ''
    var type = tag === 'input' && field.getAttribute ? field.getAttribute('type') : ''
    var key = name ? '[name=' + name + ']' : id || ''
    var tagDesc = type ? tag + '[' + type + ']' : tag
    return key ? key + ' (' + tagDesc + ')' : tagDesc
  }

  // Click — capture phase so we record the interaction even if a handler
  // calls stopPropagation before it bubbles back to window.
  window.addEventListener('click', function (e) {
    var target = e.target
    var desc = target && target.nodeType === 1 ? describeClickTarget(target) : null
    if (!desc) return
    pushAction({ kind: 'click', target: desc })
  }, true)

  window.addEventListener('submit', function (e) {
    var desc = describeFormTarget(e.target)
    if (!desc) return
    pushAction({ kind: 'submit', target: desc })
  }, true)

  window.addEventListener('change', function (e) {
    var desc = describeFieldTarget(e.target)
    if (!desc) return
    pushAction({ kind: 'change', target: desc })
  }, true)

  // Navigation — pushState/replaceState don't fire any event, so monkey
  // patch them. popstate / hashchange cover back/forward + hash routers.
  function recordNavigation(to) {
    var from = lastRoute
    var dest = to || currentRoute()
    if (dest === from) return
    pushAction({ kind: 'navigate', target: (from || '/') + ' -> ' + (dest || '/') })
    lastRoute = dest
  }

  try {
    var origPush = history.pushState
    var origReplace = history.replaceState
    history.pushState = function () {
      var ret = origPush.apply(this, arguments)
      recordNavigation(currentRoute())
      return ret
    }
    history.replaceState = function () {
      var ret = origReplace.apply(this, arguments)
      recordNavigation(currentRoute())
      return ret
    }
  } catch (_err) { /* sealed history — skip */ }

  window.addEventListener('popstate', function () { recordNavigation(currentRoute()) })
  window.addEventListener('hashchange', function () { recordNavigation(currentRoute()) })

  // -------------------------------------------------------------------------
  // Async error reporting — React error boundaries don't catch errors from
  // event handlers, setTimeout, async functions, or promise rejections.
  // Forward them to the parent so the agent can surface/fix them.
  // -------------------------------------------------------------------------

  function reportErrorToParent(error, phase) {
    if (window.parent === window) return
    try {
      window.parent.postMessage({
        type: 'canvas-error',
        phase: phase || 'runtime',
        error: error,
        route: currentRoute(),
        recentActions: recentActions.slice(),
      }, '*')
    } catch (_err) { /* ignore */ }
  }

  window.addEventListener('error', function (e) {
    var stack = (e.error && e.error.stack) || ''
    reportErrorToParent((e.message + '\n' + stack).trim())
  })

  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason
    var text
    if (typeof r === 'string') {
      text = r
    } else {
      var msg = (r && r.message) || String(r)
      var stack = (r && r.stack) || ''
      text = (msg + '\n' + stack).trim()
    }
    reportErrorToParent(text)
  })

  // -------------------------------------------------------------------------
  // canvas-ready handshake — signal the parent that we can receive messages.
  // The bridge runs as a deferred classic script, which executes BEFORE the
  // user's ES module main.tsx. Posting canvas-ready here means the parent
  // can push the theme before React's first paint, avoiding FOUC.
  // -------------------------------------------------------------------------

  if (window.parent !== window) {
    try {
      window.parent.postMessage({ type: 'canvas-ready' }, '*')
    } catch (_err) { /* ignore */ }
    // Allow user styles to finish loading before detecting capabilities.
    setTimeout(reportCapabilities, 500)
  }
})()
