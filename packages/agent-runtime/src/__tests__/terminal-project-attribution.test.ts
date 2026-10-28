// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The project a terminal is created for reaches the URL detector (SHO-200 S6).
 *
 * Two hops are covered, both through production code:
 *   - the runtime's `POST /terminal/sessions?project=…` route → `manager.create`
 *   - `PtySessionManager.create({ projectId })` → PTY bytes → `detected-urls`
 *
 * Run: bun test packages/agent-runtime/src/__tests__/terminal-project-attribution.test.ts
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runtimeTerminalRoutes } from '../runtime-terminal-routes'
import { PtySessionManager } from '../pty-session-manager'
import {
  getMostRecentDetectionForProject,
  _resetForTests as resetDetections,
} from '../detected-urls'
import { EOL, IS_WIN, waitUntil } from './helpers/pty-shell'

afterEach(() => resetDetections())

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'shogo-terminal-project-'))
}

function removeWorkspace(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Windows can hold the dir briefly; the OS temp cleaner will get it */
  }
}

describe('POST /terminal/sessions carries the project', () => {
  test('the ?project= query reaches manager.create', async () => {
    const workspaceDir = makeWorkspace()
    const created: Array<{ projectId?: string | null }> = []
    const manager = {
      create(opts: any) {
        created.push(opts)
        return {
          id: 't1',
          createdAt: Date.now(),
          session: { cwd: opts.cwd, cols: opts.cols, rows: opts.rows },
        }
      },
      list: () => [],
      get: () => null,
      kill: () => {},
    }
    const { router: app } = runtimeTerminalRoutes({ workspaceDir, manager: manager as never })
    try {
      const res = await app.request('/terminal/sessions?project=proj_a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols: 100, rows: 30 }),
      })
      expect(res.status).toBe(200)
      expect(created).toHaveLength(1)
      expect(created[0].projectId).toBe('proj_a')
    } finally {
      removeWorkspace(workspaceDir)
    }
  })

  test('a body-supplied projectId works for callers that cannot use a query', async () => {
    const workspaceDir = makeWorkspace()
    const created: Array<{ projectId?: string | null }> = []
    const manager = {
      create(opts: any) {
        created.push(opts)
        return {
          id: 't1',
          createdAt: Date.now(),
          session: { cwd: opts.cwd, cols: opts.cols, rows: opts.rows },
        }
      },
      list: () => [],
      get: () => null,
      kill: () => {},
    }
    const { router: app } = runtimeTerminalRoutes({ workspaceDir, manager: manager as never })
    try {
      await app.request('/terminal/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj_b' }),
      })
      expect(created[0].projectId).toBe('proj_b')
    } finally {
      removeWorkspace(workspaceDir)
    }
  })

  test('no project leaves the detection unattributed rather than guessed', async () => {
    const workspaceDir = makeWorkspace()
    const created: Array<{ projectId?: string | null }> = []
    const manager = {
      create(opts: any) {
        created.push(opts)
        return {
          id: 't1',
          createdAt: Date.now(),
          session: { cwd: opts.cwd, cols: opts.cols, rows: opts.rows },
        }
      },
      list: () => [],
      get: () => null,
      kill: () => {},
    }
    const { router: app } = runtimeTerminalRoutes({ workspaceDir, manager: manager as never })
    try {
      await app.request('/terminal/sessions', { method: 'POST', body: '{}' })
      expect(created[0].projectId).toBeNull()
    } finally {
      removeWorkspace(workspaceDir)
    }
  })
})

describe('PtySessionManager → detected-urls attribution', () => {
  test('a banner printed in a project’s terminal is attributed to that project', async () => {
    const workspaceDir = makeWorkspace()
    const manager = new PtySessionManager({ workspaceDir, sweepIntervalMs: 0 })
    try {
      manager.create({
        projectId: 'proj_a',
        cwd: workspaceDir,
        cmd: IS_WIN
          ? ['powershell.exe', '-NoLogo', '-NoProfile', '-Command', 'Write-Output "Local: http://localhost:5199/"; Start-Sleep -Seconds 5']
          : ['/bin/sh', '-c', 'printf "Local: http://localhost:5199/\\n"; sleep 5'],
      })
      await waitUntil(
        () => getMostRecentDetectionForProject('proj_a') !== null,
        IS_WIN ? 10_000 : 5_000,
      )
      expect(getMostRecentDetectionForProject('proj_a')?.url).toBe('http://localhost:5199')
      // …and it never shows up as some other project's URL.
      expect(getMostRecentDetectionForProject('proj_b')).toBeNull()
      expect(getMostRecentDetectionForProject(null)).toBeNull()
    } finally {
      manager.shutdown()
      removeWorkspace(workspaceDir)
    }
  })

  test('two projects’ terminals stay separate', async () => {
    const workspaceDir = makeWorkspace()
    const manager = new PtySessionManager({ workspaceDir, sweepIntervalMs: 0 })
    try {
      const print = (url: string) =>
        IS_WIN
          ? ['powershell.exe', '-NoLogo', '-NoProfile', '-Command', `Write-Output "Local: ${url}/"; Start-Sleep -Seconds 5`]
          : ['/bin/sh', '-c', `printf "Local: ${url}/\\n"; sleep 5`]
      manager.create({ projectId: 'proj_a', cmd: print('http://localhost:5201') })
      manager.create({ projectId: 'proj_b', cmd: print('http://localhost:5202') })
      await waitUntil(
        () =>
          getMostRecentDetectionForProject('proj_a') !== null &&
          getMostRecentDetectionForProject('proj_b') !== null,
        IS_WIN ? 10_000 : 5_000,
      )
      expect(getMostRecentDetectionForProject('proj_a')?.url).toBe('http://localhost:5201')
      expect(getMostRecentDetectionForProject('proj_b')?.url).toBe('http://localhost:5202')
      void EOL
    } finally {
      manager.shutdown()
      removeWorkspace(workspaceDir)
    }
  })
})
