// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import {
  BrowserWindow,
  app,
  globalShortcut,
  ipcMain,
  screen,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'
import path from 'path'
import { readConfig, writeConfig } from './config'
import type { WindowManager } from './window-manager'
import { getIslandBounds, isNotchedDisplay } from './island-placement'
import { readIslandFiles } from './island-files'
import {
  EMPTY_ISLAND_SNAPSHOT,
  isIslandMode,
  mergeIslandSnapshots,
  parseIslandAction,
  parseIslandConfigPatch,
  parseIslandSnapshot,
  type IslandActionResult,
  type IslandAppAction,
  type IslandConfig,
  type IslandLayout,
  type IslandMode,
  type IslandSnapshot,
} from './island-protocol'

export type IslandConfigUpdateResult =
  | { ok: true; config: IslandConfig }
  | { ok: false; error: string; config: IslandConfig }

export class IslandWindow {
  private window: BrowserWindow | null = null
  private mode: IslandMode = 'hidden'
  private config: IslandConfig
  private registeredShortcut: string | null = null
  /** Latest snapshot per app window, keyed by BrowserWindow id. */
  private readonly snapshots = new Map<number, IslandSnapshot>()
  private snapshot: IslandSnapshot = EMPTY_ISLAND_SNAPSHOT
  private readonly autoExpandedRequestIds = new Set<string>()

  constructor(private readonly windowManager: WindowManager) {
    this.config = readConfig().island
    this.registerIpc()
    this.registerDisplayListeners()
    const shortcutError = this.applyShortcut()
    if (shortcutError) console.warn(`[Island] ${shortcutError}`)
    if (this.config.enabled) this.createWindow()
  }

  getConfig(): IslandConfig {
    return this.config
  }

  /** Single entry point for Settings and the tray: validates, applies,
   * persists, and tells every app window about the result. */
  updateConfig(input: unknown): IslandConfigUpdateResult {
    const parsed = parseIslandConfigPatch(input)
    if (!parsed.ok) return { ok: false, error: parsed.error, config: this.config }

    const previous = this.config
    this.config = { ...previous, ...parsed.patch }
    const shortcutError = this.applyShortcut()
    if (shortcutError) {
      this.config = { ...this.config, shortcut: previous.shortcut }
      this.applyShortcut()
    }

    writeConfig({ island: this.config })
    if (this.config.enabled) {
      this.createWindow()
      this.reconcileMode()
    } else {
      this.destroyWindow()
    }
    this.windowManager.sendToAllWindows('island-config-changed', this.config)

    return shortcutError
      ? { ok: false, error: shortcutError, config: this.config }
      : { ok: true, config: this.config }
  }

  showCompose(): void {
    if (!this.config.enabled) return
    this.createWindow()
    this.setMode('compose')
    this.window?.webContents.send('island:open-compose')
  }

  destroy(): void {
    if (this.registeredShortcut) globalShortcut.unregister(this.registeredShortcut)
    this.registeredShortcut = null
    this.destroyWindow()
    screen.removeListener('display-added', this.positionWindow)
    screen.removeListener('display-removed', this.positionWindow)
    screen.removeListener('display-metrics-changed', this.positionWindow)
    ipcMain.removeListener('island:update', this.onUpdate)
    ipcMain.removeHandler('island:action')
    ipcMain.removeListener('island:mode', this.onMode)
    ipcMain.removeListener('island:interactive', this.onInteractive)
  }

