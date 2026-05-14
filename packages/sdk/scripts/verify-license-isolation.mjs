#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * verify-license-isolation
 *
 * The repo runs a split-license model documented in `docs/LICENSING.md`.
 * Three workspace packages are AGPL-3.0-or-later (the cloud-resale
 * moat):
 *
 *   @shogo/api               - apps/api/
 *   @shogo/agent-runtime     - packages/agent-runtime/
 *   @shogo/shared-runtime    - packages/shared-runtime/
 *
 * (`@shogo/canvas-runtime` is AGPL-licensed but unused; included
 * defensively in case it becomes a dependency.)
 *
 * The published `@shogo-ai/*` packages and most workspace dirs are MIT.
 * To prevent an AGPL leak — where any MIT package either declares an
 * AGPL dependency or `import`s one — this script enforces, for each
 * MIT scope, that:
 *
 *   1. Its `package.json` `dependencies` and `peerDependencies` contain
 *      no entries pointing at one of the AGPL workspace packages.
 *   2. No file under the scope's `srcRoots` contains an actual `import`
 *      / `require` statement targeting an AGPL package or a relative /
 *      absolute path into one of the AGPL source trees.
 *   3. Specific files declared in `EXEMPT_PATHS` are skipped — these
 *      are monorepo-only developer tools, never shipped to npm
 *      (`files` field in `package.json` confirms this).
 *
 * The check runs in both directions:
 *
 *   - Forward: every `@shogo-ai/*` published package.
 *   - Reverse: every newly-MIT workspace dir (`apps/mobile`,
 *     `apps/desktop`, `packages/shared-app`, etc.).
 *
 * Tarball-side checks (verifying the actual unpacked
 * `@shogo-ai/<pkg>@x.y.z.tgz` contents) live in
 * `.github/workflows/publish-sdk.yml`.
 *
 * Exit codes:
 *   0 — clean
 *   1 — leak detected (output identifies the file/line)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SDK_DIR = fileURLToPath(new URL('..', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * The set of AGPL-licensed workspace packages that no MIT scope may
 * depend on, import, or reach into via relative / absolute paths.
 *
 * Keep in sync with `docs/LICENSING.md`. When a new AGPL workspace
 * package is added, list it here and in the AGPL_PATH_FRAGMENTS array.
 */
const AGPL_PACKAGES = new Set([
  '@shogo/api',
  '@shogo/agent-runtime',
  '@shogo/shared-runtime',
  '@shogo/canvas-runtime',
])

/**
 * Path fragments that uniquely identify the AGPL source trees. A
 * relative or absolute import landing inside one of these trees from a
 * file outside it is treated as a leak just like a package-level
 * import would be.
 */
const AGPL_PATH_FRAGMENTS = [
  'apps/api/src',
  'packages/agent-runtime/src',
  'packages/shared-runtime/src',
  'packages/canvas-runtime/src',
]

/**
 * Each MIT scope to scan. `srcRoots` are subpaths inside the scope
 * that get walked for import-statement evidence. `exempt` lists
 * scope-relative file paths that are monorepo-only and not shipped
 * to npm — they may freely reference AGPL packages.
 */
const MIT_PACKAGES = [
  // Published @shogo-ai/* libraries.
  {
    name: '@shogo-ai/sdk',
    dir: join(REPO_ROOT, 'packages/sdk'),
    srcRoots: ['src', 'bin'],
    binAllowList: new Set(['bin/cli.mjs']),
    exempt: new Set(['bin/shogo.ts', 'bin/__tests__/shogo-cli.test.ts']),
  },
  {
    name: '@shogo-ai/core',
    dir: join(REPO_ROOT, 'packages/core'),
    srcRoots: ['src'],
    binAllowList: null,
    exempt: new Set(),
  },
  {
    name: '@shogo-ai/agent',
    dir: join(REPO_ROOT, 'packages/agent'),
    srcRoots: ['src'],
    binAllowList: null,
    exempt: new Set(),
  },
  {
    name: '@shogo-ai/db',
    dir: join(REPO_ROOT, 'packages/db'),
    srcRoots: ['src'],
    binAllowList: null,
    exempt: new Set(),
  },
  {
    name: '@shogo-ai/email',
    dir: join(REPO_ROOT, 'packages/email'),
    srcRoots: ['src'],
    binAllowList: null,
    exempt: new Set(),
  },
  {
    name: '@shogo-ai/voice',
    dir: join(REPO_ROOT, 'packages/voice'),
    srcRoots: ['src'],
    binAllowList: null,
    exempt: new Set(),
  },
  {
    name: '@shogo-ai/cli',
    dir: join(REPO_ROOT, 'packages/cli'),
    srcRoots: ['src'],
    binAllowList: null,
    exempt: new Set(),
  },
  {
    name: '@shogo-ai/worker',
    dir: join(REPO_ROOT, 'packages/shogo-worker'),
    srcRoots: ['src'],
    binAllowList: null,
    exempt: new Set(),
  },

  // Workspace-only MIT scopes (the bidirectional check). These were
  // flipped from AGPL to MIT in the 2026-05 relicense pass. They must
  // not import from AGPL packages either, otherwise consumers of the
  // MIT scope would transitively pull AGPL.
  {
    name: '@shogo/shared-app',
    dir: join(REPO_ROOT, 'packages/shared-app'),
    srcRoots: ['src'],
    binAllowList: null,
    exempt: new Set(),
  },
  {
    name: '@shogo/shared-ui',
    dir: join(REPO_ROOT, 'packages/shared-ui'),
    srcRoots: ['src'],
    binAllowList: null,
    exempt: new Set(),
  },
  {
    name: '@shogo/ui-kit',
    dir: join(REPO_ROOT, 'packages/ui-kit'),
    srcRoots: ['src'],
    binAllowList: null,
    exempt: new Set(),
  },
  {
    name: '@shogo/domain-stores',
    dir: join(REPO_ROOT, 'packages/domain-stores'),
    srcRoots: ['src'],
    binAllowList: null,
    exempt: new Set(),
  },
  {
    name: '@shogo/model-catalog',
    dir: join(REPO_ROOT, 'packages/model-catalog'),
    srcRoots: ['src'],
    binAllowList: null,
    exempt: new Set(),
  },
  {
    name: '@shogo/mobile',
    dir: join(REPO_ROOT, 'apps/mobile'),
    srcRoots: ['app', 'components', 'lib', 'hooks', 'contexts', 'scripts'],
    binAllowList: null,
    exempt: new Set(),
  },
  {
    name: 'shogo-desktop',
    dir: join(REPO_ROOT, 'apps/desktop'),
    srcRoots: ['src', 'scripts'],
    binAllowList: null,
    exempt: new Set(),
  },
]

const failures = []

/** Match real ES `import` / dynamic `import()` / CJS `require()` calls. */
const SOURCE_RE = new RegExp(
  [
    String.raw`\bimport\s+[^"'`+'`'+`]*\bfrom\s+['"]([^'"]+)['"]`,
    String.raw`\bimport\(\s*['"]([^'"]+)['"]\s*\)`,
    String.raw`\brequire\(\s*['"]([^'"]+)['"]\s*\)`,
    String.raw`\bimport\s+['"]([^'"]+)['"]`,
  ].join('|'),
)

for (const pkg of MIT_PACKAGES) {
  scanPackage(pkg)
}

if (failures.length === 0) {
  const names = MIT_PACKAGES.map((p) => p.name).join(', ')
  console.log(
    `[verify-license-isolation] OK — no AGPL imports or deps in ${MIT_PACKAGES.length} MIT scopes:\n  ${names}.`,
  )
  process.exit(0)
}

console.error(`[verify-license-isolation] LEAK detected — ${failures.length} issue(s):\n`)
for (const f of failures) {
  console.error(`  [${f.pkg}] ${f.file}`)
  console.error(`    ${f.kind}: ${f.evidence}`)
  console.error('')
}
console.error(
  `MIT scopes must not depend on AGPL workspace packages\n` +
  `(${[...AGPL_PACKAGES].join(', ')}).\n` +
  `Either lift the symbol into the relevant MIT package, switch to an\n` +
  `MIT alternative, or — if the dep is dev-time only — declare it in\n` +
  `devDependencies. See docs/LICENSING.md for the full strategy.\n`,
)
process.exit(1)

// ---------------------------------------------------------------------------

function scanPackage(pkg) {
  const pkgJsonPath = join(pkg.dir, 'package.json')
  let pkgJson
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  } catch {
    return
  }

  for (const field of ['dependencies', 'peerDependencies']) {
    const block = pkgJson[field] ?? {}
    for (const name of Object.keys(block)) {
      if (AGPL_PACKAGES.has(name)) {
        failures.push({
          pkg: pkg.name,
          file: relative(REPO_ROOT, pkgJsonPath),
          kind: `${field} entry`,
          evidence: `"${name}": "${block[name]}"`,
        })
      }
    }
  }

  for (const sub of pkg.srcRoots) {
    walk(join(pkg.dir, sub), (filePath) => {
      if (!/\.(?:ts|tsx|js|mjs|cjs|mts|cts|jsx)$/.test(filePath)) return
      const rel = relative(pkg.dir, filePath)
      if (pkg.exempt.has(rel)) return
      // For `bin/` roots, only scan files explicitly published.
      if (rel.startsWith('bin/') && pkg.binAllowList && !pkg.binAllowList.has(rel)) return

      const lines = readFileSync(filePath, 'utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const code = line.replace(/\/\/.*$/, '')
        const trimmed = code.trimStart()
        if (trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
        const match = code.match(SOURCE_RE)
        if (!match) continue
        const target = match[1] ?? match[2] ?? match[3] ?? match[4]
        if (!target) continue
        if (!isAgplTarget(target, filePath)) continue
        failures.push({
          pkg: pkg.name,
          file: relative(REPO_ROOT, filePath),
          kind: 'import statement',
          evidence: `${i + 1}: ${line.trim()}`,
        })
      }
    })
  }
}

function isAgplTarget(target, fromFile) {
  // 1) Bare specifier matching an AGPL package (or one of its subpaths).
  for (const pkg of AGPL_PACKAGES) {
    if (target === pkg) return true
    if (target.startsWith(`${pkg}/`)) return true
  }
  // 2) Path-shaped specifier resolving into an AGPL source tree.
  if (target.startsWith('./') || target.startsWith('../') || target.startsWith('/')) {
    let resolved
    try {
      resolved = relative(REPO_ROOT, join(fromFile, '..', target))
    } catch {
      return false
    }
    for (const frag of AGPL_PATH_FRAGMENTS) {
      if (resolved === frag || resolved.startsWith(`${frag}/`)) return true
    }
  }
  return false
}

function walk(dir, visit) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue
    if (name === '.next' || name === '.expo' || name === 'build') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      walk(full, visit)
    } else if (st.isFile()) {
      visit(full)
    }
  }
}

// SDK_DIR retained for compatibility with the old script lookup; keeps
// `bun run verify:license-isolation` working from the SDK package.
void SDK_DIR
