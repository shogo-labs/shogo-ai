// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * preview-views.ts — Per-project `WebContentsView` overlay registry.
 *
 * The "external preview" feature lets users embed a real Chromium view of
 * their own dev server (e.g. `http://localhost:5173`) inside the project
 * page. We use `WebContentsView` rather than a plain `<iframe>` because it
 * sidesteps every iframe restriction (`X-Frame-Options`, CSP
 * `frame-ancestors`, mixed-content, cookie partitioning) — exactly the
 * trick the VS Code Simple Browser and Cursor Browser pull. The trade-off
 * is that the view lives outside the React tree as an absolutely-positioned
 * overlay; React publishes a bounding rect via IPC and main keeps the view
 * aligned.
 *
 * The registry caches one view per `projectId`. Visibility toggles cheaply
 * (zero-sized bounds + `setVisible(false)`) so switching projects or
 * preview tabs does not need to recreate the view.
 *
 * Trust boundary: by default only `localhost` / `127.0.0.1` / `[::1]` /
 * `*.localhost` hosts are accepted. The renderer is expected to gate
 * non-local URLs behind the workspace-trust modal; main does NOT inspect
 * Shogo's project trust state itself.
 */

import { BrowserWindow, WebContentsView, shell, session } from 'electron'

export interface PreviewBounds {
  x: number
  y: number
  width: number
  height: number
}

export type PreviewEventName = 'url-changed' | 'load-failed' | 'title-changed' | 'loading-changed'

export interface PreviewEvent {
  projectId: string
  event: PreviewEventName
  url?: string
  title?: string
  errorCode?: number
  errorDescription?: string
  loading?: boolean
}

interface PreviewRecord {
  view: WebContentsView
  /** Owner window. We detach on window-close to avoid dangling references. */
  ownerWindow: BrowserWindow
  /** Last bounds the renderer asked for; replayed on attach. */
  lastBounds: PreviewBounds | null
  /** Whether the view is currently in the window's content-view list. */
  attached: boolean
  visible: boolean
}

const views = new Map<string, PreviewRecord>()
const eventListeners = new Set<(ev: PreviewEvent) => void>()

function isLocalHost(host: string): boolean {
  if (!host) return false
  const lower = host.toLowerCase()
  if (lower === 'localhost') return true
  if (lower === '127.0.0.1') return true
  if (lower === '[::1]' || lower === '::1') return true
  if (lower === '0.0.0.0') return true
  if (lower === '[::]' || lower === '::') return true
  if (lower.endsWith('.localhost')) return true
  return false
}

/**
 * Whether a URL is permitted to load in a preview view. By default we
 * only accept local hosts; the renderer can pass `allowNonLocal: true`
 * after it has confirmed the project is in `trusted` mode.
 *
 * Validation happens on both sides of the IPC boundary: the API
 * (`apps/api/src/routes/external-preview.ts`) also refuses to persist
 * non-local URLs without trust, so a stale renderer can't sneak past
 * the gate.
 */
export function isPreviewUrlAllowed(
  rawUrl: string,
  opts: { allowNonLocal?: boolean } = {},
): { ok: boolean; reason?: string } {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { ok: false, reason: 'empty-url' }
  }
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'invalid-url' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported-protocol' }
  }
  if (!isLocalHost(parsed.hostname) && !opts.allowNonLocal) {
    return { ok: false, reason: 'trust-required' }
  }
  return { ok: true }
}

function emit(ev: PreviewEvent): void {
  for (const cb of eventListeners) {
    try {
      cb(ev)
    } catch (err) {
      console.warn('[preview] event listener threw:', err)
    }
  }
}

export function onPreviewEvent(cb: (ev: PreviewEvent) => void): () => void {
  eventListeners.add(cb)
  return () => {
    eventListeners.delete(cb)
  }
}

function createView(projectId: string, ownerWindow: BrowserWindow): PreviewRecord {
  // Per-project persistent partition so cookies/localStorage from one
  // user's dev server don't bleed into another's. `persist:` prefix
  // makes it survive across app launches.
  const partition = `persist:shogo-preview-${projectId}`
  const previewSession = session.fromPartition(partition)

  const view = new WebContentsView({
    webPreferences: {
      session: previewSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // No preload script — this is loading the user's own dev server,
      // not Shogo's UI. The whole point is "embed and observe", not
      // "inject scripts into their app".
    },
  })

  // Open any window.open() / target="_blank" link in the system browser
  // rather than spawning new Electron windows we'd have to manage.
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url).catch(() => {})
    }
    return { action: 'deny' }
  })

  view.webContents.on('did-navigate', (_e, url) => {
    emit({ projectId, event: 'url-changed', url })
  })
  view.webContents.on('did-navigate-in-page', (_e, url) => {
    emit({ projectId, event: 'url-changed', url })
  })
  view.webContents.on('did-start-loading', () => {
    emit({ projectId, event: 'loading-changed', loading: true })
  })
  view.webContents.on('did-stop-loading', () => {
    emit({ projectId, event: 'loading-changed', loading: false })
  })
  view.webContents.on('page-title-updated', (_e, title) => {
    emit({ projectId, event: 'title-changed', title })
  })
  view.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    emit({
      projectId,
      event: 'load-failed',
      url: validatedURL,
      errorCode,
      errorDescription,
    })
  })

  const record: PreviewRecord = {
    view,
    ownerWindow,
    lastBounds: null,
    attached: false,
    visible: true,
  }
  views.set(projectId, record)
  return record
}

