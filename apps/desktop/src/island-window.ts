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
import { getApiPort } from './local-server'
import { installAppNavigationGuards, type WindowManager } from './window-manager'
import { getIslandBounds, getIslandTopInset, isIslandFocusable, isNotchedDisplay } from './island-placement'
import { readIslandFiles } from './island-files'
import { ISLAND_WINDOW_ARG } from './preload-island'
import { hasMeetingActivity } from './island-meeting'
import { planPendingNotifications } from './island-notifications'
import { PendingNotifier } from './island-pending-notification'
import {
  EMPTY_ISLAND_MEETING_STATE,
  EMPTY_ISLAND_SNAPSHOT,
  isIslandMode,
  mergeIslandSnapshots,
  parseIslandAction,
  parseIslandConfigPatch,
  parseIslandFileRefs,
  parseIslandSnapshot,
  pendingRequestsToAutoExpand,
  type IslandAction,
  type IslandActionResult,
  type IslandAppAction,
  type IslandConfig,
  type IslandLayout,
  type IslandMeetingDecision,
  type IslandMeetingState,
  type IslandMode,
  type IslandReadFilesResult,
  type IslandSnapshot,
} from './island-protocol'

export type IslandConfigUpdateResult =
  { ok: true; config: IslandConfig } | { ok: false; error: string; config: IslandConfig }

export interface IslandMeetingSource {
  getState(): IslandMeetingState
  subscribe(listener: (state: IslandMeetingState) => void): () => void
  respond(decision: IslandMeetingDecision, promptId?: string): Promise<IslandActionResult>
}

export interface IslandWindowOptions {
  /** Loads the app's `/island` route, using the same URL rules as app windows. */
  loadApp: (window: BrowserWindow) => void
  /** Meeting detection and recording; absent in cloud mode. */
  meeting?: IslandMeetingSource
}

export class IslandWindow {
  private window: BrowserWindow | null = null
  private mode: IslandMode = 'hidden'
  private config: IslandConfig
  private registeredShortcut: string | null = null
  /** Latest snapshot per app window, keyed by BrowserWindow id. */
  private readonly snapshots = new Map<number, IslandSnapshot>()
  private snapshot: IslandSnapshot = EMPTY_ISLAND_SNAPSHOT
  private readonly autoExpandedRequestIds = new Set<string>()
  /** Waiting requests already announced with an OS notification. */
  private announcedRequestIds = new Set<string>()
  private readonly pendingNotifier = new PendingNotifier((action) => this.performAction(action))
  /** Rendered card height reported by the route; sizes expanded/compose. */
  private contentHeight: number | undefined
  private meetingState: IslandMeetingState = EMPTY_ISLAND_MEETING_STATE
  private autoExpandedMeetingPromptId: string | null = null
  private unsubscribeMeeting: (() => void) | null = null

  constructor(
    private readonly windowManager: WindowManager,
    private readonly options: IslandWindowOptions,
  ) {
    this.config = readConfig().island
    if (options.meeting) {
      this.meetingState = options.meeting.getState()
      this.unsubscribeMeeting = options.meeting.subscribe((state) => {
        this.meetingState = state
        this.maybeMaterialize()
        this.sendMeeting()
        this.reconcileMode()
      })
    }
    this.registerIpc()
    this.registerDisplayListeners()
    app.on('browser-window-focus', this.onAppFocusChange)
    app.on('browser-window-blur', this.onAppFocusChange)
    const shortcutError = this.applyShortcut()
    if (shortcutError) console.warn(`[Island] ${shortcutError}`)
    // The island route is a second full renderer. Create that window on the
    // first shortcut, meeting, or agent activity instead of at launch.
    this.maybeMaterialize()
  }

  /** Open the island BrowserWindow once there is something to show. */
  private maybeMaterialize(): void {
    if (!this.config.enabled) return
    if (this.window && !this.window.isDestroyed()) return
    if (this.hasActivity()) this.createWindow()
  }

  getConfig(): IslandConfig {
    return this.config
  }

  /** Whether a meeting prompt will be seen here, making a native
   * notification redundant. */
  canPresentMeetingPrompt(): boolean {
    return this.config.enabled && !!this.window && !this.window.isDestroyed()
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
      this.sendLayout()
    } else {
      this.destroyWindow()
    }
    this.windowManager.sendToAllWindows('island-config-changed', this.config)

