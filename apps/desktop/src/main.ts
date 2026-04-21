// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

// Squirrel.Windows launches the app with lifecycle flags during
// install / update / uninstall. We must handle them immediately
// and exit before any heavy initialization runs.
import { handleSquirrelEvent } from './squirrel-startup'
if (handleSquirrelEvent()) {
  process.exit(0)
}

import { app, BrowserWindow, protocol, net, session, ipcMain, Menu, shell, Notification } from 'electron'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { startLocalServer, stopLocalServer, getApiUrl, getApiPort } from './local-server'
import { getWebDir } from './paths'
import { readConfig, writeConfig, getDeviceInfo } from './config'
import { initAutoUpdater, getIsApplyingUpdate } from './updater'
import { registerRecordingIpcHandlers, startMeetingMonitor, cleanupRecording } from './recording'
import { createTray, destroyTray } from './tray'

// Shape of JSON responses from the local API's cloud-login endpoints.
// Every field is optional because we also parse error bodies / empty 4xx
// responses through the same path.
interface CloudLoginBody {
  ok?: boolean
  error?: string
  email?: string
  workspace?: string
  authUrl?: string
  revoked?: boolean
}

// --- Persistent file logging ---
const logDir = process.platform === 'win32'
  ? path.join(app.getPath('userData'), 'logs')
  : path.join(app.getPath('home'), 'Library', 'Logs', 'Shogo')
fs.mkdirSync(logDir, { recursive: true })
const logFile = path.join(logDir, 'main.log')
const logStream = fs.createWriteStream(logFile, { flags: 'a' })

function writeLog(level: string, ...args: unknown[]): void {
  const ts = new Date().toISOString()
  const msg = args.map(a => (a instanceof Error ? a.stack || a.message : String(a))).join(' ')
  logStream.write(`${ts} [${level}] ${msg}\n`)
}

const origLog = console.log
const origError = console.error
const origWarn = console.warn
console.log = (...args: unknown[]) => { origLog(...args); writeLog('INFO', ...args) }
console.error = (...args: unknown[]) => { origError(...args); writeLog('ERROR', ...args) }
console.warn = (...args: unknown[]) => { origWarn(...args); writeLog('WARN', ...args) }

process.on('uncaughtException', (err) => {
  writeLog('FATAL', 'Uncaught exception:', err)
  logStream.end()
})
process.on('unhandledRejection', (reason) => {
  writeLog('FATAL', 'Unhandled rejection:', reason)
})

console.log(`[Desktop] === Shogo starting (v${app.getVersion()}, packaged=${app.isPackaged}) ===`)

// Must be called before app 'ready' — gives shogo:// a real origin instead of "null"
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'shogo',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

// Enforce single-instance so the OS-dispatched auth callback always reaches
// the app that initiated the login rather than spawning a duplicate.
if (!ensureSingleInstanceLock()) {
  // Parent instance will handle this launch; the spawned duplicate exits.
  // (The second-instance listener below fires on the existing instance with
  // the new argv, including any shogo://auth-callback URL.)
  process.exit(0)
}

// Register shogo:// as our OS protocol handler so redirects from the system
// browser find their way back to Electron. Note: shogo://app/* is still served
// by our in-process protocol.handle (see registerProtocol).
registerDefaultProtocolClient()

// macOS dispatches protocol URLs via open-url.
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (url.startsWith('shogo://auth-callback')) {
    void handleAuthCallback(url)
  }
})

