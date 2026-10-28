// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-213 acceptance — upload a chat attachment's bytes *before* the turn.
 *
 * The unit suites drive the Hono handlers through `app.request`, which never
 * opens a socket: they cannot show that a large body really streams, that the
 * client's abort leaves nothing behind, or that the bytes on disk are the bytes
 * that were sent. This file does all three against a real `Bun.serve`, then
 * feeds the uploaded files through the same readers `/agent/chat` uses
 * (`resolveReferenceAttachment`, `buildUploadedFilesNote`,
 * `parseFileAttachments`) so the two halves of the transport are exercised
 * together.
 *
 * Acceptance criteria covered here: 1 (server half), 4, 5, 7, 8, 9, plus the
 * wiring half of 2 and 6 (source guards at the end).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'
import { join } from 'node:path'
import { Hono } from 'hono'
import { chatAttachmentRoutes } from '../chat-attachment-routes'
import {
  MAX_INLINE_ATTACHMENT_BYTES,
  parseFileAttachments,
} from '../file-attachment-utils'
import {
  buildUploadedFilesNote,
  isReferenceAttachmentPart,
  resolveReferenceAttachment,
  saveUploadedFileParts,
  type UploadedFilePart,
} from '../upload-attachments'

/** Room for the happy-path uploads (a 24 MB archive, a 10 MB CSV). */
const ROOMY_CAP_BYTES = 64 * 1024 * 1024
/** Deliberately tight, so the over-cap paths are cheap to drive. */
const TIGHT_CAP_BYTES = 1024 * 1024
const silent = { log: () => {}, logError: () => {} }

let workspaceDir = ''
let server: ReturnType<typeof Bun.serve>
let baseUrl = ''
let tightCapServer: ReturnType<typeof Bun.serve>
let tightCapUrl = ''

/** Deterministic bytes, so the sha of what lands on disk is checkable. */
function pseudoRandomBytes(size: number, seed = 7): Uint8Array {
  const out = new Uint8Array(size)
  let x = seed
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out[i] = x & 0xff
  }
  return out
}

/** Stream `bytes` to the route without ever holding a second copy in the client. */
function streamedBody(bytes: Uint8Array, chunkSize = 1024 * 1024): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
      offset += chunkSize
    },
  })
}

function uploadUrl(name: string | undefined): string {
  return name === undefined
    ? `${baseUrl}/agent/chat/attachments`
    : `${baseUrl}/agent/chat/attachments?name=${encodeURIComponent(name)}`
}

async function put(
  name: string | undefined,
  bytes: Uint8Array,
  mediaType: string,
  target = baseUrl,
): Promise<Response> {
  const url = name === undefined
    ? `${target}/agent/chat/attachments`
    : `${target}/agent/chat/attachments?name=${encodeURIComponent(name)}`
  return fetch(url, {
    method: 'PUT',
    headers: { 'content-type': mediaType },
    body: streamedBody(bytes),
    // Bun needs this for a streaming request body.
    duplex: 'half',
  } as RequestInit)
}

/**
 * A raw socket request, because `fetch` recomputes `content-length` from the
 * body it was given — so it cannot express "the client declared 900 MB".
 */
function rawPutWithDeclaredLength(
  port: number,
  path: string,
  declaredLength: number,
  body: Uint8Array,
): Promise<string> {
  return new Promise((resolve) => {
    let raw = ''
    const socket = connect(port, '127.0.0.1', () => {
      const head = [
        `PUT ${path} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Content-Type: application/zip',
        `Content-Length: ${declaredLength}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n')
      socket.write(head)
      socket.write(body)
    })
    socket.on('data', (chunk) => {
      raw += chunk.toString('latin1')
    })
    socket.on('end', () => resolve(raw))
    socket.on('error', () => resolve(raw))
    socket.setTimeout(5000, () => {
      socket.destroy()
      resolve(raw)
    })
  })
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Wait (bounded) for a path to disappear, for the post-abort cleanup check. */
async function waitForMissing(path: string, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!existsSync(path)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !existsSync(path)
}

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'sho213-acceptance-'))
  // Bun's default request-body cap is 128 MB, which would reject a 200 MB
  // attachment with a bodiless 413 *before* the route runs. Production sets
  // this in `server.ts` (guarded below); the test server has to match it or it
  // measures Bun, not the route.
  const maxRequestBodySize = 4 * 1024 * 1024 * 1024
  const app = new Hono()
  app.route('/', chatAttachmentRoutes({ workspaceDir, maxBytes: ROOMY_CAP_BYTES, ...silent }))
  server = Bun.serve({ port: 0, maxRequestBodySize, fetch: app.fetch })
  baseUrl = `http://127.0.0.1:${server.port}`

  const tightApp = new Hono()
  tightApp.route('/', chatAttachmentRoutes({ workspaceDir, maxBytes: TIGHT_CAP_BYTES, ...silent }))
  tightCapServer = Bun.serve({ port: 0, maxRequestBodySize, fetch: tightApp.fetch })
  tightCapUrl = `http://127.0.0.1:${tightCapServer.port}`
})

