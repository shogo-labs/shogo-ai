// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The macOS menu-bar item: the Shogo mark, and a dropdown that mirrors Cursor's
// — pinned chips, one section per agent with a dot, then the actions. The order,
// caps and copy live in `tray-menu.ts` (pure, testable); this file owns the Tray
// object, the artwork and the state machine that decides when to rebuild.
//
// It exists in cloud mode too: only the Meetings submenu is local.

import { Tray, Menu, nativeImage, app, type NativeImage, type MenuItemConstructorOptions } from 'electron'
import fs from 'fs'
import path from 'path'
import { startRecording, stopRecording, getRecordingStatus, setMeetingConfig, onRecordingStateChange } from './recording'
import { readConfig, writeConfig, type MeetingConfig } from './config'
import {
  buildTrayMenuTemplate,
  describeTrayMenuTemplate,
  type TrayIcons,
  type TrayMenuHandlers,
  type TrayMenuOptions,
} from './tray-menu'
import { EMPTY_TRAY_MODEL, parseTrayModel, trayModelChanged, type TrayModel, type TrayRow } from './tray-protocol'

export interface TrayOptions {
  /** Meetings exist only in local mode; cloud shows the same menu without it. */
  localMode: boolean
  /** Open a chat: an in-place switch when a window has it, else a navigate. */
  openChat: (row: TrayRow) => void
  /** Create a workspace-agent chat and show it (the app's own New Chat). */
  newChat: () => void
  /** Drop every "new reply" dot, in the app and in this menu. */
  clearNotifications: () => void
  openApp: () => void
  openSettings: () => void
  openMeetings?: () => void
  setIslandEnabled?: (enabled: boolean) => void
}

let tray: Tray | null = null
let options: TrayOptions = {
  localMode: true,
  openChat: () => {},
  newChat: () => {},
  clearNotifications: () => {},
  openApp: () => {},
  openSettings: () => {},
}
/** The newest model published by any window, already validated by `tray-protocol`. */
let model: TrayModel = EMPTY_TRAY_MODEL
let icons: TrayIcons = { running: null, needsYou: null, newReply: null }
let lastTemplateSignature: string | null = null
let lastTemplate: MenuItemConstructorOptions[] = []
/** The 1 s tick that keeps the recording timer live. Only runs while recording. */
let titleTimer: ReturnType<typeof setInterval> | null = null
/** Dropped on destroy, so a tray rebuilt after a cloud-mode restart does not
 * leave a second listener on the recording. */
let unsubscribeRecordingState: (() => void) | null = null

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Packaged: copied by forge's extraResource. Dev: the repo's resources dir. */
function trayResourcesDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tray')
    : path.join(app.getAppPath(), 'resources', 'tray')
}

function loadTrayImage(fileName: string, template = false): NativeImage | null {
  const file = path.join(trayResourcesDir(), fileName)
  if (!fs.existsSync(file)) {
    console.warn(`[Tray] Missing artwork: ${file}`)
    return null
  }
  const image = nativeImage.createFromPath(file)
  if (image.isEmpty()) {
    console.warn(`[Tray] Could not decode ${file}`)
    return null
  }
  // A template image is drawn from its alpha channel and tinted by macOS, so the
  // mark reads correctly on a light and a dark menu bar. The recording icon is
  // deliberately not a template: it is red in both appearances.
  if (template) image.setTemplateImage(true)
  return image
}

/** Decoded once: `rebuild` runs on every state change, and re-reading a PNG
 * from disk each time is work nobody sees. */
const statusIcons: { idle: NativeImage | null; recording: NativeImage | null } = {
  idle: null,
  recording: null,
}

function statusBarImage(recording: boolean): NativeImage {
  const cached = recording ? statusIcons.recording : statusIcons.idle
  if (cached) return cached
  const name = recording ? 'trayRecording.png' : process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'
  const image = loadTrayImage(name, !recording && process.platform === 'darwin') ?? nativeImage.createEmpty()
  // Never cache an empty image: a missing or unreadable asset on the first
  // build would otherwise leave the menu bar blank for the rest of the session,
  // retried on every rebuild instead.
  if (!image.isEmpty()) {
    if (recording) statusIcons.recording = image
    else statusIcons.idle = image
  }
  return image
}

function loadIcons(): TrayIcons {
  return {
    running: loadTrayImage('trayDotRunning.png'),
    needsYou: loadTrayImage('trayDotNeedsYou.png'),
    newReply: loadTrayImage('trayDotNew.png'),
  }
}

/** Write a meeting toggle, then redraw: the item's own checkmark is drawn from
 * the template, so the menu has to be rebuilt from the saved config. */
function persistMeeting(patch: Partial<MeetingConfig>): void {
  void setMeetingConfig(patch).then(
    () => refreshTray(),
    (err) => {
      console.error('[Tray] Meeting setting failed:', err)
      refreshTray()
    },
  )
}

