// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { BrowserWindow } from 'electron'
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { getApiUrl } from './local-server'
import { getWorkspacesDir } from './paths'
import { appendShogoIdeLog, ensureShogoIdeRuntimeProfile, ensureShogoIdeServer, shogoIdeSourceDir } from './shogo-ide'
import { killProcessTree, startCodeOssServer, type RunningServer } from './code-oss-server/launch'
import type { CodeWorkbenchReport } from './code-oss-server/status'

interface IdeServerRecord {
  workspacePath: string
  ready: Promise<RunningServer>
  running?: RunningServer
}

/** One server per workspace folder, shared by every window showing it. */
const servers = new Map<string, IdeServerRecord>()
const ideWindows = new Map<string, BrowserWindow>()

function serverKey(workspacePath: string): string {
  return path.resolve(workspacePath)
}

/** A stable 10-port range per workspace, so a reopened server tends to keep its URL. */
function serverPortRange(workspacePath: string): [number, number] {
  const offset = parseInt(createHash('sha256').update(path.resolve(workspacePath)).digest('hex').slice(0, 4), 16) % 1000
  const start = 18000 + offset * 10
  return [start, start + 9]
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

function isAlive(server: RunningServer | undefined): server is RunningServer {
  return !!server && server.proc.exitCode === null && server.proc.signalCode === null
}

async function getServer(workspacePath: string, chatUrl: string | undefined, report: CodeWorkbenchReport): Promise<RunningServer> {
  const key = serverKey(workspacePath)
  const existing = servers.get(key)
  if (existing) {
    try {
      const running = await existing.ready
      if (isAlive(running)) return running
    } catch {
      // the previous start failed; start again
    }
    if (servers.get(key) === existing) servers.delete(key)
  }

  const record = { workspacePath } as IdeServerRecord
  record.ready = (async () => {
    const serverDir = await ensureShogoIdeServer((progress) =>
      report(progress.phase, { received: progress.received, total: progress.total }),
    )
    report('starting')
    const profile = ensureShogoIdeRuntimeProfile(workspacePath, { desktopChatUrl: chatUrl })
    const running = await startCodeOssServer({
      serverDir,
      profile,
      portRange: serverPortRange(workspacePath),
      env: {
        ...process.env,
        SHOGO_IDE_WORKSPACE: shogoIdeSourceDir(),
        SHOGO_AGENT_BRIDGE_URL: getApiUrl(),
        ...(chatUrl ? { SHOGO_DESKTOP_CHAT_URL: chatUrl } : {}),
      },
      log: appendShogoIdeLog,
    })
    running.proc.once('exit', (code, signal) => {
      appendShogoIdeLog(`Shogo IDE server for ${workspacePath} exited (${code ?? signal})`)
      if (servers.get(key) === record) servers.delete(key)
    })
    record.running = running
    return running
  })()
  servers.set(key, record)
  record.ready.catch(() => {
    if (servers.get(key) === record) servers.delete(key)
  })
  return record.ready
}

/**
 * Open (or focus) the Shogo IDE window for a project. Progress goes through
 * `report`; failures throw with a message meant for the user.
 */
export async function openIdeWindow(
  projectId: string,
  createWindow: () => BrowserWindow,
  opts: { workspacePath?: string; chatUrl?: string; ownerWindowId?: number; report: CodeWorkbenchReport },
): Promise<{ windowId: number; url: string }> {
  const workspacePath = resolveWorkspacePath(projectId, opts.workspacePath)
  if (!workspacePath) throw new Error('This project has no folder on this machine to open in Shogo IDE.')
  const windowKey = ideWindowKey(opts.ownerWindowId, projectId, workspacePath)

  const server = await getServer(workspacePath, opts.chatUrl, opts.report)
  const url = server.workbenchUrl(workspacePath)

  const existing = ideWindows.get(windowKey)
  if (existing && !existing.isDestroyed()) {
    if (!existing.webContents.getURL().startsWith(`http://127.0.0.1:${server.port}/`)) await existing.loadURL(url)
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return { windowId: existing.id, url: existing.webContents.getURL() }
  }

  const window = createWindow()
  ideWindows.set(windowKey, window)
  window.setTitle('Shogo-IDE')
  window.once('closed', () => {
    if (ideWindows.get(windowKey)?.id === window.id) ideWindows.delete(windowKey)
    const stillShown = [...ideWindows.keys()].some((k) => k.endsWith(`:${path.resolve(workspacePath)}`))
    if (!stillShown) stopServer(workspacePath)
  })
  await window.loadURL(url)
  window.show()
  window.focus()
  appendShogoIdeLog(`Opened Shogo IDE for ${workspacePath}`)
  return { windowId: window.id, url }
}

function stopServer(workspacePath: string): void {
  const key = serverKey(workspacePath)
  const record = servers.get(key)
  servers.delete(key)
  if (isAlive(record?.running)) killProcessTree(record.running.proc)
}

export function disposeIdeServers(): void {
  for (const record of servers.values()) {
    if (isAlive(record.running)) killProcessTree(record.running.proc)
  }
  servers.clear()
}
