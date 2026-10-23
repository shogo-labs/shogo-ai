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
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { getExactRoutes } from 'expo-router/build/getRoutes'
import { adminPageTitle, isAdminNavActive } from '../../lib/admin-nav'

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

/**
 * Moving a page is not only a file move: the admin sidebar's hrefs carry the
 * `(admin)` group segment while `usePathname()` returns the resolved URL, and
 * the header title is matched against that same string. A stale entry here
 * loses the active highlight or prints "Dashboard" without breaking
 * navigation, so the strings are pinned next to the paths they follow.
 */
const ADMIN_NAV = [
  { href: '/(admin)/admin/analytics', pathname: '/admin/analytics' },
  { href: '/(admin)/admin/marketplace', pathname: '/admin/marketplace' },
  { href: '/(admin)/admin/meetings', pathname: '/admin/meetings' },
  { href: '/(admin)/admin/projects', pathname: '/admin/projects' },
  { href: '/(admin)/admin/settings', pathname: '/admin/settings' },
] as const

describe('admin nav highlight + page title', () => {
  test('the dashboard item owns the root, and only the root', () => {
    for (const pathname of ['/', '', '/(admin)', '/index']) {
      expect(isAdminNavActive(pathname, '/(admin)')).toBe(true)
    }
    expect(isAdminNavActive('/admin/projects', '/(admin)')).toBe(false)
  })

  test('each moved admin page highlights its own nav item', () => {
    for (const { href, pathname } of ADMIN_NAV) {
      expect(isAdminNavActive(pathname, href)).toBe(true)
      expect(isAdminNavActive(pathname.replace('/admin', ''), href)).toBe(false)
    }
  })

  test('a child page keeps its section highlighted, without bleeding into others', () => {
    expect(isAdminNavActive('/admin/projects/p1', '/(admin)/admin/projects')).toBe(true)
    expect(isAdminNavActive('/admin/marketplace/listings', '/(admin)/admin/marketplace')).toBe(true)
    expect(isAdminNavActive('/admin/projects', '/(admin)/admin/meetings')).toBe(false)
  })

  test('each moved admin page titles its header', () => {
    expect(adminPageTitle('/admin/analytics')).toBe('Marketing Analytics')
    expect(adminPageTitle('/admin/ai-analytics')).toBe('AI Analytics')
    expect(adminPageTitle('/admin/meetings')).toBe('Meetings')
    expect(adminPageTitle('/admin/settings')).toBe('AI Settings')
    expect(adminPageTitle('/admin/projects')).toBe('Projects')
    expect(adminPageTitle('/admin/projects/p1')).toBe('Project Detail')
    expect(adminPageTitle('/admin/marketplace')).toBe('Marketplace Review')
    expect(adminPageTitle('/admin/marketplace/listings')).toBe('Marketplace Listings')
    expect(adminPageTitle('/admin/marketplace/listing/l1')).toBe('Listing Detail')
    expect(adminPageTitle('/admin/marketplace/payouts')).toBe('Marketplace Payouts')
  })
})


/**
 * A moved page also carries path literals that never reach the file system:
 * the marketplace tab strip navigates with `href`s, decides its highlight from
 * `match` strings and hides itself on a detail URL by prefix. A resolver test
 * cannot see any of those — they would just quietly navigate to the end-user
 * page — so the literals are pinned here.
 */
describe('the marketplace tab strip follows the moved path', () => {
  const layout = readFileSync(
    join(import.meta.dir, '../../app/(admin)/admin/marketplace/_layout.tsx'),
    'utf8',
  )
  const strings = (key: string) =>
    [...layout.matchAll(new RegExp(`${key}:\\s*'([^']+)'`, 'g'))].map((match) => match[1])

  test('its tabs target the admin pages', () => {
    expect(strings('href')).toEqual([
      '/(admin)/admin/marketplace',
      '/(admin)/admin/marketplace/listings',
      '/(admin)/admin/marketplace/payouts',
    ])
    expect(strings('match')).toEqual([
      '/admin/marketplace',
      '/admin/marketplace/listings',
      '/admin/marketplace/payouts',
    ])
  })

  test('it hides itself on an admin listing detail page', () => {
    expect(layout).toContain("pathname.startsWith('/admin/marketplace/listing/')")
    expect(layout).not.toMatch(/['"`]\/marketplace/)
  })
})
