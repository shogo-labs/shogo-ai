// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Always-on guard for the bare-root routes that must share one
 * PreviewManager. In workspace mode that is the anchor's manager
 * (`getRootPreviewManager()`); the workspace-root `getPreviewManager()` is
 * never started there, so a route that uses it reports a different preview
 * than `/preview/status` — e.g. root `/api/*` returning a permanent 503
 * "API server not ready" while status said `apiReady: true`.
 *
 * Behavioral coverage lives in `workspace-anchor-root-api.integration.test.ts`
 * (RUN_INTEGRATION=1); this keeps the invariant enforced in the default run.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf-8')

function handlerBody(method: string, path: string): string {
  const start = source.indexOf(`app.${method}('${path}'`)
  if (start < 0) throw new Error(`route not found: app.${method}('${path}')`)
  const next = source.indexOf('\napp.', start + 1)
  return source.slice(start, next < 0 ? undefined : next)
}

describe('bare-root routes resolve the anchor-aware PreviewManager', () => {
  const routes: Array<[string, string]> = [
    ['get', '/preview/status'],
    ['post', '/preview/restart'],
    ['post', '/preview/rebuild'],
    ['post', '/preview/start'],
    ['post', '/preview/stop'],
    ['all', '/api/*'],
  ]

  for (const [method, path] of routes) {
    test(`${method.toUpperCase()} ${path}`, () => {
      const body = handlerBody(method, path)
      expect(body).toContain('getRootPreviewManager()')
      expect(body).not.toContain('getPreviewManager()')
    })
  }

  test('root static serve reads the anchor dist', () => {
    const start = source.indexOf('function getDistDir()')
    const body = source.slice(start, source.indexOf('\n}', start))
    expect(body).toContain('getAnchorProjectId()')
  })

  test('both /api proxies share one on-demand ensure helper', () => {
    for (const [method, path] of [['all', '/api/*'], ['all', '/p/:projectId/api/*']] as Array<[string, string]>) {
      const body = handlerBody(method, path)
      expect(body).toContain('resolveApiProxyTarget(pm)')
      // The old crashed-only recovery + 3s grace block must be gone from both.
      expect(body).not.toContain('maybeRecoverApiServer')
      expect(body).not.toContain('API_PROXY_STARTUP_WAIT_MS')
    }
  })

  test('both /preview/stop routes record a deliberate stop', () => {
    expect(handlerBody('post', '/preview/stop')).toContain('markStoppedByUser()')
    expect(handlerBody('post', '/p/:projectId/preview/stop')).toContain('markStoppedByUser()')
  })

  test('a tool resolving a mounted project file goes through resolveApiServerTarget', () => {
    const start = source.indexOf('function resolveApiServerTarget(')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\nfunction', start + 1))
    // Mount table first (a folder-linked project's real folder is outside
    // WORKSPACE_DIR), then the merged-root layout, anchor as the fallback.
    expect(body).toContain('parseWorkspaceMounts()')
    expect(body).toContain('getWorkspacePreviewManager(')
    expect(body).toContain('getRootPreviewManager()')
  })

  test('both /api proxies forward the caller\'s headers, Authorization included', () => {
    // SHO-403 AC8: the runtime hop must not strip auth. The strip (if any)
    // belongs upstream at the edge/API preview proxy — SHO-372.
    for (const path of ['/api/*', '/p/:projectId/api/*']) {
      const body = handlerBody('all', path)
      expect(body).toContain('headers: c.req.raw.headers')
    }
  })

  test('gateway build-complete wiring uses the anchor-aware manager', () => {
    const start = source.indexOf('async function startGateway(')
    const end = source.indexOf('\nfunction', start + 1)
    const body = source.slice(start, end < 0 ? undefined : end)
    // The anchor PM plus the host that can resolve a MOUNTED project — a tool
    // editing `<otherProject>/custom-routes.ts` must not sync the anchor.
    expect(body).toContain('agentGateway.attachApiServer(getRootPreviewManager(), buildApiServerHost())')
    expect(body).not.toContain('agentGateway.attachApiServer(getPreviewManager()')
  })
})
