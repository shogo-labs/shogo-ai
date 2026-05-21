// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

// Squirrel.Windows launches the app with lifecycle flags during
// install / update / uninstall. We must handle them immediately
// and exit before any heavy initialization runs.
import { handleSquirrelEvent } from './squirrel-startup'
if (handleSquirrelEvent()) {
  process.exit(0)
}

import { app, BrowserWindow, protocol, net, session, ipcMain, Menu, shell, Notification, dialog } from 'electron'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { startLocalServer, stopLocalServer, getApiUrl, getApiPort } from './local-server'
import { getWebDir } from './paths'
import { readConfig, writeConfig, getDeviceInfo, getCloudUrl } from './config'
import { buildBugReportZip, submitToDiscord, submitToGitHub, collectSystemInfo, type BugReportPayload } from './bug-report'
import { initAutoUpdater, getIsApplyingUpdate } from './updater'
import {
  registerRecordingIpcHandlers,
  startMeetingMonitor,
  cleanupRecording,
  startRecordingHttpBridge,
} from './recording'
import { createTray, destroyTray } from './tray'
import { runCloudLogin, CloudLoginError } from '@shogo-ai/worker/cloud-login'
import {
  openPreview,
  closePreview,
  setPreviewBounds,
  setPreviewVisible,
  reloadPreview,
  goBackPreview,
  goForwardPreview,
  getPreviewState,
  closeAllForWindow,
  onPreviewEvent,
  type PreviewBounds,
} from './preview-views'

// Shape of JSON responses from the local API's cloud-login endpoints
// (used by the heartbeat + signout helpers below). Every field is optional
// because we parse error bodies / empty 4xx responses through the same path.
interface CloudLoginBody {
  ok?: boolean
  error?: string
  email?: string
  workspace?: string
  revoked?: boolean
  cloudKeyRejected?: boolean
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
// Used by the in-process protocol.handle for shogo://app/* asset serving
// (see registerProtocol). The legacy shogo://auth-callback deep link is
// no longer used now that sign-in is poll-based — see runCloudSignIn().
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

// Single-instance: keep one Shogo window per user. Second-instance just
// focuses the existing window (no auth-callback handling — sign-in is
// now driven by polling the cloud, not a deep link).
if (!ensureSingleInstanceLock()) {
  process.exit(0)
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

const IS_DEV = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let isCloudMode = false

// --- Cloud sign-in: poll-based device flow (no deep link) ---
//
// The actual handshake (POST /api/cli/login/start → open browser →
// poll /api/cli/login/poll → return minted key) lives in the MIT
// `@shogo-ai/worker/cloud-login` module so the desktop and the
// `shogo login` CLI share one implementation. The cloud only has to
// understand one device flow.
//
// Desktop-specific glue we keep here:
//   - `shell.openExternal` instead of the worker's child_process opener
//     (Electron has a first-class API and macOS sandboxing prefers it)
//   - `installSignalHandlers: false` — the worker would otherwise hook
//     SIGINT/SIGTERM, which would race with Electron's lifecycle
//   - PUT the minted key to the local API at /api/local/shogo-key
//     (validates against cloud, persists localConfig, restarts the
//     instance tunnel)
//   - Notify the renderer via `cloud-login-result` IPC
//   - `activeCloudSignIn` cancel handle used by the IPC cancel path
//
// No localhost listener, no protocol handler — works behind firewalls
// and over SSH-forwarded sessions.

function ensureSingleInstanceLock(): boolean {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return false
  }
  return true
}

// In-flight sign-in handle so the renderer can cancel via IPC. The
// handshake itself runs inside @shogo-ai/worker/cloud-login — we just
// thread an AbortController through to its `abortSignal` option.
let activeCloudSignIn: { abort: AbortController } | null = null

function notifyRendererLoginResult(payload: {
  ok: boolean
  error?: string
  email?: string
  workspace?: string
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('cloud-login-result', payload)
  }
}

async function runCloudSignIn(opts?: { workspaceId?: string }): Promise<{ ok: boolean; error?: string }> {
  if (activeCloudSignIn) {
    return { ok: false, error: 'A sign-in is already in progress. Cancel it first.' }
  }
  const cloudUrl = getCloudUrl()
  const device = getDeviceInfo()
  const ac = new AbortController()
  activeCloudSignIn = { abort: ac }

  let mintedKey: string
  let mintedEmail: string | null
  let mintedWorkspace: string | null
  try {
    const result = await runCloudLogin({
      cloudUrl,
      client: 'desktop',
      deviceId: device.id,
      deviceName: device.name,
      devicePlatform: device.platform,
      appVersion: device.appVersion,
      workspaceId: opts?.workspaceId,
      // Use Electron's first-class shell helper instead of the worker's
      // child_process opener (macOS sandboxing prefers it).
      openBrowser: (url) => shell.openExternal(url).then(() => undefined),
      // Don't let the worker steal SIGINT/SIGTERM from Electron's lifecycle.
      installSignalHandlers: false,
      abortSignal: ac.signal,
      log: (line) => writeLog('info', '[CloudLogin]', line),
    })
    mintedKey = result.key
    mintedEmail = result.email
    mintedWorkspace = result.workspace
  } catch (err) {
    const error =
      err instanceof CloudLoginError
        ? mapCloudLoginError(err)
        : `Sign-in failed: ${(err as Error)?.message ?? err}`
    const out = { ok: false as const, error }
    notifyRendererLoginResult(out)
    return out
  } finally {
    activeCloudSignIn = null
  }

  // Hand the minted key to the local API. The existing PUT handler
  // re-validates against cloud, persists localConfig, and restarts
  // the instance tunnel.
  try {
    const persistRes = await fetch(`${getApiUrl()}/api/local/shogo-key`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: mintedKey }),
    })
    const persistBody = (await persistRes.json().catch(() => ({}))) as CloudLoginBody
    if (!persistRes.ok || persistBody?.ok === false) {
      const error = persistBody?.error || `Local API rejected the minted key (HTTP ${persistRes.status})`
      notifyRendererLoginResult({ ok: false, error })
      return { ok: false, error }
    }
  } catch (err) {
    const error = `Local API unreachable: ${(err as Error)?.message ?? err}`
    notifyRendererLoginResult({ ok: false, error })
    return { ok: false, error }
  }

  notifyRendererLoginResult({
    ok: true,
    email: mintedEmail ?? undefined,
    workspace: mintedWorkspace ?? undefined,
  })

  // Bring the main window forward so the user sees the result.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }

  return { ok: true }
}

