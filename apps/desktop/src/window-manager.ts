// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { app, BrowserWindow, shell, type WebContents } from 'electron'
import path from 'path'
import { getApiPort, getApiUrl } from './local-server'

export type AppWindowKind = 'main' | 'app' | 'code-workbench'

export interface CodeWorkbenchWindowOptions {
  projectId?: string
  workspacePath?: string
}

export interface AppWindowRecord {
  id: number
  kind: AppWindowKind
  browserWindow: BrowserWindow
  createdAt: number
  lastFocusedAt: number
  codeWorkbench?: CodeWorkbenchWindowOptions
}

interface WindowManagerOptions {
  onWindowClosed?: (window: BrowserWindow, record: AppWindowRecord) => void
}

export class WindowManager {
  private readonly windows = new Map<number, AppWindowRecord>()
  private primaryWindowId: number | null = null

  constructor(private readonly options: WindowManagerOptions = {}) {}

  createPrimaryWindow(): BrowserWindow {
    return this.createWindow('main')
  }

  createAppWindow(): BrowserWindow {
    return this.createWindow('app')
  }

  createCodeWorkbenchWindow(options: CodeWorkbenchWindowOptions = {}): BrowserWindow {
    return this.createWindow('code-workbench', options)
  }

  private createWindow(kind: AppWindowKind, codeWorkbench?: CodeWorkbenchWindowOptions): BrowserWindow {
    const window = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      title: kind === 'code-workbench' ? 'Shogo-IDE' : 'Shogo',
      autoHideMenuBar: true,
      webPreferences: {
        // Do not use `path.join(__dirname, 'preload.js')` here. The main
        // process bundle inlines `__dirname` at build time, which previously
        // leaked CI paths into packaged builds and broke the preload bridge.
        // `app.getAppPath()` resolves to the actual runtime app root in both
        // dev and packaged Electron builds.
        preload: path.join(app.getAppPath(), 'dist', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // Disabled so preload can require the audio capture pipeline while the
        // renderer remains isolated behind contextBridge.
        sandbox: false,
        // Lets chat message and huddle sounds play right after launch, without
        // waiting for a click in the window (the browser's autoplay rule).
        autoplayPolicy: 'no-user-gesture-required',
        additionalArguments: [`--api-port=${getApiPort()}`],
      },
      show: false,
    })

    if (kind === 'code-workbench') {
      window.on('page-title-updated', (event) => {
        event.preventDefault()
        window.setTitle('Shogo-IDE')
      })
    }

    this.registerWindow(window, kind, codeWorkbench)
    return window
  }

  getPrimaryWindow(): BrowserWindow | null {
    if (this.primaryWindowId === null) return null
    return this.getWindow(this.primaryWindowId)
  }

  getWindow(windowId: number): BrowserWindow | null {
    const record = this.getWindowRecord(windowId)
    return record?.browserWindow ?? null
  }

  getWindowRecord(windowId: number): AppWindowRecord | null {
    const record = this.windows.get(windowId)
    if (!record || record.browserWindow.isDestroyed()) return null
    return record
  }

  getWindowForWebContents(webContents: WebContents): BrowserWindow | null {
    const window = BrowserWindow.fromWebContents(webContents)
    if (!window || window.isDestroyed()) return null
    return this.windows.has(window.id) ? window : null
  }

  getWindowRecordForWebContents(webContents: WebContents): AppWindowRecord | null {
    const window = this.getWindowForWebContents(webContents)
    return window ? this.getWindowRecord(window.id) : null
  }

  getWindowForWebContentsOrFocused(webContents: WebContents): BrowserWindow | null {
    return this.getWindowForWebContents(webContents) ?? this.getFocusedWindowRecord()?.browserWindow ?? null
  }

  getWindowRecordForWebContentsOrFocused(webContents: WebContents): AppWindowRecord | null {
    const window = this.getWindowForWebContentsOrFocused(webContents)
    return window ? this.getWindowRecord(window.id) : null
  }

  getFocusedWindowRecord(): AppWindowRecord | null {
    const window = BrowserWindow.getFocusedWindow()
    if (!window || window.isDestroyed()) return null
    return this.getWindowRecord(window.id)
  }

  focusPrimaryWindow(): boolean {
    const window = this.getPrimaryWindow()
    return window ? this.focusWindow(window.id) : false
  }

  focusWindow(windowId: number): boolean {
    const window = this.getWindow(windowId)
    if (!window) return false
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    return true
  }

  sendToWindow(windowId: number, channel: string, ...args: unknown[]): boolean {
    const window = this.getWindow(windowId)
    if (!window) return false
    window.webContents.send(channel, ...args)
    return true
  }

  sendToAllWindows(channel: string, ...args: unknown[]): void {
    for (const { browserWindow } of this.windows.values()) {
      if (!browserWindow.isDestroyed()) browserWindow.webContents.send(channel, ...args)
    }
  }

  sendToPrimaryWindow(channel: string, ...args: unknown[]): boolean {
    const window = this.getPrimaryWindow()
    return window ? this.sendToWindow(window.id, channel, ...args) : false
  }

  focusAndSendToPrimaryWindow(channel: string, ...args: unknown[]): boolean {
    if (!this.focusPrimaryWindow()) return false
    return this.sendToPrimaryWindow(channel, ...args)
  }

  navigateWindow(windowId: number, path: string): boolean {
    return this.sendToWindow(windowId, 'navigate', path)
  }

  navigatePrimaryWindow(path: string): boolean {
    const window = this.getPrimaryWindow()
    return window ? this.navigateWindow(window.id, path) : false
  }

  focusAndNavigatePrimaryWindow(path: string): boolean {
    if (!this.focusPrimaryWindow()) return false
    return this.navigatePrimaryWindow(path)
  }

  hasWindows(): boolean {
    return this.windows.size > 0
  }

  private registerWindow(window: BrowserWindow, kind: AppWindowKind, codeWorkbench?: CodeWorkbenchWindowOptions): void {
    const now = Date.now()
    const record: AppWindowRecord = {
      id: window.id,
      kind,
      browserWindow: window,
      createdAt: now,
      lastFocusedAt: now,
      ...(codeWorkbench ? { codeWorkbench } : {}),
    }

    this.windows.set(window.id, record)
    if (kind === 'main' && this.primaryWindowId === null) {
      this.primaryWindowId = window.id
    }

    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) window.show()
    })

    window.on('focus', () => {
      record.lastFocusedAt = Date.now()
    })

    window.on('closed', () => {
      this.options.onWindowClosed?.(window, record)
      this.windows.delete(window.id)
      if (this.primaryWindowId === window.id) {
        this.primaryWindowId = null
      }
    })

    installAppNavigationGuards(window.webContents)
  }
}