afterAll(() => {
  server?.stop(true)
  tightCapServer?.stop(true)
  rmSync(workspaceDir, { recursive: true, force: true })
})

describe('AC1/AC8 — a large archive streams to the workspace root over a real socket', () => {
  test('a 24 MB zip arrives byte-identical, at the root, under its own name', async () => {
    const bytes = pseudoRandomBytes(24 * 1024 * 1024)
    const res = await put('bundle.zip', bytes, 'application/zip')

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      savedPath: string
      name: string
      mediaType: string
      bytes: number
    }
    // A zip belongs at the workspace root so the agent can unzip it in place.
    expect(body.savedPath).toBe('bundle.zip')
    expect(body.bytes).toBe(bytes.length)
    expect(body.mediaType).toBe('application/zip')

    const onDisk = readFileSync(join(workspaceDir, 'bundle.zip'))
    expect(onDisk.length).toBe(bytes.length)
    expect(sha(new Uint8Array(onDisk))).toBe(sha(bytes))
  }, 60_000)

  test('a second upload of the same name gets a suffix instead of clobbering the first', async () => {
    const first = pseudoRandomBytes(64 * 1024, 11)
    const second = pseudoRandomBytes(64 * 1024, 13)
    await put('report.zip', first, 'application/zip')
    const res = await put('report.zip', second, 'application/zip')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { savedPath: string }
    expect(body.savedPath).toBe('report-1.zip')
    expect(sha(new Uint8Array(readFileSync(join(workspaceDir, 'report.zip'))))).toBe(sha(first))
    expect(sha(new Uint8Array(readFileSync(join(workspaceDir, 'report-1.zip'))))).toBe(sha(second))
  })

  test('a traversal name is flattened, never written outside the workspace', async () => {
    const res = await put('../../escaped.txt', new TextEncoder().encode('nope'), 'text/plain')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { savedPath: string }
    // One segment inside files/ — the separators are gone, not resolved.
    expect(body.savedPath.startsWith('files/')).toBe(true)
    expect(body.savedPath.split('/').length).toBe(2)
    expect(body.savedPath.includes('/../')).toBe(false)
    expect(existsSync(join(workspaceDir, '..', 'escaped.txt'))).toBe(false)
    expect(existsSync(join(workspaceDir, body.savedPath))).toBe(true)
  })

  test('a non-zip lands in files/ so the index engine sees it', async () => {
    const res = await put('notes.txt', new TextEncoder().encode('hello'), 'text/plain')

    expect(res.status).toBe(200)
    expect(((await res.json()) as { savedPath: string }).savedPath).toBe('files/notes.txt')
  })

  test('a request without a name is refused before any byte is written', async () => {
    const before = readdirSync(join(workspaceDir, 'files')).length
    const res = await put(undefined, new TextEncoder().encode('x'), 'text/plain')

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'attachment_name_required',
    )
    expect(readdirSync(join(workspaceDir, 'files')).length).toBe(before)
  })
})

