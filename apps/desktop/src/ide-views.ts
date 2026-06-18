// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { BrowserWindow, WebContentsView, shell, session } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { getApiUrl } from './local-server'
import { getWorkspacesDir } from './paths'
import { ensureShogoIdeRuntimeProfile, ensureShogoIdeSetup, getShogoIdeStatus, SHOGO_IDE_DISABLED_UPSTREAM_EXTENSIONS } from './shogo-ide'

export interface IdeViewBounds {
  x: number
  y: number
  width: number
  height: number
}

interface IdeServerRecord {
  key: string
  workspacePath: string
  url: string | null
  proc: ChildProcess
  ready: Promise<string>
}

interface IdeViewRecord {
  key: string
  windowId: number
  projectId: string
  view: WebContentsView
  ownerWindow: BrowserWindow
  lastBounds: IdeViewBounds | null
  attached: boolean
  visible: boolean
}

const servers = new Map<string, IdeServerRecord>()
const views = new Map<string, IdeViewRecord>()
const ideWindows = new Map<string, BrowserWindow>()

function viewKey(windowId: number, projectId: string): string {
  return `${windowId}:${projectId}`
}

function serverKey(workspacePath: string): string {
  return path.resolve(workspacePath)
}

function clampBounds(b: IdeViewBounds): IdeViewBounds {
  return {
    x: Math.max(0, Math.round(b.x)),
    y: Math.max(0, Math.round(b.y)),
    width: Math.max(0, Math.round(b.width)),
    height: Math.max(0, Math.round(b.height)),
  }
}

function resolveWorkspacePath(projectId: string, workspacePath?: string): string | null {
  if (workspacePath && path.isAbsolute(workspacePath)) return workspacePath
  if (!projectId || projectId.includes('/') || projectId.includes('\\') || projectId.includes('..')) return null
  const candidate = path.join(getWorkspacesDir(), projectId)
  return fs.existsSync(candidate) ? candidate : null
}

function createView(projectId: string, ownerWindow: BrowserWindow): IdeViewRecord {
  const windowId = ownerWindow.id
  const key = viewKey(windowId, projectId)
  const ideSession = session.fromPartition(`persist:shogo-code-oss-${projectId}`)
  const view = new WebContentsView({
    webPreferences: {
      session: ideSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  view.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url).catch(() => {})
    }
    return { action: 'deny' }
  })

  const rec: IdeViewRecord = {
    key,
    windowId,
    projectId,
    view,
    ownerWindow,
    lastBounds: null,
    attached: false,
    visible: true,
  }
  views.set(key, rec)
  return rec
}

function ensureAttached(rec: IdeViewRecord): void {
  if (rec.attached || rec.ownerWindow.isDestroyed()) return
  rec.ownerWindow.contentView.addChildView(rec.view)
  rec.attached = true
  applyBounds(rec)
}

function applyBounds(rec: IdeViewRecord): void {
  if (!rec.attached || !rec.visible || !rec.lastBounds) {
    rec.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    return
  }
  rec.view.setBounds(clampBounds(rec.lastBounds))
}

function detach(rec: IdeViewRecord): void {
  if (!rec.attached) return
  try {
    rec.ownerWindow.contentView.removeChildView(rec.view)
  } catch {
    // Best-effort cleanup.
  }
  rec.attached = false
}

function codeOssWorkspaceUrl(baseUrl: string, workspacePath: string): string {
  try {
    const url = new URL(baseUrl)
    url.searchParams.set('folder', workspacePath)
    return url.toString()
  } catch {
    const separator = baseUrl.includes('?') ? '&' : '?'
    return `${baseUrl}${separator}folder=${encodeURIComponent(workspacePath)}`
  }
}

function codeOssWebArgs(status: ReturnType<typeof getShogoIdeStatus>, workspacePath: string): string[] {
  const runtime = ensureShogoIdeRuntimeProfile(status.workspacePath)
  const shogoCoreExtensionPath = path.join(status.workspacePath, 'extensions', 'shogo-core')
  const shogoAgentChatExtensionPath = path.join(status.workspacePath, 'extensions', 'shogo-agent-chat')
  return [
    '--skip-welcome',
    '--disable-telemetry',
    '--disable-crash-reporter',
    '--disable-workspace-trust',
    '--user-data-dir', runtime.userDataDir,
    '--extensions-dir', runtime.extensionsDir,
    '--agents-user-data-dir', runtime.agentsUserDataDir,
    '--agents-extensions-dir', runtime.agentsExtensionsDir,
    '--crash-reporter-directory', runtime.crashReporterDirectory,
    '--extensionDevelopmentPath', shogoCoreExtensionPath,
    '--extensionDevelopmentPath', shogoAgentChatExtensionPath,
    ...SHOGO_IDE_DISABLED_UPSTREAM_EXTENSIONS.map((extensionId) => `--disable-extension=${extensionId}`),
    workspacePath,
  ]
}