  private createWindow(): void {
    if (this.window && !this.window.isDestroyed()) return
    const window = new BrowserWindow({
      width: 220,
      height: 8,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      focusable: false,
      webPreferences: {
        preload: path.join(app.getAppPath(), 'dist', 'preload-island.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
      ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    })
    this.window = window
    window.setAlwaysOnTop(true, 'screen-saver')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    window.setIgnoreMouseEvents(true, { forward: true })
    window.on('closed', () => {
      if (this.window === window) this.window = null
    })
    window.webContents.once('did-finish-load', () => {
      this.sendSnapshot()
      this.applyMode()
    })
    void window.loadFile(path.join(app.getAppPath(), 'dist', 'island.html'))
    this.positionWindow()
  }

  private destroyWindow(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
    this.mode = 'hidden'
  }

  /** Brings the registered global shortcut in line with `this.config`.
   * Returns a user-facing error instead of throwing, because Electron throws
   * on malformed accelerators and this runs during startup. */
  private applyShortcut(): string | null {
    const desired = this.config.enabled ? this.config.shortcut : null
    if (desired === this.registeredShortcut) return null
    if (this.registeredShortcut) globalShortcut.unregister(this.registeredShortcut)
    this.registeredShortcut = null
    if (!desired) return null
    try {
      if (!globalShortcut.register(desired, () => this.showCompose())) {
        return `"${desired}" is already in use by another app`
      }
    } catch {
      return `"${desired}" is not a valid shortcut`
    }
    this.registeredShortcut = desired
    return null
  }

  private setMode(mode: IslandMode): void {
    this.mode = mode
    this.applyMode()
  }

  private applyMode(): void {
    const window = this.window
    if (!window || window.isDestroyed()) return
    if (this.mode === 'compose') {
      window.setFocusable(true)
      window.setIgnoreMouseEvents(false)
      window.show()
      window.focus()
    } else {
      window.setFocusable(false)
      // The renderer turns hit-testing back on while the pointer is over a
      // visible surface, so transparent regions never swallow clicks.
      window.setIgnoreMouseEvents(true, { forward: true })
      window.showInactive()
    }
    this.positionWindow()
  }

  private positionWindow = (): void => {
    const window = this.window
    if (!window || window.isDestroyed() || !screen.getAllDisplays().length) return
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const area = { bounds: display.bounds, workArea: display.workArea }
    window.setBounds(getIslandBounds(area, this.mode))
    const layout: IslandLayout = { mode: this.mode, notched: isNotchedDisplay(area) }
    window.webContents.send('island:layout', layout)
  }

  private sendSnapshot(): void {
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send('island:snapshot', this.snapshot)
  }

  private hasActivity(): boolean {
    return this.snapshot.sessions.some(
      (session) => session.status === 'running' || session.status === 'done' || !!session.pending,
    )
  }

  private reconcileMode(): void {
    if (!this.window || this.mode === 'compose') return
    const newPending = this.snapshot.sessions
      .map((session) => session.pending?.request.id)
      .find((id): id is string => !!id && !this.autoExpandedRequestIds.has(id))
    const livePendingIds = new Set(
      this.snapshot.sessions.flatMap((session) => (session.pending ? [session.pending.request.id] : [])),
    )
    for (const id of this.autoExpandedRequestIds) {
      if (!livePendingIds.has(id)) this.autoExpandedRequestIds.delete(id)
    }

    if (newPending) {
      this.autoExpandedRequestIds.add(newPending)
      this.setMode('expanded')
    } else if (this.mode === 'hidden' && (!this.config.autoHide || this.hasActivity())) {
      this.setMode('collapsed')
    } else if (this.mode === 'collapsed' && this.config.autoHide && !this.hasActivity()) {
      this.setMode('hidden')
    }
  }

  private isIslandSender(sender: WebContents): boolean {
    return !!this.window && !this.window.isDestroyed() && sender === this.window.webContents
  }

  private findWindowFor(match: (snapshot: IslandSnapshot) => boolean): number | null {
    let best: { id: number; updatedAt: number } | null = null
    for (const [id, snapshot] of this.snapshots) {
      if (!match(snapshot) || !this.windowManager.getWindow(id)) continue
      if (!best || snapshot.updatedAt > best.updatedAt) best = { id, updatedAt: snapshot.updatedAt }
    }
    return best?.id ?? null
  }

  private findSessionWindow(projectId: string, sessionId: string): number | null {
    return this.findWindowFor((snapshot) =>
      snapshot.sessions.some((s) => s.projectId === projectId && s.sessionId === sessionId),
    )
  }

  private findProjectWindow(projectId: string): number | null {
    return this.findWindowFor((snapshot) => snapshot.sessions.some((s) => s.projectId === projectId))
  }

  private findPendingWindow(requestId: string): number | null {
    return this.findWindowFor((snapshot) =>
      snapshot.sessions.some((s) => s.pending?.request.id === requestId),
    )
  }

  /** Sends to `windowId`, or to the primary window (focused, so it can
   * navigate to a project it doesn't have open) when no window owns it. */
  private deliver(action: IslandAppAction, windowId: number | null, focus: boolean): IslandActionResult {
    const targetId = windowId ?? this.windowManager.getPrimaryWindow()?.id ?? null
    if (targetId === null) return { ok: false, error: 'Open a Shogo window to continue' }
    if (focus || windowId === null) this.windowManager.focusWindow(targetId)
    return this.windowManager.sendToWindow(targetId, 'island-action', action)
      ? { ok: true }
      : { ok: false, error: 'Shogo window is unavailable' }
  }

  private onUpdate = (event: IpcMainEvent, raw: unknown): void => {
    const window = this.windowManager.getWindowForWebContents(event.sender)
    if (!window) return
    if (!this.snapshots.has(window.id)) {
      const windowId = window.id
      window.once('closed', () => {
        this.snapshots.delete(windowId)
        this.publish()
      })
    }
    this.snapshots.set(window.id, { ...parseIslandSnapshot(raw), updatedAt: Date.now() })
    this.publish()
  }

  private publish(): void {
    this.snapshot = mergeIslandSnapshots(this.snapshots.values())
    this.sendSnapshot()
    this.reconcileMode()
  }

  private onAction = async (event: IpcMainInvokeEvent, raw: unknown): Promise<IslandActionResult> => {
    if (!this.isIslandSender(event.sender)) return { ok: false, error: 'Unauthorized' }
    const action = parseIslandAction(raw)
    if (!action) return { ok: false, error: 'Invalid island action' }

    switch (action.type) {
      case 'open':
        return this.deliver(
          action,
          this.findSessionWindow(action.projectId, action.sessionId) ?? this.findProjectWindow(action.projectId),
          true,
        )
      case 'permission':
      case 'question': {
        const windowId = this.findPendingWindow(action.requestId)
        if (windowId === null) return { ok: false, error: 'This request is no longer pending' }
        return this.deliver(action, windowId, false)
      }
      case 'send': {
        let files
        if (action.files) {
          const read = await readIslandFiles(action.files)
          if (!read.ok) return read
          files = read.attachments
        }
        const { target } = action
        const windowId =
          target.kind === 'session'
            ? (this.findSessionWindow(target.projectId, target.sessionId) ?? this.findProjectWindow(target.projectId))
            : this.findProjectWindow(target.projectId)
        return this.deliver({ ...action, files }, windowId, false)
      }
    }
  }

  private onMode = (event: IpcMainEvent, mode: unknown): void => {
    if (!this.isIslandSender(event.sender) || !isIslandMode(mode)) return
    this.setMode(mode)
    if (mode === 'collapsed') this.reconcileMode()
  }

  private onInteractive = (event: IpcMainEvent, interactive: unknown): void => {
    if (!this.isIslandSender(event.sender) || this.mode === 'compose') return
    this.window?.setIgnoreMouseEvents(interactive !== true, { forward: true })
  }

  private registerIpc(): void {
    ipcMain.on('island:update', this.onUpdate)
    ipcMain.handle('island:action', this.onAction)
    ipcMain.on('island:mode', this.onMode)
    ipcMain.on('island:interactive', this.onInteractive)
  }

  private registerDisplayListeners(): void {
    screen.on('display-added', this.positionWindow)
    screen.on('display-removed', this.positionWindow)
    screen.on('display-metrics-changed', this.positionWindow)
  }
}
