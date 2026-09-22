// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Companion to `workspace-anchor-root-routing.integration.test.ts`, kept in
 * its own file so its single-project-mode env is what `server.ts` sees at
 * module load (Bun caches a dynamically-imported module for the life of the
 * process, so a workspace-mode import earlier in the same run would
 * otherwise leak `IS_WORKSPACE_RUNTIME=true` into this test).
 *
 * Regression: making `/p/:projectId/*` etc. register unconditionally (see
 * server.ts) must not turn a single-project app's own `/p/<anything>` route
 * into a `project_not_attached` 404 — it has to keep falling through to the
 * ordinary root-dist SPA fallback exactly as when these routes weren't
 * registered at all.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const integration = process.env.RUN_INTEGRATION === '1'

describe.skipIf(!integration)('single-project mode /p/* fallback', () => {
  test('serves `/p/<anything>` from the root dist, not a workspace 404', async () => {
    const workspace = mkdtempSync(join('/tmp', 'shogo-single-p-fallback-'))
    try {
      const rootDist = join(workspace, 'dist')
      mkdirSync(rootDist, { recursive: true })
      writeFileSync(
        join(rootDist, 'index.html'),
        '<!doctype html><html><body>SINGLE_PROJECT_APP_MARKER</body></html>',
      )

      process.env.WORKSPACE_DIR = workspace
      process.env.PROJECT_ID = 'single-project-test'
      delete process.env.WORKSPACE_RUNTIME
      delete process.env.WORKSPACE_ID
      delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
      delete process.env.WORKSPACE_PROJECT_IDS

      const server = (await import('../server')).default

      // A user app route that happens to look like `/p/<id>` must still
      // resolve client-side via the ordinary SPA fallback, not a
      // `project_not_attached` 404 from the workspace machinery.
      const res = await server.fetch(
        new Request('http://runtime.test/p/some-client-route'),
        {} as any,
      )
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('SINGLE_PROJECT_APP_MARKER')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      delete process.env.WORKSPACE_DIR
      delete process.env.PROJECT_ID
    }
  })
})
