// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { app, BrowserWindow, protocol, net, session, ipcMain, Menu, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import { startLocalServer, stopLocalServer, getApiUrl, getApiPort } from './local-server'
import { getWebDir } from './paths'
import { readConfig, writeConfig } from './config'
import { initAutoUpdater } from './updater'
import { registerRecordingIpcHandlers, startMeetingMonitor, cleanupRecording } from './recording'
import { createTray, destroyTray } from './tray'

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

const IS_DEV = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let isCloudMode = false

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

  ipcMain.handle('get-vm-status', () => {
    const { isVMAvailable } = require('./vm') as typeof import('./vm')
    const config = readConfig()
    return {
      available: isVMAvailable(),
      enabled: config.vmIsolation.enabled,
      memoryMB: config.vmIsolation.memoryMB,
      cpus: config.vmIsolation.cpus,
    }
  })

  ipcMain.handle('set-vm-config', (_event, vmConfig: { enabled?: boolean | 'auto'; memoryMB?: number; cpus?: number }) => {
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
    }).then(() => {
      console.log('[Desktop] VM images downloaded successfully')
      return { success: true }
    }).catch((err: Error) => {
      console.error('[Desktop] VM image download failed:', err)
      return { success: false, error: err.message }
    })
  })

  ipcMain.handle('skip-vm-download', () => {
    console.log('[Desktop] User skipped VM image download')
    return { success: true }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Shogo',
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

app.whenReady().then(async () => {
  const config = readConfig()
  isCloudMode = config.mode === 'cloud'

  console.log(`[Desktop] Starting in ${isCloudMode ? 'cloud' : 'local'} mode`)

  registerProtocol()
  registerIpcHandlers()
  registerRecordingIpcHandlers()
  buildAppMenu()

  createWindow()

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
    createTray()
    startMeetingMonitor()
  }

  if (app.isPackaged) {
    initAutoUpdater()
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
  console.log(`[Desktop] before-quit fired, isQuitting=${isQuitting}, isCloudMode=${isCloudMode}`)
  if (isQuitting || isCloudMode) return
  isQuitting = true
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