// Windows & Linux pass the URL as the newest argv to a second-instance launch.
app.on('second-instance', (_event, argv) => {
  const callback = extractAuthCallback(argv)
  if (callback) {
    void handleAuthCallback(callback)
    return
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

const IS_DEV = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let isCloudMode = false

// --- OAuth deep-link support (shogo://auth-callback?state=...&key=...&...) ---
//
// The local "Sign in to Shogo Cloud" flow opens the system browser, which
// eventually redirects to shogo://auth-callback?... — the OS then dispatches
// that URL back to us (via open-url on macOS, or second-instance argv on
// Windows/Linux). We enforce a single-instance lock so the callback always
// wakes the original running app instead of spawning a duplicate.

function ensureSingleInstanceLock(): boolean {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return false
  }
  return true
}

function registerDefaultProtocolClient(): void {
  // In dev on Windows/Linux, setAsDefaultProtocolClient needs the electron
  // executable + the path to main.js so the OS can relaunch us correctly.
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('shogo', process.execPath, [path.resolve(process.argv[1])])
  } else {
    app.setAsDefaultProtocolClient('shogo')
  }
}

function extractAuthCallback(urls: string[]): string | null {
  for (const u of urls) {
    if (typeof u === 'string' && u.startsWith('shogo://auth-callback')) {
      return u
    }
  }
  return null
}

async function handleAuthCallback(callbackUrl: string): Promise<void> {
  try {
    const parsed = new URL(callbackUrl)
    const state = parsed.searchParams.get('state') || ''
    const key = parsed.searchParams.get('key') || ''
    const cloudUrl = parsed.searchParams.get('cloudUrl') || ''
    const email = parsed.searchParams.get('email') || ''
    const workspace = parsed.searchParams.get('workspace') || ''
    const error = parsed.searchParams.get('error') || ''

    if (error) {
      console.warn('[Desktop] Cloud login returned error:', error)
      notifyRendererLoginResult({ ok: false, error })
      return
    }

    if (!key || !state) {
      notifyRendererLoginResult({ ok: false, error: 'Malformed callback (missing key or state)' })
      return
    }

    const res = await fetch(`${getApiUrl()}/api/local/cloud-login/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, key, cloudUrl, email, workspace }),
    })
    const body = (await res.json().catch(() => ({}))) as CloudLoginBody
    if (!res.ok || body?.ok === false) {
      notifyRendererLoginResult({ ok: false, error: body?.error || `HTTP ${res.status}` })
      return
    }
    notifyRendererLoginResult({ ok: true, email: body?.email || email, workspace: body?.workspace || workspace })

    // Bring the main window to the front so the user sees the result.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  } catch (err) {
    console.error('[Desktop] Auth callback handling failed:', err)
    notifyRendererLoginResult({ ok: false, error: (err as Error)?.message || 'Callback failed' })
  }
}

function notifyRendererLoginResult(payload: { ok: boolean; error?: string; email?: string; workspace?: string }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('cloud-login-result', payload)
  }
}

// Keep the cloud-minted device key fresh by pinging the local heartbeat
// endpoint periodically. The local API forwards this to the cloud
// `/api/api-keys/heartbeat`, which updates `lastSeenAt` / `deviceAppVersion`
// for the Devices UI, and tells us to sign out if the key was revoked
// remotely. The AI proxy also updates `lastSeenAt` on every authenticated
// call, so this only matters when the device is idle.
const HEARTBEAT_INTERVAL_MS = 5 * 60_000
let heartbeatTimer: NodeJS.Timeout | null = null

function startCloudLoginHeartbeat(): void {
  if (heartbeatTimer) return
  const tick = async (): Promise<void> => {
    try {
      const res = await fetch(`${getApiUrl()}/api/local/cloud-login/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceAppVersion: app.getVersion() }),
      })
      if (!res.ok) return
      const body = (await res.json().catch(() => ({}))) as CloudLoginBody
      if (body?.revoked) {
        console.warn('[Desktop] Cloud key was revoked remotely, signing out')
        notifyRendererLoginResult({
          ok: false,
          error: 'Signed out from Shogo Cloud (key revoked)',
        })
      }
    } catch {
      // Transient network / local server hiccups are fine — next tick retries.
    }
  }
  heartbeatTimer = setInterval(() => { void tick() }, HEARTBEAT_INTERVAL_MS)
  setTimeout(() => { void tick() }, 30_000)
}

