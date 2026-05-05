// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { app, autoUpdater, ipcMain, BrowserWindow, net } from 'electron'

const TAG = '[Updater]'
const UPDATE_HOST = 'https://update.electronjs.org'
const REPO = 'shogo-labs/shogo-ai'
const CHECK_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes
const SUPPORTED_PLATFORMS = ['darwin', 'win32']

// Updates are opt-in: we probe the feed manually so we can show the user
// what's available *before* Electron's autoUpdater starts downloading.
// Squirrel couples checkForUpdates() with the actual download, so to keep
// the download user-gated we only call checkForUpdates() once the user
// clicks "Download" on the banner.
type UpdateStatus = 'idle' | 'available' | 'downloading' | 'ready' | 'error'

interface FeedResponse {
  url?: string
  name?: string
  notes?: string
  pub_date?: string
}

let currentStatus: UpdateStatus = 'idle'
let availableVersion: string | null = null
let updateReleaseName: string | null = null
let isApplyingUpdate = false
// Tracks a version the user dismissed in this session so we don't re-prompt
// every probe interval. Cleared on app restart by design.
let dismissedVersion: string | null = null
let feedURL: string | null = null
let userAgent: string | null = null

export function getIsApplyingUpdate(): boolean {
  return isApplyingUpdate
}

function broadcastUpdateStatus() {
  const payload = {
    status: currentStatus,
    releaseName: updateReleaseName,
    availableVersion,
  }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('desktop-update-status', payload)
  }
}

// Manual probe of the Electron update service. Returns the response payload
// when an update is available, or null when the server reports up-to-date
// (HTTP 204) or the request fails. We deliberately don't throw — transient
// network errors are normal and should silently retry on the next interval.
async function probeFeed(): Promise<FeedResponse | null> {
  if (!feedURL) return null
  try {
    const res = await net.fetch(feedURL, {
      headers: userAgent ? { 'User-Agent': userAgent } : undefined,
    })
    if (res.status === 204) return null
    if (!res.ok) {
      console.warn(`${TAG} Feed probe returned HTTP ${res.status}`)
      return null
    }
    const body = (await res.json().catch(() => null)) as FeedResponse | null
    if (!body || typeof body !== 'object') return null
    return body
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) {
      console.warn(`${TAG} Feed probe failed — cannot reach update server. Will retry.`)
    } else {
      console.warn(`${TAG} Feed probe failed: ${msg}`)
    }
    return null
  }
}

async function runProbe(): Promise<void> {
  // Don't disturb later phases of the update lifecycle. Once Squirrel is
  // downloading or the bits are sitting on disk, we just wait for the user
  // to restart.
  if (currentStatus === 'downloading' || currentStatus === 'ready') return

  const result = await probeFeed()
  if (!result) {
    if (currentStatus === 'available') {
      // Server now reports up-to-date (e.g. release was yanked). Clear the
      // banner so we don't keep offering a non-existent version.
      console.log(`${TAG} Previously-available update is no longer offered — clearing banner`)
      currentStatus = 'idle'
      availableVersion = null
      broadcastUpdateStatus()
    }
    return
  }

  const offered = result.name || null
  if (offered && dismissedVersion && offered === dismissedVersion) {
    // User already said "not now" for this exact version — stay quiet.
    return
  }

  if (currentStatus === 'available' && availableVersion === offered) {
    // Already prompting for this version; nothing to do.
    return
  }

  console.log(`${TAG} Update available: ${offered ?? '(unnamed)'}`)
  currentStatus = 'available'
  availableVersion = offered
  broadcastUpdateStatus()
}

export function initAutoUpdater(): void {
  const platform = process.platform
  const arch = process.arch
  const version = app.getVersion()

  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    console.log(`${TAG} Skipping — auto-update not supported on ${platform}`)
    return
  }

  feedURL = `${UPDATE_HOST}/${REPO}/${platform}-${arch}/${version}`
  userAgent = `shogo-desktop/${version} (${platform}: ${arch})`
  console.log(`${TAG} Initialising (v${version}, ${platform}-${arch})`)
  console.log(`${TAG} Feed URL: ${feedURL}`)

  autoUpdater.setFeedURL({
    url: feedURL,
    headers: { 'User-Agent': userAgent },
  })

  ipcMain.handle('get-update-status', () => ({
    status: currentStatus,
    releaseName: updateReleaseName,
    availableVersion,
  }))

  ipcMain.handle('download-update', () => {
    if (currentStatus !== 'available') {
      console.log(`${TAG} download-update ignored — status is ${currentStatus}`)
      return { ok: false, error: `not available (status=${currentStatus})` }
    }
    console.log(`${TAG} User opted in — starting download`)
    // Squirrel's checkForUpdates() is the only way to kick off the download;
    // it will fire 'update-available' immediately (since we already know one
    // is) and then 'update-downloaded' when the bits are on disk.
    autoUpdater.checkForUpdates()
    return { ok: true }
  })

  ipcMain.handle('dismiss-update', () => {
    if (currentStatus !== 'available') {
      return { ok: false, error: `not available (status=${currentStatus})` }
    }
    dismissedVersion = availableVersion
    console.log(`${TAG} User dismissed update ${dismissedVersion ?? '(unnamed)'} for this session`)
    currentStatus = 'idle'
    availableVersion = null
    broadcastUpdateStatus()
    return { ok: true }
  })

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
    if (currentStatus === 'available') {
      currentStatus = 'idle'
      availableVersion = null
      broadcastUpdateStatus()
    }
  })

  autoUpdater.on('update-downloaded', (_event, _releaseNotes, releaseName) => {
    const displayName = releaseName || availableVersion || 'a new version'
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

    // If the user-initiated download failed, return the banner to the
    // 'available' state so they can retry instead of being stuck on the
    // 'downloading' spinner forever.
    if (currentStatus === 'downloading') {
      currentStatus = 'available'
      broadcastUpdateStatus()
    }
  })

  void runProbe()
  setInterval(() => { void runProbe() }, CHECK_INTERVAL_MS)
}
