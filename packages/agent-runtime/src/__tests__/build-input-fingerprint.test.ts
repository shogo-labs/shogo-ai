// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The canvas "Update available · Refresh" toast must fire only when a rebuild
// changed what is served. Vite stacks answer that from the build
// (`build-output-prune`); metro and static-build stacks cannot, because their
// emitters are not byte-stable between two runs over identical sources — two
// real `expo export` runs of an unchanged managed expo-app emitted different
// bundles and different hashed filenames. So those paths fingerprint the
// *inputs*. These cases pin that contract, including the writes an idle agent
// makes with nobody editing code.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  consumeBuildInputChange,
  fingerprintBuildInputs,
  shouldReloadForBuild,
} from '../build-input-fingerprint'

let ws: string

function write(relativePath: string, content: string) {
  const abs = join(ws, relativePath)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'build-input-fp-'))
  write('package.json', JSON.stringify({ name: 'app' }))
  write('app/index.tsx', 'export default function Index() { return null }\n')
  write('app.json', JSON.stringify({ expo: { name: 'app' } }))
})

afterEach(() => rmSync(ws, { recursive: true, force: true }))

describe('consumeBuildInputChange', () => {
  it('announces the first build, then stays quiet while nothing changes', () => {
    expect(consumeBuildInputChange(ws)).toBe(true)
    expect(consumeBuildInputChange(ws)).toBe(false)
    expect(consumeBuildInputChange(ws)).toBe(false)
  })

  it('treats a touched file as unchanged — mtime is not content', () => {
    consumeBuildInputChange(ws)
    const file = join(ws, 'app/index.tsx')
    const later = new Date(Date.now() + 60_000)
    utimesSync(file, later, later)
    expect(consumeBuildInputChange(ws)).toBe(false)
  })

  it('reports a real edit, and reports the revert too', () => {
    consumeBuildInputChange(ws)
    write('app/index.tsx', 'export default function Index() { return 1 }\n')
    expect(consumeBuildInputChange(ws)).toBe(true)
    expect(consumeBuildInputChange(ws)).toBe(false)
    write('app/index.tsx', 'export default function Index() { return null }\n')
    expect(consumeBuildInputChange(ws)).toBe(true)
  })

  it('reports files added and removed in the source tree', () => {
    consumeBuildInputChange(ws)
    write('src/components/New.tsx', 'export const New = 1\n')
    expect(consumeBuildInputChange(ws)).toBe(true)
    unlinkSync(join(ws, 'src/components/New.tsx'))
    expect(consumeBuildInputChange(ws)).toBe(true)
  })

  it('ignores what an idle agent writes — none of it is build input', () => {
    consumeBuildInputChange(ws)
    write('MEMORY.md', '# Memory\n\n- a note\n')
    write('memory/2026-10-25.md', '## daily\n')
    write('AGENTS.md', '# Agent\n')
    write('TOOLS.md', '# Tools\n')
    write('.shogo/plans/p.md', 'a plan\n')
    write('files/upload.png', 'not really a png\n')
    write('.memory-index.db-wal', 'wal\n')
    expect(consumeBuildInputChange(ws)).toBe(false)
  })

  it('ignores dependencies and build output', () => {
    consumeBuildInputChange(ws)
    write('node_modules/left-pad/index.js', 'module.exports = 1\n')
    write('dist/assets/index-AAAA.js', 'bundle\n')
    write('dist.staging/index.html', '<!doctype html>\n')
    write('dist-ios/index.html', '<!doctype html>\n')
    write('.expo/cache/blob', 'cache\n')
    expect(consumeBuildInputChange(ws)).toBe(false)
  })

  it('still reports a change when the build consumes a nested asset', () => {
    consumeBuildInputChange(ws)
    write('assets/logo.svg', '<svg></svg>\n')
    expect(consumeBuildInputChange(ws)).toBe(true)
    consumeBuildInputChange(ws)
    write('assets/logo.svg', '<svg width="1"></svg>\n')
    expect(consumeBuildInputChange(ws)).toBe(true)
  })

  it('ignores the running app\u2019s dev database — using the app must not arm the toast', () => {
    consumeBuildInputChange(ws)
    write('prisma/schema.prisma', 'datasource db {\n  provider = "sqlite"\n}\n')
    consumeBuildInputChange(ws)
    // The app is used: SQLite writes its WAL, SHM and journal.
    write('prisma/dev.db-wal', 'frame\n')
    write('prisma/dev.db-shm', 'shm\n')
    write('prisma/dev.db-journal', 'journal\n')
    expect(consumeBuildInputChange(ws)).toBe(false)
  })

  it('ignores agent scratch, editor state and OS droppings', () => {
    consumeBuildInputChange(ws)
    write('.tmp/probe-detected.ts', 'console.log(1)\n')
    write('.tmp/sho-200/apps/api/src/index.ts', 'scratch\n')
    write('.cursor/rules.md', 'editor\n')
    write('.DS_Store', 'dropping\n')
    write('app/.DS_Store', 'nested dropping\n')
    expect(consumeBuildInputChange(ws)).toBe(false)
  })

  it('ignores test edits — a test is not served', () => {
    consumeBuildInputChange(ws)
    write('e2e/local/foo.test.ts', 'test("x", () => {})\n')
    write('src/components/__tests__/Button.test.tsx', 'it("renders", () => {})\n')
    write('src/utils.spec.ts', 'describe("util", () => {})\n')
    expect(consumeBuildInputChange(ws)).toBe(false)
  })

  it('ignores a custom outDir when the caller names it', () => {
    // A `custom` static stack can build to `build/` instead of `dist/`, so the
    // caller passes the resolved plan outDir. Without it the build dirties its
    // own inputs and the gate can never suppress.
    write('app/index.tsx', 'export default () => null\n')
    const options = { ignore: ['build', 'dist.staging'] }
    expect(consumeBuildInputChange(ws, options)).toBe(true)
    write('build/index.html', '<!doctype html>\n')
    write('build/assets/index-AAAA.js', 'bundle\n')
    write('dist.staging/index.html', '<!doctype html>\n')
    expect(consumeBuildInputChange(ws, options)).toBe(false)
    // A second build writes different output into the same folder: still not an input.
    write('build/assets/index-BBBB.js', 'bundle 2\n')
    expect(consumeBuildInputChange(ws, options)).toBe(false)
    // But a source edit still is.
    write('app/index.tsx', 'export default () => 1\n')
    expect(consumeBuildInputChange(ws, options)).toBe(true)
  })

  it('counts a folder that looks like output but was not declared', () => {
    // Documents the trade-off: ignoring is caller-driven, so a build writing to
    // an undeclared directory still flips the gate — loudly, not silently.
    consumeBuildInputChange(ws)
    write('build/index.html', '<!doctype html>\n')
    expect(consumeBuildInputChange(ws)).toBe(true)
  })

  it('reports a workspace with nothing to hash as changed', () => {
    const empty = mkdtempSync(join(tmpdir(), 'build-input-empty-'))
    try {
      expect(fingerprintBuildInputs(empty)).toBeNull()
      expect(consumeBuildInputChange(empty)).toBe(true)
      expect(consumeBuildInputChange(empty)).toBe(true)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('keeps one answer per workspace', () => {
    const other = mkdtempSync(join(tmpdir(), 'build-input-other-'))
    try {
      writeFileSync(join(other, 'app.tsx'), 'export const a = 1\n')
      consumeBuildInputChange(ws)
      expect(consumeBuildInputChange(other)).toBe(true)
      expect(consumeBuildInputChange(other)).toBe(false)
      // ws is untouched by the other workspace's bookkeeping.
      expect(consumeBuildInputChange(ws)).toBe(false)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('shouldReloadForBuild', () => {
  it('reloads unless the build says the output did not change', () => {
    expect(shouldReloadForBuild({ outputChanged: true })).toBe(true)
    expect(shouldReloadForBuild({ outputChanged: false })).toBe(false)
    // A build path that says nothing must not be able to hide a real update.
    expect(shouldReloadForBuild(undefined)).toBe(true)
    expect(shouldReloadForBuild({})).toBe(true)
  })
})
