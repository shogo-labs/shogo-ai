// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { BrowserWindow, dialog, ipcMain, type MessageBoxOptions, type OpenDialogOptions } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ExtensionInstallService, type ExtensionEnableScope } from './install-service'
import { ExtensionRegistryService } from './registry-service'
import { ExtensionHostManager, type ExtensionWorkspaceState } from './host-manager'

let installService: ExtensionInstallService | null = null
let registryService: ExtensionRegistryService | null = null
let hostManager: ExtensionHostManager | null = null

function services(): { install: ExtensionInstallService; registry: ExtensionRegistryService; host: ExtensionHostManager } {
  if (!installService) installService = new ExtensionInstallService()
  if (!registryService) registryService = new ExtensionRegistryService(installService)
  if (!hostManager) {
    hostManager = new ExtensionHostManager(installService)
    hostManager.onEvent((event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('extensions:event', event)
      }
    })
  }
  return { install: installService, registry: registryService, host: hostManager }
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

  ipcMain.handle('extensions:listTrustedPublishers', () => {
    try {
      return { ok: true, publishers: services().install.listTrustedPublishers() }
    } catch (err) {
      return failure(err)
    }
  })

  ipcMain.handle('extensions:trustPublisher', (_event, publisher: string) => {
    try {
      return { ok: true, publisher: services().install.trustPublisher(publisher) }
    } catch (err) {
      return failure(err)
    }
  })

  ipcMain.handle('extensions:getWorkspaceTrust', (_event, workspaceRoot?: string) => {
    try {
      return { ok: true, trust: services().install.getWorkspaceTrust(workspaceRoot) }
    } catch (err) {
      return failure(err)
    }
  })

  ipcMain.handle('extensions:trustWorkspace', async (_event, workspaceRoot: string) => {
    try {
      const workspace = services().install.trustWorkspace(workspaceRoot)
      await services().host.restart(workspaceRoot)
      return { ok: true, workspace, restartRequired: false }
    } catch (err) {
      return failure(err)
    }
  })

  ipcMain.handle('extensions:installFromVsix', async (event, args?: { path?: string; workspaceRoot?: string }) => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const selectedPath = args?.path ?? await pickVsixPath(window)
      if (!selectedPath) return { ok: false, cancelled: true, error: 'Install cancelled' }
      const inspection = services().install.inspectVsix(selectedPath)
      const trusted = await ensurePublisherTrusted(window, inspection.manifest.publisher, inspection.manifest.displayName ?? inspection.manifest.name)
      if (!trusted) return { ok: false, cancelled: true, error: `Publisher not trusted: ${inspection.manifest.publisher}` }
      const record = services().install.installFromVsix(selectedPath)
      const extension = services().install.listInstalled(args?.workspaceRoot).find((item) => item.id === record.id) ?? record
      return { ok: true, extension, restartRequired: true }
    } catch (err) {
      return failure(err)
    }
  })

  ipcMain.handle('extensions:installFromRegistry', async (event, id: string, version?: string, options?: { workspaceRoot?: string }) => {
    try {
      const [publisher, name] = id.split('.')
      if (!publisher || !name) throw new Error('Extension id must be publisher.name')
      const trusted = await ensurePublisherTrusted(BrowserWindow.fromWebContents(event.sender) ?? undefined, publisher, id)
      if (!trusted) return { ok: false, cancelled: true, error: `Publisher not trusted: ${publisher}` }
      const metadataUrl = version
        ? `https://open-vsx.org/api/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
        : `https://open-vsx.org/api/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}`
      const metaRes = await fetch(metadataUrl)
      if (!metaRes.ok) throw new Error(`Open VSX metadata request failed (${metaRes.status})`)
      const metadata = await metaRes.json() as { files?: { download?: string; icon?: string }; version?: string; iconUrl?: string }
      const downloadUrl = metadata.files?.download
      if (!downloadUrl) throw new Error('Open VSX metadata did not include a VSIX download URL')
      const downloadRes = await fetch(downloadUrl)
      if (!downloadRes.ok) throw new Error(`Open VSX download failed (${downloadRes.status})`)
      const bytes = Buffer.from(await downloadRes.arrayBuffer())
      const downloadsDir = path.join(os.tmpdir(), 'shogo-extension-downloads')
      fs.mkdirSync(downloadsDir, { recursive: true })
      const file = path.join(downloadsDir, `${publisher}.${name}-${metadata.version ?? version ?? Date.now()}.vsix`)
      fs.writeFileSync(file, bytes)
      const record = services().install.installFromVsix(file, 'open-vsx', {
        iconUrl: typeof metadata.iconUrl === 'string' ? metadata.iconUrl : metadata.files?.icon,
      })
      const extension = services().install.listInstalled(options?.workspaceRoot).find((item) => item.id === record.id) ?? record
      return { ok: true, extension, restartRequired: true }
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

  ipcMain.handle('extensions:restartHost', async (_event, args?: { workspaceRoot?: string }) => {
    try {
      const result = await services().host.restart(args?.workspaceRoot)
      return { ok: true, ...result, message: 'Extension host restarted.' }
    } catch (err) {
      return failure(err)
    }
  })

  ipcMain.handle('extensions:checkUpdates', () => {
    try { return services().install.checkUpdates() } catch (err) { return failure(err) }
  })

  ipcMain.handle('extensions:update', () => ({ ok: false, error: 'Extension updates are not implemented yet' }))
  ipcMain.handle('extensions:runCommand', async (_event, commandId: string, args?: unknown[], options?: { workspaceRoot?: string }) => {
    try {
      return { ok: true, result: await services().host.executeCommand(commandId, args ?? [], options?.workspaceRoot) }
    } catch (err) {
      return failure(err)
    }
  })
  ipcMain.handle('extensions:activateEvent', async (_event, event: string, options?: { workspaceRoot?: string }) => {
    try {
      return { ok: true, result: await services().host.activateEvent(event, options?.workspaceRoot) }
    } catch (err) {
      return failure(err)
    }
  })
  ipcMain.handle('extensions:getView', async (_event, viewId: string, options?: { workspaceRoot?: string; itemHandle?: string }) => {
    try {
      return { ok: true, view: await services().host.getView(viewId, options?.workspaceRoot, options?.itemHandle) }
    } catch (err) {
      return failure(err)
    }
  })
  ipcMain.handle('extensions:getStatusBarItems', async (_event, options?: { workspaceRoot?: string }) => {
    try {
      return { ok: true, items: await services().host.getStatusBarItems(options?.workspaceRoot) }
    } catch (err) {
      return failure(err)
    }
  })
  ipcMain.handle('extensions:getWebviewPanels', async (_event, options?: { workspaceRoot?: string }) => {
    try {
      return { ok: true, panels: await services().host.getWebviewPanels(options?.workspaceRoot) }
    } catch (err) {
      return failure(err)
    }
  })
  ipcMain.handle('extensions:getOutputChannels', async (_event, options?: { workspaceRoot?: string }) => {
    try {
      return { ok: true, channels: await services().host.getOutputChannels(options?.workspaceRoot) }
    } catch (err) {
      return failure(err)
    }
  })
  ipcMain.handle('extensions:respondUiRequest', (_event, requestId: string, response: { ok: boolean; result?: unknown; error?: string }) => {
    try {
      services().host.respondToUiRequest(requestId, response.ok, response.result, response.error)
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })
  ipcMain.handle('extensions:updateWorkspaceState', async (_event, state: ExtensionWorkspaceState) => {
    try {
      await services().host.updateWorkspaceState(state)
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })
  ipcMain.handle('extensions:showRunningExtensions', () => {
    try {
      const running = services().host.getRunningExtensions()
      return { ok: true, running, message: running.length === 0 ? 'No extension commands have activated yet.' : undefined }
    } catch (err) {
      return failure(err)
    }
  })
  ipcMain.handle('extensions:startBisect', () => ({ ok: false, error: 'Extension bisect requires the extension host milestone' }))
}

export function disposeExtensionsIpcHandlers(): void {
  if (hostManager) void hostManager.stop()
  for (const channel of [
    'extensions:listInstalled', 'extensions:getContributions', 'extensions:search', 'extensions:listTrustedPublishers', 'extensions:trustPublisher', 'extensions:getWorkspaceTrust', 'extensions:trustWorkspace', 'extensions:installFromVsix',
    'extensions:installFromRegistry', 'extensions:uninstall', 'extensions:enable', 'extensions:disable',
    'extensions:restartHost', 'extensions:checkUpdates', 'extensions:update', 'extensions:runCommand',
    'extensions:activateEvent', 'extensions:getView', 'extensions:getStatusBarItems', 'extensions:getWebviewPanels', 'extensions:getOutputChannels', 'extensions:respondUiRequest', 'extensions:updateWorkspaceState', 'extensions:showRunningExtensions', 'extensions:startBisect',
  ]) ipcMain.removeHandler(channel)
}

async function ensurePublisherTrusted(window: BrowserWindow | undefined, publisher: string, extensionName: string): Promise<boolean> {
  const install = services().install
  if (install.isPublisherTrusted(publisher)) return true
  const result = window
    ? await dialog.showMessageBox(window, publisherTrustDialogOptions(publisher, extensionName))
    : await dialog.showMessageBox(publisherTrustDialogOptions(publisher, extensionName))
  if (result.response !== 1) return false
  install.trustPublisher(publisher)
  return true
}

function publisherTrustDialogOptions(publisher: string, extensionName: string): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Trust Extension Publisher?',
    message: `Do you trust the publisher “${publisher}”?`,
    detail: `The extension “${extensionName}” is published by “${publisher}”. Extensions can run code in your workspace. Only install it if you trust this publisher.`,
    buttons: ['Cancel', 'Trust Publisher & Install'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
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
