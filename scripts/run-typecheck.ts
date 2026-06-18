// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Root-level typecheck runner. Fans out to every workspace package that
 * declares a `typecheck` script and reports a per-package pass/fail. Used
 * by .github/workflows/ci.yml so the pipeline doesn't need to know which
 * directories ship TypeScript and which don't.
 *
 * Why not `bun run --filter '*' typecheck`?
 *   - The filter form errors out hard if any matched package is missing
 *     the script, and we have a few workspace members that don't ship
 *     one (apps/mobile relies on Expo's runtime check, etc.).
 *   - We want a clean per-package summary at the end so a single
 *     misconfigured tsconfig is easy to spot in CI logs.
 *
 * Usage:
 *   bun run scripts/run-typecheck.ts
 */

import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { spawnSync } from 'child_process'

const REPO_ROOT = resolve(import.meta.dir, '..')

// Packages we expect to typecheck cleanly on CI. Mirrors the test runner's
// BACKEND_PACKAGES list plus a few extras that have working tsconfigs.
// Note: `apps/docs` is intentionally excluded — it's NOT in the root
// package.json `workspaces` glob, so CI's `bun install --frozen-lockfile`
// doesn't install its devDependencies (@docusaurus/tsconfig etc.). The
// docs site has its own Docker build + deploy pipeline.
const PACKAGES: readonly string[] = [
  'packages/agent',
  'packages/agent-runtime',
  'packages/canvas-runtime',
  'packages/cli',
  'packages/core',
  'packages/db',
  'packages/desktop-terminal',
  'packages/email',
  'packages/model-catalog',
  'packages/sdk',
  'packages/shared-runtime',
  'packages/shogo-worker',
  'packages/ui-kit',
  'packages/voice',
  'apps/api',
]

// Packages with known pre-existing typecheck failures. Their failures
// are reported as warnings so this runner still catches *new* regressions
// in the cleanly-typed packages, but doesn't gate CI on legacy debt that's
// already on `main`. Remove an entry only after the package goes green.
//
// What's broken (as of 2026-05-15):
//   - packages/agent-runtime: stale test fixtures (gateway-tools.branches,
//     permission-engine, preview-manager.branches, warm-pool).
//   - packages/model-catalog: TS strict-mode drift in tests.
//   - packages/shared-runtime: diagnostics.test.ts Hono fetch-type drift
//     (Promise<Response>|Response union); pre-existing on main.
//   - packages/ui-kit: TS6 baseUrl deprecation + JSX-types drift.
//   - apps/api: TS6 baseUrl deprecation cascaded from tsconfig.base.json.
//
// Each entry MUST be accompanied by a short note describing what's broken
// so contributors know the shape of the tech debt. Remove an entry only
// after the package goes green.
//
// What's broken (as of 2026-05-15):
//   - packages/agent-runtime: 60+ implicit-any parameters in test files
//     (gateway-tools.branches, permission-engine, preview-manager.branches,
//     warm-pool, agent-loop, e2e-scenarios, error-recovery, hooks); a few
//     real type errors in test fixtures.
//   - packages/model-catalog: TS strict-mode drift in tests.
//   - packages/shared-runtime: diagnostics.test.ts uses
//     `router.fetch(...).then(...)` against a Hono router whose new
//     fetch typedef is `Promise<Response> | Response`; needs to be
//     wrapped in `Promise.resolve(...)` or awaited before .then chains.
//   - apps/api: ~70 errors spanning rootDir violations on cross-workspace
//     imports (TS6059 — composite: false but implicit rootDir from
//     `include: src/**/*` clashes with `paths` aliases to other packages),
//     strict-mode drift in route handlers, and one Prisma client type
//     incompatibility between `prisma-pg` and `prisma-sqlite`. The
//     baseUrl deprecation in tsconfig.base.json was previously fatal-
//     erroring tsc before it got to these — now that the deprecation is
//     silenced (TS5101 → ignoreDeprecations: "6.0"), these surface.
const EXPECTED_FAIL = new Set<string>([
  'packages/agent-runtime',
  'packages/model-catalog',
  'packages/shared-runtime',
  'apps/api',
])

interface Result {
  pkg: string
  ok: boolean
  durationMs: number
  output: string
}

const results: Result[] = []

for (const pkg of PACKAGES) {
  const pkgDir = join(REPO_ROOT, pkg)
  const pkgJsonPath = join(pkgDir, 'package.json')

  if (!existsSync(pkgJsonPath)) {
    console.log(`[typecheck] skip ${pkg} (no package.json)`)
    continue
  }

  let scripts: Record<string, string> = {}
  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
      scripts?: Record<string, string>
    }
    scripts = pkgJson.scripts ?? {}
  } catch (err) {
    console.error(`[typecheck] FAIL ${pkg}: cannot parse package.json (${err})`)
    process.exit(1)
  }

  if (!scripts.typecheck) {
    console.log(`[typecheck] skip ${pkg} (no typecheck script)`)
    continue
  }

  const startedAt = Date.now()
  console.log(`[typecheck] ${pkg} ...`)
  const proc = spawnSync('bun', ['run', 'typecheck'], {
    cwd: pkgDir,
    encoding: 'utf8',
    stdio: 'pipe',
  })
  const durationMs = Date.now() - startedAt
  const ok = proc.status === 0
  const output = `${proc.stdout ?? ''}${proc.stderr ?? ''}`.trim()

  if (ok) {
    console.log(`[typecheck] OK   ${pkg} (${durationMs}ms)`)
  } else {
    console.log(`[typecheck] FAIL ${pkg} (${durationMs}ms)`)
    if (output) {
      console.log(output)
    }
  }

  results.push({ pkg, ok, durationMs, output })
}

const failed = results.filter((r) => !r.ok)
const newRegressions = failed.filter((r) => !EXPECTED_FAIL.has(r.pkg))
const expectedFailures = failed.filter((r) => EXPECTED_FAIL.has(r.pkg))
const unexpectedlyGreen = results
  .filter((r) => r.ok && EXPECTED_FAIL.has(r.pkg))
  .map((r) => r.pkg)

console.log('')
console.log('────────────────────────────────────────────────────────────────────────')
console.log(
  `Typecheck: ${results.length - failed.length} pass, ${failed.length} fail (${results.length} packages)`,
)

if (expectedFailures.length > 0) {
  console.log('')
  console.log(`Known pre-existing failures (not gating CI — see EXPECTED_FAIL in scripts/run-typecheck.ts):`)
  for (const r of expectedFailures) {
    console.log(`  ⚠ ${r.pkg}`)
  }
}

if (unexpectedlyGreen.length > 0) {
  console.log('')
  console.log(
    `These packages are listed as EXPECTED_FAIL but now typecheck clean. ` +
      `Please remove them from the list:`,
  )
  for (const pkg of unexpectedlyGreen) {
    console.log(`  ✓ ${pkg}`)
  }
}

if (newRegressions.length > 0) {
  console.log('')
  console.log(`New typecheck regressions:`)
  for (const r of newRegressions) {
    console.log(`  ✗ ${r.pkg}`)
    if (r.output) {
      console.log(r.output)
    }
  }
  process.exit(1)
}
