#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * verify-license-isolation
 *
 * The published `@shogo-ai/sdk` package is MIT. The other monorepo
 * packages (`@shogo/shared-runtime`, `@shogo/agent-runtime`,
 * `@shogo/shared-app`, `@shogo/domain-stores`, `@shogo/model-catalog`,
 * etc.) are AGPL-3.0-or-later. To prevent an AGPL leak — where the SDK
 * either declares an AGPL `dependency` or `import`s an AGPL package
 * from a published code path — this script enforces:
 *
 *   1. `packages/sdk/package.json` `dependencies` and `peerDependencies`
 *      contain no `@shogo/*` entries (only `@shogo-ai/*` is allowed,
 *      which is the SDK's own scope).
 *   2. No file under `packages/sdk/src/` or `packages/sdk/bin/cli.mjs`
 *      contains an actual `import` or `require` statement targeting
 *      `@shogo/*`. JSDoc/comment mentions are tolerated (they're useful
 *      provenance breadcrumbs for lifted modules).
 *   3. `packages/sdk/bin/shogo.ts` is exempt — it is a monorepo-only
 *      developer tool, never shipped to npm (`files` field in
 *      `package.json` confirms this).
 *
 * Tarball-side checks (verifying the actual unpacked
 * `@shogo-ai/sdk@x.y.z.tgz` contents) live in
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

/** Files exempt from the import-statement check (monorepo-only dev tools). */
const EXEMPT_PATHS = new Set([
  'bin/shogo.ts',
  'bin/__tests__/shogo-cli.test.ts',
])

const failures = []

// ---------------------------------------------------------------------------
// Check 1 — package.json dependencies / peerDependencies
// ---------------------------------------------------------------------------

const pkgJsonPath = join(SDK_DIR, 'package.json')
const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))

for (const field of ['dependencies', 'peerDependencies']) {
  const block = pkgJson[field] ?? {}
  for (const name of Object.keys(block)) {
    if (name.startsWith(FORBIDDEN_PREFIX) && !name.startsWith(ALLOWED_SCOPE)) {
      failures.push({
        file: relative(REPO_ROOT, pkgJsonPath),
        kind: `${field} entry`,
        evidence: `"${name}": "${block[name]}"`,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Check 2 — actual import/require statements in published code paths
// ---------------------------------------------------------------------------

/** Match real ES `import` / dynamic `import()` / CJS `require()` calls. */
const IMPORT_RE = new RegExp(
  [
    String.raw`\bimport\s+[^"'`+'`'+`]*\bfrom\s+['"](${escapeRe(FORBIDDEN_PREFIX)}[^'"]+)['"]`,
    String.raw`\bimport\(\s*['"](${escapeRe(FORBIDDEN_PREFIX)}[^'"]+)['"]\s*\)`,
    String.raw`\brequire\(\s*['"](${escapeRe(FORBIDDEN_PREFIX)}[^'"]+)['"]\s*\)`,
    // bare `import "foo"` side-effect form
    String.raw`\bimport\s+['"](${escapeRe(FORBIDDEN_PREFIX)}[^'"]+)['"]`,
  ].join('|'),
)

const SOURCE_ROOTS = [
  join(SDK_DIR, 'src'),
  join(SDK_DIR, 'bin'),
]

for (const root of SOURCE_ROOTS) {
  walk(root, (filePath) => {
    if (!/\.(?:ts|tsx|js|mjs|cjs|mts|cts)$/.test(filePath)) return
    const rel = relative(SDK_DIR, filePath)
    if (EXEMPT_PATHS.has(rel)) return
    // Only scan published binaries inside bin/
    if (rel.startsWith('bin/') && rel !== 'bin/cli.mjs') return

    const lines = readFileSync(filePath, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // Strip trailing line comments to avoid false positives.
      const code = line.replace(/\/\/.*$/, '')
      // Skip lines that are entirely inside a /* */ comment — cheap heuristic:
      // if the first non-whitespace chars are `*` or `/*`, treat as comment.
      const trimmed = code.trimStart()
      if (trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
      const match = code.match(IMPORT_RE)
      if (!match) continue
      const offending = match[1] ?? match[2] ?? match[3] ?? match[4]
      if (offending && offending.startsWith(ALLOWED_SCOPE)) continue
      failures.push({
        file: relative(REPO_ROOT, filePath),
        kind: 'import statement',
        evidence: `${i + 1}: ${line.trim()}`,
      })
    }
  })
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (failures.length === 0) {
  console.log(`[verify-license-isolation] OK — no @shogo/* imports or deps in published SDK paths.`)
  process.exit(0)
}

console.error(`[verify-license-isolation] LEAK detected — ${failures.length} issue(s):\n`)
for (const f of failures) {
  console.error(`  ${f.file}`)
  console.error(`    ${f.kind}: ${f.evidence}`)
  console.error('')
}
console.error(
  `The SDK is MIT and must not depend on AGPL-licensed @shogo/* packages.\n` +
  `Either lift the symbol into the SDK (under MIT) or stop importing it.\n` +
  `If you intentionally need the dep at dev time only, declare it in\n` +
  `devDependencies (not dependencies). See .cursor/plans/shogo-sdk-dogfood-roadmap*\n` +
  `§0.3 for the lift-and-thin-shim pattern.\n`,
)
process.exit(1)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
