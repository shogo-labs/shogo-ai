// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The menu-bar dropdown, as a pure function of the published model and the
// app's current state. Pure on purpose: `tray.ts` owns the Tray object and the
// images, this file owns the order, the caps and the copy, so both can be
// tested without Electron.

import type { MenuItemConstructorOptions, NativeImage } from 'electron'
import type { TrayGroup, TrayModel, TrayRow } from './tray-protocol'

/** A row's dot, already loaded. `null` when the asset is missing, in which
 * case the row is still clickable and simply has no dot. */
export interface TrayIcons {
  running: NativeImage | null
  needsYou: NativeImage | null
  newReply: NativeImage | null
}

/** What the Meetings submenu needs to draw itself. Local mode only. */
export interface TrayMeetingSnapshot {
  /** Transcription is enabled at all. */
  enabled: boolean
  autoDetect: boolean
  autoRecord: boolean
  islandEnabled: boolean
  recording: boolean
  /** "1:23" while recording. */
  recordingLabel: string
}

export interface TrayMenuHandlers {
  onOpenChat: (row: TrayRow) => void
  onNewChat: () => void
  onClearNotifications: () => void
  /** Open Shogo: focus the window, or show the app when none is open. */
  onOpenApp: () => void
  onToggleShowCount: (next: boolean) => void
  onOpenSettings: () => void
  onQuit: () => void
  onOpenMeetings: () => void
  onSetIslandEnabled: (next: boolean) => void
  onSetMeetingsEnabled: (next: boolean) => void
  onStartRecording: () => void
  onStopRecording: () => void
  onSetAutoDetect: (next: boolean) => void
  onSetAutoRecord: (next: boolean) => void
}

export interface TrayMenuOptions {
  model: TrayModel
  /** Meetings exist only in local mode; cloud shows the same menu without it. */
  localMode: boolean
  /** Draw the attention count beside the icon. */
  showCount: boolean
  meeting: TrayMeetingSnapshot
  icons: TrayIcons
  handlers: TrayMenuHandlers
}

/** Longest chat title a menu row shows before it is elided. */
export const TRAY_MENU_TITLE_CHARS = 48

export function ellipsizeMenuTitle(title: string, maxChars: number = TRAY_MENU_TITLE_CHARS): string {
  const text = title.trim() || 'Untitled chat'
  return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text
}

function rowIcon(row: TrayRow, icons: TrayIcons): NativeImage | undefined {
  const icon = row.status === 'running'
    ? icons.running
    : row.status === 'needs_you'
      ? icons.needsYou
      : row.status === 'new'
        ? icons.newReply
        : null
  return icon ?? undefined
}

function chatRow(row: TrayRow, icons: TrayIcons, handlers: TrayMenuHandlers): MenuItemConstructorOptions {
  return {
    label: ellipsizeMenuTitle(row.title),
    toolTip: row.title,
    ...(rowIcon(row, icons) ? { icon: rowIcon(row, icons) } : {}),
    click: () => handlers.onOpenChat(row),
  }
}

function sectionTemplate(
  group: TrayGroup,
  icons: TrayIcons,
  handlers: TrayMenuHandlers,
): MenuItemConstructorOptions[] {
  return [
    { label: ellipsizeMenuTitle(group.title, 40), enabled: false },
    ...group.rows.map((row) => chatRow(row, icons, handlers)),
  ]
}

