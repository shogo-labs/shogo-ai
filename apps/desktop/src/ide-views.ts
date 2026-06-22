// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { getApiUrl } from './local-server'
import { getWorkspacesDir } from './paths'
import { ensureShogoIdeRuntimeProfile, ensureShogoIdeSetup, getShogoIdeStatus, SHOGO_IDE_DISABLED_UPSTREAM_EXTENSIONS, syncShogoIdeProduct } from './shogo-ide'

interface IdeServerRecord {
  key: string
  workspacePath: string
  url: string | null
  proc: ChildProcess
  ready: Promise<string>
}

const servers = new Map<string, IdeServerRecord>()
const ideWindows = new Map<string, BrowserWindow>()

function serverKey(workspacePath: string): string {
  return path.resolve(workspacePath)
}

function stableHash(value: string): string {
  return createHash('sha256').update(path.resolve(value)).digest('hex')
}

function serverPortRange(workspacePath: string): string {
  const offset = parseInt(stableHash(workspacePath).slice(0, 4), 16) % 1000
  const start = 18000 + offset * 10
  return `${start}-${start + 9}`
}

function ideWindowKey(ownerWindowId: number | undefined, projectId: string, workspacePath: string): string {
  const ownerSegment = ownerWindowId === undefined ? 'global' : String(ownerWindowId)
  return `${ownerSegment}:${projectId}:${path.resolve(workspacePath)}`
}

function resolveWorkspacePath(projectId: string, workspacePath?: string): string | null {
  if (workspacePath && path.isAbsolute(workspacePath)) return workspacePath
  if (!projectId || projectId.includes('/') || projectId.includes('\\') || projectId.includes('..')) return null
  const candidate = path.join(getWorkspacesDir(), projectId)
  return fs.existsSync(candidate) ? candidate : null
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

function codeOssWebArgs(status: ReturnType<typeof getShogoIdeStatus>, workspacePath: string, desktopChatUrl?: string): string[] {
  const runtime = ensureShogoIdeRuntimeProfile(status.workspacePath, { desktopChatUrl, profileKey: workspacePath })
  const shogoCoreExtensionPath = path.join(status.workspacePath, 'extensions', 'shogo-core')
  return [
    '--skip-welcome',
    '--disable-telemetry',
    '--disable-crash-reporter',
    '--disable-workspace-trust',
    '--user-data-dir', runtime.userDataDir,
    '--extensions-dir', runtime.extensionsDir,
    '--builtin-extensions-dir', runtime.systemExtensionsDir,
    '--extensionDevelopmentPath', shogoCoreExtensionPath,
    '--host', '127.0.0.1',
    '--port', serverPortRange(workspacePath),
    '--agents-user-data-dir', runtime.agentsUserDataDir,
    '--agents-extensions-dir', runtime.agentsExtensionsDir,
    '--crash-reporter-directory', runtime.crashReporterDirectory,
    ...SHOGO_IDE_DISABLED_UPSTREAM_EXTENSIONS.map((extensionId) => `--disable-extension=${extensionId}`),
    workspacePath,
  ]
}

function codeOssLaunchCommand(scriptPath: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === 'win32') return { command: scriptPath, args }
  return { command: 'npx', args: ['-y', '-p', 'node@24.15.0', 'bash', scriptPath, ...args] }
}

function trimLaunchOutput(output: string[]): string {
  return output.join('').split(/\r?\n/).filter(Boolean).slice(-12).join('\n')
}

async function startIdeServer(workspacePath: string, desktopChatUrl?: string): Promise<IdeServerRecord> {
  const key = serverKey(workspacePath)
  const existing = servers.get(key)
  if (existing) return existing

  let status = getShogoIdeStatus()
  await ensureShogoIdeSetup(status)
  status = getShogoIdeStatus()
  if (!status.codeOssCheckoutExists) {
    throw new Error('Code OSS checkout is not present after setup.')
  }
  syncShogoIdeProduct(status)

  const scriptPath = path.join(status.codeOssCheckoutPath, 'scripts', process.platform === 'win32' ? 'code-server.bat' : 'code-server.sh')
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Code OSS web runner not found at ${scriptPath}`)
  }

  const args = codeOssWebArgs(status, workspacePath, desktopChatUrl)
  const launch = codeOssLaunchCommand(scriptPath, args)
  const output: string[] = []
  let resolvedUrl: string | null = null

  const proc = spawn(launch.command, launch.args, {
    cwd: status.codeOssCheckoutPath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SHOGO_IDE_PHASE: 'same-app-window',
      SHOGO_IDE_WORKSPACE: status.workspacePath,
      SHOGO_AGENT_BRIDGE_URL: getApiUrl(),
      ...(desktopChatUrl ? { SHOGO_DESKTOP_CHAT_URL: desktopChatUrl } : {}),
      VSCODE_DEV: '1',
    },
  })

  const ready = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for Code OSS web server URL'))
    }, 30_000)

    const onData = (chunk: Buffer) => {
      const text = chunk.toString()
      output.push(text)
      if (output.length > 40) output.splice(0, output.length - 40)
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
        const details = trimLaunchOutput(output)
        reject(new Error(`Code OSS web server exited before startup (${code ?? 'unknown'})${details ? `
${details}` : ''}`))
      }
    })
  })

  const rec: IdeServerRecord = { key, workspacePath, url: null, proc, ready }
  ready.then((url) => { rec.url = url }).catch(() => undefined)
  servers.set(key, rec)
  return rec
}

export async function openIdeWindow(
  projectId: string,
  createWindow: () => BrowserWindow,
  opts: { workspacePath?: string; chatUrl?: string; ownerWindowId?: number } = {},
): Promise<{ ok: true; windowId: number; url: string } | { ok: false; error: string }> {
  if (!projectId) return { ok: false, error: 'project-id-required' }

  try {
    const workspacePath = resolveWorkspacePath(projectId, opts.workspacePath)
    if (!workspacePath) return { ok: false, error: 'workspace-path-required' }
    const windowKey = ideWindowKey(opts.ownerWindowId, projectId, workspacePath)

    const existing = ideWindows.get(windowKey)
    if (existing && !existing.isDestroyed()) {
      const server = await startIdeServer(workspacePath, opts.chatUrl)
      const url = codeOssWorkspaceUrl(await server.ready, workspacePath)
      if (!existing.webContents.getURL().includes('folder=')) {
        await existing.loadURL(url)
      }
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return { ok: true, windowId: existing.id, url: existing.webContents.getURL() }
    }

    const server = await startIdeServer(workspacePath, opts.chatUrl)
    const url = codeOssWorkspaceUrl(await server.ready, workspacePath)
    const window = createWindow()
    ideWindows.set(windowKey, window)
    window.setTitle('Shogo-IDE')
    window.once('closed', () => {
      if (ideWindows.get(windowKey)?.id === window.id) ideWindows.delete(windowKey)
    })
    await window.loadURL(url)
    window.show()
    window.focus()
    return { ok: true, windowId: window.id, url }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function disposeIdeServers(): void {
  for (const rec of servers.values()) {
    rec.proc.kill('SIGTERM')
  }
  servers.clear()
}
