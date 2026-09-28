// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression coverage for root `/api/*` 503ing on a workspace-anchored
 * project (staging, a0f110d4-..., 2026-09-23). `/preview/status`, restart
 * and the root static serve used the anchor's PreviewManager (#951) and
 * reported `apiReady: true`, but root `/api/*` still proxied through the
 * workspace-root manager, which never starts in workspace mode and sat in
 * `generating` with no port, so every call returned
 * `{"error":"API server not ready","phase":"generating"}` while
 * `/p/<anchor>/api/*` reached the healthy sidecar.
 *
 * Drives the real `server.ts` module with workspace-mode env set before
 * import (own file: the module reads that env once at load).
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const integration = process.env.RUN_INTEGRATION === '1'

describe.skipIf(!integration)('workspace anchor root /api/*', () => {
  test('status, restart, static preview and root /api/* all resolve the same anchor manager', async () => {
    const workspace = mkdtempSync(join('/tmp', 'shogo-ws-anchor-api-'))
    const anchorId = 'anchor-proj-api'
    const anchorDir = join(workspace, anchorId)
    const envBackup = { ...process.env }
    const { PreviewManager } = await import('../preview-manager')
    const proto = PreviewManager.prototype as any
    const originals = {
      port: Object.getOwnPropertyDescriptor(proto, 'apiServerPort')!,
      phase: Object.getOwnPropertyDescriptor(proto, 'apiServerPhase')!,
      restart: proto.restart,
    }
    const sidecar = Bun.serve({
      port: 0,
      fetch: (req) => Response.json({ from: 'anchor-sidecar', path: new URL(req.url).pathname }),
    })
    const restartedDirs: string[] = []
    const isAnchor = (pm: any) => pm.workspaceDir === anchorDir
    try {
      mkdirSync(join(anchorDir, 'dist'), { recursive: true })
      writeFileSync(
        join(anchorDir, 'dist', 'index.html'),
        '<!doctype html><html><body>ANCHOR_API_MARKER</body></html>',
      )

      // Only the anchor's manager has a bound sidecar; any other instance
      // looks like the stuck workspace-root manager from the incident.
      Object.defineProperty(proto, 'apiServerPort', {
        configurable: true,
        get() {
          return isAnchor(this) ? sidecar.port : null
        },
      })
      Object.defineProperty(proto, 'apiServerPhase', {
        configurable: true,
        get() {
          return isAnchor(this) ? 'healthy' : 'generating'
        },
      })
      proto.restart = async function () {
        restartedDirs.push(this.workspaceDir)
        return { success: true }
      }

      process.env.WORKSPACE_DIR = workspace
      process.env.WORKSPACE_RUNTIME = 'true'
      process.env.WORKSPACE_ID = 'test-workspace'
      process.env.WORKSPACE_ANCHOR_PROJECT_ID = anchorId
      process.env.WORKSPACE_PROJECT_IDS = anchorId

      const server = (await import('../server')).default
      const fetchRoot = async (path: string, init?: RequestInit) =>
        (await server.fetch(new Request(`http://runtime.test${path}`, init), {} as any)) as Response

      const status = await (await fetchRoot('/preview/status')).json()
      expect(status.workspaceDir).toBe(anchorDir)

      expect((await fetchRoot('/preview/restart', { method: 'POST' })).status).toBe(200)
      expect((await fetchRoot('/preview/rebuild', { method: 'POST' })).status).toBe(200)
      expect(restartedDirs).toEqual([anchorDir, anchorDir])

      const staticRes = await fetchRoot('/')
      expect(staticRes.status).toBe(200)
      expect(await staticRes.text()).toContain('ANCHOR_API_MARKER')

      const rootApi = await fetchRoot('/api/auth/setup-status')
      expect(rootApi.status).toBe(200)
      expect(await rootApi.json()).toEqual({ from: 'anchor-sidecar', path: '/api/auth/setup-status' })

      const scopedApi = await fetchRoot(`/p/${anchorId}/api/auth/setup-status`)
      expect(scopedApi.status).toBe(200)
      expect(await scopedApi.json()).toEqual({ from: 'anchor-sidecar', path: '/api/auth/setup-status' })
    } finally {
      sidecar.stop(true)
      Object.defineProperty(proto, 'apiServerPort', originals.port)
      Object.defineProperty(proto, 'apiServerPhase', originals.phase)
      proto.restart = originals.restart
      rmSync(workspace, { recursive: true, force: true })
      for (const key of Object.keys(process.env)) {
        if (!(key in envBackup)) delete process.env[key]
      }
      Object.assign(process.env, envBackup)
    }
  })
})
