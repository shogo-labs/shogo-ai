// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The aggregate root must load with exactly what the manifest asks for
 * (SHO-518).
 *
 * `@shogo-ai/core` lists OpenTelemetry as *optional* peer dependencies, so a
 * plain `npm install @shogo-ai/core` installs none of them. The root entry is
 * the one entry the manifest promises will work after that install — a static
 * import of an optional peer anywhere reachable from `src/index.ts` turns
 * `require('@shogo-ai/core')` into MODULE_NOT_FOUND for every consumer, which
 * is exactly what the release gate caught. A *subpath* may need an optional
 * peer (`./instrumentation` does, and that is the documented contract); the
 * root barrel may not.
 *
 * This walks the barrel's export graph in the source tree, so a future
 * `export * from './something'` that drags a peer in fails in milliseconds here
 * instead of in the packed-tarball gate at release time.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const packageDir = resolve(import.meta.dir, '..', '..')
const srcDir = join(packageDir, 'src')

const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

/** Peers the manifest marks optional: `npm install <pkg>` does not install these. */
const optionalPeers = new Set(
  Object.entries(pkg.peerDependenciesMeta ?? {})
    .filter(([name, meta]) => meta?.optional === true && Boolean(pkg.peerDependencies?.[name]))
    .map(([name]) => name),
)

/**
 * `import … from 'x'`, `export … from 'x'` and side-effect `import 'x'`.
 * Dynamic `import('x')` is deliberately not matched: it runs only when the
 * caller asks for it, so it cannot break a bare import.
 */
function staticSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(
    /(?:^|\n)[ \t]*(?:import|export)[^'"();]*?from\s*['"]([^'"]+)['"]/g,
  )) {
    specifiers.push(match[1])
  }
  for (const match of source.matchAll(/(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g)) {
    specifiers.push(match[1])
  }
  return specifiers
}

/** Resolve a relative specifier to a file in `src/`, or null if it is external. */
function resolveModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(fromFile), specifier)
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Every module reachable from the root barrel by static import/export. */
function rootBarrelGraph(): { files: Set<string>; external: Map<string, string[]> } {
  const files = new Set<string>()
  const external = new Map<string, string[]>()
  const queue = [join(srcDir, 'index.ts')]

  while (queue.length > 0) {
    const file = queue.pop()!
    if (files.has(file)) continue
    files.add(file)

    for (const specifier of staticSpecifiers(readFileSync(file, 'utf8'))) {
      const resolved = resolveModule(file, specifier)
      if (resolved) {
        queue.push(resolved)
        continue
      }
      if (!specifier.startsWith('.')) {
        const importer = relative(packageDir, file)
        external.set(specifier, [...(external.get(specifier) ?? []), importer])
      }
    }
  }

  return { files, external }
}

const graph = rootBarrelGraph()
const reachable = [...graph.files].map((file) => relative(srcDir, file)).sort()

describe('@shogo-ai/core root barrel', () => {
  it('has optional peers to keep out of the root (guards the manifest shape)', () => {
    expect([...optionalPeers]).toContain('@opentelemetry/api')
  })

  it('does not statically reach any optional peer', () => {
    const problems: string[] = []
    for (const [specifier, importers] of graph.external) {
      if (optionalPeers.has(specifier)) {
        problems.push(`${specifier} is imported by ${importers.join(', ')}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('leaves ./instrumentation to its subpath', () => {
    // Re-adding it here would put every optional OpenTelemetry peer back in the
    // root entry. Do that only after the module stops importing them eagerly.
    expect(reachable).not.toContain('instrumentation.ts')
  })

  it('still re-exports every peer-free module', () => {
    expect(reachable).toEqual([
      'chat-message.ts',
      'file-types.ts',
      'index.ts',
      'logger.ts',
      'macos-junk.ts',
      'stream-buffer.ts',
      'stream-compaction.ts',
      'tech-stack-registry.ts',
    ])
  })
})
