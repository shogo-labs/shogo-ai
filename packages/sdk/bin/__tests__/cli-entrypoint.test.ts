// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `shogo bucket` through the PUBLISHED entry point (SHO-491).
 *
 * `cli.mjs` parses argv once, with only the generate/deploy/3d options declared
 * and `strict: false`. Under that parser every bucket flag is an unknown option,
 * so unless the bucket command gets the raw argv it never sees `--private`,
 * `--key`, `--min-size` or the rest — and `shogo bucket put secret.pdf
 * --private` would happily store the file public on the CDN. `bucket-cli.test.ts`
 * calls `runBucketCommand` directly and cannot catch that, so these tests spawn
 * the real binary and assert on what the API actually received.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'cli.mjs')

interface Recorded {
  method: string
  path: string
  query: URLSearchParams
  headers: Headers
  body: string
}

let server: ReturnType<typeof Bun.serve> | null = null
let base = ''
let recorded: Recorded[] = []
let work = ''

const savedEnv: Record<string, string | undefined> = {}
const ENV = ['SHOGO_API_URL', 'PROJECT_ID', 'RUNTIME_AUTH_SECRET', 'SHOGO_API_KEY'] as const

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

function startStub() {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const entry: Recorded = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        headers: request.headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text(),
      }
      recorded.push(entry)

      // The presigned PUT a real bucket would receive.
      if (entry.path.startsWith('/upload/')) {
        return new Response(null, { status: 200, headers: { etag: '"etag-1"' } })
      }
      if (entry.path === '/api/projects/p_media/bucket/uploads') {
        const ticket = JSON.parse(entry.body || '{}')
        return json({
          uploadId: 'up_1',
          mode: 'single',
          key: ticket.key,
          visibility: ticket.visibility,
          size: ticket.size,
          url: `${base}/upload/up_1`,
          headers: { 'content-type': ticket.contentType },
        })
      }
      if (entry.path === '/api/projects/p_media/bucket/uploads/up_1/complete') {
        return json({ key: 'stored', size: 11, publicUrl: `${base}/stored`, visibility: 'private' })
      }
      if (entry.path === '/api/projects/p_media/bucket/objects') {
        return json({ objects: [], cursor: null })
      }
      return json({ error: { code: 'not_found', message: entry.path } }, 404)
    },
  })
  base = `http://127.0.0.1:${server.port}`
}

/**
 * Run the published CLI the way an agent's shell does. Async on purpose: the
 * stub API lives in this process, so a blocking spawnSync would deadlock — the
 * child waits on a server whose event loop is stuck in spawnSync.
 */
async function runCli(args: string[]) {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    cwd: work,
    env: {
      ...process.env,
      SHOGO_API_URL: base,
      PROJECT_ID: 'p_media',
      RUNTIME_AUTH_SECRET: 'rt_test',
      SHOGO_API_KEY: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => proc.kill(), 10_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { exitCode, stdout, stderr }
}

const ticketBodies = () =>
  recorded
    .filter((r) => r.path === '/api/projects/p_media/bucket/uploads' && r.method === 'POST')
    .map((r) => JSON.parse(r.body))

beforeEach(() => {
  recorded = []
  work = mkdtempSync(join(tmpdir(), 'shogo-cli-entry-'))
  for (const name of ENV) savedEnv[name] = process.env[name]
  startStub()
})

afterEach(() => {
  server?.stop(true)
  server = null
  rmSync(work, { recursive: true, force: true })
  for (const name of ENV) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
})

describe('flags reach the bucket command through cli.mjs', () => {
  test('`bucket put secret.pdf --private` uploads it private', async () => {
    const file = join(work, 'secret.pdf')
    writeFileSync(file, 'hello world')

    const result = await runCli(['bucket', 'put', file, '--private'])
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)

    const tickets = ticketBodies()
    expect(tickets).toHaveLength(1)
    expect(tickets[0]).toMatchObject({
      key: basename(file),
      visibility: 'private',
      size: 11,
      contentType: 'application/pdf',
    })
  })

  test('`bucket put f --key media/clip.mp4` takes the key, not a second path', async () => {
    const file = join(work, 'clip.bin')
    writeFileSync(file, 'x'.repeat(32))

    const result = await runCli(['bucket', 'put', file, '--key', 'media/clip.mp4', '--overwrite'])
    // The bug read `--key`'s value as another file path and ENOENTed on it.
    expect(result.stderr).not.toContain('ENOENT')
    expect(result.exitCode).toBe(0)

    const tickets = ticketBodies()
    expect(tickets).toHaveLength(1)
    expect(tickets[0]).toMatchObject({ key: 'media/clip.mp4', visibility: 'public', overwrite: true })
  })

  test('`bucket ls media --private --json` asks for the private namespace', async () => {
    const result = await runCli(['bucket', 'ls', 'media', '--private', '--json'])
    expect(result.exitCode).toBe(0)

    const list = recorded.find((r) => r.path === '/api/projects/p_media/bucket/objects')
    expect(list?.query.get('visibility')).toBe('private')
    expect(list?.query.get('prefix')).toBe('media')
    expect(JSON.parse(result.stdout)).toEqual({ objects: [] })
  })
})
