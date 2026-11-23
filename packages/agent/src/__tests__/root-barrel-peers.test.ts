// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Guards the aggregate root entry (`src/index.ts`) against optional peers.
 *
 * A plain `npm install @shogo-ai/agent` installs `dependencies` and required
 * peers, and nothing else — a package listed only as an *optional* peer is
 * absent. So a module that value-imports an optional peer may be a published
 * subpath (skipping it is the consumer's choice), but it must never sit in the
 * root barrel's static `export *` graph: the root would throw MODULE_NOT_FOUND
 * for a consumer who did exactly what the docs say (SHO-519: `agent-loop`,
 * `pi-adapter` and `vision-fallback` value-import the optional
 * `@mariozechner/pi-agent-core` / `@mariozechner/pi-ai` peers).
 *
 * `scripts/verify-packed-packages.ts` catches this on the packed tarball at
 * release time; this test catches it in the PR that introduces it, and it fails
 * for any future module — not just the pi ones this card was filed about.
 *
 * Run: bun test packages/agent/src/__tests__/root-barrel-peers.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isBuiltin } from 'node:module'

const PKG_DIR = resolve(import.meta.dir, '../..')
const ENTRY = join(PKG_DIR, 'src/index.ts')

type Manifest = {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const manifest = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as Manifest

const optionalPeers = Object.entries(manifest.peerDependenciesMeta ?? {})
  .filter(([, meta]) => meta?.optional)
  .map(([name]) => name)

/** What `npm install <this package>` guarantees the consumer gets. */
const installedByDefault = new Set<string>([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}).filter((name) => !optionalPeers.includes(name)),
])

function isRuntimeImport(keyword: string, typeOnly: boolean | undefined, clause: string): boolean {
  if (typeOnly) return false
  const trimmed = clause.trim()
  if (!trimmed.startsWith('{')) return true // default import, namespace import, `export *`
  const named = trimmed
    .replace(/^\{/, '')
    .replace(/\}$/, '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  // `export { type T }` / `import { type T }` are erased by the compiler.
  return named.some((part) => !part.startsWith('type ') && part !== 'type')
}

function moduleSpecifiers(file: string): { bare: string[]; relative: string[] } {
  const source = readFileSync(file, 'utf8')
  const bare: string[] = []
  const relative: string[] = []
  const record = (specifier: string) => {
    if (specifier.startsWith('.')) relative.push(specifier)
    else bare.push(specifier)
  }

  const fromClause = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g
  for (const match of source.matchAll(fromClause)) {
    const [, keyword, typeOnly, clause, specifier] = match
    if (!isRuntimeImport(keyword!, typeOnly, clause!)) continue
    record(specifier!)
  }
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
    record(match[1]!)
  }
  return { bare, relative }
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier)
  const candidates = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/** Every bare specifier the root entry resolves at module scope, and who imports it. */
function rootRuntimeGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  const visited = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (visited.has(file)) continue
    visited.add(file)
    const { bare, relative } = moduleSpecifiers(file)
    for (const specifier of bare) {
      const importers = graph.get(specifier) ?? []
      importers.push(file.slice(PKG_DIR.length + 1))
      graph.set(specifier, importers)
    }
    for (const specifier of relative) {
      const target = resolveRelative(file, specifier)
      if (target) queue.push(target)
    }
  }
  return graph
}

describe('@shogo-ai/agent root entry', () => {
  test('loads with only what a plain `npm install @shogo-ai/agent` installs', () => {
    const graph = rootRuntimeGraph(ENTRY)
    const violations: string[] = []
    for (const [specifier, importers] of graph) {
      if (specifier.startsWith('node:') || isBuiltin(specifier)) continue
      if (installedByDefault.has(specifier)) continue
      const why = optionalPeers.includes(specifier)
        ? `optional peer '${specifier}'`
        : `'${specifier}' (not a dependency or required peer)`
      violations.push(`src/index.ts re-exports ${why}, imported by ${importers.join(', ')}`)
    }
    expect(violations).toEqual([])
  })

  test('keeps the pi-backed modules subpath-only', () => {
    const graph = rootRuntimeGraph(ENTRY)
    const piModules = ['./agent-loop', './pi-adapter', './vision-fallback']
    const barrel = readFileSync(ENTRY, 'utf8')
    for (const subpath of piModules) {
      expect(barrel).not.toContain(`from '${subpath}'`)
    }
    // The subpaths themselves still exist — this pins the decision, it does not
    // remove the modules from the package.
    for (const subpath of piModules) {
      expect(existsSync(join(PKG_DIR, 'src', `${subpath.slice(2)}.ts`))).toBe(true)
    }
    expect([...graph.keys()].filter((specifier) => specifier.startsWith('@mariozechner/'))).toEqual([])
  })
})
