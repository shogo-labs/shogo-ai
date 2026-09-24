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
})
