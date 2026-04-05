// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { app, autoUpdater } from 'electron'

const TAG = '[Updater]'
const UPDATE_HOST = 'https://update.electronjs.org'
const REPO = 'shogo-labs/shogo-ai'
const CHECK_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes
const SUPPORTED_PLATFORMS = ['darwin', 'win32']

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

  autoUpdater.on('checking-for-update', () => {
    console.log(`${TAG} Checking for updates…`)
  })

  autoUpdater.on('update-available', () => {
    console.log(`${TAG} Update available — downloading…`)
  })

  autoUpdater.on('update-not-available', () => {
    console.log(`${TAG} App is up to date (v${version})`)
  })

  autoUpdater.on('update-downloaded', (_event, releaseNotes, releaseName) => {
    console.log(`${TAG} Update downloaded: ${releaseName || 'unknown'}`)
    if (releaseNotes) {
      console.log(`${TAG} Release notes: ${typeof releaseNotes === 'string' ? releaseNotes.slice(0, 200) : releaseNotes}`)
    }
  })

  autoUpdater.on('error', (err: Error) => {
    const msg = err.message || String(err)

    if (msg.includes('Could not get code signature') || msg.includes('Code signature')) {
      console.warn(`${TAG} Update check skipped — app is not code-signed (expected in development builds)`)
    } else if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) {
      console.warn(`${TAG} Update check failed — cannot reach update server (${UPDATE_HOST}). Will retry.`)
    } else if (msg.includes('404') || msg.includes('invalid response') || msg.includes('No update available')) {
      console.warn(`${TAG} Update check failed — server returned no valid update. This is normal if no releases are published yet.`)
      console.warn(`${TAG}   Feed URL: ${feedURL}`)
      console.warn(`${TAG}   Ensure GitHub Releases for ${REPO} include a .zip asset for ${platform}-${arch}`)
    } else {
      console.error(`${TAG} Update error: ${msg}`)
    }
  })

  autoUpdater.checkForUpdates()
  setInterval(() => autoUpdater.checkForUpdates(), CHECK_INTERVAL_MS)
}
