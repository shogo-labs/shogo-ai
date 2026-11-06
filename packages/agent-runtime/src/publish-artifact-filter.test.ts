// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The published build context (SHO-308 §2). The filter used to match only the
 * first path segment, so `apps/web/node_modules` shipped into the image and was
 * laid down before `bun install`; `.env` files shipped too. Both are the sort of
 * bug that only shows up in a real image, so they are pinned here.
 */
import { describe, expect, it } from 'bun:test'
import { createPublishedArtifactFilter } from './publish-artifact-filter'

const ROOT = '/work/project'
const filterFor = () => createPublishedArtifactFilter({ projectDir: ROOT, stagingDirName: '.publish-dist' })
const keep = (rel: string) => filterFor()(`${ROOT}/${rel}`)

describe('createPublishedArtifactFilter', () => {
  it('keeps the project source, including the Prisma schema and its dev.db', () => {
    expect(keep('server.tsx')).toBe(true)
    expect(keep('package.json')).toBe(true)
    expect(keep('prisma/schema.prisma')).toBe(true)
    expect(keep('prisma/dev.db')).toBe(true)
    expect(keep('src/App.tsx')).toBe(true)
  })

  it('drops the dependency, VCS and cache directories at the root', () => {
    for (const rel of ['node_modules', 'node_modules/react/index.js', '.git/HEAD', '.shogo/x', '.tmp/y', 'dist/index.html']) {
      expect(keep(rel)).toBe(false)
    }
  })

  it('drops node_modules and caches at ANY depth, not just the first segment', () => {
    expect(keep('apps/web/node_modules/lodash/index.js')).toBe(false)
    expect(keep('packages/api/node_modules/.bin/tsc')).toBe(false)
    expect(keep('apps/web/.next/server/page.js')).toBe(false)
    expect(keep('apps/web/.turbo/cache/x')).toBe(false)
    // A sibling package's own source still ships.
    expect(keep('apps/web/src/main.tsx')).toBe(true)
  })

  it('keeps a nested dist that the app itself builds, but never the staging output', () => {
    // Only the root `dist/` is the canvas preview build (path-prefixed), which
    // must not leak into a published bundle.
    expect(keep('dist/assets/index.js')).toBe(false)
    expect(keep('.publish-dist/index.html')).toBe(false)
    expect(keep('.publish-dist')).toBe(false)
  })

  it('drops env files and keeps the example', () => {
    expect(keep('.env')).toBe(false)
    expect(keep('.env.local')).toBe(false)
    expect(keep('apps/web/.env.production')).toBe(false)
    expect(keep('.env.example')).toBe(true)
    expect(keep('apps/web/.env.example')).toBe(true)
  })

  it('drops SQLite sidecar files so a mid-write WAL cannot be replayed', () => {
    expect(keep('prisma/dev.db-wal')).toBe(false)
    expect(keep('prisma/dev.db-shm')).toBe(false)
    expect(keep('prisma/dev.db')).toBe(true)
  })

  it('refuses anything outside the project directory', () => {
    const filter = filterFor()
    expect(filter('/work/other-project/src/index.ts')).toBe(false)
    expect(filter(ROOT)).toBe(true)
  })
})
