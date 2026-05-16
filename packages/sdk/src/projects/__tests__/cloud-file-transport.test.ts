// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { CloudFileTransport, type FsAdapter, type ManifestEntry } from '../cloud-file-transport'

// ---------------------------------------------------------------------------
// In-memory FsAdapter — keeps tests sync-style + cross-platform. Mirrors the
// "fake S3" pattern used in apps/api/src/__tests__/files-route.test.ts.
// ---------------------------------------------------------------------------

interface FakeFile {
  type: 'file' | 'dir'
  data?: Uint8Array
  mtimeMs?: number
}

function makeFs(initial: Record<string, string | Uint8Array> = {}): FsAdapter & {
  state: Map<string, FakeFile>
  writes: Array<{ path: string; bytes: number }>
} {
  const state = new Map<string, FakeFile>()
  const writes: Array<{ path: string; bytes: number }> = []
  for (const [path, content] of Object.entries(initial)) {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
    state.set(path, { type: 'file', data: bytes, mtimeMs: Date.now() })
    // implicit parent dirs
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (dir && !state.has(dir)) state.set(dir, { type: 'dir' })
    }
  }
  return {
    state,
    writes,
    async readFile(path) {
      const e = state.get(path)
      if (!e || e.type !== 'file') throw new Error(`ENOENT: ${path}`)
      return e.data!
    },
    async writeFile(path, data) {
      writes.push({ path, bytes: data.byteLength })
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/')
        if (dir && !state.has(dir)) state.set(dir, { type: 'dir' })
      }
      state.set(path, { type: 'file', data, mtimeMs: Date.now() })
    },
    async mkdir(path) {
      const parts = path.split('/')
      for (let i = 1; i <= parts.length; i++) {
        const dir = parts.slice(0, i).join('/')
        if (dir && !state.has(dir)) state.set(dir, { type: 'dir' })
      }
    },
    async unlink(path) {
      state.delete(path)
    },
    async stat(path) {
      const e = state.get(path)
      if (!e) throw new Error(`ENOENT: ${path}`)
      return {
        size: e.data?.byteLength ?? 0,
        mtimeMs: e.mtimeMs ?? 0,
        isDirectory: () => e.type === 'dir',
      }
    },
    async readdir(path) {
      const prefix = path.endsWith('/') ? path : path + '/'
      const out: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = []
      for (const [p, e] of state) {
        if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) {
          const name = p.slice(prefix.length)
          out.push({
            name,
            isDirectory: () => e.type === 'dir',
            isFile: () => e.type === 'file',
          })
        }
      }
      return out
    },
    async rename(src, dest) {
      // Move all entries with the src prefix to dest
      const entries: Array<[string, FakeFile]> = []
      for (const [p, e] of state) {
        if (p === src || p.startsWith(src + '/')) {
          entries.push([p, e])
        }
      }
      for (const [p, e] of entries) {
        state.delete(p)
        const newPath = p === src ? dest : dest + p.slice(src.length)
        state.set(newPath, e)
      }
    },
    async rm(path) {
      const toDelete: string[] = []
      for (const p of state.keys()) {
        if (p === path || p.startsWith(path + '/')) toDelete.push(p)
      }
      for (const p of toDelete) state.delete(p)
    },
  }
}

// ---------------------------------------------------------------------------
// Fake fetch — script the responses by URL pattern.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string
  method: string
  body?: string
  headers?: Record<string, string>
}

function makeFetch(handler: (req: RecordedRequest) => Response): {
  fetchImpl: typeof fetch
  requests: RecordedRequest[]
} {
  const requests: RecordedRequest[] = []
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    const headers = Object.fromEntries(
      Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
    )
    const body =
      init?.body && typeof init.body !== 'object'
        ? String(init.body)
        : init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body as any)
          : undefined
    const req = { url, method: init?.method ?? 'GET', body, headers }
    requests.push(req)
    return handler(req)
  }) as unknown as typeof fetch
  return { fetchImpl, requests }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const apiUrl = 'https://api.test'
const apiKey = 'shogo_sk_test'
const projectId = 'proj-1'