/** Translate the worker's typed CloudLoginError into the user-facing
 * strings the renderer's Settings UI expects. Keeps the strings in one
 * place (the previous duplicate had them inlined at five different
 * `return { ok: false, error: '...' }` sites). */
function mapCloudLoginError(err: CloudLoginError): string {
  switch (err.kind) {
    case 'denied': return 'Sign-in was denied in the browser.'
    case 'expired': return 'Sign-in request expired before approval.'
    case 'timeout': return 'Sign-in timed out before approval.'
    case 'cancelled': return 'Cancelled'
    case 'transport': return err.message
    default: return err.message
  }
}

// Keep the cloud-minted device key fresh by pinging the local heartbeat
// endpoint periodically. The local API forwards this to the cloud
// `/api/api-keys/heartbeat`, which updates `lastSeenAt` / `deviceAppVersion`
// for the Devices UI. If the cloud rejects the key (revoked / expired),
// we push `cloudKeyRejected` to the renderer so Settings can show a
// warning banner — but we never auto-sign the user out. The AI proxy
// also updates `lastSeenAt` on every authenticated call, so this only
// matters when the device is idle.
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
      const body = (await res.json().catch(() => ({}))) as CloudLoginBody
      if (body?.cloudKeyRejected) {
        console.warn('[Desktop] Cloud rejected API key — notifying renderer of connection issue')
      }
      // Push current cloud-connection health to the renderer so the
      // Settings UI can show a warning banner without signing out.
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('cloud-connection-status', {
          connected: body?.ok === true,
          cloudKeyRejected: !!body?.cloudKeyRejected,
          error: body?.error,
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
    {
      label: 'Help',
      submenu: [
        {
          label: 'Documentation',
          click: () => { shell.openExternal('https://docs.shogo.ai') },
        },
        { type: 'separator' },
        {
          label: 'Report Bug...',
          click: () => {
            if (mainWindow) {
              if (mainWindow.isMinimized()) mainWindow.restore()
              mainWindow.focus()
              mainWindow.webContents.send('navigate', '/settings?tab=support')
            }
          },
        },
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

  // Folder picker for "external" (VS Code-style) projects. Bound to a
  // single visible window so the OS sheet attaches to the right frame on
  // macOS. Returns absolute paths; the caller is responsible for POSTing
  // them to /api/local/projects/from-folders.
  ipcMain.handle('pick-folders', async (event, opts?: { multi?: boolean; defaultPath?: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
    const properties: Array<
      'openDirectory' | 'multiSelections' | 'createDirectory' | 'showHiddenFiles'
    > = ['openDirectory', 'createDirectory']
    if (opts?.multi) properties.push('multiSelections')
    try {
      const res = win
        ? await dialog.showOpenDialog(win, { properties, defaultPath: opts?.defaultPath })
        : await dialog.showOpenDialog({ properties, defaultPath: opts?.defaultPath })
      if (res.canceled || res.filePaths.length === 0) return { ok: false as const }
      return { ok: true as const, paths: res.filePaths }
    } catch (err) {
      console.error('[Desktop] pick-folders failed:', err)
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false as const, error: message }
    }
  })

  ipcMain.handle('get-device-info', () => getDeviceInfo())

  // Cloud sign-in: drive the same poll-based device flow the CLI uses
  // (see runCloudSignIn() above). We open the system browser pointed at
  // /auth/cli-link, poll cloud /api/cli/login/poll until approved or
  // cancelled, then PUT the minted key into local /api/local/shogo-key.
  // The renderer's `cloud-login-result` IPC fires exactly once.
  // Pass `{ workspaceId }` to pre-select a workspace on the bridge picker.
  ipcMain.handle('start-cloud-login', async (_event, opts?: { workspaceId?: string }) => {
    try {
      return await runCloudSignIn(opts)
    } catch (err) {
      console.error('[Desktop] start-cloud-login failed:', err)
      return { ok: false, error: (err as Error)?.message || 'Failed to start cloud login' }
    }
  })

  // Cancel an in-progress sign-in (the user closed the browser tab and
  // wants to try a different workspace, etc.). Idempotent — no-op when
  // nothing is in flight.
  ipcMain.handle('cancel-cloud-login', () => {
    if (!activeCloudSignIn) return { ok: true, cancelled: false }
    activeCloudSignIn.abort.abort()
    return { ok: true, cancelled: true }
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

  // Chat-turn-complete notification: includes session + project so a click
  // can focus the window and navigate the renderer to the right chat.
  ipcMain.handle(
    'show-chat-notification',
    (
      _event,
      args: { title: string; body: string; sessionId: string; projectId: string },
    ) => {
      if (!Notification.isSupported()) return
      const { title, body, sessionId, projectId } = args
      const n = new Notification({ title, body, silent: false })
      n.on('click', () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
          mainWindow.webContents.send('notification-clicked', { sessionId, projectId })
        }
      })
      n.show()
    },
  )

  // Source of truth for renderer inactivity detection on desktop —
  // document.hasFocus() is unreliable when another app is foregrounded on
  // macOS, so we defer to BrowserWindow.isFocused().
  ipcMain.handle('get-window-focused', () => {
    return !!mainWindow && mainWindow.isFocused()
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

  // --- Bug report / log sharing ---

  ipcMain.handle('capture-screenshot', async () => {
    if (!mainWindow) return { ok: false, error: 'No window available' }
    try {
      const image = await mainWindow.webContents.capturePage()
      return { ok: true, base64: image.toPNG().toString('base64') }
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || 'Screenshot capture failed' }
    }
  })

  ipcMain.handle('export-bug-report', async (_event, payload: BugReportPayload) => {
    try {
      const bundle = buildBugReportZip(payload)
      const result = await dialog.showSaveDialog({
        title: 'Save Bug Report',
        defaultPath: bundle.filename,
        filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
      })
      if (result.canceled || !result.filePath) {
        return { ok: false, error: 'Cancelled' }
      }
      fs.writeFileSync(result.filePath, bundle.zipBuffer)
      return { ok: true, path: result.filePath }
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || 'Export failed' }
    }
  })

  ipcMain.handle('submit-bug-report', async (_event, payload: BugReportPayload) => {
    try {
      const config = readConfig()
      const bundle = buildBugReportZip(payload)
      const results: { discord?: { ok: boolean; error?: string }; github?: { ok: boolean; error?: string; issueUrl?: string } } = {}

      if (config.bugReport?.discordWebhookUrl) {
        results.discord = await submitToDiscord(config.bugReport.discordWebhookUrl, payload, bundle)
      }

      if (config.bugReport?.githubRepo && config.bugReport?.githubToken) {
        results.github = await submitToGitHub(config.bugReport.githubRepo, config.bugReport.githubToken, payload)
      }

      if (!results.discord && !results.github) {
        return { ok: false, error: 'No submission targets configured. Use "Export" to save locally.' }
      }

      const anyFailed = (results.discord && !results.discord.ok) || (results.github && !results.github.ok)
      if (anyFailed) {
        const errors = [results.discord?.error, results.github?.error].filter(Boolean).join('; ')
        return { ok: false, error: errors }
      }
      return { ok: true, ...results }
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || 'Submission failed' }
    }
  })

  ipcMain.handle('get-bug-report-config', () => {
    const config = readConfig()
    return {
      hasDiscord: !!config.bugReport?.discordWebhookUrl,
      hasGitHub: !!(config.bugReport?.githubRepo && config.bugReport?.githubToken),
      maxLogLines: config.bugReport?.maxLogLines ?? 500,
    }
  })

  ipcMain.handle('set-bug-report-config', (_event, bugReport: { discordWebhookUrl?: string; githubRepo?: string; githubToken?: string; maxLogLines?: number }) => {
    const current = readConfig()
    writeConfig({ bugReport: { ...current.bugReport, ...bugReport } })
    return { ok: true }
  })

  ipcMain.handle('get-system-info', () => collectSystemInfo())

  // ---------------------------------------------------------------------
  // External preview: Electron WebContentsView overlay
  // ---------------------------------------------------------------------
  //
  // For projects with `workingMode === 'external'` we let users embed a
  // real Chromium view of their own dev server. The view lives in
  // `preview-views.ts` as a per-project registry; main.ts is the IPC
  // bridge between the renderer (React layout) and that registry.
  //
  // Bounds are pushed by the renderer in window-local CSS pixels; we pass
  // them straight through because `WebContentsView.setBounds` operates in
  // the same coordinate space as the host BrowserWindow.

  ipcMain.handle(
    'preview:open',
    (event, args: { projectId: string; url: string; allowNonLocal?: boolean }) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
      if (!win) return { ok: false, error: 'no-window' }
      return openPreview(args?.projectId, args?.url, win, {
        allowNonLocal: !!args?.allowNonLocal,
      })
    },
  )

  ipcMain.handle('preview:close', (_event, args: { projectId: string }) => {
    closePreview(args?.projectId)
    return { ok: true }
  })

  ipcMain.handle('preview:set-bounds', (_event, args: { projectId: string; bounds: PreviewBounds }) => {
    if (!args?.projectId || !args?.bounds) return { ok: false }
    setPreviewBounds(args.projectId, args.bounds)
    return { ok: true }
  })

  ipcMain.handle('preview:set-visible', (_event, args: { projectId: string; visible: boolean }) => {
    if (!args?.projectId) return { ok: false }
    setPreviewVisible(args.projectId, !!args.visible)
    return { ok: true }
  })

  ipcMain.handle('preview:reload', (_event, args: { projectId: string }) => {
    reloadPreview(args?.projectId)
    return { ok: true }
  })

  ipcMain.handle('preview:go-back', (_event, args: { projectId: string }) => {
    goBackPreview(args?.projectId)
    return { ok: true }
  })

  ipcMain.handle('preview:go-forward', (_event, args: { projectId: string }) => {
    goForwardPreview(args?.projectId)
    return { ok: true }
  })

  ipcMain.handle('preview:get-state', (_event, args: { projectId: string }) => {
    return getPreviewState(args?.projectId)
  })

  // Forward preview events to every renderer. The renderer ignores events
  // for project IDs it doesn't care about, so a single shared channel is
  // fine — there's only one BrowserWindow in practice.
  onPreviewEvent((ev) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send('preview:event', ev)
      } catch {}
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
      // ⚠️ Do NOT use `path.join(__dirname, 'preload.js')` here. `scripts/bundle-main.mjs`
      // runs `bun build --target node --format cjs` over this file, and Bun inlines
      // `__dirname` as a string literal of the source file's directory at build time
      // rather than leaving it as Node's runtime CJS builtin. On a CI runner that
      // means `__dirname` ships as `/Users/runner/work/<org>/<repo>/apps/desktop/src`
      // baked into `app.asar`, so on every other machine Electron tries to load a
      // preload script from a path that doesn't exist — no IPC bridge gets installed,
      // `window.shogoDesktop` is undefined, and the renderer fails over to the
      // default `localhost:8002` API URL, which is wrong for the packaged desktop
      // (it uses a dynamic port from `getApiPort()`). v1.7.8 shipped that regression.
      //
      // `app.getAppPath()` is supplied by Electron at runtime and is NOT subject to
      // bundler inlining. It returns the directory containing the loaded
      // `package.json` — `apps/desktop/` in dev, `…/Contents/Resources/app.asar/` in
      // a packaged build — and `preload.js` is at `<that>/dist/preload.js` in both.
      preload: path.join(app.getAppPath(), 'dist', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox is disabled so the preload script can require the audio
      // capture pipeline (pcm-worklet.ts, audio-capture-manager.ts) via
      // relative paths. contextIsolation=true + nodeIntegration=false still
      // keep the main world insulated — only the contextBridge-exposed
      // functions reach the page.
      sandbox: false,
      additionalArguments: [`--api-port=${getApiPort()}`],
    },
    show: false,
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    if (mainWindow) closeAllForWindow(mainWindow)
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
    mainWindow.loadURL(getCloudUrl())
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

function isTrustedMediaOrigin(url: string): boolean {
  if (!url) return false
  if (url.startsWith('shogo://')) return true
  if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) return true
  if (IS_DEV) {
    const devUrl = process.env.DESKTOP_DEV_URL
    if (devUrl && url.startsWith(devUrl)) return true
  }
  if (isCloudMode) {
    const cloudUrl = getCloudUrl()
    if (cloudUrl && url.startsWith(cloudUrl)) return true
  }
  return false
}

function setupSessionHandlers(): void {
  const apiOrigin = getApiUrl()
  const appOrigin = 'shogo://app'
  const ses = session.defaultSession

  // Allow microphone (and other media) requests only from our own app
  // origins. Without an explicit handler, Electron's default is to deny
  // permission requests from non-standard schemes like `shogo://`, which
  // is why getUserMedia silently fails in the packaged macOS build.
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission === 'media') {
      const requestingUrl = details?.requestingUrl || webContents.getURL()
      if (isTrustedMediaOrigin(requestingUrl)) {
        callback(true)
        return
      }
      console.warn(`[Desktop] denying ${permission} request from untrusted origin: ${requestingUrl}`)
      callback(false)
      return
    }
    callback(false)
  })

  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    if (permission === 'media') {
      return isTrustedMediaOrigin(requestingOrigin)
    }
    return false
  })

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

      // Preserve the API server's `Access-Control-Allow-Headers` when present:
      // Hono's `cors()` middleware reflects the request's
      // `Access-Control-Request-Headers`, so the API already echoes back any
      // custom header the renderer sends (`X-Chat-Session-Id`, `X-Session-Id`,
      // `x-client-version`, `x-sync-version`, …). Overwriting it with a static
      // list silently broke preflights as soon as we added new headers — see
      // the 1.7.15 chat regression where `x-chat-session-id` was rejected.
      // Fall back to a permissive default only if the server didn't send one.
      const hasAllowHeaders =
        (headers['Access-Control-Allow-Headers']?.length ?? 0) > 0 ||
        (headers['access-control-allow-headers']?.length ?? 0) > 0
      if (!hasAllowHeaders) {
        headers['Access-Control-Allow-Headers'] = ['Content-Type,Authorization,X-Requested-With']
      }

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
          "script-src 'self' shogo: blob: 'unsafe-inline' 'unsafe-eval'",
          "worker-src 'self' shogo: blob:",
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

  const skipLocalServer = !isCloudMode && process.env.SHOGO_SKIP_LOCAL_SERVER === 'true'
  if (!isCloudMode && !skipLocalServer) {
    console.log('[Desktop] Starting local server...')
    try {
      await startLocalServer()
    } catch (err) {
      console.error('[Desktop] Failed to start local server:', err)
      app.quit()
      return
    }
    setupSessionHandlers()
  } else if (skipLocalServer) {
    console.log('[Desktop] SHOGO_SKIP_LOCAL_SERVER=true — skipping local API (e2e mode)')
  }

  createWindow()

  if (!isCloudMode) {
    createTray()
    startMeetingMonitor()
    startCloudLoginHeartbeat()
    void startRecordingHttpBridge()
  }

  if (app.isPackaged) {
    initAutoUpdater()
  } else {
    // In dev mode, register no-op handlers so the renderer doesn't crash
    // when it invokes update-related IPC (initAutoUpdater registers these
    // only in packaged builds).
    ipcMain.handle('get-update-status', () => ({ status: 'idle', releaseName: null, availableVersion: null }))
    ipcMain.handle('download-update', () => ({ ok: false, error: 'Updates disabled in dev mode' }))
    ipcMain.handle('dismiss-update', () => ({ ok: true }))
    ipcMain.handle('install-update', () => {})
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