const handlers: TrayMenuHandlers = {
  onOpenChat: (row) => options.openChat(row),
  onNewChat: () => options.newChat(),
  onClearNotifications: () => options.clearNotifications(),
  onOpenApp: () => options.openApp(),
  onToggleShowCount: (next) => {
    writeConfig({ tray: { ...readConfig().tray, showCount: next } })
    rebuild({ force: true })
  },
  onOpenSettings: () => options.openSettings(),
  onQuit: () => app.quit(),
  onOpenMeetings: () => options.openMeetings?.(),
  onSetIslandEnabled: (next) => {
    options.setIslandEnabled?.(next)
    refreshTray()
  },
  onSetMeetingsEnabled: (next) => persistMeeting({ enabled: next }),
  onStartRecording: () => {
    startRecording().catch((err) => console.error('[Tray] Start failed:', err))
  },
  onStopRecording: () => {
    stopRecording().catch((err) => console.error('[Tray] Stop failed:', err))
  },
  onSetAutoDetect: (next) => persistMeeting({ autoDetect: next }),
  onSetAutoRecord: (next) => persistMeeting({ autoRecord: next }),
}

function menuOptions(): TrayMenuOptions {
  const config = readConfig()
  const status = getRecordingStatus()
  return {
    model,
    localMode: options.localMode,
    showCount: config.tray.showCount,
    meeting: {
      enabled: config.meetings.enabled,
      autoDetect: config.meetings.autoDetect,
      autoRecord: config.meetings.autoRecord,
      islandEnabled: config.island.enabled,
      recording: status.isRecording,
      recordingLabel: formatDuration(status.duration),
    },
    icons,
    handlers,
  }
}

/** The count beside the icon: chats that need you plus replies you haven't
 * opened. While recording the title is the timer instead. */
function refreshTitle(): void {
  if (!tray) return
  const status = getRecordingStatus()
  if (status.isRecording) {
    const label = formatDuration(status.duration)
    tray.setTitle(label)
    tray.setToolTip(`Shogo — recording ${label}`)
    startTitleTimer()
    return
  }
  stopTitleTimer()
  // Read the setting rather than remembering it: it can be changed from
  // Settings in another window, and the title must follow without a rebuild.
  const count = readConfig().tray.showCount ? model.attentionCount : 0
  tray.setTitle(count > 0 ? String(count) : '')
  tray.setToolTip(count > 0 ? `Shogo — ${count} waiting` : 'Shogo')
}

function startTitleTimer(): void {
  if (titleTimer) return
  titleTimer = setInterval(refreshTitle, 1000)
}

function stopTitleTimer(): void {
  if (!titleTimer) return
  clearInterval(titleTimer)
  titleTimer = null
}

/**
 * Redraw the menu when — and only when — something it shows has changed. The
 * flattening of the template is the signature: same labels, same dots, same
 * checkboxes means the same menu, so an idle app rebuilds nothing even while
 * chats keep publishing their model.
 */
function rebuild(opts: { force?: boolean } = {}): void {
  if (!tray) return
  const status = getRecordingStatus()
  tray.setImage(statusBarImage(status.isRecording))

  const menu = menuOptions()
  const template = buildTrayMenuTemplate(menu)
  const signature = describeTrayMenuTemplate(template).join('\n')
  if (opts.force || signature !== lastTemplateSignature) {
    lastTemplateSignature = signature
    lastTemplate = template
    tray.setContextMenu(Menu.buildFromTemplate(template))
  }
  refreshTitle()
}

/** Called by main for every validated model a window publishes. */
export function setTrayModel(next: unknown): void {
  const parsed = parseTrayModel(next)
  if (!trayModelChanged(model, parsed)) {
    // A republish of the same rows still refreshes the title: the recording
    // state or the Show Count setting may have changed under it.
    refreshTitle()
    return
  }
  model = parsed
  rebuild()
}

export function createTray(next: Partial<TrayOptions> = {}): void {
  options = { ...options, ...next }
  if (tray) {
    rebuild({ force: true })
    return
  }

  icons = loadIcons()
  lastTemplateSignature = null
  tray = new Tray(statusBarImage(false))
  tray.setToolTip('Shogo')
  rebuild({ force: true })

  // A recording can start from the Meetings submenu, the island prompt, the
  // app's own controls or auto-detect; the icon and timer follow the capture
  // itself rather than the click that began it.
  unsubscribeRecordingState = onRecordingStateChange(() => refreshTray())

  // Left-click opens the dropdown on every platform. Recording moved into
  // Meetings ▸; a click that silently started a capture was the old surprise.
  tray.on('click', () => tray?.popUpContextMenu())
  // Windows and Linux open the menu on right-click as well; macOS already does.
  tray.on('right-click', () => tray?.popUpContextMenu())
}

export function destroyTray(): void {
  stopTitleTimer()
  unsubscribeRecordingState?.()
  unsubscribeRecordingState = null
  if (tray) {
    tray.destroy()
    tray = null
  }
  lastTemplateSignature = null
  lastTemplate = []
}

/** Rebuild after a state change the tray cannot observe itself (meeting
 * config written by the app, island toggled in Settings). */
export function refreshTray(): void {
  rebuild({ force: true })
}

/**
 * The current dropdown as plain lines, for the e2e spec. Reading the real
 * template (not a mock) is the point: it is what the Tray is showing.
 */
export function describeTrayMenuForTests(): string[] {
  return describeTrayMenuTemplate(lastTemplate)
}

/** Click one row of the open dropdown by its label, for the e2e spec. */
export function clickTrayItemForTests(label: string): boolean {
  const find = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions | undefined => {
    for (const item of items) {
      if (item.label === label) return item
      if (Array.isArray(item.submenu)) {
        const nested = find(item.submenu)
        if (nested) return nested
      }
    }
    return undefined
  }
  const item = find(lastTemplate)
  if (!item || item.enabled === false) return false
  item.click?.(item as never, undefined as never, undefined as never)
  return true
}
