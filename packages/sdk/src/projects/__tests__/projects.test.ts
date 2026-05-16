// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { ProjectsApi } from '../index'
import type { HttpClient } from '../../http/client.js'
import type { ShogoResponse } from '../../types.js'

interface RecordedCall {
  method: string
  path: string
  body?: unknown
  searchParams?: Record<string, string>
}

function makeHttp(handler: (call: RecordedCall) => any): { http: HttpClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const respond = (call: RecordedCall): ShogoResponse<any> => ({ data: handler(call), status: 200, error: null as any })
  const http = {
    get(path: string, searchParams?: Record<string, string>) {
      const call = { method: 'GET', path, searchParams }
      calls.push(call)
      return Promise.resolve(respond(call))
    },
    post(path: string, body?: unknown) {
      const call = { method: 'POST', path, body }
      calls.push(call)
      return Promise.resolve(respond(call))
    },
    request(path: string, opts: { method?: string; body?: unknown } = {}) {
      const call = { method: opts.method ?? 'GET', path, body: opts.body }
      calls.push(call)
      return Promise.resolve(respond(call))
    },
    delete(path: string, searchParams?: Record<string, string>) {
      const call = { method: 'DELETE', path, searchParams }
      calls.push(call)
      return Promise.resolve(respond(call))
    },
  } as unknown as HttpClient
  return { http, calls }
}

describe('ProjectsApi', () => {
  describe('manifest', () => {
    it('GETs /workspace/manifest and unwraps `files`', async () => {
      const fixture = [{ path: 'a.ts', size: 1, lastModified: null, etag: null }]
      const { http, calls } = makeHttp(() => ({ ok: true, files: fixture }))
      const api = new ProjectsApi(http, () => 'k', () => 'https://api.test')
      const out = await api.manifest('p-1')
      expect(out).toEqual(fixture)
      expect(calls[0]).toEqual({
        method: 'GET',
        path: '/api/projects/p-1/workspace/manifest',
        searchParams: undefined,
      })
    })

    it('URL-encodes the projectId', async () => {
      const { http, calls } = makeHttp(() => ({ ok: true, files: [] }))
      const api = new ProjectsApi(http, () => 'k', () => 'https://api.test')
      await api.manifest('proj/with/slash')
      expect(calls[0]!.path).toBe('/api/projects/proj%2Fwith%2Fslash/workspace/manifest')
    })
  })

  describe('listFiles + readFile + writeFile + deleteFile', () => {
    it('listFiles GETs /s3/files', async () => {
      const { http, calls } = makeHttp(() => ({ ok: true, files: [{ path: 'a.ts', type: 'file' }] }))
      const api = new ProjectsApi(http, () => 'k', () => 'https://api.test')
      await api.listFiles('p-1')
      expect(calls[0]!.path).toBe('/api/projects/p-1/s3/files')
    })

    it('readFile GETs /files/<path> and unwraps content', async () => {
      const { http, calls } = makeHttp(() => ({ ok: true, content: 'hello' }))
      const api = new ProjectsApi(http, () => 'k', () => 'https://api.test')
      const content = await api.readFile('p-1', 'src/App.tsx')
      expect(content).toBe('hello')
      expect(calls[0]!.path).toBe('/api/projects/p-1/files/src/App.tsx')
    })

    it('writeFile PUTs /files/<path> with { content } body', async () => {
      const { http, calls } = makeHttp(() => ({ ok: true }))
      const api = new ProjectsApi(http, () => 'k', () => 'https://api.test')
      await api.writeFile('p-1', 'src/App.tsx', 'new content')
      expect(calls[0]).toEqual({
        method: 'PUT',
        path: '/api/projects/p-1/files/src/App.tsx',
        body: { content: 'new content' },
      })
    })

    it('deleteFile DELETEs /files/<path>', async () => {
      const { http, calls } = makeHttp(() => ({}))
      const api = new ProjectsApi(http, () => 'k', () => 'https://api.test')
      await api.deleteFile('p-1', 'src/old.ts')
      expect(calls[0]!.method).toBe('DELETE')
      expect(calls[0]!.path).toBe('/api/projects/p-1/files/src/old.ts')
    })
  })

  describe('transport()', () => {
    it('throws a useful error when no API key is configured', () => {
      const { http } = makeHttp(() => ({}))
      const api = new ProjectsApi(http, () => null, () => 'https://api.test')
      expect(() => api.transport('p-1', '/local')).toThrow(/no API key configured/)
    })

    it('uses opts.apiKey when provided to override the resolver', () => {
      const { http } = makeHttp(() => ({}))
      const api = new ProjectsApi(http, () => null, () => 'https://api.test')
      const t = api.transport('p-1', '/local', { apiKey: 'shogo_sk_ad-hoc' })
      expect(t).toBeDefined()
    })
  })

  describe('pull/push (smoke)', () => {
    it('pull creates a transport and calls downloadAll when key+url resolve', async () => {
      const { http } = makeHttp(() => ({}))
      const api = new ProjectsApi(http, () => 'shogo_sk_test', () => 'https://api.test')

      // Inject a fake fetch + fs so we don't touch the network or disk.
      const fetchImpl = (async (input: any) => {
        const url = typeof input === 'string' ? input : input.url
        if (url.endsWith('/workspace/manifest')) {
          return new Response(JSON.stringify({ ok: true, files: [], source: 's3', generatedAt: '' }), { status: 200 })
        }
        return new Response('{}', { status: 200 })
      }) as unknown as typeof fetch
      const fakeFs = {
        readFile: async () => new Uint8Array(),
        writeFile: async () => undefined,
        mkdir: async () => undefined,
        unlink: async () => undefined,
        stat: async () => ({ size: 0, mtimeMs: 0, isDirectory: () => false }),
        readdir: async () => [],
        rename: async () => undefined,
        rm: async () => undefined,
      }
      const stats = await api.pull('p-1', { into: '/tmp/x', fetchImpl, fs: fakeFs })
      expect(stats).toBeDefined()
      expect(stats.downloaded).toBe(0)
    })
  })
})