async function startIdeServer(workspacePath: string): Promise<IdeServerRecord> {
  const key = serverKey(workspacePath)
  const existing = servers.get(key)
  if (existing) return existing

  let status = getShogoIdeStatus()
  await ensureShogoIdeSetup(status)
  status = getShogoIdeStatus()
  if (!status.codeOssCheckoutExists) {
    throw new Error('Code OSS checkout is not present after setup.')
  }

  const scriptPath = path.join(status.codeOssCheckoutPath, 'scripts', process.platform === 'win32' ? 'code-server.bat' : 'code-server.sh')
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Code OSS web runner not found at ${scriptPath}`)
  }

  const args = codeOssWebArgs(status, workspacePath)
  let resolvedUrl: string | null = null

  const proc = spawn(scriptPath, args, {
    cwd: status.codeOssCheckoutPath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SHOGO_IDE_PHASE: 'same-app-window',
      SHOGO_IDE_WORKSPACE: status.workspacePath,
      SHOGO_AGENT_BRIDGE_URL: getApiUrl(),
      VSCODE_DEV: '1',
      VSCODE_SKIP_PRELAUNCH: '1',
    },
  })

  const ready = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for Code OSS web server URL'))
    }, 30_000)

    const onData = (chunk: Buffer) => {
      const text = chunk.toString()
      const match = text.match(/https?:\/\/[^\s]+/)
      if (match && !resolvedUrl) {
        resolvedUrl = match[0]
        clearTimeout(timeout)
        resolve(resolvedUrl)
      }
    }

    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    proc.once('exit', (code) => {
      servers.delete(key)
      if (!resolvedUrl) {
        clearTimeout(timeout)
        reject(new Error(`Code OSS web server exited before startup (${code ?? 'unknown'})`))
      }
    })
  })

  const rec: IdeServerRecord = { key, workspacePath, url: null, proc, ready }
  ready.then((url) => { rec.url = url }).catch(() => undefined)
  servers.set(key, rec)
  return rec
}

export async function openIdeView(
  projectId: string,
  ownerWindow: BrowserWindow,
  opts: { workspacePath?: string } = {},
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!projectId) return { ok: false, error: 'project-id-required' }
  if (ownerWindow.isDestroyed()) return { ok: false, error: 'window-destroyed' }

  try {
    const workspacePath = resolveWorkspacePath(projectId, opts.workspacePath)
    if (!workspacePath) return { ok: false, error: 'workspace-path-required' }
    const server = await startIdeServer(workspacePath)
    const url = codeOssWorkspaceUrl(await server.ready, workspacePath)

    let rec = views.get(viewKey(ownerWindow.id, projectId))
    if (!rec) rec = createView(projectId, ownerWindow)
    ensureAttached(rec)

    if (rec.view.webContents.getURL() !== url) {
      await rec.view.webContents.loadURL(url)
    }
    return { ok: true, url }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function openIdeWindow(
  projectId: string,
  createWindow: () => BrowserWindow,
  opts: { workspacePath?: string } = {},
): Promise<{ ok: true; windowId: number; url: string } | { ok: false; error: string }> {
  if (!projectId) return { ok: false, error: 'project-id-required' }

  try {
    const workspacePath = resolveWorkspacePath(projectId, opts.workspacePath)
    if (!workspacePath) return { ok: false, error: 'workspace-path-required' }

    const existing = ideWindows.get(projectId)
    if (existing && !existing.isDestroyed()) {
      const server = await startIdeServer(workspacePath)
      const url = codeOssWorkspaceUrl(await server.ready, workspacePath)
      if (!existing.webContents.getURL().includes('folder=')) {
        await existing.loadURL(url)
      }
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return { ok: true, windowId: existing.id, url: existing.webContents.getURL() }
    }

    const server = await startIdeServer(workspacePath)
    const url = codeOssWorkspaceUrl(await server.ready, workspacePath)
    const window = createWindow()
    ideWindows.set(projectId, window)
    window.setTitle('Shogo-IDE')
    window.once('closed', () => {
      if (ideWindows.get(projectId)?.id === window.id) ideWindows.delete(projectId)
    })
    await window.loadURL(url)
    window.show()
    window.focus()
    return { ok: true, windowId: window.id, url }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function setIdeViewBounds(windowId: number, projectId: string, bounds: IdeViewBounds): void {
  const rec = views.get(viewKey(windowId, projectId))
  if (!rec) return
  rec.lastBounds = bounds
  applyBounds(rec)
}

export function setIdeViewVisible(windowId: number, projectId: string, visible: boolean): void {
  const rec = views.get(viewKey(windowId, projectId))
  if (!rec) return
  rec.visible = visible
  if (visible) ensureAttached(rec)
  applyBounds(rec)
}

export function closeIdeView(windowId: number, projectId: string): void {
  const key = viewKey(windowId, projectId)
  const rec = views.get(key)
  if (!rec) return
  detach(rec)
  rec.view.webContents.close()
  views.delete(key)
}

export function closeAllIdeViewsForWindow(windowId: number): void {
  for (const rec of [...views.values()]) {
    if (rec.windowId === windowId) closeIdeView(windowId, rec.projectId)
  }
}

export function disposeIdeServers(): void {
  for (const rec of servers.values()) {
    rec.proc.kill('SIGTERM')
  }
  servers.clear()
}
