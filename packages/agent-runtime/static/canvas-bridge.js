// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Shogo Canvas Bridge
// ---------------------------------------------------------------------------
// Served live by the agent-runtime at GET /agent/canvas/bridge.js and
// injected into every workspace HTML response. Owns all iframe-side infra:
//   - update bar (drawn by the host above the preview, or a slim top bar in
//     the document when no host is present)
//   - SSE listener for agent rebuild events (-> update bar)
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
  // Phone / narrow preview layout
  // -------------------------------------------------------------------------
  // Agent UIs are often authored as desktop dashboards (`grid-cols-2/3/4`).
  // Studio desktop iframes stay wide, so these rules only apply at
  // CANVAS_PHONE_MAX_WIDTH_PX (Studio's phone / narrow preview breakpoint).
  // Existing canvases pick this up on reload — no per-project rebuild.
  var RESPONSIVE_STYLE_ID = '__shogo-canvas-responsive'
  // Keep this in sync with apps/mobile/lib/native-phone-layout.ts.
  var CANVAS_PHONE_MAX_WIDTH_PX = 767
  var FLEX_VIEWPORT_SHELLS = [
    '.flex.h-screen',
    '.flex.min-h-screen',
    '.flex.h-dvh',
    '.flex.min-h-dvh',
  ]

  function injectStyleTag(id, css) {
    if (document.getElementById(id)) return
    var style = document.createElement('style')
    style.id = id
    style.textContent = css
    ;(document.head || document.documentElement).appendChild(style)
  }

  injectStyleTag(RESPONSIVE_STYLE_ID, [
    'html, body { max-width: 100%; }',
    '@media (max-width: ' + CANVAS_PHONE_MAX_WIDTH_PX + 'px) {',
    '  html, body { overflow-x: hidden; }',
    '  .grid.grid-cols-2,',
    '  .grid.grid-cols-3,',
    '  .grid.grid-cols-4,',
    '  .grid.grid-cols-5,',
    '  .grid.grid-cols-6 {',
    '    grid-template-columns: repeat(1, minmax(0, 1fr)) !important;',
    '  }',
    '  .grid > * { min-width: 0; }',
    '  .truncate { overflow: visible; text-overflow: unset; white-space: normal; }',
    '  [role="tablist"] { overflow-x: auto; flex-wrap: nowrap; }',
    '  ' + FLEX_VIEWPORT_SHELLS.join(',\n  ') + ' {',
    '    flex-direction: column !important;',
    '    height: auto !important;',
    '    min-height: 100dvh;',
    '  }',
    '  ' + FLEX_VIEWPORT_SHELLS.map(function (sel) { return sel + ' > :first-child' }).join(',\n  ') + ' {',
    '    width: 100% !important;',
    '    max-width: 100% !important;',
    '    flex: none !important;',
    '  }',
    '}',
  ].join('\n'))

  // -------------------------------------------------------------------------
  // Update bar
  // -------------------------------------------------------------------------
  // A rebuild produced new output. The bar must never cover the user's app,
  // so when the host can draw it (Studio / the mobile app) the parent draws a
  // full-width bar ABOVE the preview and this document draws nothing. The
  // in-document bar is only the fallback for a standalone preview tab (or any
  // host that never acks), and it is pinned to the top instead of floating at
  // the bottom.

  var TOAST_ID = '__shogo-update-toast'
  var TOAST_STYLE_ID = '__shogo-toast-styles'

  // Set by a host that draws the bar itself: either before this script runs
  // (window.__shogoCanvasHostDrawsUpdateBar — the native WebView injection) or
  // by a `canvas-host` message from the parent frame.
  var hostDrawsUpdateBar = !!window.__shogoCanvasHostDrawsUpdateBar
  // A rebuild happened but no host ack had arrived yet. If one shows up later
  // we hand the update over instead of losing it.
  var updatePending = false

  function injectToastStyles() {
    if (document.getElementById(TOAST_STYLE_ID)) return
    var style = document.createElement('style')
    style.id = TOAST_STYLE_ID
    style.textContent = [
      '@keyframes __shogo-bar-fade-in {',
      '  from { opacity: 0; }',
      '  to   { opacity: 1; }',
      '}',
      '#' + TOAST_ID + ' {',
      '  position: fixed;',
      '  top: 0; left: 0; right: 0;',
      '  z-index: 2147483647;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  gap: 8px;',
      '  min-height: 28px;',
      '  box-sizing: border-box;',
      '  padding: 0 28px;',
      '  background: rgb(226 121 39);',
      '  color: #fff;',
      "  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;",
      '  font-size: 12px;',
      '  font-weight: 500;',
      '  line-height: 28px;',
      '  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);',
      '  animation: __shogo-bar-fade-in 0.15s ease-out;',
      '}',
      '#' + TOAST_ID + ' button {',
      '  border: none;',
      '  cursor: pointer;',
      '  font-family: inherit;',
      '  font-size: 12px;',
      '  line-height: 1;',
      '  color: #fff;',
      '}',
      '#' + TOAST_ID + ' .refresh-btn {',
      '  background: rgba(255, 255, 255, 0.2);',
      '  border-radius: 4px;',
      '  padding: 3px 8px;',
      '  font-weight: 600;',
      '}',
      '#' + TOAST_ID + ' .dismiss-btn {',
      '  position: absolute;',
      '  right: 4px;',
      '  top: 0;',
      '  bottom: 0;',
      '  background: transparent;',
      '  padding: 0 8px;',
      '  font-size: 14px;',
      '}',
      '#' + TOAST_ID + ' .dismiss-btn:hover {',
      '  color: rgba(255, 255, 255, 0.75);',
      '}',
    ].join('\n')
    document.head.appendChild(style)
  }

  function showUpdateBar() {
    // Cross-script dedup: if any prior bridge (e.g. an old embedded copy
    // baked into a stale main.tsx) already mounted a bar, don't add a
    // second one.
    if (document.getElementById(TOAST_ID)) return
    injectToastStyles()

    var barEl = document.createElement('div')
    barEl.id = TOAST_ID

    var label = document.createElement('span')
    label.textContent = 'Update available'

    var refreshBtn = document.createElement('button')
    refreshBtn.className = 'refresh-btn'
    refreshBtn.textContent = 'Refresh'
    refreshBtn.onclick = function () { window.location.reload() }

    var dismissBtn = document.createElement('button')
    dismissBtn.className = 'dismiss-btn'
    dismissBtn.textContent = '\u00d7'
    dismissBtn.setAttribute('aria-label', 'Dismiss')
    dismissBtn.onclick = function () {
      var el = document.getElementById(TOAST_ID)
      if (el) el.remove()
    }

    barEl.appendChild(label)
    barEl.appendChild(refreshBtn)
    barEl.appendChild(dismissBtn)
    document.body.appendChild(barEl)
  }

  function removeUpdateBar() {
    var el = document.getElementById(TOAST_ID)
    if (el) el.remove()
  }

  // Post to the embedding frame, or to our own window when this document is
  // top-level (the native WebView publishes window messages to React Native).
  function postToHost(msg) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(msg, '*')
      } else {
        window.postMessage(msg, '*')
      }
    } catch (_err) { /* ignore */ }
  }

  function onHostDrawsUpdateBar() {
    hostDrawsUpdateBar = true
    if (!updatePending) return
    // The rebuild landed before the host acknowledged it. Hand it over now and
    // drop the fallback bar so exactly one bar is ever visible.
    updatePending = false
    removeUpdateBar()
    postToHost({ type: 'canvas-update-available' })
  }

  function notifyUpdateAvailable() {
    updatePending = true
    if (hostDrawsUpdateBar) {
      updatePending = false
      postToHost({ type: 'canvas-update-available' })
      return
    }
    showUpdateBar()
  }

  // -------------------------------------------------------------------------
  // SSE listener — rebuild events from the agent runtime
  // With automatic reconnection and exponential backoff.
  // -------------------------------------------------------------------------

  var SSE_MAX_RETRY_MS = 30000
  var SSE_INITIAL_RETRY_MS = 1000
  var sseRetryDelay = SSE_INITIAL_RETRY_MS
  var sseReady = false

  function connectSSE() {
    try {
      var sse = new EventSource('/agent/canvas/stream')
      sse.onopen = function () {
        // Reset backoff on successful connection
        sseRetryDelay = SSE_INITIAL_RETRY_MS
      }
      sse.onmessage = function (e) {
        try {
          var evt = JSON.parse(e.data)
          if (evt && evt.type === 'init') { sseReady = true; return }
          if (evt && evt.type === 'reload' && sseReady) notifyUpdateAvailable()
        } catch (_err) { /* ignore malformed events */ }
      }
      sse.onerror = function () {
        // EventSource auto-reconnects natively, but if the connection
        // stays in error state we close and retry with backoff to avoid
        // hammering a dead server
        sse.close()
        setTimeout(function () {
          sseRetryDelay = Math.min(sseRetryDelay * 2, SSE_MAX_RETRY_MS)
          connectSSE()
        }, sseRetryDelay)
      }
    } catch (_err) {
      // Older browsers without EventSource: degrade gracefully (no live toasts).
      // Retry after backoff in case it's a transient error
      setTimeout(function () {
        sseRetryDelay = Math.min(sseRetryDelay * 2, SSE_MAX_RETRY_MS)
        connectSSE()
      }, sseRetryDelay)
    }
  }

  connectSSE()

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
    } else if (msg.type === 'canvas-host') {
      // The host draws the update bar itself (a row above the preview), so
      // this document must never draw its own.
      if (msg.updateBar === true) onHostDrawsUpdateBar()
    } else if (msg.type === 'canvas-reload') {
      // Reload on the current route/hash, exactly like the bar's Refresh.
      window.location.reload()
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

  // -------------------------------------------------------------------------
  // Stale-bundle self-heal — a browser tab (especially a standalone
  // `*.preview.shogo.ai` / `*.shogo.one` tab, not embedded in an iframe, so
  // `reportErrorToParent` above has nowhere to send the error) can hold an
  // old `index.html` whose <script>/<link> tags point at content-hashed
  // filenames an atomic rebuild has since deleted. Rather than leave the
  // user staring at a blank page, do exactly one reload per distinct failed
  // hashed URL: the fresh `index.html` the reload fetches points at the
  // *current* hashes, so this self-heals the common case. Guarded by
  // sessionStorage (not just an in-memory flag) so it survives the reload
  // and still stops after one attempt if the SAME url keeps failing —
  // i.e. this is a real deploy issue, not a stale cache.
  // -------------------------------------------------------------------------

  var STALE_ASSET_RELOAD_KEY = '__shogoStaleAssetReloadUrl'
  var staleAssetReloadAttemptedInMemory = false

  // Mirrors `isContentHashedFilename` in
  // packages/shared-runtime/src/static-asset-cache.ts. Only recognized
  // hashed bundle URLs are eligible for auto-reload — an unrelated broken
  // image or third-party resource should not trigger a page reload.
  function isContentHashedAssetUrl(url) {
    var path = String(url).split('?')[0].split('#')[0]
    var base = path.split('/').pop() || path
    return /[-_][A-Za-z0-9]{8,}\.[A-Za-z0-9]+$/.test(base)
  }

  function tryRecoverFromStaleAsset(url) {
    if (!url || !isContentHashedAssetUrl(url)) return false
    try {
      if (sessionStorage.getItem(STALE_ASSET_RELOAD_KEY) === url) return false
      sessionStorage.setItem(STALE_ASSET_RELOAD_KEY, url)
    } catch (_err) {
      // sessionStorage unavailable (e.g. a sandboxed iframe without
      // storage access) — fall back to an in-memory, once-per-page-load
      // guard so we still never loop within a single session.
      if (staleAssetReloadAttemptedInMemory) return false
      staleAssetReloadAttemptedInMemory = true
    }
    try { window.location.reload() } catch (_err) { /* ignore */ }
    return true
  }

  // Capture phase is required: a <script>/<link>/<img> that fails to fetch fires
  // a non-bubbling error event on the element, so a listener registered without
  // `true` never sees it. Without this, a main bundle that 404s or hangs leaves
  // the frame silently blank — the bridge itself loads and reports healthy.
  window.addEventListener('error', function (e) {
    var target = e.target
    if (target && target !== window && target.tagName) {
      var url = target.src || target.href || ''
      reportErrorToParent(
        'Failed to load ' + target.tagName.toLowerCase() + (url ? ': ' + url : ''),
      )
      tryRecoverFromStaleAsset(url)
      return
    }
    var stack = (e.error && e.error.stack) || ''
    reportErrorToParent((e.message + '\n' + stack).trim())
  }, true)

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
