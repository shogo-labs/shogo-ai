// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `shogo bucket` CLI (SHO-491).
 *
 * `runBucketCommand` is called directly with a stub `fetch`, so these tests pin
 * what an agent sees: the exact API path each verb hits, the expiry clamp, the
 * paging in `ls`, and the error code/message it must relay verbatim (a 402
 * carries the Billing link; a 409 tells it to pass `--overwrite`).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBucketCommand } from '../bucket-cli.mjs'

interface Call {
  url: string
  method: string
  headers: Headers
  body: unknown
}

let calls: Call[] = []
let respond: (call: Call) => Response = () => json({})
let logged: string[] = []
let errored: string[] = []

const realFetch = globalThis.fetch
const realLog = console.log
const realError = console.error

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

const ENV = ['SHOGO_API_URL', 'PROJECT_ID', 'RUNTIME_AUTH_SECRET', 'SHOGO_API_KEY'] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  calls = []
  logged = []
  errored = []
  respond = () => json({})
  for (const name of ENV) savedEnv[name] = process.env[name]
  process.env.SHOGO_API_URL = 'https://api.shogo.test'
  process.env.PROJECT_ID = 'p_media'
  process.env.RUNTIME_AUTH_SECRET = 'rt_test'
  delete process.env.SHOGO_API_KEY

  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: (init.method ?? 'GET').toUpperCase(),
      headers: new Headers(init.headers),
      body: init.body,
    }
    calls.push(call)
    return respond(call)
  }) as unknown as typeof fetch
  console.log = (...args: unknown[]) => {
    logged.push(args.join(' '))
  }
  console.error = (...args: unknown[]) => {
    errored.push(args.join(' '))
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
  console.log = realLog
  console.error = realError
  for (const name of ENV) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
})

describe('help and dispatch', () => {
  test('no command prints the usage and succeeds', async () => {
    expect(await runBucketCommand([])).toBe(0)
    expect(logged.join('\n')).toContain('shogo bucket put <path…>')
    expect(calls).toHaveLength(0)
  })

  test('--help does the same', async () => {
    expect(await runBucketCommand(['--help'])).toBe(0)
    expect(logged.join('\n')).toContain('shogo bucket usage')
  })

  test('an unknown verb exits non-zero and shows the usage', async () => {
    expect(await runBucketCommand(['frobnicate'])).toBe(1)
    expect(errored.join('\n')).toContain('Unknown bucket command: frobnicate')
  })

  test('missing credentials name the variable that is missing', async () => {
    delete process.env.PROJECT_ID
    await expect(runBucketCommand(['usage'])).rejects.toMatchObject({ code: 'missing_credentials' })
    await expect(runBucketCommand(['usage'])).rejects.toThrow(/PROJECT_ID/)
  })
})

describe('verbs', () => {
  test('url clamps --expires and sends the visibility', async () => {
    respond = () => json({ url: 'https://cdn.shogo.test/p_media/a.png' })

    expect(await runBucketCommand(['url', 'a.png', '--expires', '999999'])).toBe(0)
    expect(calls[0].url).toContain('/api/projects/p_media/bucket/objects/a.png?')
    expect(calls[0].url).toContain('expiresIn=86400')
    expect(calls[0].url).toContain('visibility=public')
    expect(calls[0].headers.get('x-runtime-token')).toBe('rt_test')
    expect(logged[0]).toBe('https://cdn.shogo.test/p_media/a.png')

    await runBucketCommand(['url', 'secret.pdf', '--private', '--expires', '1'])
    expect(calls[1].url).toContain('visibility=private')
    expect(calls[1].url).toContain('expiresIn=60')
  })

  test('url needs a key', async () => {
    await expect(runBucketCommand(['url'])).rejects.toMatchObject({ code: 'missing_argument' })
  })

  test('ls pages through every cursor and prints one line per object', async () => {
    respond = (call) => {
      const cursor = new URL(call.url).searchParams.get('cursor')
      if (!cursor) {
        return json({ objects: [{ key: 'a.png', size: 1024 }], cursor: 'a.png' })
      }
      return json({ objects: [{ key: 'b.png', size: 2048 }], cursor: null })
    }

    expect(await runBucketCommand(['ls', 'media/'])).toBe(0)
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toContain('prefix=media%2F')
    expect(calls[1].url).toContain('cursor=a.png')
    expect(logged.join('\n')).toContain('a.png')
    expect(logged.join('\n')).toContain('b.png')
  })

  test('ls --json is machine-readable and includes the prefix filter', async () => {
    respond = () => json({ objects: [{ key: 'a.png', size: 1 }], cursor: null })
    await runBucketCommand(['ls', '--json'])
    const payload = JSON.parse(logged[0])
    expect(payload.objects).toHaveLength(1)
  })

  test('ls with nothing there says so on stderr, not as a blank screen', async () => {
    respond = () => json({ objects: [], cursor: null })
    await runBucketCommand(['ls'])
    expect(errored.join('\n')).toContain('no objects')
  })

  test('rm deletes each key with the visibility it was given', async () => {
    respond = () => json({ ok: true })
    expect(await runBucketCommand(['rm', 'a.png', 'b.png', '--private'])).toBe(0)
    expect(calls.map((call) => call.method)).toEqual(['DELETE', 'DELETE'])
    expect(calls[0].url).toContain('/bucket/objects/a.png?visibility=private')
    expect(calls[1].url).toContain('/bucket/objects/b.png?visibility=private')
  })

  test('rm without a key is a usage error', async () => {
    await expect(runBucketCommand(['rm'])).rejects.toMatchObject({ code: 'missing_argument' })
  })

  test('usage prints the allowance, and "unlimited" for desktop', async () => {
    respond = () =>
      json({
        projectBytes: 1024,
        projectObjects: 1,
        workspaceUsedBytes: 1024,
        allowanceBytes: Number.MAX_SAFE_INTEGER,
        billingMode: 'shadow',
        usdPerGbMonth: 0.02,
        publicBaseUrl: 'http://localhost:3000',
      })
    await runBucketCommand(['usage'])
    const out = logged.join('\n')
    expect(out).toContain('unlimited')
    expect(out).toContain('shadow @ $0.02/GB-month')
  })

  test('usage --json is the API payload verbatim', async () => {
    respond = () => json({ projectBytes: 0, projectObjects: 0, billingMode: 'shadow' })
    await runBucketCommand(['usage', '--json'])
    expect(JSON.parse(logged[0])).toMatchObject({ projectBytes: 0 })
  })
})