describe('AC7 — over the cap, and an aborted upload, leave nothing behind', () => {
  test('a declared content-length over the cap is refused without reading the body', async () => {
    const raw = await rawPutWithDeclaredLength(
      tightCapServer.port,
      '/agent/chat/attachments?name=declared.zip',
      TIGHT_CAP_BYTES * 900,
      new Uint8Array(1),
    )

    expect(raw).toContain('413')
    expect(raw).toContain('attachment_too_large')
    expect(existsSync(join(workspaceDir, 'declared.zip'))).toBe(false)
  }, 20_000)

  test('a chunked upload that crosses the cap is cut off and its partial file removed', async () => {
    const res = await put(
      'sneaky.zip',
      pseudoRandomBytes(TIGHT_CAP_BYTES + 512 * 1024),
      'application/zip',
      tightCapUrl,
    )

    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'attachment_too_large',
    )
    expect(await waitForMissing(join(workspaceDir, 'sneaky.zip'))).toBe(true)
  }, 60_000)

  test('a client that aborts mid-upload leaves no partial file', async () => {
    const controller = new AbortController()
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(streamController) {
        if (sent >= 3 * 1024 * 1024) {
          // Abort from the client side, the way a closed tab would.
          controller.abort()
          streamController.error(new Error('aborted'))
          return
        }
        streamController.enqueue(pseudoRandomBytes(64 * 1024, sent))
        sent += 64 * 1024
      },
    })

    await fetch(uploadUrl('aborted.zip'), {
      method: 'PUT',
      headers: { 'content-type': 'application/zip' },
      body,
      signal: controller.signal,
      duplex: 'half',
    } as RequestInit).catch(() => undefined)

    expect(await waitForMissing(join(workspaceDir, 'aborted.zip'))).toBe(true)
  }, 30_000)
})

describe('AC4/AC5/AC9 — what the model sees for an uploaded reference', () => {
  test('a 10 MB CSV is inlined up to the cap with a truncation note pointing at the file', async () => {
    const rows = ['id,name,amount']
    let size = 0
    let i = 0
    while (size < 10 * 1024 * 1024) {
      const row = `${i},customer-${i},${(i * 3.5).toFixed(2)}`
      rows.push(row)
      size += row.length + 1
      i++
    }
    const csv = rows.join('\n')
    const res = await put('ledger.csv', new TextEncoder().encode(csv), 'text/csv')
    const { savedPath } = (await res.json()) as { savedPath: string }

    const parts: UploadedFilePart[] = [
      { type: 'file', mediaType: 'text/csv', name: 'ledger.csv', savedPath, url: 'http://x/download/ledger.csv' },
    ]
    expect(isReferenceAttachmentPart(parts[0])).toBe(true)

    const parsed = parseFileAttachments(parts, { workspaceDir })
    const text = parsed.textContext

    expect(parsed.images.length).toBe(0)
    expect(text).toContain('ledger.csv')
    // The head only — never the whole 10 MB.
    expect(text.length).toBeLessThan(MAX_INLINE_ATTACHMENT_BYTES + 1024)
    expect(text).toContain('[Truncated:')
    expect(text).toContain(savedPath)
    expect(text).toContain('read_file')
    // And the agent can reach the rest from the path the note names.
    const onDisk = readFileSync(join(workspaceDir, savedPath), 'utf-8')
    expect(onDisk.length).toBe(csv.length)
  }, 60_000)

  test('two large files in one turn stay inside the per-turn budget', async () => {
    const big = new TextEncoder().encode('x'.repeat(200 * 1024))
    await put('one.log', big, 'text/plain')
    await put('two.log', big, 'text/plain')

    const parsed = parseFileAttachments(
      [
        { type: 'file', mediaType: 'text/plain', name: 'one.log', savedPath: 'files/one.log' },
        { type: 'file', mediaType: 'text/plain', name: 'two.log', savedPath: 'files/two.log' },
      ],
      { workspaceDir },
    )
    // 256 KB turn budget + the per-file truncation heads, nothing more.
    expect(parsed.textContext.length).toBeLessThan(256 * 1024 + 32 * 1024)
  })

  test('an uploaded image still reaches the model as an image block', async () => {
    // Smallest valid PNG (1x1, transparent).
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    )
    const res = await put('pixel.png', new Uint8Array(png), 'image/png')
    const { savedPath } = (await res.json()) as { savedPath: string }

    const parsed = parseFileAttachments(
      [{ type: 'file', mediaType: 'image/png', name: 'pixel.png', savedPath }],
      { workspaceDir },
    )

    expect(parsed.images.length).toBe(1)
    expect(parsed.images[0].mimeType).toBe('image/png')
    expect(parsed.images[0].data).toBe(png.toString('base64'))
  })

  test('a legacy base64 part still works end to end (old client / eval runner)', async () => {
    const base64 = Buffer.from('legacy attachment body').toString('base64')
    const parts: UploadedFilePart[] = [
      { type: 'file', mediaType: 'text/plain', name: 'legacy.txt', url: `data:text/plain;base64,${base64}` },
    ]
    expect(isReferenceAttachmentPart(parts[0])).toBe(false)

    const { saved, savedSummaries } = saveUploadedFileParts({ workspaceDir, parts })
    expect(saved.length).toBe(1)
    expect(readFileSync(saved[0].absolutePath, 'utf-8')).toBe('legacy attachment body')

    const parsed = parseFileAttachments(parts, { workspaceDir })
    expect(parsed.textContext).toContain('legacy attachment body')
    expect(buildUploadedFilesNote(savedSummaries, false)).toContain(saved[0].savedPath)
  })
})

