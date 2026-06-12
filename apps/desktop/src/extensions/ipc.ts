// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ExtensionInstallService, type ExtensionEnableScope } from './install-service'
import { ExtensionRegistryService } from './registry-service'

let installService: ExtensionInstallService | null = null
let registryService: ExtensionRegistryService | null = null

function services(): { install: ExtensionInstallService; registry: ExtensionRegistryService } {
  if (!installService) installService = new ExtensionInstallService()
  if (!registryService) registryService = new ExtensionRegistryService(installService)
  return { install: installService, registry: registryService }
}

export function registerExtensionsIpcHandlers(): void {
  ipcMain.handle('extensions:listInstalled', (_event, args?: { workspaceRoot?: string }) => {
    try {
      return { ok: true, extensions: services().install.listInstalled(args?.workspaceRoot) }
    } catch (err) {
      return failure(err)
    }
  })

  ipcMain.handle('extensions:getContributions', (_event, args?: { workspaceRoot?: string }) => {
    try {
      return { ok: true, ...services().install.getContributions(args?.workspaceRoot) }
    } catch (err) {
      return failure(err)
    }
  })

  ipcMain.handle('extensions:search', async (_event, query: string, options?: { size?: number }) => {
    try {
      return { ok: true, results: await services().registry.search(query, options) }
    } catch (err) {
      return failure(err)
    }
  })

  ipcMain.handle('extensions:installFromVsix', async (event, args?: { path?: string }) => {
    try {
      const selectedPath = args?.path ?? await pickVsixPath(BrowserWindow.fromWebContents(event.sender) ?? undefined)
      if (!selectedPath) return { ok: false, cancelled: true, error: 'Install cancelled' }
      const record = services().install.installFromVsix(selectedPath)
      return { ok: true, extension: record, restartRequired: true }
    } catch (err) {
      return failure(err)
    }
  })

  ipcMain.handle('extensions:installFromRegistry', async (_event, id: string, version?: string) => {
    try {
      const [publisher, name] = id.split('.')
      if (!publisher || !name) throw new Error('Extension id must be publisher.name')
      const metadataUrl = version
        ? `https://open-vsx.org/api/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
        : `https://open-vsx.org/api/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}`
      const metaRes = await fetch(metadataUrl)
      if (!metaRes.ok) throw new Error(`Open VSX metadata request failed (${metaRes.status})`)
      const metadata = await metaRes.json() as { files?: { download?: string }; version?: string }
      const downloadUrl = metadata.files?.download
      if (!downloadUrl) throw new Error('Open VSX metadata did not include a VSIX download URL')
      const downloadRes = await fetch(downloadUrl)
      if (!downloadRes.ok) throw new Error(`Open VSX download failed (${downloadRes.status})`)
      const bytes = Buffer.from(await downloadRes.arrayBuffer())
      const downloadsDir = path.join(os.tmpdir(), 'shogo-extension-downloads')
      fs.mkdirSync(downloadsDir, { recursive: true })
      const file = path.join(downloadsDir, `${publisher}.${name}-${metadata.version ?? version ?? Date.now()}.vsix`)
      fs.writeFileSync(file, bytes)
      const record = services().install.installFromVsix(file)
      return { ok: true, extension: record, restartRequired: true }
    } catch (err) {
      return failure(err)
    }
  })

  ipcMain.handle('extensions:uninstall', (_event, id: string) => {
    try { return services().install.uninstall(id) } catch (err) { return failure(err) }
  })

  ipcMain.handle('extensions:enable', (_event, id: string, scope?: ExtensionEnableScope, workspaceRoot?: string) => {
    try { return services().install.setEnabled(id, true, scope, workspaceRoot) } catch (err) { return failure(err) }
  })

  ipcMain.handle('extensions:disable', (_event, id: string, scope?: ExtensionEnableScope, workspaceRoot?: string) => {
    try { return services().install.setEnabled(id, false, scope, workspaceRoot) } catch (err) { return failure(err) }
  })

  ipcMain.handle('extensions:restartHost', () => {
    try {
      services().install.clearRestartRequired()
      return { ok: true, restarted: false, message: 'No extension host is running yet. Restart-required state was cleared.' }
    } catch (err) {
      return failure(err)
    }
  })

  ipcMain.handle('extensions:checkUpdates', () => {
    try { return services().install.checkUpdates() } catch (err) { return failure(err) }
  })

  ipcMain.handle('extensions:update', () => ({ ok: false, error: 'Extension updates are not implemented yet' }))
  ipcMain.handle('extensions:runCommand', () => ({ ok: false, error: 'Extension command host is not implemented yet' }))
  ipcMain.handle('extensions:showRunningExtensions', () => ({ ok: true, running: [], message: 'No extension host is running yet' }))
  ipcMain.handle('extensions:startBisect', () => ({ ok: false, error: 'Extension bisect requires the extension host milestone' }))
}

export function disposeExtensionsIpcHandlers(): void {
  for (const channel of [
    'extensions:listInstalled', 'extensions:getContributions', 'extensions:search', 'extensions:installFromVsix',
    'extensions:installFromRegistry', 'extensions:uninstall', 'extensions:enable', 'extensions:disable',
    'extensions:restartHost', 'extensions:checkUpdates', 'extensions:update', 'extensions:runCommand',
    'extensions:showRunningExtensions', 'extensions:startBisect',
  ]) ipcMain.removeHandler(channel)
}

async function pickVsixPath(window?: BrowserWindow): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: 'Install Extension from VSIX',
    properties: ['openFile'],
    filters: [{ name: 'VSIX Extensions', extensions: ['vsix'] }],
  }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

function failure(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}