describe('CloudFileTransport', () => {
  describe('constructor', () => {
    it('rejects missing required options', () => {
      expect(() => new CloudFileTransport({ apiUrl: '', apiKey, projectId, localDir: '/x' })).toThrow(/apiUrl/)
      expect(() => new CloudFileTransport({ apiUrl, apiKey: '', projectId, localDir: '/x' })).toThrow(/apiKey/)
      expect(() => new CloudFileTransport({ apiUrl, apiKey, projectId: '', localDir: '/x' })).toThrow(/projectId/)
      expect(() => new CloudFileTransport({ apiUrl, apiKey, projectId, localDir: '' })).toThrow(/localDir/)
    })

    it('trims trailing slashes from apiUrl', () => {
      const t = new CloudFileTransport({
        apiUrl: 'https://api.test///',
        apiKey,
        projectId,
        localDir: '/x',
      })
      expect((t as any).apiUrl).toBe('https://api.test')
    })
  })

  describe('listManifest', () => {
    it('GETs the manifest endpoint with auth and returns files', async () => {
      const manifestFiles: ManifestEntry[] = [
        { path: 'src/App.tsx', size: 100, lastModified: '2026-05-15T00:00:00Z', etag: null },
        { path: 'package.json', size: 50, lastModified: '2026-05-15T00:00:00Z', etag: null },
      ]
      const { fetchImpl, requests } = makeFetch(() =>
        new Response(JSON.stringify({ ok: true, projectId, files: manifestFiles, source: 's3', generatedAt: '' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      const fs = makeFs()
      const transport = new CloudFileTransport({ apiUrl, apiKey, projectId, localDir: '/local', fetchImpl, fs })
      const files = await transport.listManifest()
      expect(files).toEqual(manifestFiles)
      expect(requests[0]?.url).toBe(`${apiUrl}/api/projects/${projectId}/workspace/manifest`)
      expect(requests[0]?.headers?.authorization).toBe(`Bearer ${apiKey}`)
    })

    it('throws with manifest_failed prefix on non-2xx', async () => {
      const { fetchImpl } = makeFetch(() => new Response('boom', { status: 500 }))
      const transport = new CloudFileTransport({ apiUrl, apiKey, projectId, localDir: '/local', fetchImpl, fs: makeFs() })
      await expect(transport.listManifest()).rejects.toThrow(/manifest_failed/)
    })

    it('applies include filter to the returned manifest', async () => {
      const files: ManifestEntry[] = [
        { path: 'src/A.tsx', size: 1, lastModified: null, etag: null },
        { path: 'docs/X.md', size: 1, lastModified: null, etag: null },
      ]
      const { fetchImpl } = makeFetch(() =>
        new Response(JSON.stringify({ ok: true, projectId, files, source: 's3', generatedAt: '' }), { status: 200 }),
      )
      const transport = new CloudFileTransport({
        apiUrl, apiKey, projectId, localDir: '/local',
        fetchImpl, fs: makeFs(),
        include: ['src/**'],
      })
      const result = await transport.listManifest()
      expect(result.map((f) => f.path)).toEqual(['src/A.tsx'])
    })
  })

  describe('downloadAll', () => {
    function scriptDownload(manifest: ManifestEntry[], fileContents: Record<string, string>) {
      return makeFetch((req) => {
        if (req.url.endsWith('/workspace/manifest')) {
          return new Response(JSON.stringify({ ok: true, projectId, files: manifest, source: 's3', generatedAt: '' }), { status: 200 })
        }
        if (req.url.endsWith('/s3/presign')) {
          const body = JSON.parse(req.body!) as { files: Array<{ path: string; action: string }> }
          return new Response(
            JSON.stringify({
              ok: true,
              urls: body.files.map((f) => ({ path: f.path, action: f.action, url: `https://download.test/${f.path}` })),
            }),
            { status: 200 },
          )
        }
        if (req.url.startsWith('https://download.test/')) {
          const path = req.url.slice('https://download.test/'.length)
          const content = fileContents[path]
          if (content == null) return new Response('not found', { status: 404 })
          return new Response(content, { status: 200 })
        }
        return new Response('unhandled', { status: 500 })
      })
    }

    it('downloads via batch presign + per-file GET and writes atomically', async () => {
      const manifest: ManifestEntry[] = [
        { path: 'src/App.tsx', size: 5, lastModified: null, etag: null },
        { path: 'package.json', size: 3, lastModified: null, etag: null },
      ]
      const { fetchImpl, requests } = scriptDownload(manifest, {
        'src/App.tsx': 'hello',
        'package.json': '{}',
      })
      const fs = makeFs()
      const events: any[] = []
      const transport = new CloudFileTransport({
        apiUrl, apiKey, projectId, localDir: '/local',
        fetchImpl, fs, onProgress: (e) => events.push(e),
      })

      const stats = await transport.downloadAll()

      expect(stats.downloaded).toBe(2)
      expect(stats.errors).toEqual([])
      // Files landed in the final localDir (post-rename)
      expect(new TextDecoder().decode((await fs.readFile('/local/src/App.tsx')))).toBe('hello')
      expect(new TextDecoder().decode((await fs.readFile('/local/package.json')))).toBe('{}')
      // Presign call carries the auth header
      const presignReq = requests.find((r) => r.url.endsWith('/s3/presign'))!
      expect(presignReq.headers?.authorization).toBe(`Bearer ${apiKey}`)
      // Progress callback fired for each file
      expect(events.filter((e) => e.kind === 'download')).toHaveLength(2)
      // Staging dir was renamed away
      expect(fs.state.has('/local.shogo-pull-tmp')).toBe(false)
    })

    it('throws and leaves staging dir intact when any download fails', async () => {
      const manifest: ManifestEntry[] = [
        { path: 'a.ts', size: 1, lastModified: null, etag: null },
        { path: 'b.ts', size: 1, lastModified: null, etag: null },
      ]
      const { fetchImpl } = scriptDownload(manifest, { 'a.ts': 'A' })
      // b.ts will 404 → counted as error.
      const fs = makeFs()
      const transport = new CloudFileTransport({ apiUrl, apiKey, projectId, localDir: '/local', fetchImpl, fs })
      await expect(transport.downloadAll()).rejects.toThrow(/Pull aborted/)
      // Live dir untouched
      expect(fs.state.has('/local')).toBe(false)
      // Staging dir kept
      expect(fs.state.has('/local.shogo-pull-tmp')).toBe(true)
    })

    it('downloadFiles writes directly into localDir without staging', async () => {
      const manifest: ManifestEntry[] = [{ path: 'a.ts', size: 1, lastModified: null, etag: null }]
      const { fetchImpl } = scriptDownload(manifest, { 'a.ts': 'hi' })
      const fs = makeFs()
      const transport = new CloudFileTransport({ apiUrl, apiKey, projectId, localDir: '/local', fetchImpl, fs })
      const stats = await transport.downloadFiles(manifest)
      expect(stats.downloaded).toBe(1)
      expect(new TextDecoder().decode((await fs.readFile('/local/a.ts')))).toBe('hi')
      // No staging dir created on this path.
      expect(fs.state.has('/local.shogo-pull-tmp')).toBe(false)
    })
  })

  describe('uploadAll', () => {
    function scriptUpload() {
      return makeFetch((req) => {
        if (req.url.endsWith('/s3/presign')) {
          const body = JSON.parse(req.body!) as { files: Array<{ path: string; action: string }> }
          return new Response(
            JSON.stringify({
              ok: true,
              urls: body.files.map((f) => ({ path: f.path, action: f.action, url: `https://upload.test/${f.path}` })),
            }),
            { status: 200 },
          )
        }
        if (req.url.endsWith('/workspace/manifest')) {
          return new Response(JSON.stringify({ ok: true, projectId, files: [], source: 's3', generatedAt: '' }), { status: 200 })
        }
        if (req.url.startsWith('https://upload.test/')) {
          return new Response('', { status: 200 })
        }
        if (req.method === 'DELETE') {
          return new Response('', { status: 200 })
        }
        return new Response('unhandled', { status: 500 })
      })
    }

    it('walks localDir, batches presigns, and PUTs each file', async () => {
      const { fetchImpl, requests } = scriptUpload()
      const fs = makeFs({
        '/local/src/App.tsx': 'app',
        '/local/package.json': '{}',
        '/local/node_modules/lib.js': 'NO',
      })
      const transport = new CloudFileTransport({ apiUrl, apiKey, projectId, localDir: '/local', fetchImpl, fs })
      const stats = await transport.uploadAll()

      expect(stats.uploaded).toBe(2)
      expect(stats.errors).toEqual([])
      const puts = requests.filter((r) => r.method === 'PUT' && r.url.startsWith('https://upload.test/'))
      expect(puts.map((r) => r.url.replace('https://upload.test/', '')).sort()).toEqual([
        'package.json',
        'src/App.tsx',
      ])
      // node_modules is excluded by walkLocal
      expect(puts.every((r) => !r.url.includes('node_modules'))).toBe(true)
    })

    it('deleteRemote: deletes remote files missing locally', async () => {
      const fs = makeFs({ '/local/src/A.tsx': 'a' })
      const { fetchImpl, requests } = makeFetch((req) => {
        if (req.url.endsWith('/workspace/manifest')) {
          return new Response(
            JSON.stringify({
              ok: true,
              projectId,
              files: [
                { path: 'src/A.tsx', size: 1, lastModified: null, etag: null },
                { path: 'src/old.tsx', size: 1, lastModified: null, etag: null },
              ],
              source: 's3',
              generatedAt: '',
            }),
            { status: 200 },
          )
        }
        if (req.url.endsWith('/s3/presign')) {
          const body = JSON.parse(req.body!) as { files: Array<{ path: string; action: string }> }
          return new Response(
            JSON.stringify({
              ok: true,
              urls: body.files.map((f) => ({ path: f.path, action: f.action, url: `https://up.test/${f.path}` })),
            }),
            { status: 200 },
          )
        }
        if (req.url.startsWith('https://up.test/')) return new Response('', { status: 200 })
        if (req.method === 'DELETE') return new Response('', { status: 200 })
        return new Response('x', { status: 500 })
      })
      const transport = new CloudFileTransport({ apiUrl, apiKey, projectId, localDir: '/local', fetchImpl, fs })
      const stats = await transport.uploadAll({ deleteRemote: true })
      expect(stats.uploaded).toBe(1)
      expect(stats.deleted).toBe(1)
      const deleted = requests.find((r) => r.method === 'DELETE')!
      expect(deleted.url).toBe(`${apiUrl}/api/projects/${projectId}/files/src/old.tsx`)
    })
  })

  describe('uploadFiles', () => {
    it('uploads only the listed paths, honoring include filter', async () => {
      const fs = makeFs({
        '/local/src/A.tsx': 'a',
        '/local/src/B.tsx': 'b',
      })
      const { fetchImpl, requests } = makeFetch((req) => {
        if (req.url.endsWith('/s3/presign')) {
          const body = JSON.parse(req.body!) as { files: Array<{ path: string; action: string }> }
          return new Response(
            JSON.stringify({
              ok: true,
              urls: body.files.map((f) => ({ path: f.path, action: f.action, url: `https://up.test/${f.path}` })),
            }),
            { status: 200 },
          )
        }
        if (req.url.startsWith('https://up.test/')) return new Response('', { status: 200 })
        return new Response('', { status: 500 })
      })
      const transport = new CloudFileTransport({
        apiUrl, apiKey, projectId, localDir: '/local',
        fetchImpl, fs, include: ['src/A.tsx'],
      })
      const stats = await transport.uploadFiles(['src/A.tsx', 'src/B.tsx'])
      expect(stats.uploaded).toBe(1)
      const puts = requests.filter((r) => r.method === 'PUT')
      expect(puts).toHaveLength(1)
      expect(puts[0]!.url).toContain('src/A.tsx')
    })
  })

  describe('deleteRemote', () => {
    it('DELETEs the path and treats 404 as success', async () => {
      const { fetchImpl, requests } = makeFetch(() => new Response('', { status: 404 }))
      const transport = new CloudFileTransport({ apiUrl, apiKey, projectId, localDir: '/local', fetchImpl, fs: makeFs() })
      await transport.deleteRemote('src/missing.ts') // should not throw
      expect(requests[0]?.method).toBe('DELETE')
    })

    it('throws on non-404 error responses', async () => {
      const { fetchImpl } = makeFetch(() => new Response('', { status: 500 }))
      const transport = new CloudFileTransport({ apiUrl, apiKey, projectId, localDir: '/local', fetchImpl, fs: makeFs() })
      await expect(transport.deleteRemote('a.ts')).rejects.toThrow(/HTTP 500/)
    })
  })
})
