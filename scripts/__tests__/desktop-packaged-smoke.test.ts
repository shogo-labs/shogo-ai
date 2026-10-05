// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { MIN_BUNDLED_BUN, apiPortFromLog, versionAtLeast } from '../ci/desktop-packaged-smoke'

describe('apiPortFromLog', () => {
  it('reads the API port the packaged app announced (the last one wins after a restart)', () => {
    const log = [
      '[Desktop] Port 39100 is in use, using port 39101 instead',
      '[Desktop] Ports: API=39101, RuntimeBase=39110',
      '[Desktop] API server is healthy',
      '[Desktop] Ports: API=39102, RuntimeBase=39110',
    ].join('\n')
    expect(apiPortFromLog(log)).toBe(39102)
    expect(apiPortFromLog('[Desktop] API server is healthy')).toBeNull()
  })

  it('matches the line the desktop main process actually logs', () => {
    const src = readFileSync(join(import.meta.dir, '../../apps/desktop/src/local-server.ts'), 'utf-8')
    expect(src).toContain('console.log(`[Desktop] Ports: API=${apiPort}, RuntimeBase=${RUNTIME_BASE_PORT}`)')
  })
})

describe('versionAtLeast', () => {
  it('compares dotted versions numerically, ignoring prerelease/build suffixes', () => {
    expect(versionAtLeast('1.4.2', MIN_BUNDLED_BUN)).toBe(true)
    expect(versionAtLeast('1.4.0', MIN_BUNDLED_BUN)).toBe(true)
    expect(versionAtLeast('1.10.0', MIN_BUNDLED_BUN)).toBe(true)
    expect(versionAtLeast('2.0.0\n', MIN_BUNDLED_BUN)).toBe(true)
    expect(versionAtLeast('1.3.11', MIN_BUNDLED_BUN)).toBe(false)
    expect(versionAtLeast('1.3.99-canary.1', MIN_BUNDLED_BUN)).toBe(false)
    expect(versionAtLeast('', MIN_BUNDLED_BUN)).toBe(false)
  })

  it('the CI Bun pin (which the desktop bundles) meets the minimum', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf-8'))
    const pinned = String(pkg.packageManager).replace(/^bun@/, '')
    expect(versionAtLeast(pinned, MIN_BUNDLED_BUN)).toBe(true)
  })
})
