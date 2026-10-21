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
 * fails when one path is claimed twice. It also pins the two paths join mail
 * depends on: `/settings` (Settings → People) and `/admin/settings` (the admin
 * AI/provider console). The matching half of that pin is
 * `apps/api/src/__tests__/join-notification-settings-url.test.ts`.
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
 * Duplicate paths that predate SHO-110 and are tracked separately: each is an
 * admin page that a group-hoisted route answers at a user path. The user-facing
 * winner is right for the app today (in-app links always carry the group
 * segment), so only the emailed `/settings` collision was a live bug — these
 * four plus the root index trio are the follow-up. Frozen like a lint ratchet:
 * a *new* duplicate fails, and fixing one of these forces its removal here.
 */
const KNOWN_DUPLICATES = new Set([
  // `app/index.tsx` (auth/onboarding/embed gate), `(app)/index.tsx` (home),
  // `(onboarding)/index.tsx` and `(admin)/index.tsx` (admin dashboard) — the
  // root path is claimed by groups by design; only the first one is the entry.
  '/',
  '/analytics', // (app)/analytics.tsx | (admin)/analytics.tsx
  '/marketplace', // (app)/marketplace/index.tsx | (admin)/marketplace/index.tsx
  '/meetings', // (app)/meetings/index.tsx | (admin)/meetings.tsx
  '/projects', // (app)/projects/index.tsx | (admin)/projects/index.tsx
])

const routes = resolveRouteTree()
const duplicates = [...routes].filter(([, files]) => files.length > 1).map(([path]) => path).sort()

describe('route paths under app/', () => {
  test('/settings is the end-user Settings page and nothing else', () => {
    expect(routes.get('/settings')).toEqual(['(app)/settings.tsx'])
  })

  test('/admin/settings is the admin AI console and nothing else', () => {
    expect(routes.get('/admin/settings')).toEqual(['(admin)/admin/settings.tsx'])
  })

  test('no new duplicate paths', () => {
    expect(duplicates.filter((path) => !KNOWN_DUPLICATES.has(path))).toEqual([])
  })

  test('the known-duplicate list has no stale entries', () => {
    expect([...KNOWN_DUPLICATES].filter((path) => !duplicates.includes(path))).toEqual([])
  })
})
