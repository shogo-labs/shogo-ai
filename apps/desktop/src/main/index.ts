import { app, BrowserWindow, shell, session } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { registerIpcHandlers } from './ipc-handlers'
import { LocalAgentRuntimeManager } from './runtime-manager'
import { FileSyncManager } from './file-sync-manager'
import { createTray } from './tray'
import { setupAutoUpdater } from './auto-updater'

const isDev = !app.isPackaged

// Enable Chrome DevTools Protocol on port 9222 so external tools
// (e.g. chrome-devtools MCP) can connect to the renderer process.
// Must be called before app.whenReady().
if (isDev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

/**
 * Resolve the URL/path for the web app.
 *
 * Dev:  loads the apps/web Vite dev server (must be running separately)
 * Prod: loads the pre-built web app bundled as an extra resource
 */
const WEB_DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:3000'
const WEB_DIST_PATH = isDev
  ? join(__dirname, '../../../../apps/web/dist/index.html')
  : join(process.resourcesPath, 'web-dist', 'index.html')

// API server URL for the runtime manager's AI proxy.
// In dev the web app proxies /api → localhost:8002, but the runtime manager
// talks to the API directly (needs the real host, not the Vite proxy).
const API_URL = process.env.API_URL || 'http://localhost:8002'

let mainWindow: BrowserWindow | null = null
let runtimeManager: LocalAgentRuntimeManager | null = null
let syncManager: FileSyncManager | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#09090b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', (event) => {
    if (runtimeManager && runtimeManager.getActiveProjects().length > 0) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  if (isDev) {
    mainWindow.loadURL(WEB_DEV_URL)
    // Open devtools in a separate window in dev
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else if (existsSync(WEB_DIST_PATH)) {
    mainWindow.loadFile(WEB_DIST_PATH)
  } else {
    // Fallback: load the web app's live URL
    mainWindow.loadURL(WEB_DEV_URL)
  }
}

app.whenReady().then(async () => {
  // Allow CORS for API requests from the web app
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders } })
  })

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Access-Control-Allow-Origin': ['*'],
      },
    })
  })

  runtimeManager = new LocalAgentRuntimeManager()
  runtimeManager.setApiUrl(API_URL)

  syncManager = new FileSyncManager()
  syncManager.setApiUrl(API_URL)

  registerIpcHandlers(runtimeManager, syncManager, () => mainWindow)

  createWindow()
  createTray(runtimeManager, () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    } else {
      createWindow()
    }
  })

  setupAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else {
      mainWindow?.show()
      mainWindow?.focus()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (!runtimeManager || runtimeManager.getActiveProjects().length === 0) {
      app.quit()
    }
  }
})

app.on('before-quit', async () => {
  if (syncManager) {
    syncManager.stopAll()
  }
  if (runtimeManager) {
    await runtimeManager.stopAll()
  }
})
