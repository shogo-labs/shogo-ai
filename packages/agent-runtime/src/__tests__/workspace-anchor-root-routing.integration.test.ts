// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression coverage for the "Project Ready" placeholder persisting at the
 * bare runtime root for a workspace-anchored project on staging
 * (218bef53-..., 2026-09-22), even after the anchor was correctly included in
 * `WORKSPACE_PROJECT_IDS` (#946) and hydrate no longer hung (#947).
 *
 * Root cause: the bare root (`/`, `/preview/status`, `/preview/start`, the
 * root catch-all's dist/ serve) always operated on the ROOT-rooted
 * `getPreviewManager()` singleton, which is never started in workspace mode
 * — the anchor's REAL build lives in its own `getWorkspacePreviewManager(id)`
 * instance (`<WORKSPACE_DIR>/<anchorId>/dist`), reachable only via
 * `/p/<anchorId>/…`. Compounding this, those `/p/:projectId/*` routes were
 * themselves registered inside `if (IS_WORKSPACE_RUNTIME) {…}` evaluated
 * ONCE at module load — before any real `/pool/assign` call ever flips that
 * `let` to `true` — so on every real warm-pool boot they were never
 * registered at all, and `/p/<id>/…` silently fell through to the root
 * catch-all's (empty) dist.
 *
 * This test drives the real `server.ts` module (like
 * `server-history-route.integration.test.ts`) with workspace-mode env set
 * BEFORE import, so both the always-registered `/p/:projectId/*` routes and
 * the anchor-aware root delegation are exercised end-to-end over HTTP.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const integration = process.env.RUN_INTEGRATION === '1'

describe.skipIf(!integration)('workspace anchor root routing', () => {
  test('root `/` and `/preview/status` reflect the ANCHOR preview, not an empty root dist', async () => {
    const workspace = mkdtempSync(join('/tmp', 'shogo-ws-anchor-root-'))
    const anchorId = 'anchor-proj-1'
    const envBackup = { ...process.env }
    try {
      // Seed the anchor's OWN dist/ — what its workspace-scoped
      // PreviewManager would have built (`<ws>/<anchorId>/dist`) — with
      // content distinguishable from the (deliberately absent) root dist.
      const anchorDist = join(workspace, anchorId, 'dist')
      mkdirSync(anchorDist, { recursive: true })
      writeFileSync(
        join(anchorDist, 'index.html'),
        '<!doctype html><html><body>ANCHOR_REAL_APP_MARKER</body></html>',
      )
      writeFileSync(join(anchorDist, 'app.js'), 'console.log("anchor bundle")')

      // Simulate a workspace-runtime assign: env flipped BEFORE server.ts is
      // ever imported (module load), mirroring `/pool/assign` in production
      // as closely as an import-time test can.
      process.env.WORKSPACE_DIR = workspace
      process.env.WORKSPACE_RUNTIME = 'true'
      process.env.WORKSPACE_ID = 'test-workspace'
      process.env.WORKSPACE_ANCHOR_PROJECT_ID = anchorId
      process.env.WORKSPACE_PROJECT_IDS = anchorId

      const server = (await import('../server')).default

      // The bare root must serve the ANCHOR's real dist, not 404 / an empty
      // scaffold — this is exactly what a browser hitting the public preview
      // URL (or the Studio canvas iframe) does.
      const rootRes = await server.fetch(new Request('http://runtime.test/'), {} as any)
      expect(rootRes.status).toBe(200)
      const rootHtml = await rootRes.text()
      expect(rootHtml).toContain('ANCHOR_REAL_APP_MARKER')

      // `/preview/status` (what `usePreviewPhase` polls) must describe the
      // ANCHOR's PreviewManager — distinguishable by `workspaceDir` pointing
      // at the anchor's subfolder, not the literal workspace root.
      const statusRes = await server.fetch(new Request('http://runtime.test/preview/status'), {} as any)
      expect(statusRes.status).toBe(200)
      const status = await statusRes.json()
      expect(status.workspaceDir).toBe(join(workspace, anchorId))

      // The `/p/<anchorId>/…` route must ALSO reach the same real content
      // (no regression on the existing, previously-dead-code path).
      const memberRes = await server.fetch(
        new Request(`http://runtime.test/p/${anchorId}/`),
        {} as any,
      )
      expect(memberRes.status).toBe(200)
      expect(await memberRes.text()).toContain('ANCHOR_REAL_APP_MARKER')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      for (const key of Object.keys(process.env)) {
        if (!(key in envBackup)) delete process.env[key]
      }
      Object.assign(process.env, envBackup)
    }
  })
})
