// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { app, autoUpdater, ipcMain, BrowserWindow } from 'electron'

const TAG = '[Updater]'
const UPDATE_HOST = 'https://update.electronjs.org'
const REPO = 'shogo-labs/shogo-ai'
const CHECK_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes
const SUPPORTED_PLATFORMS = ['darwin', 'win32']

type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'error'

let currentStatus: UpdateStatus = 'idle'
let updateReleaseName: string | null = null
let isApplyingUpdate = false

export function getIsApplyingUpdate(): boolean {
  return isApplyingUpdate
}

function broadcastUpdateStatus() {
  const payload = { status: currentStatus, releaseName: updateReleaseName }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('desktop-update-status', payload)
  }
}

export function initAutoUpdater(): void {
  const platform = process.platform
  const arch = process.arch
  const version = app.getVersion()

  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    console.log(`${TAG} Skipping — auto-update not supported on ${platform}`)
    return
  }

  const feedURL = `${UPDATE_HOST}/${REPO}/${platform}-${arch}/${version}`
  console.log(`${TAG} Initialising (v${version}, ${platform}-${arch})`)
  console.log(`${TAG} Feed URL: ${feedURL}`)

  const userAgent = `shogo-desktop/${version} (${platform}: ${arch})`
  autoUpdater.setFeedURL({
    url: feedURL,
    headers: { 'User-Agent': userAgent },
  })

  ipcMain.handle('get-update-status', () => ({
    status: currentStatus,
    releaseName: updateReleaseName,
  }))

  ipcMain.handle('install-update', () => {
    if (currentStatus === 'ready') {
      console.log(`${TAG} User triggered restart — applying update`)
      isApplyingUpdate = true
      autoUpdater.quitAndInstall()
    }
  })

  autoUpdater.on('checking-for-update', () => {
    console.log(`${TAG} Checking for updates…`)
  })

  autoUpdater.on('update-available', () => {
    console.log(`${TAG} Update available — downloading…`)
    currentStatus = 'downloading'
    broadcastUpdateStatus()
  })

  autoUpdater.on('update-not-available', () => {
    console.log(`${TAG} App is up to date (v${version})`)
  })

  autoUpdater.on('update-downloaded', (_event, _releaseNotes, releaseName) => {
    const displayName = releaseName || 'a new version'
    console.log(`${TAG} Update downloaded: ${displayName}`)
    currentStatus = 'ready'
    updateReleaseName = displayName
    broadcastUpdateStatus()
  })

  autoUpdater.on('error', (err: Error) => {
    const msg = err.message || String(err)

    if (msg.includes('Could not get code signature') || msg.includes('Code signature')) {
      console.warn(`${TAG} Update check skipped — app is not code-signed (expected in development builds)`)
    } else if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) {
      console.warn(`${TAG} Update check failed — cannot reach update server (${UPDATE_HOST}). Will retry.`)
    } else if (msg.includes('Can not find Squirrel')) {
      console.warn(`${TAG} Squirrel not found — app was not installed via the Setup installer. Auto-updates are disabled.`)
      console.warn(`${TAG} To enable auto-updates, reinstall using the Shogo-Setup.exe installer.`)
      return
    } else if (msg.includes('404') || msg.includes('invalid response') || msg.includes('No update available')) {
      console.warn(`${TAG} No update available from server (this is normal if no newer releases are published).`)
    } else {
      console.error(`${TAG} Update error: ${msg}`)
    }
  })

  autoUpdater.checkForUpdates()
  setInterval(() => {
    if (currentStatus !== 'ready') {
      autoUpdater.checkForUpdates()
    }
  }, CHECK_INTERVAL_MS)
}
