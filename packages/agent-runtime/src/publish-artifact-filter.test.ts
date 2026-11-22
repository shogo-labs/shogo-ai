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
  measureDockerignoreExclusion,
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
 * The project's own `.dockerignore` (SHO-514).
 *
 * This IS a Docker build context (`COPY . /app`), so a project's existing rules
 * have to be honoured — otherwise the file it maintains is silently ignored and
 * the image carries what the author meant to leave out. The direction matters:
 * `.dockerignore` may only remove paths, never re-add the secrets and platform
 * files this filter already decided.
 */
describe('createPublishedArtifactFilter + .dockerignore', () => {
  const withIgnoreFile = (body: string, run: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'shogo-dockerignore-'))
    try {
      writeFileSync(join(dir, '.dockerignore'), body)
      run(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const keepIn = (dir: string, rel: string) =>
    createPublishedArtifactFilter({ projectDir: dir, stagingDirName: '.publish-dist' })(join(dir, rel))

  it('drops what the project excludes and keeps the rest', () => {
    withIgnoreFile('docs/\n*.md\ncoverage\n', (dir) => {
      expect(keepIn(dir, 'docs/guide.md')).toBe(false)
      expect(keepIn(dir, 'README.md')).toBe(false)
      expect(keepIn(dir, 'coverage/lcov.info')).toBe(false)
      expect(keepIn(dir, 'src/App.tsx')).toBe(true)
      expect(keepIn(dir, 'server.tsx')).toBe(true)
    })
  })

  it('cannot bring back a hard exclusion (secrets, node_modules, sidecar files)', () => {
    withIgnoreFile('!.env\n!node_modules\n!prisma/dev.db-wal\n', (dir) => {
      expect(keepIn(dir, '.env')).toBe(false)
      expect(keepIn(dir, 'node_modules/react/index.js')).toBe(false)
      expect(keepIn(dir, 'apps/web/node_modules/lodash/index.js')).toBe(false)
      expect(keepIn(dir, 'prisma/dev.db-wal')).toBe(false)
    })
  })

  it('cannot exclude the files the published image boots from', () => {
    withIgnoreFile('prisma/\npackage.json\nbun.lock\n', (dir) => {
      expect(keepIn(dir, 'prisma/schema.prisma')).toBe(true)
      expect(keepIn(dir, 'prisma/dev.db')).toBe(true)
      expect(keepIn(dir, 'package.json')).toBe(true)
      expect(keepIn(dir, 'bun.lock')).toBe(true)
      // The rest of `prisma/` still follows the rule.
      expect(keepIn(dir, 'prisma/seed.ts')).toBe(false)
    })
  })

  it('survives a blanket "*" rule with the files the image needs', () => {
    // `*` is what a project writes when it means "ship nothing but what Docker
    // copies explicitly" — the exact file that would otherwise blank an image.
    withIgnoreFile('*\n', (dir) => {
      expect(keepIn(dir, 'src/App.tsx')).toBe(false)
      expect(keepIn(dir, 'server.tsx')).toBe(false)
      expect(keepIn(dir, 'package.json')).toBe(true)
      expect(keepIn(dir, 'prisma/schema.prisma')).toBe(true)
      expect(keepIn(dir, 'prisma/dev.db')).toBe(true)
    })
  })

  it('never ships .dockerignore itself, since BuildKit would apply it twice', () => {
    withIgnoreFile('docs/\n', (dir) => {
      expect(keepIn(dir, '.dockerignore')).toBe(false)
    })
  })

  it('is exactly today\'s filter when the project has no .dockerignore', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shogo-dockerignore-none-'))
    try {
      expect(keepIn(dir, 'src/App.tsx')).toBe(true)
      expect(keepIn(dir, 'node_modules/x/index.js')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports how much the project is leaving out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shogo-dockerignore-measure-'))
    try {
      writeFileSync(join(dir, '.dockerignore'), 'docs/\n')
      mkdirSync(join(dir, 'docs', 'nested'), { recursive: true })
      writeFileSync(join(dir, 'docs/a.md'), 'aaaa')
      writeFileSync(join(dir, 'docs/nested/b.md'), 'bbbbbb')
      writeFileSync(join(dir, 'src.txt'), 'kept')
      const measured = measureDockerignoreExclusion({ projectDir: dir, stagingDirName: '.publish-dist' })
      expect(measured.paths).toBe(2)
      expect(measured.bytes).toBe(10)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
  type StoredObject = { body: Buffer; contentType?: string; cacheControl?: string }
  const fakeStore = () => {
    const objects = new Map<string, StoredObject>()
    const commands: string[] = []
    const notFound = () => {
      const err: any = new Error('NotFound')
      err.name = 'NotFound'
      err.$metadata = { httpStatusCode: 404 }
      return err
    }
    return {
      objects,
      commands,
      store: {
        bucket: 'workspaces',
        client: {
          async send(command: any) {
            const name = command.constructor.name
            commands.push(name)
            const key = command.input.Key
            if (name === 'HeadObjectCommand') {
              const stored = objects.get(key)
              if (!stored) throw notFound()
              return {
                ContentLength: stored.body.length,
                ContentType: stored.contentType,
                CacheControl: stored.cacheControl,
              }
            }
            if (name === 'PutObjectCommand') {
              objects.set(key, {
                body: Buffer.from(command.input.Body),
                contentType: command.input.ContentType,
                cacheControl: command.input.CacheControl,
              })
              return { ETag: '"x"' }
            }
            if (name === 'CopyObjectCommand') {
              const stored = objects.get(key)
              if (!stored) throw notFound()
              objects.set(key, {
                body: stored.body,
                contentType: command.input.ContentType,
                cacheControl: command.input.CacheControl,
              })
              return {}
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
    objects.set(`proj-1/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`, {
      body: Buffer.alloc(0),
      contentType: 'video/mp4',
      cacheControl: 'no-cache',
    })
    try {
      const result = await offloadArtifactMedia({
        contextDir: dir,
        sourceDir: dir,
        projectId: 'proj-1',
        store,
        logger: { log: () => {}, warn: () => {} },
      })
      expect(result.reused).toBe(1)
      expect(result.restamped).toBe(0)
      // Only the dist object needed a write.
      expect(commands.filter((c) => c === 'PutObjectCommand').length).toBe(1)
      expect(commands).not.toContain('CopyObjectCommand')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('re-stamps an object that reached the store before its type was known', async () => {
    seed()
    const { store, objects, commands } = fakeStore()
    const oid = createHash('sha256').update(Buffer.alloc(3000, 7)).digest('hex')
    const key = `proj-1/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`
    // What a presigned `git lfs push` leaves behind: the bytes, no media type.
    objects.set(key, { body: Buffer.alloc(3000, 7), contentType: 'application/octet-stream' })
    try {
      const result = await offloadArtifactMedia({
        contextDir: dir,
        sourceDir: dir,
        projectId: 'proj-1',
        store,
        logger: { log: () => {}, warn: () => {} },
      })
      // The pod serves the object's own metadata, so the type and the caching
      // policy has to be right on the object, not only in the response.
      expect(result.restamped).toBe(1)
      expect(result.reused).toBe(0)
      expect(objects.get(key)?.contentType).toBe('video/mp4')
      expect(objects.get(key)?.cacheControl).toBe('no-cache')
      expect(commands).toContain('CopyObjectCommand')
      // A re-stamp copies server-side; it never re-uploads the bytes.
      expect(commands.filter((c) => c === 'PutObjectCommand').length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * An oid is ONE object, and the pod serves that object's own `Cache-Control`
   * (a length-known store body takes no per-response headers), so every path
   * referencing it has to agree on one policy. Per-path stamping let the last
   * writer win, which put a year-long `immutable` on a stable URL.
   */
  const seedDistOnly = () => {
    dir = mkdtempSync(join(tmpdir(), 'shogo-offload-'))
    git(['init', '--quiet'])
    writeFileSync(join(dir, 'README.md'), '# demo\n')
    mkdirSync(join(dir, 'dist', 'assets'), { recursive: true })
  }

  const mediaBytes = () => Buffer.alloc(PUBLISH_DIST_OFFLOAD_MIN_BYTES + 32, 3)

  it('stamps the weakest policy when a hashed and a stable path share one object', async () => {
    seedDistOnly()
    const bytes = mediaBytes()
    writeFileSync(join(dir, 'dist', 'About-Us.png'), bytes)
    writeFileSync(join(dir, 'dist', 'assets', 'About-Us-abcdef12.png'), bytes)
    const { store, objects } = fakeStore()
    const oid = createHash('sha256').update(bytes).digest('hex')
    const key = `proj-1/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`
    try {
      const result = await offloadArtifactMedia({
        contextDir: dir,
        sourceDir: dir,
        projectId: 'proj-1',
        store,
        logger: { log: () => {}, warn: () => {} },
      })
      // Two pointers, one object — uploaded once, not twice.
      expect(result.pointers).toBe(2)
      expect(result.uploaded).toBe(1)
      expect([...objects.keys()]).toEqual([key])
      // `/About-Us.png` can change on the next publish, so the shared object
      // must not be immutable even though its hashed twin is.
      expect(objects.get(key)?.cacheControl).toBe('no-cache')
      expect(objects.get(key)?.contentType).toBe('image/png')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps an object immutable when every path referencing it is hashed', async () => {
    seedDistOnly()
    const bytes = mediaBytes()
    writeFileSync(join(dir, 'dist', 'assets', 'hero-abcdef12.png'), bytes)
    writeFileSync(join(dir, 'dist', 'assets', 'hero-12345678.png'), bytes)
    const { store, objects } = fakeStore()
    try {
      const result = await offloadArtifactMedia({
        contextDir: dir,
        sourceDir: dir,
        projectId: 'proj-1',
        store,
        logger: { log: () => {}, warn: () => {} },
      })
      expect(result.uploaded).toBe(1)
      expect([...objects.values()][0]?.cacheControl).toBe('public, max-age=31536000, immutable')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('downgrades an immutable object once a stable path serves the same bytes', async () => {
    seedDistOnly()
    const bytes = mediaBytes()
    writeFileSync(join(dir, 'dist', 'About-Us.png'), bytes)
    const { store, objects, commands } = fakeStore()
    const oid = createHash('sha256').update(bytes).digest('hex')
    const key = `proj-1/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`
    // Stamped by an earlier publish that only referenced the hashed copy.
    objects.set(key, { body: bytes, contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' })
    try {
      const result = await offloadArtifactMedia({
        contextDir: dir,
        sourceDir: dir,
        projectId: 'proj-1',
        store,
        logger: { log: () => {}, warn: () => {} },
      })
      expect(result.restamped).toBe(1)
      expect(objects.get(key)?.cacheControl).toBe('no-cache')
      expect(commands).toContain('CopyObjectCommand')
      // A metadata re-stamp never re-uploads the bytes.
      expect(commands).not.toContain('PutObjectCommand')
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