function buildAppMenu(): void {
  const config = readConfig()
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: config.mode === 'cloud' ? 'Switch to Local Mode' : 'Switch to Cloud Mode',
          click: () => {
            const newMode = config.mode === 'cloud' ? 'local' : 'cloud'
            writeConfig({ mode: newMode })
            app.relaunch()
            app.exit(0)
          },
        },
        { type: 'separator' },
        process.platform === 'darwin'
          ? { role: 'close' as const }
          : { role: 'quit' as const },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin' ? [
          { type: 'separator' as const },
          { role: 'front' as const },
        ] : [
          { role: 'close' as const },
        ]),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpcHandlers(): void {
  ipcMain.handle('get-app-mode', () => readConfig().mode)
  ipcMain.handle('get-app-config', () => readConfig())
  ipcMain.handle('set-app-mode', (_event, mode: 'local' | 'cloud') => {
    writeConfig({ mode })
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle('get-device-info', () => getDeviceInfo())

  // Cloud login: ask the local API for a one-shot authUrl (includes state
  // nonce + device metadata), then open it in the user's default browser.
  ipcMain.handle('start-cloud-login', async () => {
    try {
      const device = getDeviceInfo()
      const res = await fetch(`${getApiUrl()}/api/local/cloud-login/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: device.id,
          deviceName: device.name,
          devicePlatform: device.platform,
          deviceAppVersion: device.appVersion,
        }),
      })
      const body = (await res.json().catch(() => ({}))) as CloudLoginBody
      if (!res.ok || !body?.authUrl) {
        return { ok: false, error: body?.error || `HTTP ${res.status}` }
      }
      await shell.openExternal(body.authUrl)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || 'Failed to start cloud login' }
    }
  })

  ipcMain.handle('sign-out-cloud', async () => {
    try {
      const res = await fetch(`${getApiUrl()}/api/local/cloud-login/signout`, { method: 'POST' })
      const body = (await res.json().catch(() => ({}))) as CloudLoginBody
      return { ok: res.ok && body?.ok !== false, error: body?.error }
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || 'Sign-out failed' }
    }
  })

  ipcMain.handle('get-vm-status', () => {
    const { isVMAvailable } = require('./vm') as typeof import('./vm')
    const config = readConfig()
    return {
      available: isVMAvailable(),
      enabled: config.vmIsolation.enabled,
      memoryMB: config.vmIsolation.memoryMB,
      cpus: config.vmIsolation.cpus,
      mountWorkspace: config.vmIsolation.mountWorkspace,
    }
  })

  ipcMain.handle('set-vm-config', (_event, vmConfig: { enabled?: boolean | 'auto'; memoryMB?: number; cpus?: number; mountWorkspace?: boolean }) => {
    const current = readConfig()
    writeConfig({
      vmIsolation: { ...current.vmIsolation, ...vmConfig },
    })
    return readConfig().vmIsolation
  })

  ipcMain.handle('get-vm-image-status', () => {
    const { isVMAvailable, getVMImageDir, VMImageManager } = require('./vm') as typeof import('./vm')
    const imageDir = getVMImageDir()
    const mgr = new VMImageManager(imageDir)
    return {
      imagesPresent: mgr.isImagePresent(),
      vmAvailable: isVMAvailable(),
      imageVersion: mgr.getImageVersion(),
      imageDir,
    }
  })

  ipcMain.handle('download-vm-images', (event) => {
    const { getVMImageDir, VMImageManager } = require('./vm') as typeof import('./vm')
    const imageDir = getVMImageDir()
    const mgr = new VMImageManager(imageDir)

    return mgr.downloadImage((progress) => {
      event.sender.send('vm-image-download-progress', progress)
    }).then(async () => {
      console.log('[Desktop] VM images downloaded successfully')
      try {
        await fetch(`${getApiUrl()}/api/vm/pool/recycle`, { method: 'POST' })
        console.log('[Desktop] VM pool recycled with new images')
      } catch { /* pool may not be running */ }
      return { success: true }
    }).catch((err: Error) => {
      console.error('[Desktop] VM image download failed:', err)
      return { success: false, error: err.message }
    })
  })

  ipcMain.handle('recycle-vm-pool', async () => {
    try {
      const res = await fetch(`${getApiUrl()}/api/vm/pool/recycle`, { method: 'POST' })
      return res.json()
    } catch (err: any) {
      return { success: false, error: err?.message || 'Recycle failed' }
    }
  })

  ipcMain.handle('skip-vm-download', () => {
    console.log('[Desktop] User skipped VM image download')
    return { success: true }
  })

  // Desktop notification for remote actions
  ipcMain.handle('show-remote-action-notification', (_event, title: string, body: string) => {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show()
    }
  })

  ipcMain.handle('check-vm-image-update', async () => {
    try {
      const { getVMImageDir, VMImageManager } = require('./vm') as typeof import('./vm')
      const imageDir = getVMImageDir()
      const mgr = new VMImageManager(imageDir)
      if (!mgr.isImagePresent()) {
        return { available: false, currentVersion: null, latestVersion: '' }
      }
      const result = await mgr.checkForUpdate()
      return { available: result.available, currentVersion: mgr.getImageVersion(), latestVersion: result.version }
    } catch (err) {
      console.warn('[Desktop] VM image update check failed:', err)
      return { available: false, currentVersion: null, latestVersion: '' }
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Shogo',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--api-port=${getApiPort()}`],
    },
    show: false,
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const appOrigins = ['shogo://app', 'http://localhost']
    const isInternal = appOrigins.some((origin) => url.startsWith(origin))
    if (!isInternal) {
      event.preventDefault()
      if (url.startsWith('http://') || url.startsWith('https://')) {
        shell.openExternal(url)
      }
    }
  })

  if (isCloudMode) {
    const config = readConfig()
    mainWindow.loadURL(config.cloudUrl)
  } else if (IS_DEV) {
    const devUrl = process.env.DESKTOP_DEV_URL || `http://localhost:8081`
    mainWindow.loadURL(devUrl).catch(() => {
      loadProductionWeb()
    })
  } else {
    loadProductionWeb()
  }
}

function loadProductionWeb(): void {
  if (!mainWindow) return

  const webDir = getWebDir()
  const indexPath = path.join(webDir, 'index.html')

  if (!fs.existsSync(indexPath)) {
    console.error(`[Desktop] Web build not found at ${indexPath}`)
    mainWindow.loadURL('data:text/html,<h1>Web build not found</h1><p>Run expo export --platform web first.</p>')
    return
  }

  mainWindow.loadURL('shogo://app/')
}

function registerProtocol(): void {
  protocol.handle('shogo', (request) => {
    const webDir = getWebDir()
    let urlPath = new URL(request.url).pathname

    if (urlPath.startsWith('/')) {
      urlPath = urlPath.substring(1)
    }

    const filePath = path.join(webDir, urlPath)
    if (urlPath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return net.fetch(`file://${filePath}`)
    }

    const indexPath = path.join(webDir, 'index.html')
    return net.fetch(`file://${indexPath}`)
  })
}

function setupSessionHandlers(): void {
  const apiOrigin = getApiUrl()
  const appOrigin = 'shogo://app'
  const ses = session.defaultSession

  ses.webRequest.onBeforeSendHeaders(
    { urls: [`${apiOrigin}/*`] },
    (details, callback) => {
      ses.cookies.get({ url: apiOrigin })
        .then((cookies) => {
          const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')
          const headers = { ...details.requestHeaders }
          if (cookieStr) {
            headers['Cookie'] = cookieStr
          }
          callback({ requestHeaders: headers })
        })
        .catch(() => callback({ requestHeaders: details.requestHeaders }))
    }
  )

  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders }

    if (details.url.startsWith(apiOrigin)) {
      headers['Access-Control-Allow-Origin'] = [appOrigin]
      headers['Access-Control-Allow-Credentials'] = ['true']
      headers['Access-Control-Allow-Methods'] = ['GET,POST,PUT,PATCH,DELETE,OPTIONS']
      headers['Access-Control-Allow-Headers'] = ['Content-Type,Authorization,X-Requested-With']

      const setCookies = headers['Set-Cookie'] || headers['set-cookie']
      if (setCookies) {
        const rewritten = setCookies.map((cookie: string) => {
          let c = cookie.replace(/;\s*SameSite=\w+/i, '')
          c = c.replace(/;\s*Secure/i, '')
          return `${c}; SameSite=None; Secure`
        })
        headers['Set-Cookie'] = rewritten
        delete headers['set-cookie']
      }
    }

    if (!isCloudMode) {
      headers['Content-Security-Policy'] = [
        [
          "default-src 'self' shogo: https: http:",
          `connect-src *`,
          `frame-src 'self' shogo: ${apiOrigin} http://localhost:*`,
          "script-src 'self' shogo: 'unsafe-inline' 'unsafe-eval'",
          "style-src 'self' shogo: 'unsafe-inline'",
          "img-src * data: blob:",
          "font-src 'self' shogo: data: https:",
        ].join('; ')
      ]
    }

    callback({ responseHeaders: headers })
  })
}

