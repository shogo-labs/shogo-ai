// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron'
import path from 'path'
import { startRecording, stopRecording, getRecordingStatus } from './recording'
import { readConfig, writeConfig } from './config'

let tray: Tray | null = null
let updateTimer: ReturnType<typeof setInterval> | null = null

function getTrayIcon(recording: boolean): Electron.NativeImage {
  // Use a template image for macOS menu bar (adapts to light/dark)
  const size = 18
  const canvas = nativeImage.createEmpty()

  if (recording) {
    // Red filled circle for recording state
    const redCircle = Buffer.from(
      `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 2}" fill="#FF3B30"/>
      </svg>`
    )
    return nativeImage.createFromBuffer(redCircle, { width: size, height: size })
  }

  // Default: microphone-style icon as template
  const micIcon = Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect x="6" y="2" width="6" height="10" rx="3" fill="black"/>
      <path d="M4 9a5 5 0 0 0 10 0" stroke="black" stroke-width="1.5" fill="none"/>
      <line x1="9" y1="14" x2="9" y2="16" stroke="black" stroke-width="1.5"/>
    </svg>`
  )
  const img = nativeImage.createFromBuffer(micIcon, { width: size, height: size })
  img.setTemplateImage(true)
  return img
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function buildContextMenu(): Menu {
  const status = getRecordingStatus()
  const config = readConfig()

  if (status.isRecording) {
    return Menu.buildFromTemplate([
      {
        label: `Recording ${formatDuration(status.duration)}`,
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Stop Recording',
        click: () => {
          stopRecording().catch((err) => console.error('[Tray] Stop failed:', err))
        },
      },
      { type: 'separator' },
      {
        label: 'Open Meetings',
        click: focusAndNavigate,
      },
    ])
  }

  return Menu.buildFromTemplate([
    {
      label: 'Start Recording',
      click: () => {
        startRecording().catch((err) => console.error('[Tray] Start failed:', err))
      },
    },
    { type: 'separator' },
    {
      label: 'Auto-detect Meetings',
      type: 'checkbox',
      checked: config.meetings.autoDetect,
      click: (item) => {
        writeConfig({
          meetings: { ...config.meetings, autoDetect: item.checked },
        })
      },
    },
    {
      label: 'Auto-record',
      type: 'checkbox',
      checked: config.meetings.autoRecord,
      enabled: config.meetings.autoDetect,
      click: (item) => {
        writeConfig({
          meetings: { ...config.meetings, autoRecord: item.checked },
        })
      },
    },
    { type: 'separator' },
    {
      label: 'Open Meetings',
      click: focusAndNavigate,
    },
    { type: 'separator' },
    {
      label: 'Quit Shogo',
      click: () => app.quit(),
    },
  ])
}

function focusAndNavigate(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
    win.webContents.send('navigate', '/meetings')
  }
}

function refreshTray(): void {
  if (!tray) return
  const status = getRecordingStatus()
  tray.setImage(getTrayIcon(status.isRecording))
  tray.setContextMenu(buildContextMenu())

  if (status.isRecording) {
    tray.setTitle(formatDuration(status.duration))
    tray.setToolTip(`Shogo - Recording ${formatDuration(status.duration)}`)
  } else {
    tray.setTitle('')
    tray.setToolTip('Shogo')
  }
}

export function createTray(): void {
  if (tray) return

  tray = new Tray(getTrayIcon(false))
  tray.setToolTip('Shogo')
  tray.setContextMenu(buildContextMenu())

  // Click toggles recording
  tray.on('click', () => {
    const status = getRecordingStatus()
    if (status.isRecording) {
      stopRecording().catch((err) => console.error('[Tray] Stop failed:', err))
    } else {
      startRecording().catch((err) => console.error('[Tray] Start failed:', err))
    }
  })

  // Refresh tray state every second while recording
  updateTimer = setInterval(refreshTray, 1000)
}

export function destroyTray(): void {
  if (updateTimer) {
    clearInterval(updateTimer)
    updateTimer = null
  }
  if (tray) {
    tray.destroy()
    tray = null
  }
}
