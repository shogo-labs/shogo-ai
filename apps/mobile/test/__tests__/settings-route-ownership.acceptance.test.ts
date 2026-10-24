// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Who owns `/settings`, and does every in-app link still land on a real route?
 * (SHO-110, QA acceptance.)
 *
 * `(admin)` and `(app)` are route *groups*, so both trees answer in the same URL
 * space. Before SHO-110 two files claimed `/settings` — the admin AI console
 * (`app/(admin)/settings.tsx`) and the end-user Settings page
 * (`app/(app)/settings.tsx`) — and a plain GET (email, bookmark, shared link)
 * resolved to the admin console, which bounced a non-admin to `/projects`.
 *
 * This spec is deliberately independent of `route-path-collisions.test.ts` (the
 * change's own ratchet): it re-resolves the real tree with expo-router, then
 * asserts *by file content* that `/settings` is the end-user page and
 * `/admin/settings` is the admin console, so a rename that points one path at
 * the wrong file fails here even if the collision count stays at zero.
 *
 * The second half guards the class of bug the rename can leave behind: any
 * absolute `/(admin)/…` or `/(app)/…` navigation literal in the app must resolve
 * to a file that exists. A stale `router.push('/(admin)/settings')` is a dead
 * tap target that no typecheck can see.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { getExactRoutes } from 'expo-router/build/getRoutes'

const MOBILE = join(import.meta.dir, '../..')
const APP_DIR = join(MOBILE, 'app')
const SOURCE_ROOTS = ['app', 'components', 'lib', 'hooks'].map((dir) => join(MOBILE, dir))

type RouteNode = {
  type: 'layout' | 'route' | 'api'
  route: string
  contextKey: string
  children?: RouteNode[]
}

function walk(dir: string, onFile: (path: string) => void): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, onFile)
    else onFile(path)
  }
}

/** expo-router's own resolution over the real file tree → path → owning files. */
function resolveRouteTree(): Map<string, string[]> {
  const keys: string[] = []
  walk(APP_DIR, (path) => keys.push('./' + relative(APP_DIR, path).split(sep).join('/')))

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

  const visit = (node: RouteNode, parent: string) => {
    const segments = parent.split('/').filter(Boolean)
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

const routes = resolveRouteTree()

/** `/admin/settings` for `/(admin)/admin/settings`, `/settings` for `/(app)/settings`. */
function toWebPath(literal: string): string {
  const withoutQuery = literal.split('?')[0].split('#')[0]
  const segments = withoutQuery
    .split('/')
    .filter(Boolean)
    .filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')))
    // `/(app)/index` is `/`: expo-router's index route owns its directory.
    .filter((segment) => segment !== 'index')
  return '/' + segments.join('/')
}

/** Dynamic routes (`/grants/[id]`) answer paths no static key holds. */
const dynamicRoutes = [...routes.keys()]
  .filter((path) => path.includes('['))
  .map((path) => ({
    path,
    pattern: new RegExp(
      '^' +
        path
          .split('/')
          .map((segment) => {
            if (segment.startsWith('[...') && segment.endsWith(']')) return '.+'
            if (segment.startsWith('[') && segment.endsWith(']')) return '[^/]+'
            return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          })
          .join('/') +
        '$',
    ),
  }))

function routeExists(path: string): boolean {
  if (routes.has(path)) return true
  return dynamicRoutes.some((route) => route.pattern.test(path))
}

describe('/settings belongs to the end-user Settings page', () => {
  test('exactly one file claims /settings, and it is the user page', () => {
    expect(routes.get('/settings')).toEqual(['(app)/settings.tsx'])
  })

  test('that file renders the user Settings page, not the admin console', () => {
    const source = readFileSync(join(APP_DIR, '(app)/settings.tsx'), 'utf8')
    expect(source).toContain('"settings-legacy-page"')
    // Admin-console markers: the AI/provider screen's header and its models card.
    expect(source).not.toContain('Admin / Intelligence')
    expect(source).not.toContain('components/admin/ModelsCard')
  })

  test('the admin AI console moved to /admin/settings and keeps its own screen', () => {
    expect(routes.get('/admin/settings')).toEqual(['(admin)/admin/settings.tsx'])
    const source = readFileSync(join(APP_DIR, '(admin)/admin/settings.tsx'), 'utf8')
    expect(source).toContain('Admin / Intelligence')
    expect(source).toContain('Choose your AI provider and configure models.')
    expect(source).not.toContain('"settings-legacy-page"')
  })

  test('no file under (admin) answers at /settings', () => {
    const adminFiles = [...routes]
      .filter(([, files]) => files.some((file) => file.startsWith('(admin)/')))
      .map(([path]) => path)
    expect(adminFiles).not.toContain('/settings')
  })
})

describe('every absolute in-app route literal resolves to a real file', () => {
  const literals: Array<{ file: string; line: number; literal: string }> = []
  const pattern = /['"`]\/(?:\(admin\)|\(app\))[^'"`\n]*/g

  for (const root of SOURCE_ROOTS) {
    walk(root, (path) => {
      if (!/\.(ts|tsx)$/.test(path) || /\.test\.(ts|tsx)$/.test(path)) return
      const lines = readFileSync(path, 'utf8').split('\n')
      lines.forEach((text, index) => {
        // `pathname === '/(app)/index'` compares the current location; it is not
        // a navigation target and names no route.
        if (text.includes('pathname')) return
        for (const match of text.matchAll(pattern)) {
          literals.push({ file: relative(MOBILE, path), line: index + 1, literal: match[0].slice(1) })
        }
      })
    })
  }

  test('the scan actually sees the entry points it is meant to guard', () => {
    const joined = literals.map((entry) => `${entry.file}:${entry.literal}`).join('\n')
    expect(joined).toContain('(admin)/_layout.tsx:/(admin)/admin/settings')
    expect(joined).toContain('components/chat/ModelPickerMenu.tsx:/(admin)/admin/settings')
    expect(literals.length).toBeGreaterThan(20)
  })

  test('no literal is stale', () => {
    const stale = literals
      // Dynamic targets (`${id}`, `[id]`) cannot be resolved statically.
      .filter((entry) => !entry.literal.includes('${') && !entry.literal.includes('['))
      .map((entry) => ({ ...entry, path: toWebPath(entry.literal) }))
      .filter((entry) => !routeExists(entry.path))
      .map((entry) => `${entry.file}:${entry.line} → ${entry.literal} (${entry.path})`)
    expect(stale).toEqual([])
  })
})
