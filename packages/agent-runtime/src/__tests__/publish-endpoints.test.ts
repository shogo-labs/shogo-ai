// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-308: the two publish endpoints share one staging directory, and the first
 * one used to delete it.
 *
 * This is the test that was missing. #1975 shipped a skip that assumed
 * `/agent/publish-artifact` could read `dist.publish.staging` after
 * `/agent/dist-files?publish=true` had run, and its tests mocked the runtime, so
 * they asserted the API's calls instead of the runtime's behaviour. Every
 * server-backed publish on staging then failed with `artifact_missing`.
 *
 * So these cases drive the real handlers, mounted on a real Hono app, against a
 * real directory and a real tar: `keep=true` must leave the staging dir for the
 * artifact call, and without it the artifact call must fail with
 * `dist_not_found` — which is the bug, and it fails on the code before the fix.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import {
  handleDistFiles,
  handlePublishArtifact,
  type PublishEndpointDeps,
} from '../publish-endpoints'
import { PUBLISH_STAGING_DIR } from '../preview-manager'

let workspace: string
let app: Hono

function mount(workspaceDir: string): Hono {
  const deps: PublishEndpointDeps = {
    projectDir: () => workspaceDir,
    outputRoot: (_projectId, projectDir) => projectDir,
  }
  const hono = new Hono()
  hono.get('/agent/dist-files', (c) => handleDistFiles(c, deps))
  hono.get('/agent/publish-artifact', (c) => handlePublishArtifact(c, deps))
  return hono
}

/** A project with a source file and a publish build output, as a real one has. */
function seedProject(dir: string): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo' }))
  writeFileSync(join(dir, 'server.tsx'), 'export default { fetch: () => new Response("ok") }\n')
  const staging = join(dir, PUBLISH_STAGING_DIR)
  mkdirSync(join(staging, 'assets'), { recursive: true })
  writeFileSync(join(staging, 'index.html'), '<!doctype html><title>published</title>')
  writeFileSync(join(staging, 'assets', 'app.js'), 'console.log("published")')
}

const distFiles = (query = '') =>
  app.fetch(new Request(`http://runtime.test/agent/dist-files?publish=true${query}`))
