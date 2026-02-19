import { ipcMain, BrowserWindow, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { LocalAgentRuntimeManager } from './runtime-manager'

const SETTINGS_PATH = () => join(app.getPath('userData'), 'settings.json')

function loadSettings(): Record<string, unknown> {
  try {
    const path = SETTINGS_PATH()
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'))
    }
  } catch {
    // corrupt settings file — start fresh
  }
  return {}
}

function saveSettings(settings: Record<string, unknown>): void {
  writeFileSync(SETTINGS_PATH(), JSON.stringify(settings, null, 2))
}

export function registerIpcHandlers(
  runtimeManager: LocalAgentRuntimeManager,
  getMainWindow: () => BrowserWindow | null,
): void {
  // ── Runtime lifecycle ──────────────────────────────────────────────

  ipcMain.handle('runtime:start', async (_event, projectId: string) => {
    try {
      const info = await runtimeManager.start(projectId)
      return { ok: true, data: info }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('runtime:stop', async (_event, projectId: string) => {
    try {
      await runtimeManager.stop(projectId)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('runtime:restart', async (_event, projectId: string) => {
    try {
      const info = await runtimeManager.restart(projectId)
      return { ok: true, data: info }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('runtime:status', (_event, projectId: string) => {
    return runtimeManager.status(projectId)
  })

  ipcMain.handle('runtime:list', () => {
    return runtimeManager.list()
  })

  ipcMain.handle('runtime:logs', (_event, projectId: string) => {
    return runtimeManager.getLogs(projectId)
  })

  // Forward log events to renderer
  runtimeManager.onLog((projectId, line) => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('runtime:log', projectId, line)
    }
  })

  // ── Settings ───────────────────────────────────────────────────────

  ipcMain.handle('settings:get', (_event, key: string) => {
    const settings = loadSettings()
    return settings[key] ?? null
  })

  ipcMain.handle('settings:set', (_event, key: string, value: unknown) => {
    const settings = loadSettings()
    settings[key] = value
    saveSettings(settings)
  })

  ipcMain.handle('settings:getAll', () => {
    return loadSettings()
  })

  // ── API Key management (encrypted with OS keychain) ────────────────

  ipcMain.handle('auth:setApiKey', (_event, key: string) => {
    runtimeManager.setAnthropicApiKey(key)
    return { ok: true }
  })

  ipcMain.handle('auth:hasApiKey', () => {
    return runtimeManager.getAnthropicApiKey() !== null
  })

  ipcMain.handle('auth:clearApiKey', () => {
    try {
      const keyPath = join(app.getPath('userData'), '.anthropic-key')
      if (existsSync(keyPath)) {
        writeFileSync(keyPath, '')
      }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  // ── App info ───────────────────────────────────────────────────────

  ipcMain.handle('app:version', () => {
    return app.getVersion()
  })

  ipcMain.handle('app:platform', () => {
    return process.platform
  })

  ipcMain.handle('app:agentsDir', () => {
    return join(app.getPath('home'), 'shogo-agents')
  })

  ipcMain.handle('app:apiUrl', () => {
    return runtimeManager.apiUrl
  })

  ipcMain.handle('app:isEncryptionAvailable', () => {
    return safeStorage.isEncryptionAvailable()
  })
}
