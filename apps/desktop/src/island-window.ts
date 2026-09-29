// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import {
  BrowserWindow,
  Notification,
  app,
  globalShortcut,
  ipcMain,
  screen,
  type Display,
} from 'electron'
import path from 'path'
import { readConfig, type IslandConfig } from './config'
import type { WindowManager } from './window-manager'
import {
  getIslandBounds,
  isNotchedDisplay,
  type IslandBoundsDisplay,
  type IslandPlacementMode,
} from './island-placement'

export type IslandWindowMode = IslandPlacementMode
export { getIslandBounds, isNotchedDisplay }

interface IslandSnapshot {
  sessions?: Array<{
    status?: string
    pending?: { kind?: string; request?: { id?: string } }
  }>
}

function asDisplay(display: Display): IslandBoundsDisplay {
  return { bounds: display.bounds, workArea: display.workArea }
}

export class IslandWindow {
  private window: BrowserWindow | null = null
  private mode: IslandWindowMode = 'hidden'
  private latestSnapshot: IslandSnapshot = { sessions: [] }
  private config: IslandConfig
  private readonly windowManager: WindowManager
  private shortcut: string | null = null
  private registered = false
  private notifiedPendingIds = new Set<string>()

  constructor(windowManager: WindowManager) {
    this.windowManager = windowManager
    this.config = readConfig().island
    this.registerIpc()
    this.registerDisplayListeners()
    if (this.config.enabled) {
      this.createWindow()
      this.registerShortcut()
    }
  }

  refreshConfig(): void {
    const previous = this.config
    this.config = readConfig().island
    if (!this.config.enabled) {
      this.destroyWindow()
      this.unregisterShortcut()
      return
    }
    if (previous.shortcut !== this.config.shortcut) {
      this.unregisterShortcut()
      this.registerShortcut()
    }
    if (!this.window) {
      this.createWindow()
      this.registerShortcut()
    }
  }

  setEnabled(enabled: boolean): void {
    this.config = { ...this.config, enabled }
    if (enabled) {
      this.createWindow()
      this.registerShortcut()
    } else {
      this.destroyWindow()
      this.unregisterShortcut()
    }
  }

  showCompose(): void {
    if (!this.config.enabled) return
    this.setMode('compose')
    this.window?.setFocusable(true)
    this.window?.show()
    this.window?.focus()
    this.window?.webContents.send('island:open-compose')
  }

  destroy(): void {
    this.unregisterShortcut()
    this.destroyWindow()
    screen.removeListener('display-added', this.positionWindow)
    screen.removeListener('display-removed', this.positionWindow)
    screen.removeListener('display-metrics-changed', this.positionWindow)
    ipcMain.removeListener('island:update', this.onUpdate)
    ipcMain.removeListener('island:action', this.onAction)
    ipcMain.removeListener('island:mode', this.onMode)
    ipcMain.removeListener('island:interactive', this.onInteractive)
  }

  private createWindow(): void {
    if (this.window && !this.window.isDestroyed()) return
    const preloadPath = path.join(app.getAppPath(), 'dist', 'preload-island.js')
    this.window = new BrowserWindow({
      width: 220,
      height: 8,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      focusable: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
      ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    })
    this.window.setAlwaysOnTop(true, 'screen-saver')
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    this.window.on('closed', () => {
      this.window = null
    })
    this.window.webContents.once('did-finish-load', () => {
      this.sendSnapshot()
      this.sendMode()
      this.positionWindow()
    })
    void this.window.loadFile(path.join(app.getAppPath(), 'dist', 'island.html'))
    this.positionWindow()
  }

  private destroyWindow(): void {
    if (!this.window || this.window.isDestroyed()) {
      this.window = null
      return
    }
    this.window.close()
    this.window = null
  }

  private registerShortcut(): void {
    if (this.registered) return
    const shortcut = this.config.shortcut || 'CommandOrControl+Shift+Space'
    if (!globalShortcut.register(shortcut, () => this.showCompose())) {
      console.warn(`[Island] Unable to register shortcut ${shortcut}`)
      return
    }
    this.shortcut = shortcut
    this.registered = true
  }