describe('AC8 — /agent/chat resolves a reference inside the workspace only', () => {
  test('a saved path resolves, and is listed in the agent note', async () => {
    const bytes = new TextEncoder().encode('quarterly numbers')
    await put('numbers.txt', bytes, 'text/plain')
    const resolved = resolveReferenceAttachment(workspaceDir, {
      type: 'file',
      mediaType: 'text/plain',
      name: 'numbers.txt',
      savedPath: 'files/numbers.txt',
    })

    expect(resolved === 'outside' || resolved === 'missing').toBe(false)
    if (resolved === 'outside' || resolved === 'missing') return
    expect(resolved.bytes).toBe(bytes.length)
    const note = buildUploadedFilesNote(
      [`- \`${resolved.savedPath}\` (${resolved.mediaType}, 17 B)`],
      false,
    )
    expect(note).toContain('files/numbers.txt')
  })

  test('a path that escapes the workspace is refused, and a stale one is not fatal', () => {
    expect(
      resolveReferenceAttachment(workspaceDir, {
        type: 'file',
        mediaType: 'text/plain',
        savedPath: '../../etc/passwd',
      }),
    ).toBe('outside')
    expect(
      resolveReferenceAttachment(workspaceDir, {
        type: 'file',
        mediaType: 'text/plain',
        savedPath: '/etc/passwd',
      }),
    ).toBe('outside')
    expect(
      resolveReferenceAttachment(workspaceDir, {
        type: 'file',
        mediaType: 'text/plain',
        savedPath: 'files/gone.txt',
      }),
    ).toBe('missing')
  })
})

describe('wiring — every hop forwards the upload instead of buffering it (AC2, AC6)', () => {
  const repoRoot = join(import.meta.dir, '../../../..')
  const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf-8')

  test('/agent/chat resolves reference parts and never re-saves them', () => {
    const src = read('packages/agent-runtime/src/server.ts')
    expect(src).toContain('resolveReferenceAttachment(WORKSPACE_DIR, part)')
    expect(src).toContain("code: 'invalid_attachment_path'")
    expect(src).toContain('parts: userFileParts.filter((part) => !isReferenceAttachmentPart(part))')
    expect(src).toContain('chatAttachmentRoutes({')
  })

  test('the runtime raises Bun\'s request-body cap above the attachment cap', () => {
    // Bun's own default is 128 MB and it answers with a bodiless 413 before any
    // handler runs, so a 200 MB attachment (AC1) would never reach the route.
    const src = read('packages/agent-runtime/src/server.ts')
    const declared = src.match(/maxRequestBodySize:\s*([0-9*\s]+),/)
    expect(declared).not.toBeNull()
    const bytes = (declared?.[1] ?? '0').split('*').reduce((acc, part) => acc * Number(part.trim()), 1)
    expect(bytes).toBeGreaterThanOrEqual(2 * 1024 * 1024 * 1024)
  })

  test('all three API agent-proxy hops stream the attachment path', () => {
    for (const rel of [
      'apps/api/src/routes/workspace-chat.ts',
      'apps/api/src/routes/local-agent-proxy.ts',
      'apps/api/src/server.ts',
    ]) {
      const src = read(rel)
      expect(src).toContain('isChatAttachmentUpload')
      expect(src).toContain("duplex: 'half'")
    }
    // The paired-machine tunnel cannot carry binary frames: it must say so
    // rather than corrupt the file.
    expect(read('apps/api/src/server.ts')).toContain('attachment_upload_unsupported')
  })

  test('the client persists the reference part, not the bytes', () => {
    const src = read('apps/mobile/components/chat/ChatPanel.tsx')
    expect(src).toContain('prepareOutgoingFiles(fileArray')
    expect(src).toContain('messagePayload.files = outgoingParts')
    // Nothing may put a data URL back into the outgoing parts.
    expect(src).not.toMatch(/parts\.push\(\{\s*type: "file",\s*mediaType: file\.type/)
  })
})