function clampBounds(b: PreviewBounds): PreviewBounds {
  return {
    x: Math.max(0, Math.round(b.x)),
    y: Math.max(0, Math.round(b.y)),
    width: Math.max(0, Math.round(b.width)),
    height: Math.max(0, Math.round(b.height)),
  }
}

function applyBounds(rec: PreviewRecord): void {
  if (!rec.attached || !rec.visible || !rec.lastBounds) {
    // Tuck off-screen rather than fully detaching so we don't lose
    // navigation state on quick visibility flips.
    rec.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    return
  }
  try {
    rec.view.setBounds(clampBounds(rec.lastBounds))
  } catch (err) {
    console.warn('[preview] setBounds failed:', err)
  }
}

function ensureAttached(rec: PreviewRecord): void {
  if (rec.attached || rec.ownerWindow.isDestroyed()) return
  try {
    rec.ownerWindow.contentView.addChildView(rec.view)
    rec.attached = true
    applyBounds(rec)
  } catch (err) {
    console.error('[preview] attach failed:', err)
  }
}

function detach(rec: PreviewRecord): void {
  if (!rec.attached) return
  try {
    rec.ownerWindow.contentView.removeChildView(rec.view)
  } catch (err) {
    console.warn('[preview] detach failed:', err)
  }
  rec.attached = false
}

/**
 * Open or update the preview view for `projectId`. Idempotent: calling
 * with the same URL is a no-op; calling with a new URL navigates.
 */
export function openPreview(
  projectId: string,
  url: string,
  ownerWindow: BrowserWindow,
  opts: { allowNonLocal?: boolean } = {},
): { ok: true } | { ok: false; error: string } {
  if (!projectId) return { ok: false, error: 'project-id-required' }
  const allowed = isPreviewUrlAllowed(url, opts)
  if (!allowed.ok) return { ok: false, error: allowed.reason || 'url-not-allowed' }
  if (ownerWindow.isDestroyed()) return { ok: false, error: 'window-destroyed' }

  let rec = views.get(projectId)
  if (!rec) {
    rec = createView(projectId, ownerWindow)
  } else if (rec.ownerWindow !== ownerWindow) {
    // Window changed (unlikely in single-window Shogo, but handle it):
    // detach from the old window and rebind. We don't recreate the
    // webContents — that would discard the page state.
    detach(rec)
    rec.ownerWindow = ownerWindow
  }

  ensureAttached(rec)

  const current = rec.view.webContents.getURL()
  if (current !== url) {
    rec.view.webContents.loadURL(url).catch((err) => {
      emit({
        projectId,
        event: 'load-failed',
        url,
        errorDescription: err instanceof Error ? err.message : String(err),
      })
    })
  }
  return { ok: true }
}

export function setPreviewBounds(projectId: string, bounds: PreviewBounds): void {
  const rec = views.get(projectId)
  if (!rec) return
  rec.lastBounds = bounds
  applyBounds(rec)
}

export function setPreviewVisible(projectId: string, visible: boolean): void {
  const rec = views.get(projectId)
  if (!rec) return
  rec.visible = visible
  if (visible) {
    ensureAttached(rec)
  } else {
    // Keep the webContents alive so navigation state survives a tab
    // switch; just hide it by zeroing bounds. We deliberately don't
    // call detach() here so HMR remounts feel instant.
    applyBounds(rec)
  }
}

export function reloadPreview(projectId: string): void {
  views.get(projectId)?.view.webContents.reload()
}

export function goBackPreview(projectId: string): void {
  const wc = views.get(projectId)?.view.webContents
  if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
}

export function goForwardPreview(projectId: string): void {
  const wc = views.get(projectId)?.view.webContents
  if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
}

export function getPreviewState(projectId: string): {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
} | null {
  const rec = views.get(projectId)
  if (!rec) return null
  const wc = rec.view.webContents
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
  }
}

export function closePreview(projectId: string): void {
  const rec = views.get(projectId)
  if (!rec) return
  detach(rec)
  try {
    // Stop in-flight loads first so we don't get a `did-fail-load` after
    // the listeners have gone.
    rec.view.webContents.stop()
  } catch {}
  try {
    rec.view.webContents.close()
  } catch (err) {
    console.warn('[preview] webContents.close failed:', err)
  }
  views.delete(projectId)
}

/**
 * Destroy every view owned by `window`. Call from `window.on('closed')`
 * to avoid leaking WebContents.
 */
export function closeAllForWindow(window: BrowserWindow): void {
  for (const [projectId, rec] of [...views.entries()]) {
    if (rec.ownerWindow === window) closePreview(projectId)
  }
}
