// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/routes/files.ts`.
 *
 * Endpoints:
 *   - GET  /projects/:id/files          — list (db lookup → filesystem fallback)
 *   - GET  /projects/:id/files/*        — read text + binary mime branches
 *   - PUT  /projects/:id/files/*        — write + traversal guards
 *   - GET  /projects/:id/s3/files       — S3 listing + filter excluded dirs
 *   - POST /projects/:id/s3/presign     — read & write URL generation
 *
 * Covers:
 *   - getProjectPath: db hit, db miss + dir exists, db miss + dir miss
 *   - validateFilePath: ".." traversal, leading "/", excluded dir, allowed test-results
 *   - text vs binary mime serving (Content-Type, Content-Length, Cache-Control)
 *   - ENOENT branch maps to 404, generic read error maps to 500
 *   - PUT body validation, mkdir recursive
 *   - S3 list: filter by extension + excluded dirs, builds directory entries
 *   - S3 presign: invalid body, read+write URL routing, content-type override
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// ─── Mock prisma ──────────────────────────────────────────────────────

const prismaMock = {
  project: { findUnique: mock(async (_args: any) => null as any) },
}
mock.module('../lib/prisma', () => ({ prisma: prismaMock }))

// ─── Mock S3 lib ──────────────────────────────────────────────────────

const s3Mock = {
  getPresignedReadUrl: mock(async (key: string, _opts: any) => `https://s3.test/read/${key}`),
  getPresignedWriteUrl: mock(async (key: string, _opts: any) => `https://s3.test/write/${key}`),
  listAllObjectsInS3: mock(async (_prefix: string, _bucket: string) => [] as Array<{
    relativePath: string
    size: number
    lastModified?: Date
  }>),
  deleteFromS3: mock(async (_key: string) => {}),
  isS3Enabled: mock(() => true),
}
mock.module('../lib/s3', () => s3Mock)

// ─── Mock fs/promises ─────────────────────────────────────────────────

interface FsEntry {
  type: 'file' | 'dir'
  content?: string | Buffer
  size?: number
}
const fsState = new Map<string, FsEntry>()
const mkdirCalls: string[] = []
const writeFileCalls: Array<{ path: string; content: string }> = []

function setFile(path: string, content: string | Buffer) {
  fsState.set(path, { type: 'file', content, size: typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength })
  // create parent dirs implicitly
  const parts = path.split('/')
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/')
    if (dir && !fsState.has(dir)) fsState.set(dir, { type: 'dir' })
  }
}
function setDir(path: string) {
  fsState.set(path, { type: 'dir' })
}

mock.module('fs/promises', () => ({
  readdir: async (dir: string, _opts: any) => {
    const entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = []
    const prefix = dir.endsWith('/') ? dir : dir + '/'
    for (const [path, entry] of fsState) {
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) {
        const name = path.slice(prefix.length)
        entries.push({
          name,
          isDirectory: () => entry.type === 'dir',
          isFile: () => entry.type === 'file',
        })
      }
    }
    if (entries.length === 0 && !fsState.has(dir)) {
      const err: any = new Error(`ENOENT: ${dir}`)
      err.code = 'ENOENT'
      throw err
    }
    return entries
  },
  readFile: async (path: string, enc?: any) => {
    const e = fsState.get(path)
    if (!e || e.type !== 'file') {
      const err: any = new Error(`ENOENT: ${path}`)
      err.code = 'ENOENT'
      throw err
    }
    if (enc === 'utf-8' || enc === 'utf8') {
      return typeof e.content === 'string' ? e.content : (e.content as Buffer).toString('utf-8')
    }
    return Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content as string)
  },
  writeFile: async (path: string, content: string, _enc?: any) => {
    writeFileCalls.push({ path, content })
    setFile(path, content)
  },
  mkdir: async (path: string, _opts: any) => {
    mkdirCalls.push(path)
    setDir(path)
  },
  stat: async (path: string) => {
    const e = fsState.get(path)
    if (!e) {
      const err: any = new Error(`ENOENT: ${path}`)
      err.code = 'ENOENT'
      throw err
    }
    return { size: e.size ?? 0, isDirectory: () => e.type === 'dir', isFile: () => e.type === 'file' }
  },
  unlink: async (path: string) => {
    if (!fsState.has(path)) {
      const err: any = new Error(`ENOENT: ${path}`)
      err.code = 'ENOENT'
      throw err
    }
    fsState.delete(path)
  },
}))

// ─── Import after mocks ──────────────────────────────────────────────

const { filesRoutes } = await import('../routes/files')
const router = filesRoutes({ workspacesDir: '/ws' })

beforeEach(() => {
  fsState.clear()
  mkdirCalls.length = 0
  writeFileCalls.length = 0
  prismaMock.project.findUnique.mockClear()
  prismaMock.project.findUnique.mockImplementation(async () => null)
  s3Mock.getPresignedReadUrl.mockClear()
  s3Mock.getPresignedWriteUrl.mockClear()
  s3Mock.listAllObjectsInS3.mockClear()
  s3Mock.listAllObjectsInS3.mockImplementation(async () => [])
  s3Mock.deleteFromS3.mockClear()
  s3Mock.deleteFromS3.mockImplementation(async () => {})
  s3Mock.isS3Enabled.mockClear()
  s3Mock.isS3Enabled.mockImplementation(() => true)
})

afterAll(() => mock.restore())

// ═══════════════════════════════════════════════════════════════════════
// GET /projects/:id/files (list)
// ═══════════════════════════════════════════════════════════════════════

describe('GET /projects/:id/files', () => {
  test('404 when project missing in db and dir does not exist', async () => {
    const res = await router.request('/projects/missing/files')
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('project_not_found')
  })

  test('happy path: lists src files via filesystem fallback', async () => {
    setDir('/ws/p1')
    setDir('/ws/p1/src')
    setFile('/ws/p1/src/App.tsx', 'export default function App(){}')
    setFile('/ws/p1/src/main.ts', 'console.log("hi")')
    setFile('/ws/p1/src/styles.css', 'body{}')
    setFile('/ws/p1/package.json', '{"name":"p1"}')
    setFile('/ws/p1/tsconfig.json', '{}')

    const res = await router.request('/projects/p1/files')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    const paths = body.files.map((f: any) => f.path).sort()
    expect(paths).toContain('src/App.tsx')
    expect(paths).toContain('src/main.ts')
    expect(paths).toContain('src/styles.css')
    expect(paths).toContain('package.json')
    expect(paths).toContain('tsconfig.json')
  })

  test('excludes node_modules and .git directories', async () => {
    setDir('/ws/p2')
    setDir('/ws/p2/src')
    setDir('/ws/p2/src/node_modules')
    setFile('/ws/p2/src/node_modules/lib.ts', 'noop')
    setDir('/ws/p2/src/.git')
    setFile('/ws/p2/src/.git/HEAD', 'ref')
    setFile('/ws/p2/src/App.tsx', 'ok')

    const res = await router.request('/projects/p2/files')
    const body = await res.json()
    const paths = body.files.map((f: any) => f.path)
    expect(paths).not.toContain('src/node_modules')
    expect(paths).not.toContain('src/.git')
    expect(paths).toContain('src/App.tsx')
  })

  test('filters out files with disallowed extensions', async () => {
    setDir('/ws/p3')
    setDir('/ws/p3/src')
    setFile('/ws/p3/src/binary.dat', 'data')
    setFile('/ws/p3/src/script.sh', '#!/bin/bash')
    setFile('/ws/p3/src/App.tsx', 'ok')
    const res = await router.request('/projects/p3/files')
    const paths = (await res.json()).files.map((f: any) => f.path)
    expect(paths).toContain('src/App.tsx')
    expect(paths).not.toContain('src/binary.dat')
    expect(paths).not.toContain('src/script.sh')
  })

  test('uses db lookup result when project exists in db', async () => {
    prismaMock.project.findUnique.mockImplementation(async () => ({ id: 'p_db' }))
    setDir('/ws/p_db')
    setDir('/ws/p_db/src')
    setFile('/ws/p_db/src/App.tsx', 'ok')
    const res = await router.request('/projects/p_db/files')
    expect(res.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// GET /projects/:id/files/*
// ═══════════════════════════════════════════════════════════════════════

describe('GET /projects/:id/files/*', () => {
  test('400 on directory traversal with ..', async () => {
    setDir('/ws/p')
    const res = await router.request('/projects/p/files/..%2Fsecret')
    expect(res.status).toBe(400)
  })

  test('400 when path traverses node_modules', async () => {
    setDir('/ws/p')
    const res = await router.request('/projects/p/files/node_modules/lib.ts')
    expect(res.status).toBe(400)
  })

  test('allows test-results path even though dist-style excluded by name', async () => {
    setDir('/ws/p')
    setFile('/ws/p/test-results/run.json', '{}')
    const res = await router.request('/projects/p/files/test-results/run.json')
    expect(res.status).toBe(200)
  })

  test('404 when project missing', async () => {
    const res = await router.request('/projects/missing/files/foo.ts')
    expect(res.status).toBe(404)
  })

  test('returns text file as JSON content', async () => {
    setDir('/ws/p_text')
    setFile('/ws/p_text/src/App.tsx', 'export const x = 1')
    const res = await router.request('/projects/p_text/files/src/App.tsx')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.content).toBe('export const x = 1')
    expect(body.path).toBe('src/App.tsx')
  })

  test('serves binary mime files with correct content-type', async () => {
    setDir('/ws/p_bin')
    setFile('/ws/p_bin/img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const res = await router.request('/projects/p_bin/files/img.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-length')).toBe('4')
    expect(res.headers.get('cache-control')).toContain('max-age=60')
  })

  test('404 with file_not_found code when ENOENT', async () => {
    setDir('/ws/p_missing_file')
    const res = await router.request('/projects/p_missing_file/files/src/missing.ts')
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('file_not_found')
  })

  test('serves svg with image/svg+xml content-type', async () => {
    setDir('/ws/p_svg')
    setFile('/ws/p_svg/icon.svg', '<svg/>')
    const res = await router.request('/projects/p_svg/files/icon.svg')
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
  })

  test('serves webm video with video/webm content-type', async () => {
    setDir('/ws/p_vid')
    setFile('/ws/p_vid/run.webm', Buffer.from([0]))
    const res = await router.request('/projects/p_vid/files/run.webm')
    expect(res.headers.get('content-type')).toBe('video/webm')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// PUT /projects/:id/files/*
// ═══════════════════════════════════════════════════════════════════════

describe('PUT /projects/:id/files/*', () => {
  function put(path: string, body: any) {
    return router.request(`/projects/p_w/files/${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  test('400 when content is not a string', async () => {
    setDir('/ws/p_w')
    const res = await put('src/A.tsx', { content: 123 })
    expect(res.status).toBe(400)
  })

  test('400 when path is excluded (node_modules)', async () => {
    setDir('/ws/p_w')
    const res = await put('node_modules/x.ts', { content: 'x' })
    expect(res.status).toBe(400)
  })

  test('happy path writes file and ensures dir exists', async () => {
    setDir('/ws/p_w')
    const res = await put('src/deep/nested/file.ts', { content: 'hello' })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(mkdirCalls.some((d) => d.includes('src/deep/nested'))).toBe(true)
    expect(writeFileCalls.length).toBe(1)
    expect(writeFileCalls[0].content).toBe('hello')
  })

  test('404 when project missing', async () => {
    const res = await router.request('/projects/missing/files/x.ts', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    })
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// GET /projects/:id/s3/files
// ═══════════════════════════════════════════════════════════════════════

describe('GET /projects/:id/s3/files', () => {
  test('returns empty array when bucket has no matching files', async () => {
    s3Mock.listAllObjectsInS3.mockImplementation(async () => [])
    const res = await router.request('/projects/p_s3/s3/files')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.files).toEqual([])
    expect(body.source).toBe('s3')
  })

  test('filters non-source extensions out', async () => {
    s3Mock.listAllObjectsInS3.mockImplementation(async () => [
      { relativePath: 'App.tsx', size: 100 },
      { relativePath: 'binary.dat', size: 5 },
      { relativePath: 'package.json', size: 20 },
    ])
    const res = await router.request('/projects/p_s3/s3/files')
    const body = await res.json()
    const filePaths = body.files.filter((f: any) => f.type === 'file').map((f: any) => f.path)
    expect(filePaths).toContain('App.tsx')
    expect(filePaths).toContain('package.json')
    expect(filePaths).not.toContain('binary.dat')
  })

  test('excludes node_modules-nested files', async () => {
    s3Mock.listAllObjectsInS3.mockImplementation(async () => [
      { relativePath: 'src/App.tsx', size: 100 },
      { relativePath: 'node_modules/lib/index.ts', size: 50 },
    ])
    const res = await router.request('/projects/p_s3/s3/files')
    const paths = (await res.json()).files
      .filter((f: any) => f.type === 'file')
      .map((f: any) => f.path)
    expect(paths).toContain('src/App.tsx')
    expect(paths).not.toContain('node_modules/lib/index.ts')
  })

  test('builds parent directory entries from file paths', async () => {
    s3Mock.listAllObjectsInS3.mockImplementation(async () => [
      { relativePath: 'src/components/Button.tsx', size: 100 },
    ])
    const res = await router.request('/projects/p_s3/s3/files')
    const dirs = (await res.json()).files.filter((f: any) => f.type === 'directory').map((f: any) => f.path)
    expect(dirs).toContain('src')
    expect(dirs).toContain('src/components')
  })

  test('sorts directories before files alphabetically', async () => {
    s3Mock.listAllObjectsInS3.mockImplementation(async () => [
      { relativePath: 'src/App.tsx', size: 1 },
      { relativePath: 'package.json', size: 2 },
    ])
    const res = await router.request('/projects/p_s3/s3/files')
    const items = (await res.json()).files
    expect(items[0].type).toBe('directory')
  })

  test('500 on S3 error', async () => {
    s3Mock.listAllObjectsInS3.mockImplementation(async () => { throw new Error('s3 down') })
    const res = await router.request('/projects/p_s3/s3/files')
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('s3_list_failed')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// POST /projects/:id/s3/presign
// ═══════════════════════════════════════════════════════════════════════

describe('POST /projects/:id/s3/presign', () => {
  function presign(body: any) {
    return router.request('/projects/p_pre/s3/presign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  test('400 when files is not an array', async () => {
    const res = await presign({})
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_body')
  })

  test('generates read URL for action=read', async () => {
    const res = await presign({ files: [{ path: 'src/A.tsx', action: 'read' }] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.urls[0].url).toContain('s3.test/read/p_pre/src/A.tsx')
    expect(s3Mock.getPresignedReadUrl).toHaveBeenCalled()
    expect(s3Mock.getPresignedWriteUrl).not.toHaveBeenCalled()
  })

  test('generates write URL for action=write with content type', async () => {
    const res = await presign({
      files: [{ path: 'src/A.tsx', action: 'write', contentType: 'application/typescript' }],
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.urls[0].url).toContain('s3.test/write/p_pre/src/A.tsx')
    const call = s3Mock.getPresignedWriteUrl.mock.calls[0]
    expect(call[1].contentType).toBe('application/typescript')
  })

  test('default contentType is application/octet-stream when omitted', async () => {
    await presign({ files: [{ path: 'src/A.tsx', action: 'write' }] })
    const call = s3Mock.getPresignedWriteUrl.mock.calls[0]
    expect(call[1].contentType).toBe('application/octet-stream')
  })

  test('handles mixed read and write in one call', async () => {
    const res = await presign({
      files: [
        { path: 'a.ts', action: 'read' },
        { path: 'b.ts', action: 'write' },
      ],
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.urls).toHaveLength(2)
    expect(body.urls[0].action).toBe('read')
    expect(body.urls[1].action).toBe('write')
  })

  test('500 when S3 helper throws', async () => {
    s3Mock.getPresignedReadUrl.mockImplementation(async () => { throw new Error('s3 fail') })
    const res = await presign({ files: [{ path: 'a.ts', action: 'read' }] })
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('s3_presign_failed')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// GET /projects/:id/workspace/manifest
// ═══════════════════════════════════════════════════════════════════════

describe('GET /projects/:id/workspace/manifest', () => {
  test('returns the full project tree with no extension filter', async () => {
    s3Mock.listAllObjectsInS3.mockImplementation(async () => [
      { relativePath: 'package.json', size: 100, lastModified: new Date('2026-01-01') },
      { relativePath: 'src/App.tsx', size: 200, lastModified: new Date('2026-01-02') },
      { relativePath: 'config.json', size: 50, lastModified: new Date('2026-01-03') },
      // Files outside INCLUDED_EXTENSIONS that the narrower /s3/files would skip:
      { relativePath: 'public/logo.png', size: 1024, lastModified: new Date('2026-01-04') },
      { relativePath: 'plans/2026.yaml', size: 300, lastModified: new Date('2026-01-05') },
    ])
    const res = await router.request('/projects/p_m/workspace/manifest')
    expect(res.status).toBe(200)
    const body = await res.json()
    const paths = body.files.map((f: any) => f.path).sort()
    expect(paths).toContain('public/logo.png')
    expect(paths).toContain('plans/2026.yaml')
    expect(paths).toContain('src/App.tsx')
    expect(body.projectId).toBe('p_m')
    expect(body.source).toBe('s3')
  })

  test('excludes files inside EXCLUDED_DIRS', async () => {
    s3Mock.listAllObjectsInS3.mockImplementation(async () => [
      { relativePath: 'src/App.tsx', size: 1, lastModified: new Date() },
      { relativePath: 'node_modules/lib.js', size: 1, lastModified: new Date() },
      { relativePath: 'dist/bundle.js', size: 1, lastModified: new Date() },
      { relativePath: '.git/HEAD', size: 1, lastModified: new Date() },
    ])
    const res = await router.request('/projects/p_m/workspace/manifest')
    const paths = (await res.json()).files.map((f: any) => f.path)
    expect(paths).toContain('src/App.tsx')
    expect(paths).not.toContain('node_modules/lib.js')
    expect(paths).not.toContain('dist/bundle.js')
    expect(paths).not.toContain('.git/HEAD')
  })

  test('excludes SENSITIVE_FILE_PATTERNS', async () => {
    s3Mock.listAllObjectsInS3.mockImplementation(async () => [
      { relativePath: 'src/App.tsx', size: 1, lastModified: new Date() },
      { relativePath: '.env', size: 1, lastModified: new Date() },
      { relativePath: '.env.local', size: 1, lastModified: new Date() },
      { relativePath: 'secrets/server.pem', size: 1, lastModified: new Date() },
      { relativePath: 'keys/id_rsa', size: 1, lastModified: new Date() },
    ])
    const res = await router.request('/projects/p_m/workspace/manifest')
    const paths = (await res.json()).files.map((f: any) => f.path)
    expect(paths).toContain('src/App.tsx')
    expect(paths).not.toContain('.env')
    expect(paths).not.toContain('.env.local')
    expect(paths).not.toContain('secrets/server.pem')
    expect(paths).not.toContain('keys/id_rsa')
  })

  test('entries carry size + lastModified', async () => {
    s3Mock.listAllObjectsInS3.mockImplementation(async () => [
      { relativePath: 'a.ts', size: 42, lastModified: new Date('2026-05-15T00:00:00Z') },
    ])
    const res = await router.request('/projects/p_m/workspace/manifest')
    const body = await res.json()
    expect(body.files[0]).toEqual({
      path: 'a.ts',
      size: 42,
      lastModified: '2026-05-15T00:00:00.000Z',
      etag: null,
    })
  })

  test('500 on S3 error with manifest_failed code', async () => {
    s3Mock.listAllObjectsInS3.mockImplementation(async () => { throw new Error('s3 down') })
    const res = await router.request('/projects/p_m/workspace/manifest')
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('manifest_failed')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// DELETE /projects/:id/files/*
// ═══════════════════════════════════════════════════════════════════════

describe('DELETE /projects/:id/files/*', () => {
  function del(path: string) {
    return router.request(`/projects/p_d/files/${path}`, { method: 'DELETE' })
  }

  test('400 when path is empty or invalid', async () => {
    setDir('/ws/p_d')
    const r1 = await del('..%2Fsecret')
    expect(r1.status).toBe(400)
    const r2 = await del('node_modules/lib.js')
    expect(r2.status).toBe(400)
  })

  test('403 when path matches SENSITIVE_FILE_PATTERNS', async () => {
    setDir('/ws/p_d')
    const res = await del('.env')
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('forbidden_path')
  })

  test('happy path: removes from S3 and best-effort unlink locally', async () => {
    setDir('/ws/p_d')
    setFile('/ws/p_d/src/old.ts', 'old')
    const res = await del('src/old.ts')
    expect(res.status).toBe(200)
    expect(s3Mock.deleteFromS3).toHaveBeenCalledTimes(1)
    expect(s3Mock.deleteFromS3.mock.calls[0][0]).toBe('p_d/src/old.ts')
    expect(fsState.has('/ws/p_d/src/old.ts')).toBe(false)
  })

  test('treats S3 NotFound as idempotent success', async () => {
    setDir('/ws/p_d')
    s3Mock.deleteFromS3.mockImplementation(async () => {
      const err: any = new Error('not there')
      err.$metadata = { httpStatusCode: 404 }
      throw err
    })
    const res = await del('src/missing.ts')
    expect(res.status).toBe(200)
  })

  test('500 when S3 delete throws unexpectedly', async () => {
    setDir('/ws/p_d')
    s3Mock.deleteFromS3.mockImplementation(async () => { throw new Error('s3 down') })
    const res = await del('src/oops.ts')
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('delete_failed')
  })

  test('skips S3 when isS3Enabled() returns false (dev mode unlink only)', async () => {
    s3Mock.isS3Enabled.mockImplementation(() => false)
    setDir('/ws/p_d')
    setFile('/ws/p_d/src/local.ts', 'x')
    const res = await del('src/local.ts')
    expect(res.status).toBe(200)
    expect(s3Mock.deleteFromS3).not.toHaveBeenCalled()
    expect(fsState.has('/ws/p_d/src/local.ts')).toBe(false)
  })
})