  private unregisterShortcut(): void {
    if (this.shortcut) globalShortcut.unregister(this.shortcut)
    this.shortcut = null
    this.registered = false
  }

  private setMode(mode: IslandWindowMode): void {
    this.mode = mode
    if (mode === 'hidden') {
      this.window?.setFocusable(false)
      this.window?.showInactive()
    } else if (mode === 'compose') {
      this.window?.setFocusable(true)
      this.window?.show()
      this.window?.focus()
    } else {
      this.window?.setFocusable(false)
      this.window?.showInactive()
    }
    this.positionWindow()
    this.sendMode()
  }

  private sendMode(): void {
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send('island:mode', this.mode)
  }

  private sendSnapshot(): void {
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send('island:snapshot', this.latestSnapshot)
  }

  private positionWindow = (): void => {
    if (!this.window || this.window.isDestroyed() || !screen.getAllDisplays().length) return
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    this.window.setBounds(getIslandBounds(asDisplay(display), this.mode))
  }

  private hasPending(snapshot: IslandSnapshot): boolean {
    return (snapshot.sessions ?? []).some((session) => !!session.pending)
  }

  private hasActivity(snapshot: IslandSnapshot): boolean {
    return (snapshot.sessions ?? []).some(
      (session) =>
        session.status === 'running' ||
        session.status === 'done' ||
        !!session.pending,
    )
  }

  private onUpdate = (event: Electron.IpcMainEvent, snapshot: IslandSnapshot): void => {
    if (!this.windowManager.getWindowForWebContents(event.sender)) return
    this.latestSnapshot = snapshot ?? { sessions: [] }
    if (!this.config.enabled) {
      const pendingIds = (this.latestSnapshot.sessions ?? [])
        .map((session) => session.pending?.request?.id)
        .filter((id): id is string => !!id)
      const newPendingId = pendingIds.find((id) => !this.notifiedPendingIds.has(id))
      if (newPendingId && Notification.isSupported()) {
        this.notifiedPendingIds.add(newPendingId)
        new Notification({
          title: 'Shogo needs your attention',
          body: 'An agent is waiting for approval or an answer.',
        }).show()
      }
      return
    }
    this.sendSnapshot()
    if (this.hasPending(this.latestSnapshot)) {
      this.setMode('expanded')
    } else if (this.mode === 'hidden' && (!this.config.autoHide || this.hasActivity(this.latestSnapshot))) {
      this.setMode('collapsed')
    } else if (
      this.mode !== 'compose' &&
      this.config.autoHide &&
      !this.hasActivity(this.latestSnapshot)
    ) {
      this.setMode('hidden')
    }
  }

  private onAction = (event: Electron.IpcMainEvent, action: unknown): void => {
    if (!this.window || event.sender !== this.window.webContents) return
    if (!action || typeof action !== 'object') return
    const payload = action as { type?: string; projectId?: string; sessionId?: string }
    if (payload.type === 'open' && payload.projectId && payload.sessionId) {
      this.windowManager.focusAndSendToPrimaryWindow('island-action', action)
      return
    }
    this.windowManager.sendToPrimaryWindow('island-action', action)
  }

  private onMode = (event: Electron.IpcMainEvent, mode: unknown): void => {
    if (!this.window || event.sender !== this.window.webContents) return
    if (mode !== 'hidden' && mode !== 'collapsed' && mode !== 'expanded' && mode !== 'compose') return
    this.setMode(mode)
  }

  private onInteractive = (event: Electron.IpcMainEvent, interactive: unknown): void => {
    if (!this.window || event.sender !== this.window.webContents) return
    this.window.setIgnoreMouseEvents(!interactive, { forward: true })
  }

  private registerIpc(): void {
    ipcMain.on('island:update', this.onUpdate)
    ipcMain.on('island:action', this.onAction)
    ipcMain.on('island:mode', this.onMode)
    ipcMain.on('island:interactive', this.onInteractive)
  }

  private registerDisplayListeners(): void {
    screen.on('display-added', this.positionWindow)
    screen.on('display-removed', this.positionWindow)
    screen.on('display-metrics-changed', this.positionWindow)
  }
}
