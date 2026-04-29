// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runtimeTerminalRoutes } from '../runtime-terminal-routes'

function withWorkspace<T>(fn: (workspaceDir: string) => Promise<T>): Promise<T> {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'shogo-runtime-terminal-test-'))
  return fn(workspaceDir).finally(() => {
    rmSync(workspaceDir, { recursive: true, force: true })
  })
}

describe('runtimeTerminalRoutes', () => {
  test('serves preset commands as JSON at the runtime-local path', async () => {
    await withWorkspace(async (workspaceDir) => {
      const app = runtimeTerminalRoutes({ workspaceDir })

      const res = await app.request('/terminal/commands')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')

      const body = await res.json() as { commands: Record<string, Array<{ id: string }>> }
      expect(body.commands.package.some(cmd => cmd.id === 'bun-install')).toBe(true)
    })
  })

  test('serves free-form command endpoint as a terminal stream', async () => {
    await withWorkspace(async (workspaceDir) => {
      const app = runtimeTerminalRoutes({ workspaceDir })

      const res = await app.request('http://runtime.test/terminal/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'printf ok' }),
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/plain')

      const text = await res.text()
      expect(text).toContain('SHOGO_TERM_META:')
    })
  })
})
