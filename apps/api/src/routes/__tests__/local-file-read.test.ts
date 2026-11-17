// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Local-only read route for a `file://` share on the desktop (SHO-302).
 * Serves a file that is already on this machine's disk, but only from inside
 * the workspaces dir or a folder-linked project root, and only with a session.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Hono } from 'hono'

const externalRoots: string[] = []
mock.module('../../lib/prisma', () => ({
  prisma: {
    project: {
      findMany: async () => externalRoots.map((path) => ({ projectFolders: [{ path }] })),
    },
  },
}))

const { localFileReadRoutes } = await import('../local-file-read')

let workspacesDir = ''
let outsideDir = ''
let externalDir = ''

function appWithSession(authenticated: boolean) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', { isAuthenticated: authenticated })
    await next()
  })
  app.route('/', localFileReadRoutes({ workspacesDir }))
  return app
}

function get(path: string, authenticated = true, init?: RequestInit) {
  return appWithSession(authenticated).request(
    `http://localhost/api/local-files?path=${encodeURIComponent(path)}`,
    init,
  )
}

const RANGE_BODY = Array.from({ length: 100 }, (_, index) => String(index % 10)).join('')

beforeAll(() => {
  workspacesDir = mkdtempSync(join(tmpdir(), 'local-file-read-'))
  outsideDir = mkdtempSync(join(tmpdir(), 'local-file-read-outside-'))
  externalDir = mkdtempSync(join(tmpdir(), 'local-file-read-external-'))

  mkdirSync(join(workspacesDir, 'proj-a', 'out'), { recursive: true })
  writeFileSync(join(workspacesDir, 'proj-a', 'out', 'report.pdf'), 'pdf bytes')
  writeFileSync(join(workspacesDir, 'proj-a', 'out', 'notes.md'), '# Notes')
  writeFileSync(join(workspacesDir, 'proj-a', 'out', 'index.html'), '<script>alert(1)</script>')
  writeFileSync(join(workspacesDir, 'proj-a', 'out', 'diagram.svg'), '<svg/>')
  writeFileSync(join(workspacesDir, 'proj-a', 'out', 'blob.bin'), 'opaque')
  // A known 100-byte body, so a ranged read can be asserted byte by byte.
  writeFileSync(join(workspacesDir, 'proj-a', 'out', 'clip.mp4'), RANGE_BODY)
  writeFileSync(join(outsideDir, 'secret.txt'), 'nope')
  symlinkSync(outsideDir, join(workspacesDir, 'proj-a', 'escape'))
  writeFileSync(join(externalDir, 'linked.txt'), 'linked project file')
  externalRoots.push(externalDir)
})

afterAll(() => {
  for (const dir of [workspacesDir, outsideDir, externalDir]) rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/local-files', () => {
  it('serves a file inside the workspaces dir with its content type', async () => {
    const res = await get(join(workspacesDir, 'proj-a', 'out', 'report.pdf'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(await res.text()).toBe('pdf bytes')
  })

  it('serves a markdown file as text/markdown', async () => {
    const res = await get(join(workspacesDir, 'proj-a', 'out', 'notes.md'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/markdown')
  })

  it('renders a pdf inline', async () => {
    const res = await get(join(workspacesDir, 'proj-a', 'out', 'report.pdf'))
    expect(res.headers.get('content-disposition')).toStartWith('inline')
  })

  it('downloads an html file instead of rendering it on the API origin', async () => {
    const res = await get(join(workspacesDir, 'proj-a', 'out', 'index.html'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html')
    expect(res.headers.get('content-disposition')).toStartWith('attachment')
  })

  it('downloads an svg file instead of rendering it on the API origin', async () => {
    const res = await get(join(workspacesDir, 'proj-a', 'out', 'diagram.svg'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('content-disposition')).toStartWith('attachment')
  })

  it('downloads an unknown type rather than rendering it', async () => {
    const res = await get(join(workspacesDir, 'proj-a', 'out', 'blob.bin'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toStartWith('attachment')
  })

  it('serves a file inside a folder-linked project root', async () => {
    const res = await get(join(externalDir, 'linked.txt'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('linked project file')
  })

  it('refuses a path outside the allowed roots', async () => {
    const res = await get('/etc/passwd')
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('forbidden_path')
  })

  it('refuses a .. path that resolves outside the roots', async () => {
    const outsideName = outsideDir.split('/').pop()!
    const traversal = `${workspacesDir}/proj-a/../../${outsideName}/secret.txt`
    const res = await get(traversal)
    expect(res.status).toBe(403)
  })

  it('refuses a symlink that escapes the roots', async () => {
    const res = await get(join(workspacesDir, 'proj-a', 'escape', 'secret.txt'))
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('forbidden_path')
  })

  it('answers 404 file_not_found for a deleted file', async () => {
    const res = await get(join(workspacesDir, 'proj-a', 'out', 'gone.pdf'))
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('file_not_found')
  })

  it('answers 401 without a session', async () => {
    const res = await get(join(workspacesDir, 'proj-a', 'out', 'report.pdf'), false)
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('unauthorized')
  })

  it('answers 400 when path is missing', async () => {
    const res = await appWithSession(true).request('http://localhost/api/local-files')
    expect(res.status).toBe(400)
  })
})

/**
 * The viewer points a `<video>` at this route, and a media element only starts
 * (and seeks) by asking for byte ranges. Reading the whole file into memory and
 * answering 200 made every video download in full first (SHO-387).
 */
describe('GET /api/local-files with a Range', () => {
  const clip = () => join(workspacesDir, 'proj-a', 'out', 'clip.mp4')

  it('advertises ranges and serves the whole file without one', async () => {
    const res = await get(clip())

    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe('100')
    expect(await res.text()).toBe(RANGE_BODY)
  })

  it('answers a byte range with 206 and its content-range', async () => {
    const res = await get(clip(), true, { headers: { range: 'bytes=0-9' } })

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-9/100')
    expect(res.headers.get('content-length')).toBe('10')
    expect(await res.text()).toBe('0123456789')
  })

  it('answers a suffix range with the final bytes', async () => {
    const res = await get(clip(), true, { headers: { range: 'bytes=-5' } })

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 95-99/100')
    expect(await res.text()).toBe('56789')
  })

  it('answers a range past the end with 416 and the file size', async () => {
    const res = await get(clip(), true, { headers: { range: 'bytes=200-' } })

    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */100')
  })
})
