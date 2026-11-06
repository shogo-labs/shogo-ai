// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The `/pool/export` shape over a real socket, because `app.request()` never
 * disconnects and the disconnect IS the bug (SHO-352).
 *
 * The host pulls an export, times out, and drops the connection mid-body.
 * Whatever the client does, the guest must end up with no descriptor left on
 * the tarball it already unlinked — otherwise the inode lives until the process
 * dies, which on Samsara was 3.6 GB across five abandoned exports.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spooledFileResponse } from '../spool'

const EXPORT_BYTES = 8 * 1024 * 1024

let spool: string
let server: ReturnType<typeof Bun.serve>

/** Spool files this process holds open after unlinking them. */
function openDeletedSpoolFds(): number {
  if (process.platform !== 'linux') return -1
  let open = 0
  for (const entry of readdirSync('/proc/self/fd')) {
    let target: string
    try {
      target = readlinkSync(join('/proc/self/fd', entry))
    } catch {
      continue
    }
    if (target.startsWith(spool) && target.endsWith(' (deleted)')) open++
  }
  return open
}

/** Open descriptors of this process — the cross-platform stand-in. */
function openFdCount(): number {
  try {
    return readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').length
  } catch {
    return -1
  }
}

async function within(ms: number, predicate: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeAll(() => {
  spool = mkdtempSync(join(tmpdir(), 'spool-route-'))
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== '/pool/export') return new Response('not found', { status: 404 })
      // Exactly what the route does: pack to the spool, then hand the path over
      // with the request's own abort signal.
      const path = join(spool, `${Date.now()}-pool-export.tar.gz`)
      writeFileSync(path, Buffer.alloc(EXPORT_BYTES, 3))
      return spooledFileResponse(path, { 'Content-Type': 'application/gzip' }, { signal: req.signal })
    },
  })
})

afterAll(() => {
  server.stop(true)
  rmSync(spool, { recursive: true, force: true })
})

describe('POST /pool/export over a real socket', () => {
  test('dropping the connection mid-body leaves no deleted spool descriptor behind', async () => {
    const fdsBefore = openFdCount()
    const ac = new AbortController()
    const res = await fetch(`http://127.0.0.1:${server.port}/pool/export`, { method: 'POST', signal: ac.signal })
    expect(res.status).toBe(200)

    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(first.value!.byteLength).toBeGreaterThan(0)

    if (process.platform === 'linux') {
      // The file is already unlinked and still open: the leak in its natural
      // state. If this ever hits 0 the test is no longer proving anything.
      expect(openDeletedSpoolFds()).toBeGreaterThan(0)
    }

    // The host gives up, exactly as it does on its export deadline.
    ac.abort()

    if (process.platform === 'linux') {
      expect(await within(2000, () => openDeletedSpoolFds() === 0)).toBe(true)
    }
    expect(await within(2000, () => openFdCount() <= fdsBefore)).toBe(true)
  })
})