const VM_IMAGE_CHECK_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes

function startVMImageUpdateChecker(): void {
  async function check() {
    try {
      const { getVMImageDir, VMImageManager } = require('./vm') as typeof import('./vm')
      const imageDir = getVMImageDir()
      const mgr = new VMImageManager(imageDir)
      if (!mgr.isImagePresent()) return

      const result = await mgr.checkForUpdate()
      if (result.available) {
        console.log(`[Desktop] VM image update available: ${result.version}`)
        const payload = { currentVersion: mgr.getImageVersion(), latestVersion: result.version }
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('vm-image-update-available', payload)
        }
      }
    } catch { /* network failures are expected — silently retry later */ }
  }

  setTimeout(check, 60_000)
  setInterval(check, VM_IMAGE_CHECK_INTERVAL_MS)
}

app.whenReady().then(async () => {
  const config = readConfig()
  isCloudMode = config.mode === 'cloud'

  console.log(`[Desktop] Starting in ${isCloudMode ? 'cloud' : 'local'} mode`)

  registerProtocol()
  registerIpcHandlers()
  registerRecordingIpcHandlers()
  buildAppMenu()

  if (!isCloudMode) {
    console.log('[Desktop] Starting local server...')
    try {
      await startLocalServer()
    } catch (err) {
      console.error('[Desktop] Failed to start local server:', err)
      app.quit()
      return
    }
    setupSessionHandlers()
  }

  createWindow()

  // If we were launched with a shogo://auth-callback in argv (Win/Linux cold
  // boot via the default protocol client), dispatch it now that the local
  // API is up. Give the window a beat to be ready to receive the IPC event.
  if (!isCloudMode) {
    const cold = extractAuthCallback(process.argv)
    if (cold) {
      setTimeout(() => void handleAuthCallback(cold), 1000)
    }
  }

  if (!isCloudMode) {
    createTray()
    startMeetingMonitor()
    startCloudLoginHeartbeat()
  }

  if (app.isPackaged) {
    initAutoUpdater()
  }

  if (!isCloudMode) {
    startVMImageUpdateChecker()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

let isQuitting = false
app.on('before-quit', (event) => {
  console.log(`[Desktop] before-quit fired, isQuitting=${isQuitting}, isCloudMode=${isCloudMode}, applyingUpdate=${getIsApplyingUpdate()}`)
  if (isQuitting || isCloudMode) return
  isQuitting = true

  if (getIsApplyingUpdate()) {
    console.log('[Desktop] Update pending — doing fast sync cleanup, letting Squirrel handle restart')
    cleanupRecording()
    destroyTray()
    stopLocalServer().catch(() => {})
    return
  }

  event.preventDefault()
  console.log('[Desktop] Waiting for server cleanup before exit...')
  cleanupRecording()
  destroyTray()
  stopLocalServer()
    .then(() => console.log('[Desktop] Server cleanup complete'))
    .catch((err) => console.error('[Desktop] Server cleanup error:', err))
    .finally(() => {
      console.log('[Desktop] Exiting app')
      app.exit(0)
    })
})
