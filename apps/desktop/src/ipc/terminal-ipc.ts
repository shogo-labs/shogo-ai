// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ipcMain handlers for the Desktop terminal control plane.
 *
 * Registered once by main.ts on app startup. The renderer side hits
 * these via `window.shogoDesktopTerminal.*` (see preload-terminal.ts).
 *
 * The data plane does NOT live here — see terminal-port-broker.ts.
 */

import { ipcMain, BrowserWindow } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  disposePtyHostClient,
  getPtyHostClient,
} from '../pty-host-client'
import { getWorkspacesDir } from '../paths'
import { brokerAttach } from './terminal-port-broker'
import type {
  ControlEvent,
  SessionInfo,
  SpawnOptions as RendererSpawnOptions,
} from '@shogo/pty-core'
import type { SpawnOptions as HostSpawnOptions } from '../pty-host/protocol'

const CH = {
  spawn:  'shogo:terminal:spawn',
  write:  'shogo:terminal:write',
  resize: 'shogo:terminal:resize',
  signal: 'shogo:terminal:signal',
  kill:   'shogo:terminal:kill',
  list:   'shogo:terminal:list',
  attach: 'shogo:terminal:attach',
  detach: 'shogo:terminal:detach',
  listSnapshots: 'shogo:terminal:snapshots:list',
  restoreSession: 'shogo:terminal:snapshots:restore',
  discardSnapshot: 'shogo:terminal:snapshots:discard',
  restartHost: 'shogo:terminal:host:restart',
  event:  'shogo:terminal:event',
} as const

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec || 'pwsh.exe'
  return process.env.SHELL || '/bin/zsh'
}

function resolveWorkspaceCwd(opts: RendererSpawnOptions): string {
  if (opts.cwd && path.isAbsolute(opts.cwd) && fs.existsSync(opts.cwd)) return opts.cwd
  if (opts.projectId && /^[A-Za-z0-9._-]+$/.test(opts.projectId)) {
    const candidate = path.join(getWorkspacesDir(), opts.projectId)
    if (fs.existsSync(candidate)) return candidate
  }
  return os.homedir()
}

function normalizeSpawnOptions(opts: RendererSpawnOptions): HostSpawnOptions {
  const shell = opts.shell || defaultShell()
  const fallbackPath = process.platform === 'win32'
    ? process.env.PATH || ''
    : process.env.PATH || '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  return {
    shell,
    args: opts.args ?? (process.platform === 'win32' ? [] : ['-l']),
    cwd: resolveWorkspaceCwd(opts),
    env: {
      ...process.env as Record<string, string>,
      PATH: fallbackPath,
      TERM_PROGRAM: 'shogo',
      SHOGO_TERMINAL: '1',
      ...(opts.env ?? {}),
    },
    cols: opts.cols,
    rows: opts.rows,
    restoreId: opts.restoreId,
    workspaceHash: opts.workspaceHash ?? opts.projectId ?? 'default',
    profileId: opts.profileId,
  }
}

let registered = false

export function registerTerminalIpcHandlers(): void {
  if (registered) return
  registered = true

  const host = getPtyHostClient()

  // Fan host events out to every BrowserWindow so the renderer can
  // observe session:exit / session:reap / host:ready / host:log.
  host.on('event', (ev: ControlEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send(CH.event, ev) } catch { /* renderer gone */ }
    }
  })

  ipcMain.handle(CH.spawn, async (_e, opts: RendererSpawnOptions): Promise<SessionInfo> => {
    return host.spawn(normalizeSpawnOptions(opts))
  })
  ipcMain.handle(CH.write, async (_e, id: string, text: string): Promise<void> => {
    await host.write(id, text)
  })
  ipcMain.handle(CH.resize, async (_e, id: string, cols: number, rows: number): Promise<void> => {
    await host.resize(id, cols, rows)
  })
  ipcMain.handle(CH.signal, async (_e, id: string, sig: 'INT' | 'TERM' | 'KILL'): Promise<void> => {
    await host.signal(id, sig)
  })
  ipcMain.handle(CH.kill, async (_e, id: string): Promise<void> => {
    await host.kill(id)
  })
  ipcMain.handle(CH.list, async (): Promise<SessionInfo[]> => {
    return host.list()
  })
  ipcMain.handle(
    CH.attach,
    async (event, id: string, sinceSeq: number): Promise<{ channelId: string; latestSeq: number }> => {
      return brokerAttach(event.sender, id, sinceSeq)
    },
  )
  ipcMain.handle(CH.detach, async (_e, id: string, channelId: string): Promise<void> => {
    await host.detach(id, channelId)
  })
  ipcMain.handle(CH.listSnapshots, async (_e, workspaceHash: string) => {
    return host.listSnapshots(workspaceHash)
  })
  ipcMain.handle(CH.restoreSession, async (_e, workspaceHash: string, snapshotId: string) => {
    const session = await host.restoreSession(workspaceHash, snapshotId)
    return { newSessionId: session.id, session }
  })
  ipcMain.handle(CH.discardSnapshot, async (_e, workspaceHash: string, snapshotId: string) => {
    await host.discardSnapshot(workspaceHash, snapshotId)
  })
  ipcMain.handle(CH.restartHost, async () => {
    await host.restart()
  })
}

/**
 * Tear down — invoked from main.ts in the app-shutdown path.
 */
export async function disposeTerminalIpc(): Promise<void> {
  if (!registered) return
  registered = false
  ipcMain.removeHandler(CH.spawn)
  ipcMain.removeHandler(CH.write)
  ipcMain.removeHandler(CH.resize)
  ipcMain.removeHandler(CH.signal)
  ipcMain.removeHandler(CH.kill)
  ipcMain.removeHandler(CH.list)
  ipcMain.removeHandler(CH.attach)
  ipcMain.removeHandler(CH.detach)
  ipcMain.removeHandler(CH.listSnapshots)
  ipcMain.removeHandler(CH.restoreSession)
  ipcMain.removeHandler(CH.discardSnapshot)
  ipcMain.removeHandler(CH.restartHost)
  try { await getPtyHostClient().flushSnapshots() } catch {}
  await disposePtyHostClient()
}

export const TERMINAL_IPC_CHANNELS = CH