    return shortcutError ? { ok: false, error: shortcutError, config: this.config } : { ok: true, config: this.config }
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
    this.unsubscribeMeeting?.()
    this.unsubscribeMeeting = null
    this.pendingNotifier.closeAll()
    screen.removeListener('display-added', this.positionWindow)
    screen.removeListener('display-removed', this.positionWindow)
    screen.removeListener('display-metrics-changed', this.positionWindow)
    app.removeListener('browser-window-focus', this.onAppFocusChange)
    app.removeListener('browser-window-blur', this.onAppFocusChange)
    ipcMain.removeListener('island:update', this.onUpdate)
    ipcMain.removeHandler('island:action')
    ipcMain.removeHandler('island:read-files')
    ipcMain.removeListener('island:mode', this.onMode)
    ipcMain.removeListener('island:interactive', this.onInteractive)
    ipcMain.removeListener('island:content-height', this.onContentHeight)
    ipcMain.removeListener('island:request-state', this.onRequestState)
  }

  private createWindow(): void {
    if (this.window && !this.window.isDestroyed()) return
    const window = new BrowserWindow({
      width: 220,
      height: 8,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      focusable: false,
      // macOS otherwise pushes the window below the menu bar, which puts the
      // hover zone under the notch instead of on it.
      enableLargerThanScreen: true,
      webPreferences: {
        // The `/island` route runs the full app bundle, which reads its API
        // URL and local-mode flag from the main preload's `shogoDesktop`.
        preload: path.join(app.getAppPath(), 'dist', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        additionalArguments: [`--api-port=${getApiPort()}`, ISLAND_WINDOW_ARG],
      },
      ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    })
    this.window = window
    window.setAlwaysOnTop(true, 'screen-saver')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // The hidden/collapsed window is the pointer hot zone. Making it
    // click-through here prevents macOS from ever delivering the mouse event
    // that should expand the island, especially when it overlaps the menu bar.
    window.setIgnoreMouseEvents(false)
    installAppNavigationGuards(window.webContents)
    window.on('closed', () => {
      if (this.window === window) this.window = null
    })
    window.webContents.on('did-finish-load', () => {
      this.sendSnapshot()
      this.sendMeeting()
      this.applyMode()
    })
    this.options.loadApp(window)
    this.positionWindow()
  }

  private destroyWindow(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
    this.mode = 'hidden'
    this.contentHeight = undefined
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
    window.setFocusable(isIslandFocusable(this.mode))
    if (this.mode === 'compose') {
      window.setIgnoreMouseEvents(false)
      window.show()
      window.focus()
    } else {
      // Keep the hot zone hit-testable. The window is only the small
      // top-center island bounds, and file drops also require hit testing.
      window.setIgnoreMouseEvents(false)
      window.showInactive()
    }
    this.positionWindow()
  }

  private currentDisplayArea() {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    return { bounds: display.bounds, workArea: display.workArea }
  }

  private positionWindow = (): void => {
    const window = this.window
    if (!window || window.isDestroyed() || !screen.getAllDisplays().length) return
    window.setBounds(getIslandBounds(this.currentDisplayArea(), this.mode, process.platform, this.contentHeight))
    this.sendLayout()
  }

  private sendLayout(): void {
    const window = this.window
    if (!window || window.isDestroyed() || !screen.getAllDisplays().length) return
    const area = this.currentDisplayArea()
    const layout: IslandLayout = {
      mode: this.mode,
      notched: isNotchedDisplay(area),
      topInset: getIslandTopInset(area),
      sounds: this.config.sounds,
      soundVolume: this.config.soundVolume,
    }
    window.webContents.send('island:layout', layout)
  }

  private sendSnapshot(): void {
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send('island:snapshot', this.snapshot)
  }

  private sendMeeting(): void {
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send('island:meeting', this.meetingState)
  }

  private hasActivity(): boolean {
    return (
      hasMeetingActivity(this.meetingState) ||
      this.snapshot.sessions.some(
        (session) =>
          session.status === 'running' || session.status === 'done' || !!session.pending || !!session.pendingPlan,
      )
    )
  }

  private reconcileMode(): void {
    if (!this.window || this.mode === 'compose') return
    const { expand: newPending, suppressed } = pendingRequestsToAutoExpand(
      this.snapshot,
      this.autoExpandedRequestIds,
    )
    for (const id of suppressed) this.autoExpandedRequestIds.add(id)
    const livePendingIds = new Set(
      this.snapshot.sessions.flatMap((session) => (session.pending ? [session.pending.request.id] : [])),
    )
    for (const id of this.autoExpandedRequestIds) {
      if (!livePendingIds.has(id)) this.autoExpandedRequestIds.delete(id)
    }

    const meetingPromptId = this.meetingState.prompt?.id ?? null
    const newMeetingPrompt = !!meetingPromptId && meetingPromptId !== this.autoExpandedMeetingPromptId
    if (meetingPromptId) this.autoExpandedMeetingPromptId = meetingPromptId

    if (newPending || newMeetingPrompt) {
      if (newPending) this.autoExpandedRequestIds.add(newPending)
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
    return this.findWindowFor((snapshot) => snapshot.sessions.some((s) => s.pending?.request.id === requestId))
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
    this.snapshots.set(window.id, {
      ...parseIslandSnapshot(raw),
      updatedAt: Date.now(),
    })
    this.publish()
  }

  private onAppFocusChange = (): void => {
    this.publish()
  }

  private publish(): void {
    const focused = this.windowManager.getFocusedWindowRecord()
    const focusedSnapshot = focused ? this.snapshots.get(focused.browserWindow.id) : undefined
    this.snapshot = mergeIslandSnapshots(this.snapshots.values(), focusedSnapshot)
    this.maybeMaterialize()
    this.sendSnapshot()
    this.reconcileMode()
    this.notifyPending()
  }

  /** A waiting agent the island is not showing gets an OS notification. */
  private notifyPending(): void {
    const plan = planPendingNotifications(this.snapshot, this.announcedRequestIds, {
      islandPresent: this.canPresentMeetingPrompt(),
    })
    this.announcedRequestIds = plan.announced
    for (const id of plan.resolved) this.pendingNotifier.close(id)
    for (const notice of plan.notify) this.pendingNotifier.show(notice)
  }

  private onAction = async (event: IpcMainInvokeEvent, raw: unknown): Promise<IslandActionResult> => {
    if (!this.isIslandSender(event.sender)) return { ok: false, error: 'Unauthorized' }
    const action = parseIslandAction(raw)
    if (!action) return { ok: false, error: 'Invalid island action' }
    return this.performAction(action)
  }

  /** Runs an island action. The island's IPC and the OS notification buttons
   * both come through here, so an answer behaves the same from either. */
  private performAction = async (action: IslandAction): Promise<IslandActionResult> => {
    switch (action.type) {
      case 'open':
        return this.deliver(
          action,
          this.findSessionWindow(action.projectId, action.sessionId) ?? this.findProjectWindow(action.projectId),
          true,
        )
      case 'navigate':
        return this.windowManager.focusAndNavigatePrimaryWindow(action.path)
          ? { ok: true }
          : { ok: false, error: 'Open a Shogo window to continue' }
      case 'show-app': {
        if (!this.windowManager.focusPrimaryWindow()) return { ok: false, error: 'Open a Shogo window to continue' }
        // The island is a non-activating panel, so macOS won't make Shogo the
        // active app on its own.
        if (process.platform === 'darwin') app.focus({ steal: true })
        return { ok: true }
      }
      case 'meeting':
        return this.options.meeting
          ? this.options.meeting.respond(action.decision, action.promptId)
          : {
              ok: false,
              error: 'Meeting recording is only available in local mode',
            }
      case 'permission':
      case 'question': {
        const windowId = this.findPendingWindow(action.requestId)
        if (windowId === null) return { ok: false, error: 'This request is no longer pending' }
        return this.deliver(action, windowId, false)
      }
      case 'stop':
      case 'plan': {
        const windowId = this.findSessionWindow(action.projectId, action.sessionId)
        if (windowId === null) return { ok: false, error: 'That chat is no longer open in Shogo' }
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

  private onReadFiles = async (event: IpcMainInvokeEvent, raw: unknown): Promise<IslandReadFilesResult> => {
    if (!this.isIslandSender(event.sender)) return { ok: false, error: 'Unauthorized' }
    const files = parseIslandFileRefs(raw)
    if (!files || files.length === 0) return { ok: false, error: 'No files to attach' }
    return readIslandFiles(files)
  }

  private onMode = (event: IpcMainEvent, mode: unknown): void => {
    if (!this.isIslandSender(event.sender) || !isIslandMode(mode)) return
    this.setMode(mode)
    if (mode === 'collapsed') this.reconcileMode()
  }

  private onInteractive = (event: IpcMainEvent, interactive: unknown): void => {
    if (!this.isIslandSender(event.sender) || this.mode === 'compose') return
    // Do not switch the hot zone back to click-through. The renderer sends
    // `false` while the pointer is outside the surface, but that state still
    // needs to receive the next mouse movement/drop on macOS.
    if (interactive === true) this.window?.setIgnoreMouseEvents(false)
  }

  private onContentHeight = (event: IpcMainEvent, height: unknown): void => {
    if (!this.isIslandSender(event.sender)) return
    if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return
    const next = Math.ceil(height)
    if (next === this.contentHeight) return
    this.contentHeight = next
    if (this.mode === 'expanded' || this.mode === 'compose') this.positionWindow()
  }

  private onRequestState = (event: IpcMainEvent): void => {
    if (!this.isIslandSender(event.sender)) return
    this.sendSnapshot()
    this.sendMeeting()
    this.sendLayout()
  }

  private registerIpc(): void {
    ipcMain.on('island:update', this.onUpdate)
    ipcMain.handle('island:action', this.onAction)
    ipcMain.handle('island:read-files', this.onReadFiles)
    ipcMain.on('island:mode', this.onMode)
    ipcMain.on('island:interactive', this.onInteractive)
    ipcMain.on('island:content-height', this.onContentHeight)
    ipcMain.on('island:request-state', this.onRequestState)
  }

  private registerDisplayListeners(): void {
    screen.on('display-added', this.positionWindow)
    screen.on('display-removed', this.positionWindow)
    screen.on('display-metrics-changed', this.positionWindow)
  }
}
