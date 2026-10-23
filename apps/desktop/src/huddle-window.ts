// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { BrowserWindow, app, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import path from 'path'
import { getApiPort } from './local-server'
import { installAppNavigationGuards, type WindowManager } from './window-manager'
import {
  HUDDLE_MIN_SIZE,
  HUDDLE_WINDOW_ARG,
  huddleBounds,
  parseHuddleCommand,
  parseHuddleMode,
  parseHuddleSnapshot,
  parseJoinRequest,
  type HuddleJoinRequest,
  type HuddleWindowMode,
} from './huddle-protocol'

export interface HuddleWindowOptions {
  /** Loads the app's `/huddle` route, using the same URL rules as app windows. */
  loadApp: (window: BrowserWindow) => void
}

/**
 * The call window on desktop: frameless, always on top, resizable, and
 * modeled on the island window. It hosts the LiveKit room (so it can render
 * video), reports state to the app window that started the call, and takes
 * commands from it. One call at a time, like the rest of the app.
 */
export class HuddleHostWindow {
  private window: BrowserWindow | null = null
  /** The app window that owns the call; it gets state snapshots. */
  private owner: WebContents | null = null
  private request: HuddleJoinRequest | null = null
  private mode: HuddleWindowMode = 'mini'
  /** Where the mini card was last, so switching back and forth keeps it in the same corner. */
  private miniBounds: Electron.Rectangle | null = null
  private ready = false

  constructor(
    private readonly windowManager: WindowManager,
    private readonly options: HuddleWindowOptions,
  ) {
    ipcMain.handle('huddle:open', this.onOpen)
    ipcMain.on('huddle:command', this.onCommand)
    ipcMain.on('huddle:focus', this.onFocus)
    ipcMain.on('huddle:host-ready', this.onHostReady)
    ipcMain.on('huddle:host-state', this.onHostState)
    ipcMain.on('huddle:host-mode', this.onHostMode)
    ipcMain.on('huddle:host-close', this.onHostClose)
    ipcMain.on('huddle:host-show-app', this.onShowApp)
  }

  destroy(): void {
    ipcMain.removeHandler('huddle:open')
    ipcMain.removeListener('huddle:command', this.onCommand)
    ipcMain.removeListener('huddle:focus', this.onFocus)
    ipcMain.removeListener('huddle:host-ready', this.onHostReady)
    ipcMain.removeListener('huddle:host-state', this.onHostState)
    ipcMain.removeListener('huddle:host-mode', this.onHostMode)
    ipcMain.removeListener('huddle:host-close', this.onHostClose)
    ipcMain.removeListener('huddle:host-show-app', this.onShowApp)
    this.closeWindow()
  }

  private isHost(sender: WebContents): boolean {
    return !!this.window && !this.window.isDestroyed() && sender === this.window.webContents
  }

  private isOwner(sender: WebContents): boolean {
    return !!this.owner && !this.owner.isDestroyed() && sender === this.owner
  }

  private workArea(): Electron.Rectangle {
    const anchor = this.owner && !this.owner.isDestroyed() ? BrowserWindow.fromWebContents(this.owner) : null
    const display = anchor ? screen.getDisplayMatching(anchor.getBounds()) : screen.getPrimaryDisplay()
    return display.workArea
  }

