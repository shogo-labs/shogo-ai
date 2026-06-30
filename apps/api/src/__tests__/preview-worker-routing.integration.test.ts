// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration test for the *.preview.shogo.ai preview-router Cloudflare Worker —
 * specifically the wake-on-visit behavior: a preview link whose pod was never
 * provisioned (never opened in Studio) or has scaled to zero would otherwise
 * hard-fail at Kourier. The Worker now serves a loading page on the document
 * navigation and exposes a /__shogo/wake endpoint that calls the API to
 * provision + wake the pod, then reloads.
 *
 *   bun test apps/api/src/__tests__/preview-worker-routing.integration.test.ts
 *
 * Like the published-worker test, this extracts the ACTUAL worker script from
 * terraform/modules/preview-router/main.tf, substitutes the Terraform
 * interpolations, and drives requests through its real `fetch(request, env)`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ANCHOR_HOST = 'kourier-preview-us.shogo.ai'
const API_WAKE_ORIGIN = 'https://api.shogo.ai'

function extractWorkerScript(): string {
  const repoRoot = resolve(import.meta.dir, '../../../..')
  const tfPath = join(repoRoot, 'terraform/modules/preview-router/main.tf')
  const tf = readFileSync(tfPath, 'utf-8')

  const startMarker = 'content = <<-JS'
  const start = tf.indexOf(startMarker)
  if (start === -1) throw new Error('Could not find worker `content = <<-JS` heredoc in main.tf')
  const bodyStart = tf.indexOf('\n', start) + 1
  const endMatch = tf.slice(bodyStart).match(/\n\s*JS\b/)
  if (!endMatch) throw new Error('Could not find closing `JS` heredoc terminator')
  let body = tf.slice(bodyStart, bodyStart + endMatch.index!)

  // Substitute the two Terraform interpolations the script relies on.
  body = body
    .replaceAll(
      '${jsonencode({ for code, r in cloudflare_record.anchor : code => r.hostname })}',
      JSON.stringify({ us: ANCHOR_HOST }),
    )
    .replaceAll("'${var.default_region}'", JSON.stringify('us'))

  if (body.includes('${')) {
    const leftover = body.slice(body.indexOf('${'), body.indexOf('${') + 60)
    throw new Error(`Unsubstituted Terraform interpolation in worker script near: ${leftover}`)
  }
  return body
}

let workerModule: { fetch: (req: Request, env: any) => Promise<Response> }
let tmpDir: string

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'preview-worker-'))
  const modPath = join(tmpDir, 'worker.mjs')
  writeFileSync(modPath, extractWorkerScript())
  const mod = await import(modPath)
  workerModule = mod.default
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

interface RecordedCall {
  url: string
  cf?: any
}
let calls: RecordedCall[] = []
const realFetch = globalThis.fetch

function installFetch(handler: (url: string) => { status: number; body?: string }) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = input instanceof Request ? input.url : typeof input === 'string' ? input : input.url
    calls.push({ url, cf: init?.cf })
    const { status, body } = handler(url)
    return new Response(body ?? '', { status })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
  calls = []
})

function makeEnv(opts: { apiWakeOrigin?: string; region?: string } = {}): any {
  return {
    PREVIEW_REGIONS: { get: async () => opts.region ?? 'us' },
    ...(opts.apiWakeOrigin ? { API_WAKE_ORIGIN: opts.apiWakeOrigin } : {}),
  }
}

describe('preview-router worker — wake-on-visit', () => {
  test('/__shogo/wake calls the API wake endpoint and returns its readiness', async () => {
    installFetch((url) =>
      url.includes('/api/preview/') ? { status: 200, body: '{"ready":true}' } : { status: 404 },
    )
    const env = makeEnv({ apiWakeOrigin: API_WAKE_ORIGIN })
    const req = new Request('https://p1.preview.shogo.ai/__shogo/wake')

    const res = await workerModule.fetch(req, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ready: true })
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe(`${API_WAKE_ORIGIN}/api/preview/p1/wake`)
  })

  test('document navigation on a not-ready preview returns the loading page', async () => {
    installFetch((url) =>
      url.includes('/api/preview/') ? { status: 200, body: '{"ready":false}' } : { status: 200, body: '<html>preview</html>' },
    )
    const env = makeEnv({ apiWakeOrigin: API_WAKE_ORIGIN })
    const req = new Request('https://p1.preview.shogo.ai/', { headers: { Accept: 'text/html' } })

    const res = await workerModule.fetch(req, env)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Waking things up')
    expect(html).toContain('/__shogo/wake')
    // Only the API wake call ran; the preview was NOT proxied while not ready.
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe(`${API_WAKE_ORIGIN}/api/preview/p1/wake`)
  })

  test('document navigation on a ready preview proxies transparently to Kourier', async () => {
    installFetch((url) =>
      url.includes('/api/preview/') ? { status: 200, body: '{"ready":true}' } : { status: 200, body: '<html>live</html>' },
    )
    const env = makeEnv({ apiWakeOrigin: API_WAKE_ORIGIN })
    const req = new Request('https://p1.preview.shogo.ai/', { headers: { Accept: 'text/html' } })

    const res = await workerModule.fetch(req, env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>live</html>')
    // Proxied to the regional Kourier anchor via resolveOverride.
    const proxied = calls.find((c) => c.cf?.resolveOverride)
    expect(proxied?.cf?.resolveOverride).toBe(ANCHOR_HOST)
  })

  test('without API_WAKE_ORIGIN, documents proxy transparently (no behavior change)', async () => {
    installFetch(() => ({ status: 200, body: '<html>x</html>' }))
    const env = makeEnv({}) // no API origin configured
    const req = new Request('https://p1.preview.shogo.ai/', { headers: { Accept: 'text/html' } })

    const res = await workerModule.fetch(req, env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>x</html>')
    // No API wake call; straight proxy to the anchor.
    expect(calls.every((c) => !c.url.includes('/api/preview/'))).toBe(true)
    const proxied = calls.find((c) => c.cf?.resolveOverride)
    expect(proxied?.cf?.resolveOverride).toBe(ANCHOR_HOST)
  })
})
