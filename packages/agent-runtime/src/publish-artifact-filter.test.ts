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

// ---------------------------------------------------------------------------
// Large media stays out of the artifact (SHO-485 §2a)
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  PUBLISH_DIST_OFFLOAD_MIN_BYTES,
  artifactPointerTargets,
  offloadArtifactMedia,
} from './publish-artifact-filter'

describe('artifactPointerTargets', () => {
  const sizes = new Map<string, number>([
    ['src/hero.mp4', 400 * 1024 * 1024],
    ['src/small.png', 2048],
    ['dist/assets/hero-abc123.mp4', 400 * 1024 * 1024],
    ['dist/logo.png', 1024],
    ['dist/app.js', 900 * 1024],
    ['dist/big.html', PUBLISH_DIST_OFFLOAD_MIN_BYTES * 2],
  ])
  const paths = [...sizes.keys()]

  it('keeps every LFS-tracked source path, whatever its size', () => {
    const targets = artifactPointerTargets({ paths, lfsTracked: new Set(['src/hero.mp4', 'src/small.png']), sizes })
    expect(targets).toContain('src/hero.mp4')
    // A tracked file below the dist threshold still leaves: the bytes are in the
    // store, so the image does not need them twice.
    expect(targets).toContain('src/small.png')
  })

  it('keeps dist files at or above 5 MiB out, whether public/ copied or hashed', () => {
    const targets = artifactPointerTargets({ paths, lfsTracked: new Set(), sizes })
    expect(targets).toEqual(['dist/assets/hero-abc123.mp4'])
  })

  it('leaves small dist files and HTML in the artifact', () => {
    const targets = artifactPointerTargets({ paths, lfsTracked: new Set(), sizes })
    expect(targets).not.toContain('dist/logo.png')
    expect(targets).not.toContain('dist/app.js')
    // HTML is the one file the runtime must read to inject its bridge.
    expect(targets).not.toContain('dist/big.html')
  })

  it('is a no-op for a project with no LFS and nothing over the threshold', () => {
    const small = new Map([['dist/a.png', 1000], ['src/App.tsx', 400]])
    expect(artifactPointerTargets({ paths: [...small.keys()], lfsTracked: new Set(), sizes: small })).toEqual([])
  })
})

/**
 * The real offload, against a real git repo (that is what decides what is
 * LFS-tracked) and a fake object store. The invariant it pins: after it runs,
 * every pointer in the context is backed by an object, or the publish failed
 * with a name.
 */
describe('offloadArtifactMedia', () => {
  let dir: string
  const fakeStore = () => {
    const objects = new Map<string, Buffer>()
    const commands: string[] = []
    return {
      objects,
      commands,
      store: {
        bucket: 'workspaces',
        client: {
          async send(command: any) {
            const name = command.constructor.name
            commands.push(name)
            if (name === 'HeadObjectCommand') {
              if (!objects.has(command.input.Key)) {
                const err: any = new Error('NotFound')
                err.name = 'NotFound'
                err.$metadata = { httpStatusCode: 404 }
                throw err
              }
              return {}
            }
            if (name === 'PutObjectCommand') {
              objects.set(command.input.Key, Buffer.from(command.input.Body))
              return { ETag: '"x"' }
            }
            return {}
          },
        },
      },
    }
  }

  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })

  const seed = () => {
    dir = mkdtempSync(join(tmpdir(), 'shogo-offload-'))
    git(['init', '--quiet'])
    writeFileSync(join(dir, '.gitattributes'), '*.mp4 filter=lfs diff=lfs merge=lfs -text\n')
    writeFileSync(join(dir, 'README.md'), '# demo\n')
    writeFileSync(join(dir, 'clip.mp4'), Buffer.alloc(3000, 7))
    mkdirSync(join(dir, 'dist', 'assets'), { recursive: true })
    writeFileSync(join(dir, 'dist', 'assets', 'big.mp4'), Buffer.alloc(PUBLISH_DIST_OFFLOAD_MIN_BYTES + 16, 9))
    writeFileSync(join(dir, 'dist', 'app.js'), 'console.log(1)\n')
  }

  it('replaces LFS source files and big dist files with pointer text, after storing the bytes', async () => {
    seed()
    const { store, objects } = fakeStore()
    try {
      const result = await offloadArtifactMedia({
        contextDir: dir,
        sourceDir: dir,
        projectId: 'proj-1',
        store,
        logger: { log: () => {}, warn: () => {} },
      })

      const clip = readFileSync(join(dir, 'clip.mp4'), 'utf-8')
      expect(clip).toContain('version https://git-lfs.github.com/spec/v1')
      const oid = createHash('sha256').update(Buffer.alloc(3000, 7)).digest('hex')
      expect(clip).toContain(`oid sha256:${oid}`)
      expect(clip).toContain('size 3000')

      const bigDist = readFileSync(join(dir, 'dist', 'assets', 'big.mp4'), 'utf-8')
      expect(bigDist).toContain('version https://git-lfs.github.com/spec/v1')

      // Both objects are durable, under the project's LFS namespace.
      expect(objects.has(`proj-1/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`)).toBe(true)
      expect([...objects.keys()].filter((k) => k.startsWith('proj-1/lfs/objects/')).length).toBe(2)
      expect(result.pointers).toBe(2)
      expect(result.uploaded).toBe(2)
      expect(result.bytesLeftOut).toBe(3000 + PUBLISH_DIST_OFFLOAD_MIN_BYTES + 16)

      // Untouched files stay real.
      expect(readFileSync(join(dir, 'README.md'), 'utf-8')).toBe('# demo\n')
      expect(readFileSync(join(dir, 'dist', 'app.js'), 'utf-8')).toBe('console.log(1)\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reuses an object the store already has instead of re-uploading it', async () => {
    seed()
    const { store, objects, commands } = fakeStore()
    const oid = createHash('sha256').update(Buffer.alloc(3000, 7)).digest('hex')
    objects.set(`proj-1/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`, Buffer.alloc(0))
    try {
      const result = await offloadArtifactMedia({
        contextDir: dir,
        sourceDir: dir,
        projectId: 'proj-1',
        store,
        logger: { log: () => {}, warn: () => {} },
      })
      expect(result.reused).toBe(1)
      // Only the dist object needed a write.
      expect(commands.filter((c) => c === 'PutObjectCommand').length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails with a named error rather than ship a pointer with no bytes behind it', async () => {
    seed()
    const broken = {
      bucket: 'workspaces',
      client: {
        async send(command: any) {
          if (command.constructor.name === 'HeadObjectCommand') {
            const err: any = new Error('NotFound')
            err.name = 'NotFound'
            err.$metadata = { httpStatusCode: 404 }
            throw err
          }
          throw new Error('AccessDenied')
        },
      },
    }
    try {
      await expect(
        offloadArtifactMedia({
          contextDir: dir,
          sourceDir: dir,
          projectId: 'proj-1',
          store: broken,
          logger: { log: () => {}, warn: () => {} },
        }),
      ).rejects.toThrow(/lfs_object_missing/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