function meetingsSubmenu(options: TrayMenuOptions): MenuItemConstructorOptions[] {
  const { meeting, handlers } = options
  const items: MenuItemConstructorOptions[] = [
    {
      label: 'Meetings & transcription',
      type: 'checkbox',
      checked: meeting.enabled,
      click: (item) => handlers.onSetMeetingsEnabled(item.checked),
    },
    { type: 'separator' },
  ]
  if (meeting.recording) {
    items.push({ label: `Recording ${meeting.recordingLabel}`, enabled: false })
    items.push({ label: 'Stop Recording', click: () => handlers.onStopRecording() })
  } else {
    items.push({
      label: 'Start Recording',
      enabled: meeting.enabled,
      click: () => handlers.onStartRecording(),
    })
  }
  items.push(
    { type: 'separator' },
    {
      label: 'Auto-detect Meetings',
      type: 'checkbox',
      checked: meeting.autoDetect,
      enabled: meeting.enabled,
      click: (item) => handlers.onSetAutoDetect(item.checked),
    },
    {
      label: 'Auto-record',
      type: 'checkbox',
      checked: meeting.autoRecord,
      enabled: meeting.enabled && meeting.autoDetect,
      click: (item) => handlers.onSetAutoRecord(item.checked),
    },
    {
      label: 'Show Island',
      type: 'checkbox',
      checked: meeting.islandEnabled,
      click: (item) => handlers.onSetIslandEnabled(item.checked),
    },
    { type: 'separator' },
    { label: 'Open Meetings', click: () => handlers.onOpenMeetings() },
  )
  return items
}

/**
 * The whole dropdown, in the order Russell asked for (Cursor's): the pinned
 * chats, then one section per agent/project that has something to say, then
 * the actions. A model with nothing to report falls back to the 5 newest chats
 * so the menu is never just actions.
 */
export function buildTrayMenuTemplate(options: TrayMenuOptions): MenuItemConstructorOptions[] {
  const { model, icons, handlers } = options
  const template: MenuItemConstructorOptions[] = []

  const chatSections: MenuItemConstructorOptions[] = []
  if (model.pinned.length > 0) {
    chatSections.push({ label: 'Pinned', enabled: false })
    chatSections.push(...model.pinned.map((row) => chatRow(row, icons, handlers)))
  }
  if (model.groups.length > 0) {
    if (chatSections.length > 0) chatSections.push({ type: 'separator' })
    chatSections.push(...model.groups.flatMap((group) => sectionTemplate(group, icons, handlers)))
  } else if (model.recent.length > 0) {
    if (chatSections.length > 0) chatSections.push({ type: 'separator' })
    chatSections.push({ label: 'Recent', enabled: false })
    chatSections.push(...model.recent.map((row) => chatRow(row, icons, handlers)))
  }

  if (chatSections.length > 0) {
    template.push(...chatSections, { type: 'separator' })
  } else {
    template.push({ label: 'No chats yet', enabled: false }, { type: 'separator' })
  }

  template.push(
    { label: 'New Chat', click: () => handlers.onNewChat() },
    {
      label: 'Clear All Notifications',
      enabled: model.canClear,
      click: () => handlers.onClearNotifications(),
    },
    { type: 'separator' },
    { label: 'Open Shogo', click: () => handlers.onOpenApp() },
    {
      label: 'Show Count',
      type: 'checkbox',
      checked: options.showCount,
      click: (item) => handlers.onToggleShowCount(item.checked),
    },
  )

  if (options.localMode) {
    template.push(
      { label: 'Meetings', submenu: meetingsSubmenu(options) },
      { type: 'separator' },
    )
  }

  template.push(
    { label: 'Settings', click: () => handlers.onOpenSettings() },
    { label: 'Quit Shogo', click: () => handlers.onQuit() },
  )

  return template
}

/**
 * The template flattened to plain lines, so a test (or the e2e hook) can assert
 * the menu without a native menu: one indent level per depth, `[x]`/`[ ]` for a
 * checkbox and `(disabled)` for an item that cannot be clicked.
 */
export function describeTrayMenuTemplate(template: MenuItemConstructorOptions[]): string[] {
  const out: string[] = []
  const walk = (items: MenuItemConstructorOptions[], depth: number): void => {
    for (const item of items) {
      if (item.type === 'separator') {
        out.push(`${'-'.repeat(depth + 1)} ---`)
        continue
      }
      const flags: string[] = []
      if (item.type === 'checkbox') flags.push(item.checked ? '[x]' : '[ ]')
      if (item.enabled === false) flags.push('(disabled)')
      const label = item.label ?? ''
      out.push(`${'-'.repeat(depth + 1)} ${label}${flags.length ? ' ' + flags.join(' ') : ''}`.trimEnd())
      if (Array.isArray(item.submenu)) walk(item.submenu, depth + 1)
    }
  }
  walk(template, 0)
  return out
}