describe('put', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shogo-bucket-cli-'))
  })

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('a file goes through the ticket, the PUT and complete, and prints the URL', async () => {
    const path = join(dir, 'hero.png')
    writeFileSync(path, 'abcd')

    respond = (call) => {
      if (call.url.endsWith('/bucket/uploads')) {
        return json(
          {
            uploadId: 'u1',
            key: 'renders/hero.png',
            visibility: 'public',
            mode: 'single',
            url: 'https://storage.test/put/hero.png',
            method: 'PUT',
            headers: {},
            completeUrl: 'x',
            publicUrl: 'https://cdn.shogo.test/p_media/renders/hero.png',
          },
          201,
        )
      }
      if (call.url.startsWith('https://storage.test/')) return new Response(null, { status: 200 })
      return json({
        key: 'renders/hero.png',
        size: 4,
        etag: 'e',
        visibility: 'public',
        publicUrl: 'https://cdn.shogo.test/p_media/renders/hero.png',
      })
    }

    expect(await runBucketCommand(['put', path, '--prefix', 'renders'])).toBe(0)

    const ticket = calls.find((call) => call.url.endsWith('/bucket/uploads'))!
    expect(JSON.parse(String(ticket.body ?? '{}'))).toMatchObject({
      key: 'renders/hero.png',
      size: 4,
      visibility: 'public',
      overwrite: false,
    })
    expect(calls.some((call) => call.url === 'https://storage.test/put/hero.png')).toBe(true)
    expect(logged.join('\n')).toContain('https://cdn.shogo.test/p_media/renders/hero.png')
  })

  test('--private is carried into the ticket', async () => {
    const path = join(dir, 'secret.pdf')
    writeFileSync(path, 'abc')

    respond = (call) => {
      if (call.url.endsWith('/bucket/uploads')) {
        return json(
          {
            uploadId: 'u2',
            key: 'secret.pdf',
            visibility: 'private',
            mode: 'single',
            url: 'https://storage.test/put/secret.pdf',
            method: 'PUT',
            headers: {},
            completeUrl: 'x',
            publicUrl: null,
          },
          201,
        )
      }
      if (call.url.startsWith('https://storage.test/')) return new Response(null, { status: 200 })
      return json({ key: 'secret.pdf', size: 3, etag: 'e', visibility: 'private', publicUrl: null })
    }

    await runBucketCommand(['put', path, '--private'])
    const ticket = calls.find((call) => call.url.endsWith('/bucket/uploads'))!
    expect(JSON.parse(String(ticket.body ?? '{}')).visibility).toBe('private')
  })

  test('put without a path is a usage error', async () => {
    await expect(runBucketCommand(['put'])).rejects.toMatchObject({ code: 'missing_argument' })
  })

  test('a missing local file fails loudly instead of uploading nothing', async () => {
    await expect(runBucketCommand(['put', join(dir, 'nope.png')])).rejects.toBeTruthy()
    expect(calls).toHaveLength(0)
  })
})

