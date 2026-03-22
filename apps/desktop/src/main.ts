// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { app, BrowserWindow, protocol, net, session } from 'electron'
import path from 'path'
import fs from 'fs'
import { startLocalServer, stopLocalServer, getApiUrl } from './local-server'
import { getWebDir } from './paths'

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
    },
    show: false,
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (IS_DEV) {
    // In dev, load from the Expo dev server or the built web files
    const devUrl = process.env.DESKTOP_DEV_URL || `http://localhost:8081`
    mainWindow.loadURL(devUrl).catch(() => {
      // Fall back to built files if dev server isn't running
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

  // Use a custom protocol to serve the SPA with proper route handling.
  // file:// doesn't support SPA routing (History API), so we register
  // a custom scheme that falls back to index.html for all unknown paths.
  mainWindow.loadURL('shogo://app/')
}

function registerProtocol(): void {
  protocol.handle('shogo', (request) => {
    const webDir = getWebDir()
    let urlPath = new URL(request.url).pathname

    // Remove leading slash for file resolution
    if (urlPath.startsWith('/')) {
      urlPath = urlPath.substring(1)
    }

    // Try to serve the exact file first
    const filePath = path.join(webDir, urlPath)
    if (urlPath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return net.fetch(`file://${filePath}`)
    }

    // SPA fallback: serve index.html for all routes
    const indexPath = path.join(webDir, 'index.html')
    return net.fetch(`file://${indexPath}`)
  })
}

function setupSessionHandlers(): void {
  const apiOrigin = getApiUrl()
  const appOrigin = 'shogo://app'
  const ses = session.defaultSession

  // Attach cookies from the jar to outgoing API requests.
  // Cookies set by localhost:8002 won't auto-attach on requests from shogo://
  // because they're cross-origin with SameSite=Lax.
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

  // Override CORS + cookie headers on API responses, and set CSP on all responses.
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders }

    if (details.url.startsWith(apiOrigin)) {
      headers['Access-Control-Allow-Origin'] = [appOrigin]
      headers['Access-Control-Allow-Credentials'] = ['true']
      headers['Access-Control-Allow-Methods'] = ['GET,POST,PUT,PATCH,DELETE,OPTIONS']
      headers['Access-Control-Allow-Headers'] = ['Content-Type,Authorization,X-Requested-With']

      // Rewrite Set-Cookie to SameSite=None;Secure so the browser stores
      // them for cross-origin requests from shogo:// → localhost
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

    headers['Content-Security-Policy'] = [
      [
        "default-src 'self' shogo:",
        `connect-src 'self' shogo: ${apiOrigin} http://localhost:* ws://localhost:*`,
        "script-src 'self' shogo: 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' shogo: 'unsafe-inline'",
        "img-src 'self' shogo: data: blob: https:",
        "font-src 'self' shogo: data:",
      ].join('; ')
    ]

    callback({ responseHeaders: headers })
  })
}

app.whenReady().then(async () => {
  registerProtocol()

  console.log('[Desktop] Starting local server...')
  try {
    await startLocalServer()
  } catch (err) {
    console.error('[Desktop] Failed to start local server:', err)
    app.quit()
    return
  }

  setupSessionHandlers()
  createWindow()

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

app.on('before-quit', async () => {
  await stopLocalServer()
})
