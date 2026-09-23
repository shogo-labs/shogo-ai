// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Packaging guard for the desktop local-mode API bundle.
 *
 *   bun test apps/api/src/lib/runtime/__tests__/local-bundle-integrity.test.ts
 *
 * The desktop ships `apps/api` as a single `bun build` artifact at
 * `resources/bundle/api.js` (see `apps/desktop/scripts/bundle-api.mjs`); no
 * TypeScript source tree is shipped alongside it.
 *
 * Cloud-only islands are kept out of that bundle with the idiom
 *
 *   if (process.env.SHOGO_LOCAL_MODE !== 'true') {
 *     mod = await import(new URL('./cloud-only.ts', import.meta.url).href)
 *   }
 *
 * `new URL(..., import.meta.url)` is opaque to the bundler, so the module is
 * never inlined. That is *only* safe because the build defines
 * SHOGO_LOCAL_MODE="true", which lets bun dead-code-eliminate the whole branch.
 *
 * If that idiom is used WITHOUT the guard — or on a module the desktop
 * actually needs — the import survives DCE and resolves at runtime against
 * `resources/bundle/`, where no `.ts` file exists. The packaged app throws
 *
 *   Cannot find module '<...>/resources/bundle/<mod>.ts' from '<...>/api.js'
 *
 * which surfaces to the user as a 500 from `/sandbox/url` ("couldn't reach
 * project's runtime"). Source checkouts never reproduce it, because there the
 * `.ts` file really is on disk.
 *
 * This builds the runtime manager the way packaging does and asserts the
 * invariant: zero surviving runtime-relative `.ts` imports.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..', '..')
const MANAGER_ENTRY = join(REPO_ROOT, 'apps/api/src/lib/runtime/manager.ts')

/** Mirrors EXTERNAL_PACKAGES in apps/desktop/scripts/bundle-api.mjs. */
const EXTERNAL_PACKAGES = [
  'electron',
  'playwright-core',
  '@playwright/mcp',
  '@prisma/client',
  'prisma',
  'prisma-adapter-bun-sqlite',
  'sqlite-vec',
  'typescript-language-server',
  'typescript',
  'pyright',
]

/**
 * Build the runtime manager the way `bundle-api.mjs` builds `api.js`.
 *
 * Shells out to `bun build` rather than calling `Bun.build()` in-process:
 * sibling suites in this directory use `mock.module()`, and a populated mock
 * registry makes in-process bundling fail to read the real files
 * ("Unexpected reading file: .../cloud-sync-watcher.ts"), silently emitting a
 * bundle with modules missing. A subprocess is isolated from that registry,
 * and it is also exactly what packaging does.
 */
function buildLocalModeBundle(outDir: string): string {
  const externals = EXTERNAL_PACKAGES.flatMap((pkg) => ['--external', pkg])
  const proc = Bun.spawnSync({
    cmd: [
      'bun',
      'build',
      MANAGER_ENTRY,
      '--target',
      'bun',
      '--outdir',
      outDir,
      '--define',
      'process.env.SHOGO_LOCAL_MODE="true"',
      ...externals,
    ],
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (proc.exitCode !== 0) {
    throw new Error(
      `bun build failed (exit ${proc.exitCode}):\n${proc.stderr.toString()}`
    )
  }
  return readFileSync(join(outDir, 'manager.js'), 'utf-8')
}

/**
 * Executable `new URL("./x.ts", import.meta.url)` specifiers left in the
 * emitted bundle. Bundler module banners (`// path/to/x.ts`) are comments and
 * deliberately excluded — those mean the module WAS inlined, which is good.
 */
function survivingRuntimeTsImports(bundle: string): string[] {
  const matches = bundle.matchAll(
    /new URL\(\s*["'](\.{1,2}\/[A-Za-z0-9._/-]*\.ts)["']\s*,\s*import\.meta\.url\s*\)/g
  )
  return [...new Set([...matches].map((m) => m[1]))].sort()
}

describe('desktop local-mode bundle integrity', () => {
  let outDir: string
  let bundle: string

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), 'shogo-bundle-integrity-'))
    bundle = buildLocalModeBundle(outDir)
  })

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true })
  })

  test('no runtime-relative .ts import survives dead-code elimination', () => {
    const surviving = survivingRuntimeTsImports(bundle)

    expect(
      surviving,
      surviving.length
        ? `These modules are imported via new URL(..., import.meta.url) but are ` +
          `NOT dead-code-eliminated in local mode, so they will not exist in ` +
          `resources/bundle/ at runtime: ${surviving.join(', ')}. Either import ` +
          `them with a static specifier (import('./x')) so the bundler inlines ` +
          `them, or gate them behind process.env.SHOGO_LOCAL_MODE !== 'true'.`
        : undefined
    ).toEqual([])
  })

  test('cloud-content-sync is inlined into the local bundle', () => {
    // Positive control: the desktop calls into cloud-content-sync on the
    // project-open path (isProjectCloudLinked / syncCloudProjectIntoDir /
    // isCloudSyncActive), so its implementation must actually ship.
    // Compare booleans, not the 2 MB bundle, so failures stay readable.
    const inlined = bundle.includes('apps/api/src/lib/runtime/cloud-content-sync.ts')
    const unresolvable = bundle.includes('new URL("./cloud-content-sync.ts"')

    expect(
      { inlined, unresolvable },
      'cloud-content-sync must be inlined into the desktop bundle, not ' +
        'imported at runtime from resources/bundle/cloud-content-sync.ts'
    ).toEqual({ inlined: true, unresolvable: false })
  })
})