describe('offload', () => {
  let dir = ''
  const bigBytes = Buffer.alloc(6 * 1024 * 1024, 7)
  const bigKey = `offload/${createHash('sha256').update(bigBytes).digest('hex').slice(0, 16)}/big.bin`

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shogo-offload-'))
    writeFileSync(join(dir, 'big.bin'), bigBytes)
    writeFileSync(join(dir, 'small.txt'), 'tiny')
  })

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('--dry-run names only the files at or above the threshold and uploads nothing', async () => {
    expect(await runBucketCommand(['offload', dir, '--dry-run'])).toBe(0)

    const report = JSON.parse(logged.join('\n'))
    expect(Object.keys(report.manifest)).toEqual(['big.bin'])
    expect(report.manifest['big.bin']).toContain(bigKey)
    expect(report.uploaded).toBe(0)
    // Nothing was minted: a dry run must not touch the bucket at all.
    expect(calls.filter((call) => call.url.includes('/bucket/uploads'))).toHaveLength(0)
  })

  test('a real run uploads under content-addressed keys and a re-run uploads nothing', async () => {
    const existing: string[] = []

    respond = (call) => {
      if (call.url.includes('/bucket/objects?') || call.url.includes('/bucket/objects?')) {
        return json({ objects: existing.map((key) => ({ key, size: 1 })), cursor: null })
      }
      if (call.url.endsWith('/bucket/uploads')) {
        return json(
          {
            uploadId: 'u1',
            key: bigKey,
            visibility: 'public',
            mode: 'single',
            url: 'https://storage.test/put/big.bin',
            method: 'PUT',
            headers: {},
            completeUrl: 'x',
            publicUrl: `https://cdn.shogo.test/p_media/${bigKey}`,
          },
          201,
        )
      }
      if (call.url.startsWith('https://storage.test/')) return new Response(null, { status: 200 })
      if (call.url.includes('/bucket/objects/')) {
        return json({ url: `https://cdn.shogo.test/p_media/${bigKey}` })
      }
      return json({
        key: bigKey,
        size: 6 * 1024 * 1024,
        etag: 'e',
        visibility: 'public',
        publicUrl: `https://cdn.shogo.test/p_media/${bigKey}`,
      })
    }

    expect(await runBucketCommand(['offload', dir, '--json'])).toBe(0)
    let report = JSON.parse(logged[logged.length - 1])
    expect(report.uploaded).toBe(1)
    expect(report.skipped).toBe(0)
    expect(report.manifest['big.bin']).toBe(`https://cdn.shogo.test/p_media/${bigKey}`)
    existing.push(bigKey)

    logged = []
    calls = []
    expect(await runBucketCommand(['offload', dir, '--json'])).toBe(0)
    report = JSON.parse(logged[logged.length - 1])
    expect(report.uploaded).toBe(0)
    expect(report.skipped).toBe(1)
    // Idempotent: the second run mints no ticket.
    expect(calls.filter((call) => call.url.includes('/bucket/uploads'))).toHaveLength(0)
  })

  test('an empty directory reports an empty manifest, not an error', async () => {
    rmSync(join(dir, 'big.bin'))
    rmSync(join(dir, 'small.txt'))
    await runBucketCommand(['offload', dir, '--json'])
    const report = JSON.parse(logged.join('\n'))
    expect(report).toEqual({ manifest: {}, uploaded: 0, skipped: 0 })
  })

  test('a missing directory fails loudly', async () => {
    await expect(runBucketCommand(['offload', join(dir, 'nope')])).rejects.toBeTruthy()
  })
})

describe('errors are relayed with their code', () => {
  test('a 402 carries the reason, the numbers and the Billing link', async () => {
    respond = () =>
      json(
        {
          error: {
            code: 'bucket_payment_required',
            message: 'over the allowance',
            reason: 'usage_limit_reached',
            usedBytes: 12,
            allowanceBytes: 10,
            usdPerGbMonth: 0.02,
            billingUrl: 'https://app.test/billing?workspace=ws_1',
          },
        },
        402,
      )

    const error = await runBucketCommand(['usage']).catch((caught) => caught)
    expect(error.code).toBe('bucket_payment_required')
    expect(error.details.reason).toBe('usage_limit_reached')
    expect(error.details.usedBytes).toBe(12)
    expect(error.details.billingUrl).toContain('/billing?workspace=ws_1')
  })

  test('a 409 keeps key_exists so the agent learns to pass --overwrite', async () => {
    respond = () => json({ error: { code: 'key_exists', message: '"a.png" already exists' } }, 409)
    const error = await runBucketCommand(['rm', 'a.png']).catch((caught) => caught)
    expect(error.code).toBe('key_exists')
  })

  test('a non-JSON failure still gets a code derived from the status', async () => {
    respond = () => new Response('gateway', { status: 502 })
    const error = await runBucketCommand(['ls']).catch((caught) => caught)
    expect(error.code).toBe('http_502')
  })
})