  private createWindow(): void {
    if (this.window && !this.window.isDestroyed()) return
    const bounds = huddleBounds('mini', this.workArea())
    const window = new BrowserWindow({
      ...bounds,
      minWidth: HUDDLE_MIN_SIZE.width,
      minHeight: HUDDLE_MIN_SIZE.height,
      frame: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: true,
      skipTaskbar: false,
      show: false,
      backgroundColor: '#0a0a0a',
      title: 'Shogo huddle',
      webPreferences: {
        // The `/huddle` route runs the full app bundle, which reads its API
        // URL and local-mode flag from the main preload's `shogoDesktop`.
        preload: path.join(app.getAppPath(), 'dist', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // Keep timers and WebRTC at full speed when another app is in front.
        backgroundThrottling: false,
        additionalArguments: [`--api-port=${getApiPort()}`, HUDDLE_WINDOW_ARG],
      },
    })
    this.window = window
    this.ready = false
    this.mode = 'mini'
    // Above other apps, and over full-screen ones, so reactions stay visible.
    window.setAlwaysOnTop(true, 'floating')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    installAppNavigationGuards(window.webContents)
    window.once('ready-to-show', () => window.showInactive())
    window.on('closed', () => {
      if (this.window === window) {
        this.window = null
        this.ready = false
        // Closing the window ends the call; the renderer already left on unload.
        this.sendToOwner('huddle:state', { status: 'idle', ended: true })
        this.request = null
      }
    })
    window.on('moved', () => {
      if (this.mode === 'mini' && !window.isDestroyed()) this.miniBounds = window.getBounds()
    })
    this.options.loadApp(window)
  }

  private closeWindow(): void {
    const window = this.window
    this.window = null
    this.ready = false
    this.request = null
    if (window && !window.isDestroyed()) window.destroy()
  }

  private sendToOwner(channel: string, payload: unknown): void {
    if (this.owner && !this.owner.isDestroyed()) this.owner.send(channel, payload)
  }

  private sendToHost(channel: string, payload?: unknown): void {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, payload)
  }

  private applyMode(mode: HuddleWindowMode): void {
    const window = this.window
    if (!window || window.isDestroyed()) return
    if (this.mode === 'mini' && mode !== 'mini') this.miniBounds = window.getBounds()
    this.mode = mode
    const area = this.workArea()
    const next = huddleBounds(mode, area, mode === 'mini' ? this.miniBounds : window.getBounds())
    window.setBounds(next, true)
    window.setAlwaysOnTop(true, 'floating')
    if (mode === 'expanded') {
      window.show()
      window.focus()
    }
  }

  private onOpen = (event: IpcMainInvokeEvent, raw: unknown): { ok: boolean; error?: string } => {
    if (!this.windowManager.getWindowForWebContents(event.sender)) return { ok: false, error: 'Unauthorized' }
    const request = parseJoinRequest(raw)
    if (!request) return { ok: false, error: 'Invalid huddle request' }
    this.owner = event.sender
    const sameCall = this.request?.conversationId === request.conversationId
    this.request = request
    this.createWindow()
    if (sameCall && this.window) {
      this.window.showInactive()
      return { ok: true }
    }
    // A different call replaces the old one: the host leaves it as it joins.
    if (this.ready) this.sendToHost('huddle:join', request)
    return { ok: true }
  }

  private onHostReady = (event: IpcMainEvent): void => {
    if (!this.isHost(event.sender)) return
    this.ready = true
    if (this.request) this.sendToHost('huddle:join', this.request)
  }

  private onCommand = (event: IpcMainEvent, raw: unknown): void => {
    if (!this.isOwner(event.sender)) return
    const command = parseHuddleCommand(raw)
    if (!command) return
    if (command.type === 'view') {
      this.applyMode(command.view === 'expanded' ? 'expanded' : 'mini')
    }
    this.sendToHost('huddle:command', command)
  }

  private onFocus = (event: IpcMainEvent, raw: unknown): void => {
    if (!this.isOwner(event.sender) || !this.window || this.window.isDestroyed()) return
    const mode = parseHuddleMode(raw)
    if (mode) this.applyMode(mode)
    this.window.show()
    this.window.focus()
  }

  private onHostState = (event: IpcMainEvent, raw: unknown): void => {
    if (!this.isHost(event.sender)) return
    const snapshot = parseHuddleSnapshot(raw)
    if (snapshot) this.sendToOwner('huddle:state', snapshot)
  }

  private onHostMode = (event: IpcMainEvent, raw: unknown): void => {
    if (!this.isHost(event.sender)) return
    const mode = parseHuddleMode(raw)
    if (mode && mode !== this.mode) this.applyMode(mode)
  }

  private onHostClose = (event: IpcMainEvent): void => {
    if (!this.isHost(event.sender)) return
    this.closeWindow()
  }

  private onShowApp = (event: IpcMainEvent, raw: unknown): void => {
    if (!this.isHost(event.sender)) return
    const target = typeof raw === 'string' && raw.startsWith('/') && raw.length < 500 ? raw : null
    if (target) this.windowManager.focusAndNavigatePrimaryWindow(target)
    else this.windowManager.focusPrimaryWindow()
  }
}