/**
 * File links served by the local API: chat attachments, direct or relayed from
 * a cloud workspace (`/api/cloud/<ws>/...`), and `share_file` download links
 * (`/api/f/<token>`, plus the legacy `/f/<token>`). They need the desktop's
 * session, which the system browser does not have.
 */
const IN_APP_FILE_PATH =
  /^\/(?:api\/(?:cloud\/[^/]+\/)?(?:conversation-files|chat-attachments)|api\/f|f)\//

/**
 * Renderer event that asks the app to show a file in its own viewer. The
 * preload re-dispatches it on `window`, so the renderer treats it as an
 * ordinary in-app click instead of a navigation.
 */
export const OPEN_FILE_EVENT = 'shogo:open-file'

/** True for a chat file link on the local API origin. Other URLs are not. */
export function isInAppFileUrl(url: string, apiUrl: string): boolean {
  let target: URL
  let api: URL
  try {
    target = new URL(url)
    api = new URL(apiUrl)
  } catch {
    return false
  }
  return target.origin === api.origin && IN_APP_FILE_PATH.test(target.pathname)
}

/** Hands a file link back to the renderer, which opens it in its own pane. */
function openFileInApp(webContents: WebContents, url: string): void {
  if (webContents.isDestroyed()) return
  webContents.send(OPEN_FILE_EVENT, { href: url })
}

/** Keeps app windows on the app origin; external links open in the browser. */
export function installAppNavigationGuards(webContents: WebContents): void {
  webContents.setWindowOpenHandler(({ url }) => {
    if (isInAppFileUrl(url, getApiUrl())) {
      // Never a new window and never the system browser: the renderer shows
      // the file in its own pane, like it does on web (SHO-80).
      openFileInApp(webContents, url)
      return { action: 'deny' }
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  webContents.on('will-navigate', (event, url) => {
    // A plain `<a href>` to a served file would otherwise navigate the window
    // to the API's raw response; keep the app where it is and show the file.
    if (isInAppFileUrl(url, getApiUrl())) {
      event.preventDefault()
      openFileInApp(webContents, url)
      return
    }
    const appOrigins = ['shogo://app', 'http://localhost', 'http://127.0.0.1']
    const isInternal = appOrigins.some((origin) => url.startsWith(origin))
    if (!isInternal) {
      event.preventDefault()
      if (url.startsWith('http://') || url.startsWith('https://')) {
        shell.openExternal(url)
      }
    }
  })

  // Any window the app does open gets the same rules.
  webContents.on('did-create-window', (child) => installAppNavigationGuards(child.webContents))
}
