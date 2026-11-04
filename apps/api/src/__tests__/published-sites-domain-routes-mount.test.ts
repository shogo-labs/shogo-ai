// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `apps/api/src/server.ts` must mount the published-sites custom-domain routes
 * (SHO-304, QA round 1 blocker 1).
 *
 * `publishedSitesRoutes()` registers `/published-sites/:sourceProjectId/domains*`,
 * but a router that is never mounted answers nothing: the desktop's
 * `local-publish.ts` proxies hit `/api/published-sites/:id/domains*` on this app,
 * and with no forward they 404 in production. The router test alone can't catch
 * that — it calls `publishedSitesRoutes()` directly — so this test asserts the
 * real server mounts each route AND rewrites the pathname to the router's own
 * path before forwarding.
 *
 * `server.ts` has process-wide side effects (crons, DB init), so this reads the
 * source rather than importing it.
 *
 * Run: bun --smol test apps/api/src/__tests__/published-sites-domain-routes-mount.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf8')

/** Text of the handler registered for `app.<method>('<path>'`, up to its end. */
function mountBlock(method: string, path: string): string | null {
  const start = source.indexOf(`app.${method}('${path}',`)
  if (start === -1) return null
  const end = source.indexOf('\n})', start)
  return source.slice(start, end === -1 ? start + 800 : end + 3)
}

const ROUTES: Array<{ method: string; apiPath: string; routerPath: string }> = [
  {
    method: 'get',
    apiPath: '/api/published-sites/:sourceProjectId/domains',
    routerPath: '/published-sites/${c.req.param(\'sourceProjectId\')}/domains',
  },
  {
    method: 'post',
    apiPath: '/api/published-sites/:sourceProjectId/domains',
    routerPath: '/published-sites/${c.req.param(\'sourceProjectId\')}/domains',
  },
  {
    method: 'post',
    apiPath: '/api/published-sites/:sourceProjectId/domains/:domainId/verify',
    routerPath:
      '/published-sites/${c.req.param(\'sourceProjectId\')}/domains/${c.req.param(\'domainId\')}/verify',
  },
  {
    method: 'post',
    apiPath: '/api/published-sites/:sourceProjectId/domains/:domainId/retrigger',
    routerPath:
      '/published-sites/${c.req.param(\'sourceProjectId\')}/domains/${c.req.param(\'domainId\')}/retrigger',
  },
  {
    method: 'patch',
    apiPath: '/api/published-sites/:sourceProjectId/domains/:domainId/primary',
    routerPath:
      '/published-sites/${c.req.param(\'sourceProjectId\')}/domains/${c.req.param(\'domainId\')}/primary',
  },
  {
    method: 'delete',
    apiPath: '/api/published-sites/:sourceProjectId/domains/:domainId',
    routerPath: '/published-sites/${c.req.param(\'sourceProjectId\')}/domains/${c.req.param(\'domainId\')}',
  },
]

describe('server.ts mounts the published-sites custom-domain routes', () => {
  for (const route of ROUTES) {
    test(`${route.method.toUpperCase()} ${route.apiPath}`, () => {
      const block = mountBlock(route.method, route.apiPath)
      expect(block).not.toBeNull()
      // ...and it actually forwards into the cloud router at that router's path.
      expect(block!).toContain('publishedSitesRoutes()')
      expect(block!).toContain(route.routerPath)
    })
  }
})
