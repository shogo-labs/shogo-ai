#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * verify-license-isolation
 *
 * The published `@shogo-ai/*` packages (`sdk`, `core`, `agent`, `db`,
 * `email`, `voice`, `cli`, `diagnostics`, `lsp`) are MIT-licensed. The
 * other monorepo packages (`@shogo/shared-runtime`,
 * `@shogo/agent-runtime`, `@shogo/shared-app`, `@shogo/domain-stores`,
 * etc.) are AGPL-3.0-or-later. To prevent an AGPL leak — where any MIT
 * package either declares an AGPL `dependency` or `import`s an AGPL
 * package from a published code path — this script enforces, for each
 * MIT package:
 *
 *   1. Its `package.json` `dependencies` and `peerDependencies` contain
 *      no `@shogo/*` entries (only `@shogo-ai/*` is allowed, which is
 *      our own MIT scope).
 *   2. No file under the package's `src/` (and `bin/` for the SDK)
 *      contains an actual `import` / `require` statement targeting
 *      `@shogo/*`. JSDoc/comment mentions are tolerated.
 *   3. Specific files declared in `EXEMPT_PATHS` are skipped — these
 *      are monorepo-only developer tools, never shipped to npm
 *      (`files` field in `package.json` confirms this).
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

const FORBIDDEN_PREFIX = '@shogo/'
const ALLOWED_SCOPE = '@shogo-ai/'

/**
 * Each MIT package to scan. `srcRoots` are subpaths inside the package
 * that get walked for import-statement evidence. `exempt` lists
 * package-relative file paths that are monorepo-only and not shipped
 * to npm — they may freely reference `@shogo/*`.
 */
const MIT_PACKAGES = [
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
]

const failures = []

/** Match real ES `import` / dynamic `import()` / CJS `require()` calls. */
const IMPORT_RE = new RegExp(
  [
    String.raw`\bimport\s+[^"'`+'`'+`]*\bfrom\s+['"](${escapeRe(FORBIDDEN_PREFIX)}[^'"]+)['"]`,
    String.raw`\bimport\(\s*['"](${escapeRe(FORBIDDEN_PREFIX)}[^'"]+)['"]\s*\)`,
    String.raw`\brequire\(\s*['"](${escapeRe(FORBIDDEN_PREFIX)}[^'"]+)['"]\s*\)`,
    String.raw`\bimport\s+['"](${escapeRe(FORBIDDEN_PREFIX)}[^'"]+)['"]`,
  ].join('|'),
)

for (const pkg of MIT_PACKAGES) {
  scanPackage(pkg)
}

if (failures.length === 0) {
  const names = MIT_PACKAGES.map((p) => p.name).join(', ')
  console.log(`[verify-license-isolation] OK — no @shogo/* imports or deps in: ${names}.`)
  process.exit(0)
}

console.error(`[verify-license-isolation] LEAK detected — ${failures.length} issue(s):\n`)
for (const f of failures) {
  console.error(`  [${f.pkg}] ${f.file}`)
  console.error(`    ${f.kind}: ${f.evidence}`)
  console.error('')
}
console.error(
  `The MIT @shogo-ai/* packages must not depend on AGPL @shogo/* packages.\n` +
  `Either lift the symbol into the relevant MIT package, or stop importing\n` +
  `it. If you need the dep at dev time only, declare it in devDependencies\n` +
  `(not dependencies). See packages/sdk/DEVELOPING.md for the lift pattern.\n`,
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
      if (name.startsWith(FORBIDDEN_PREFIX) && !name.startsWith(ALLOWED_SCOPE)) {
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
      if (!/\.(?:ts|tsx|js|mjs|cjs|mts|cts)$/.test(filePath)) return
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
        const match = code.match(IMPORT_RE)
        if (!match) continue
        const offending = match[1] ?? match[2] ?? match[3] ?? match[4]
        if (offending && offending.startsWith(ALLOWED_SCOPE)) continue
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

function walk(dir, visit) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      walk(full, visit)
    } else if (st.isFile()) {
      visit(full)
    }
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// SDK_DIR retained for compatibility with the old script lookup; keeps
// `bun run verify:license-isolation` working from the SDK package.
void SDK_DIR
