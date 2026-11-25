// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The published Dockerfile is a string, not a file on disk, so the repo-wide
 * Bun-pin guard (`scripts/__tests__/bun-version-pins.test.ts`) never sees it —
 * which is how it shipped on Bun 1.1 while every real Dockerfile had moved to
 * 1.4. QA caught it as a failed `bun install --frozen-lockfile`: a lockfile
 * written on macOS has no Linux optional deps for a Bun that old, so the
 * install (and therefore the publish) failed at build time. Pin it here.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  PUBLISHED_BASE_IMAGE,
  PUBLISHED_BUN_VERSION,
  publishedDockerfile,
} from '../published-dockerfile'

const repoPackageManager: string = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../../../package.json'), 'utf-8'),
).packageManager

const pinnedBun = repoPackageManager.replace(/^bun@/, '')

describe('publishedDockerfile', () => {
  it('builds from the same Bun the repo pins in packageManager', () => {
    expect(pinnedBun).toMatch(/^\d+\.\d+\.\d+$/)
    expect(PUBLISHED_BUN_VERSION).toBe(pinnedBun)
    expect(PUBLISHED_BASE_IMAGE).toBe(`oven/bun:${pinnedBun}-debian`)
  })

  it('never builds from a floating or EOL base tag', () => {
    expect(PUBLISHED_BASE_IMAGE).not.toMatch(/:latest$|:1\.\d+-slim$/)
    expect(publishedDockerfile().match(/^FROM .*/m)?.[0]).toBe(`FROM ${PUBLISHED_BASE_IMAGE}`)
  })

  it('installs dependencies only when a lockfile exists, and recovers a stale one', () => {
    const install = publishedDockerfile()
      .split('\n')
      .find((line) => line.startsWith('RUN ') && line.includes('bun install'))
    expect(install).toContain('bun install --production --frozen-lockfile')
    // A stale lockfile resolves from the manifest instead of failing the publish.
    expect(install).toContain('elif ! bun install --production --frozen-lockfile')
  })

  it('removes the stale lockfile before recovering, because --production is frozen too', () => {
    const install = publishedDockerfile()
      .split('\n')
      .find((line) => line.startsWith('RUN ') && line.includes('bun install'))!

    // Bun 1.4.4 treats `--production` as implicitly frozen once a lockfile
    // exists, so the recovery only works if the stale file is gone first.
    const rmAt = install.indexOf('rm -f bun.lock bun.lockb')
    const recoveryAt = install.indexOf('bun install --production; fi')
    expect(rmAt).toBeGreaterThan(-1)
    expect(recoveryAt).toBeGreaterThan(rmAt)

    // The frozen attempt still comes first, so a matching lockfile is honoured.
    expect(install.indexOf('--frozen-lockfile')).toBeLessThan(rmAt)
  })

  it('bakes the prebuilt marker so the pod skips install and build', () => {
    const text = publishedDockerfile()
    expect(text).toContain('ENV SHOGO_PREBUILT_IMAGE=true')
    expect(text).not.toMatch(/\bvite build\b|\bexpo export\b/)
  })

  it('runs as non-root and exposes the published port', () => {
    const text = publishedDockerfile()
    expect(text).toContain('USER bun')
    expect(text).toContain('ENV PORT=3000')
    expect(text).toContain('CMD ["bun", "server.tsx"]')
  })
})