const artifact = () => app.fetch(new Request('http://runtime.test/agent/publish-artifact'))

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'shogo-publish-endpoints-'))
  seedProject(workspace)
  app = mount(workspace)
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('publish endpoints share the staging dir', () => {
  it('keeps the build output for the artifact call when keep=true', async () => {
    const files = await distFiles('&keep=true')
    expect(files.status).toBe(200)
    const body = (await files.json()) as Array<{ path: string; content: string }>
    expect(body.map((f) => f.path).sort()).toEqual(['assets/app.js', 'index.html'])
    // The directory the image build reads is still there.
    expect(existsSync(join(workspace, PUBLISH_STAGING_DIR))).toBe(true)

    const res = await artifact()
    expect(res.status).toBe(200)
    const archive = (await res.json()) as { archive: string; bytes: number }
    expect(archive.bytes).toBeGreaterThan(0)
    expect(Buffer.from(archive.archive, 'base64').subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
    // The artifact call is the last reader, so it cleans up after itself.
    expect(existsSync(join(workspace, PUBLISH_STAGING_DIR))).toBe(false)
  })

  it('deletes the build output without keep, so the artifact call has nothing to read', async () => {
    const files = await distFiles()
    expect(files.status).toBe(200)
    expect(existsSync(join(workspace, PUBLISH_STAGING_DIR))).toBe(false)

    // This is the bug: the publish flow's own download removed the directory the
    // image build needs, and the publish died with artifact_missing.
    const res = await artifact()
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('dist_not_found')
  })

  it('leaves a static publish cleaning up after itself', async () => {
    // No keep, no artifact call: the staging dir must not be left behind.
    await distFiles()
    expect(existsSync(join(workspace, PUBLISH_STAGING_DIR))).toBe(false)
  })

  it('reports a project that is not attached instead of reading the wrong directory', async () => {
    const detached = new Hono()
    detached.get('/agent/dist-files', (c) =>
      handleDistFiles(c, { projectDir: () => null, outputRoot: (_id, dir) => dir }),
    )
    const res = await detached.fetch(new Request('http://runtime.test/agent/dist-files?publish=true'))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('project_not_attached')
  })
})

// ---------------------------------------------------------------------------
// The archive does not cross the API (SHO-485 §2b)
// ---------------------------------------------------------------------------

/**
 * Given a `bucket` + `key`, the runtime streams the tar it just made straight
 * into object storage and answers with its location — no base64 body, so a
 * media-heavy project's artifact never sits in the API's heap. Without a target
 * it keeps the old body for a caller that has not been rolled out yet.
 */
describe('publish-artifact upload target', () => {
  const fakeStore = () => {
    const puts: Array<{ bucket: string; key: string; body: Buffer }> = []
    return {
      puts,
      store: {
        bucket: 'workspaces',
        client: {
          async send(command: any) {
            if (command.constructor.name === 'PutObjectCommand') {
              puts.push({
                bucket: command.input.Bucket,
                key: command.input.Key,
                body: Buffer.from(command.input.Body),
              })
              return { ETag: '"etag"' }
            }
            return {}
          },
        },
      },
    }
  }

  function mountWithStore(workspaceDir: string, store: any): Hono {
    const deps: PublishEndpointDeps = {
      projectDir: () => workspaceDir,
      outputRoot: (_projectId, projectDir) => projectDir,
      objectStore: () => ({ client: store.client, bucket: store.bucket }),
    }
    const hono = new Hono()
    hono.get('/agent/publish-artifact', (c) => handlePublishArtifact(c, deps))
    return hono
  }

  it('uploads the tar itself and answers with the key and its size', async () => {
    const { store, puts } = fakeStore()
    const hono = mountWithStore(workspace, store)
    const res = await hono.fetch(
      new Request('http://runtime.test/agent/publish-artifact?projectId=p1&bucket=publish&key=acme/artifacts/abc.tar.gz'),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { bucket: string; key: string; bytes: number; archive?: string }
    expect(body.key).toBe('acme/artifacts/abc.tar.gz')
    expect(body.bucket).toBe('publish')
    expect(body.archive).toBeUndefined()
    expect(puts.length).toBe(1)
    expect(puts[0].key).toBe('acme/artifacts/abc.tar.gz')
    expect(puts[0].body.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
    expect(body.bytes).toBe(puts[0].body.length)
    // Still the last reader of the staging dir.
    expect(existsSync(join(workspace, PUBLISH_STAGING_DIR))).toBe(false)
  })

  it('keeps the base64 body for a caller that names no target', async () => {
    const { store, puts } = fakeStore()
    const hono = mountWithStore(workspace, store)
    const res = await hono.fetch(new Request('http://runtime.test/agent/publish-artifact?projectId=p1'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { archive?: string }
    expect(typeof body.archive).toBe('string')
    expect(puts.length).toBe(0)
  })
})

describe('publish-artifact size guard', () => {
  it('refuses a context over the named limit instead of letting the Job evict', async () => {
    const previous = process.env.PUBLISH_ARTIFACT_MAX_BYTES
    // 1 byte: the tar of any real project is bigger.
    process.env.PUBLISH_ARTIFACT_MAX_BYTES = '1'
    try {
      const deps: PublishEndpointDeps = {
        projectDir: () => workspace,
        outputRoot: (_projectId, projectDir) => projectDir,
      }
      const hono = new Hono()
      hono.get('/agent/publish-artifact', (c) => handlePublishArtifact(c, deps))
      const res = await hono.fetch(new Request('http://runtime.test/agent/publish-artifact?projectId=p1'))
      expect(res.status).toBe(413)
      const body = (await res.json()) as { error: string; message: string }
      expect(body.error).toBe('artifact_too_large')
      expect(body.message).toContain('limit for an image build')
    } finally {
      if (previous === undefined) delete process.env.PUBLISH_ARTIFACT_MAX_BYTES
      else process.env.PUBLISH_ARTIFACT_MAX_BYTES = previous
    }
  })
})

// ---------------------------------------------------------------------------
// A runtime with no object store never base64s a large artifact (SHO-536 §A)
// ---------------------------------------------------------------------------

function mountWithoutStore(workspaceDir: string): Hono {
  const deps: PublishEndpointDeps = {
    projectDir: () => workspaceDir,
    outputRoot: (_projectId, projectDir) => projectDir,
  }
  const hono = new Hono()
  hono.get('/agent/publish-artifact', (c) => handlePublishArtifact(c, deps))
  return hono
}

async function withEnv(name: string, value: string, fn: () => Promise<void>): Promise<void> {
  const previous = process.env[name]
  process.env[name] = value
  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

describe('publish-artifact with no object store', () => {
  it('streams the tar to the API presigned PUT instead of base64ing it', async () => {
    const received: number[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push((await req.arrayBuffer()).byteLength)
        return new Response(null, { status: 200 })
      },
    })
    try {
      const putUrl = `http://127.0.0.1:${server.port}/upload`
      const res = await mountWithoutStore(workspace).fetch(
        new Request(
          'http://runtime.test/agent/publish-artifact?projectId=p1&bucket=publish' +
            `&key=acme/artifacts/abc.tar.gz&putUrl=${encodeURIComponent(putUrl)}`,
        ),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        key: string
        bytes: number
        archive?: string
        offload?: { skipped?: string }
      }
      expect(body.archive).toBeUndefined()
      expect(body.key).toBe('acme/artifacts/abc.tar.gz')
      expect(body.bytes).toBeGreaterThan(0)
      // What the API put in the bucket is the whole tar, not a truncated body.
      expect(received).toEqual([body.bytes])
      // And the API is told the media stayed in it.
      expect(body.offload).toEqual({ skipped: 'no_object_store' })
    } finally {
      server.stop(true)
    }
  })

  it('refuses an artifact over the inline limit by name instead of crashing on a V8 string', async () => {
    await withEnv('PUBLISH_ARTIFACT_INLINE_MAX_BYTES', '1', async () => {
      const res = await mountWithoutStore(workspace).fetch(
        new Request('http://runtime.test/agent/publish-artifact?projectId=p1'),
      )
      expect(res.status).toBe(413)
      const body = (await res.json()) as { error: string; message: string }
      expect(body.error).toBe('artifact_too_large_for_inline')
      expect(body.message).toContain('must go through object storage')
    })
  })

  it('still streams a context over the inline limit when the API minted a PUT', async () => {
    const received: number[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push((await req.arrayBuffer()).byteLength)
        return new Response(null, { status: 200 })
      },
    })
    try {
      await withEnv('PUBLISH_ARTIFACT_INLINE_MAX_BYTES', '1', async () => {
        const putUrl = `http://127.0.0.1:${server.port}/upload`
        const res = await mountWithoutStore(workspace).fetch(
          new Request(
            'http://runtime.test/agent/publish-artifact?projectId=p1&bucket=publish' +
              `&key=acme/artifacts/abc.tar.gz&putUrl=${encodeURIComponent(putUrl)}`,
          ),
        )
        expect(res.status).toBe(200)
        expect(received).toHaveLength(1)
      })
    } finally {
      server.stop(true)
    }
  })

  it('names the missing object store when the size limit is what trips', async () => {
    await withEnv('PUBLISH_ARTIFACT_MAX_BYTES', '1', async () => {
      const res = await mountWithoutStore(workspace).fetch(
        new Request('http://runtime.test/agent/publish-artifact?projectId=p1'),
      )
      expect(res.status).toBe(413)
      const body = (await res.json()) as { error: string; message: string }
      expect(body.error).toBe('artifact_too_large')
      expect(body.message).toContain('no object store')
    })
  })

  it('uploads through the store when the runtime has one, and reports the media offload', async () => {
    const puts: number[] = []
    const hono = mountWithStoreForTest(workspace, {
      bucket: 'workspaces',
      client: {
        async send(command: any) {
          if (command.constructor.name === 'PutObjectCommand') {
            puts.push(Buffer.from(command.input.Body).length)
            return { ETag: '"etag"' }
          }
          return {}
        },
      },
    })
    const res = await hono.fetch(
      new Request('http://runtime.test/agent/publish-artifact?projectId=p1&bucket=publish&key=acme/artifacts/abc.tar.gz'),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { bytes: number; offload?: unknown }
    expect(puts).toEqual([body.bytes])
    expect(body.offload).toBeUndefined()
  })
})

function mountWithStoreForTest(workspaceDir: string, store: any): Hono {
  const deps: PublishEndpointDeps = {
    projectDir: () => workspaceDir,
    outputRoot: (_projectId, projectDir) => projectDir,
    objectStore: () => store,
  }
  const hono = new Hono()
  hono.get('/agent/publish-artifact', (c) => handlePublishArtifact(c, deps))
  return hono
}
