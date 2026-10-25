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
