// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * No two route files claim the same web path (SHO-110).
 *
 * `(admin)` and `(app)` are groups, so their contents share the URL space.
 * Two files both answering `/settings` are indistinguishable to a *direct*
 * request — an email, a bookmark, a shared link — and the resolver picked the
 * admin console, which then bounced the visitor to `/projects`. In-app
 * navigation never noticed because it pushes `/(admin)/settings` or
 * `/(app)/settings`, group segment included.
 *
 * This test asks expo-router itself what every file under `app/` resolves to
 * (`getExactRoutes` over a context module built from the real file tree), then
 * fails when one path is claimed twice. It also pins the ownership pairs a
 * direct request must get right: `/settings` (Settings → People, matching
 * `apps/api/src/__tests__/join-notification-settings-url.test.ts`) against
 * `/admin/settings` (the admin AI/provider console), plus the four user pages
 * the admin console used to answer (SHO-115) — each is the `(app)` file alone,
 * with the admin screen under `/admin/<name>`.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { getExactRoutes } from 'expo-router/build/getRoutes'

const APP_DIR = join(import.meta.dir, '../../app')

type RouteNode = {
  type: 'layout' | 'route' | 'api'
  route: string
  contextKey: string
  children?: RouteNode[]
}

/** `./`-prefixed context keys, the shape a Metro `require.context` produces. */
function contextKeys(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      contextKeys(path, acc)
      continue
    }
    acc.push('./' + relative(APP_DIR, path).split(sep).join('/'))
  }
  return acc
}

/** Every path a file under `app/` answers to, keyed back to its file. */
function resolveRouteTree(): Map<string, string[]> {
  const keys = contextKeys(APP_DIR)
  const contextModule = ((key: string) => ({ default: () => null, key })) as unknown as {
    (key: string): unknown
    keys: () => string[]
    resolve: (key: string) => string
    id: string
  }
  contextModule.keys = () => keys
  contextModule.resolve = (key: string) => key
  contextModule.id = 'app'

  const tree = getExactRoutes(contextModule as never, { ignoreRequireErrors: true }) as unknown as RouteNode

  const byPath = new Map<string, string[]>()
  const visit = (node: RouteNode, parentPath: string) => {
    const segments = parentPath.split('/').filter(Boolean)
    for (const segment of node.route.split('/').filter(Boolean)) {
      const isGroup = segment.startsWith('(') && segment.endsWith(')')
      if (!isGroup && segment !== 'index') segments.push(segment)
    }
    const path = '/' + segments.join('/')
    if (node.type === 'route') {
      const file = node.contextKey.replace(/^\.\//, '')
      byPath.set(path, [...(byPath.get(path) ?? []), file])
    }
    for (const child of node.children ?? []) visit(child, path)
  }
  visit(tree, '')
  return byPath
}

/**
 * Duplicate paths that survive by design: only the root, where
 * `app/index.tsx` (auth/onboarding/embed gate), `(app)/index.tsx` (home),
 * `(onboarding)/index.tsx` and `(admin)/index.tsx` (admin dashboard) all claim
 * `/` and the gate picks the destination. Everything else was moved under
 * `/admin/*` (SHO-110 for `/settings`, SHO-115 for the four below). Frozen like
 * a lint ratchet: a *new* duplicate fails, and fixing one of these forces its
 * removal here.
 */
const KNOWN_DUPLICATES = new Set([
  // `app/index.tsx` (auth/onboarding/embed gate), `(app)/index.tsx` (home),
  // `(onboarding)/index.tsx` and `(admin)/index.tsx` (admin dashboard) — the
  // root path is claimed by groups by design; only the first one is the entry.
  '/',
])

/**
 * The admin console's user-path pages, moved under `/admin/*` so a direct
 * request for the end-user page can never land on an admin screen: `<user>`
 * belongs to the `(app)` file alone, `<admin>` to the `(admin)` one.
 */
const ADMIN_PAGES = [
  { user: '/analytics', admin: '/admin/analytics', adminFile: '(admin)/admin/analytics.tsx' },
  { user: '/marketplace', admin: '/admin/marketplace', adminFile: '(admin)/admin/marketplace/index.tsx' },
  { user: '/meetings', admin: '/admin/meetings', adminFile: '(admin)/admin/meetings.tsx' },
  { user: '/projects', admin: '/admin/projects', adminFile: '(admin)/admin/projects/index.tsx' },
] as const

const routes = resolveRouteTree()
const duplicates = [...routes].filter(([, files]) => files.length > 1).map(([path]) => path).sort()

describe('route paths under app/', () => {
  test('/settings is the end-user Settings page and nothing else', () => {
    expect(routes.get('/settings')).toEqual(['(app)/settings.tsx'])
  })

  test('/admin/settings is the admin AI console and nothing else', () => {
    expect(routes.get('/admin/settings')).toEqual(['(admin)/admin/settings.tsx'])
  })

  for (const { user, admin, adminFile } of ADMIN_PAGES) {
    test(`${user} is the end-user page and ${admin} is the admin one`, () => {
      expect(routes.get(user)).toHaveLength(1)
      expect(routes.get(user)?.[0]?.startsWith('(app)/')).toBe(true)
      expect(routes.get(admin)).toEqual([adminFile])
    })
  }

  test('no new duplicate paths', () => {
    expect(duplicates.filter((path) => !KNOWN_DUPLICATES.has(path))).toEqual([])
  })

  test('the known-duplicate list has no stale entries', () => {
    expect([...KNOWN_DUPLICATES].filter((path) => !duplicates.includes(path))).toEqual([])
  })
})
