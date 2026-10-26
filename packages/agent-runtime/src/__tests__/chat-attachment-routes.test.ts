// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { chatAttachmentRoutes } from '../chat-attachment-routes'

async function withWorkspace<T>(fn: (workspaceDir: string) => Promise<T>): Promise<T> {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'shogo-chat-attachment-test-'))
  try {
    return await fn(workspaceDir)
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true })
  }
}

const silent = { log: () => {}, logError: () => {} }

function upload(
  app: ReturnType<typeof chatAttachmentRoutes>,
  name: string | undefined,
  body: BodyInit | null,
  headers: Record<string, string> = {},
) {
  const query = name === undefined ? '' : `?name=${encodeURIComponent(name)}`
  return app.request(`/agent/chat/attachments${query}`, {
    method: 'PUT',
    body,
    headers,
  })
}

describe('PUT /agent/chat/attachments', () => {
  test('streams a non-zip upload into files/ and returns its reference', async () => {
    await withWorkspace(async (workspaceDir) => {
      const app = chatAttachmentRoutes({ workspaceDir, ...silent })
      const res = await upload(app, 'notes.txt', 'hello world', { 'content-type': 'text/plain' })

      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        savedPath: string
        name: string
        mediaType: string
        bytes: number
        summary: string
      }
      expect(body.savedPath).toBe('files/notes.txt')
      expect(body.name).toBe('notes.txt')
      expect(body.mediaType).toBe('text/plain')
      expect(body.bytes).toBe(11)
      expect(body.summary).toContain('files/notes.txt')
      expect(readFileSync(join(workspaceDir, 'files', 'notes.txt'), 'utf-8')).toBe('hello world')
    })
  })

  test('routes a zip to the workspace root so unzip sees it there', async () => {
    await withWorkspace(async (workspaceDir) => {
      const app = chatAttachmentRoutes({ workspaceDir, ...silent })
      const res = await upload(app, 'bundle.zip', 'PK\u0003\u0004', { 'content-type': 'application/zip' })

      expect(res.status).toBe(200)
      const body = (await res.json()) as { savedPath: string }
      expect(body.savedPath).toBe('bundle.zip')
      expect(existsSync(join(workspaceDir, 'bundle.zip'))).toBe(true)
    })
  })

  test('rejects a traversal filename instead of writing outside the workspace', async () => {
    await withWorkspace(async (workspaceDir) => {
      const app = chatAttachmentRoutes({ workspaceDir, ...silent })
      const res = await upload(app, '../../escape.txt', 'nope', { 'content-type': 'text/plain' })

      expect(res.status).toBe(200)
      const body = (await res.json()) as { savedPath: string }
      // The sanitizer flattens separators, so the name survives as one flat
      // file inside files/ rather than climbing out of the workspace.
      expect(body.savedPath.startsWith('files/')).toBe(true)
      expect(body.savedPath.slice('files/'.length)).not.toContain('/')
      expect(existsSync(join(workspaceDir, 'files', '.._.._escape.txt'))).toBe(true)
      expect(readdirSync(workspaceDir).sort()).toEqual(['files'])
    })
  })

  test('requires a name', async () => {
    await withWorkspace(async (workspaceDir) => {
      const app = chatAttachmentRoutes({ workspaceDir, ...silent })
      const res = await upload(app, undefined, 'x', { 'content-type': 'text/plain' })

      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('attachment_name_required')
    })
  })

  test('refuses an over-cap upload from its content-length before reading bytes', async () => {
    await withWorkspace(async (workspaceDir) => {
      const app = chatAttachmentRoutes({ workspaceDir, maxBytes: 8, ...silent })
      const res = await upload(app, 'big.txt', 'far too many bytes', { 'content-type': 'text/plain' })

      expect(res.status).toBe(413)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('attachment_too_large')
      expect(existsSync(join(workspaceDir, 'files', 'big.txt'))).toBe(false)
    })
  })

  test('aborts a chunked upload that crosses the cap and leaves no partial file', async () => {
    await withWorkspace(async (workspaceDir) => {
      const app = chatAttachmentRoutes({ workspaceDir, maxBytes: 8, ...silent })
      const chunks = [new TextEncoder().encode('12345'), new TextEncoder().encode('67890')]
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        },
      })

      const res = await app.request('/agent/chat/attachments?name=stream.bin', {
        method: 'PUT',
        body: stream,
        headers: { 'content-type': 'application/octet-stream' },
        // @ts-expect-error Bun accepts duplex on RequestInit; TS lib does not.
        duplex: 'half',
      })

      expect(res.status).toBe(413)
      const filesDir = join(workspaceDir, 'files')
      expect(existsSync(filesDir) ? readdirSync(filesDir) : []).toEqual([])
    })
  })

  test('calls the index hook with the saved file and survives a throwing hook', async () => {
    await withWorkspace(async (workspaceDir) => {
      const seen: string[] = []
      const app = chatAttachmentRoutes({
        workspaceDir,
        log: () => {},
        logError: () => {},
        onFileWritten: (saved) => {
          seen.push(saved.savedPath)
          throw new Error('index exploded')
        },
      })

      const res = await upload(app, 'doc.md', '# hi', { 'content-type': 'text/markdown' })

      expect(res.status).toBe(200)
      expect(seen).toEqual(['files/doc.md'])
    })
  })
})
