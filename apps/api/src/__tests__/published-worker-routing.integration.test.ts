// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration test for the *.shogo.one subdomain-router Cloudflare Worker —
 * specifically the SERVER-BACKED `/api/*` proxy that is the fix for "the
 * server doesn't work in published apps" (dynamic API calls returning the
 * HTML shell instead of JSON).
 *
 *   bun test apps/api/src/__tests__/published-worker-routing.integration.test.ts
 *
 * Rather than re-implement the routing logic, this test extracts the ACTUAL
 * worker script shipped in terraform/modules/publish-hosting-oci/main.tf,
 * substitutes the Terraform interpolations with test values, loads it as a
 * real ES module, and drives requests through its `fetch(request, env)` with a
 * fake KV + a recording `fetch`. So a regression in the deployed worker's
 * routing is caught here.
 *
 * Asserted:
 *   - `/api/*` on a server-backed subdomain → proxied to KOURIER_ORIGIN (the
 *     Knative ingress), NOT Object Storage, carrying the published host.
 *   - static paths on the same subdomain → still served from Object Storage.
 *   - `/api/*` on a NON-server-backed subdomain → served from Object Storage
 *     (unchanged legacy behavior — no accidental proxying).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const OCI_ORIGIN = 'https://objectstorage.test/p/par123/o'
const KOURIER_ORIGIN = 'https://ingress.shogo.test'
const PUBLISH_DOMAIN = 'shogo.one'

// ─── Extract the real worker script from terraform ──────────────────────────

function extractWorkerScript(): string {
  // apps/api/src/__tests__ → repo root is four levels up.
  const repoRoot = resolve(import.meta.dir, '../../../..')
  const tfPath = join(repoRoot, 'terraform/modules/publish-hosting-oci/main.tf')
  const tf = readFileSync(tfPath, 'utf-8')

  const startMarker = 'content = <<-JS'
  const start = tf.indexOf(startMarker)
  if (start === -1) throw new Error('Could not find worker `content = <<-JS` heredoc in main.tf')
  const bodyStart = tf.indexOf('\n', start) + 1
  // The heredoc terminator is a line containing only optional whitespace + `JS`.
  const endMatch = tf.slice(bodyStart).match(/\n\s*JS\b/)
  if (!endMatch) throw new Error('Could not find closing `JS` heredoc terminator')
  let body = tf.slice(bodyStart, bodyStart + endMatch.index!)

  // Substitute the Terraform interpolations the worker relies on. These are
  // the ONLY `${...}` tokens in the script (ORIGIN_BASE + PUBLISH_DOMAIN).
  body = body
    .replaceAll("'${local.par_base_url}'", JSON.stringify(OCI_ORIGIN))
    .replaceAll("'${var.publish_domain}'", JSON.stringify(PUBLISH_DOMAIN))

  if (body.includes('${')) {
    const leftover = body.slice(body.indexOf('${'), body.indexOf('${') + 60)
    throw new Error(`Unsubstituted Terraform interpolation in worker script near: ${leftover}`)
  }
  return body
}

let workerModule: { fetch: (req: Request, env: any) => Promise<Response> }
let tmpDir: string

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'worker-routing-'))
  const modPath = join(tmpDir, 'worker.mjs')
  writeFileSync(modPath, extractWorkerScript())
  const mod = await import(modPath)
  workerModule = mod.default
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ─── Recording fetch ────────────────────────────────────────────────────────

interface RecordedCall {
  url: string
  headers: Record<string, string>
  // Cloudflare-specific request init (`{ cf: { resolveOverride } }`) passed as
  // fetch's second arg. The server-backed proxy keeps the published host in the
  // URL and only overrides DNS resolution to the Kourier ingress via this.
  cf?: any
}
let calls: RecordedCall[] = []
const realFetch = globalThis.fetch

function installFetch(handler: (url: string) => { status: number; body?: string }) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const req: Request | null = input instanceof Request ? input : null
    const url = req ? req.url : typeof input === 'string' ? input : input.url
    const headers: Record<string, string> = {}
    if (req) req.headers.forEach((v, k) => { headers[k] = v })
    calls.push({ url, headers, cf: init?.cf })
    const { status, body } = handler(url)
    return new Response(body ?? '', { status })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
  calls = []
})

// A fake server-backed env: KV says `august-...` is server-backed, others not.
function makeEnv(serverBackedSubdomains: string[]): any {
  return {
    KOURIER_ORIGIN,
    SERVER_BACKED: {
      get: async (key: string) => (serverBackedSubdomains.includes(key) ? '1' : null),
    },
    // No custom-domain KV in these tests (platform subdomains only).
    CUSTOM_DOMAINS: undefined,
  }
}

describe('subdomain-router worker — server-backed /api proxy', () => {
  test('/api/* on a server-backed subdomain is proxied to the Knative ingress, not OCI', async () => {
    installFetch(() => ({ status: 200, body: '{"id":"McCailey"}' }))
    const env = makeEnv(['august-29th-celebration-portal'])
    const req = new Request('https://august-29th-celebration-portal.shogo.one/api/collab/by-name/McCailey')

    const res = await workerModule.fetch(req, env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('{"id":"McCailey"}')

    // Exactly one upstream call. The worker keeps the PUBLISHED host in the
    // request URL (so Cloudflare sends Host: {subdomain}.{publish_domain}, which
    // the DomainMapping routes to published-{id}) and only overrides DNS
    // resolution to the Kourier ingress host via cf.resolveOverride.
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('https://august-29th-celebration-portal.shogo.one/api/collab/by-name/McCailey')
    expect(calls[0].cf?.resolveOverride).toBe(KOURIER_ORIGIN.replace(/^https?:\/\//, ''))
    expect(calls[0].url.startsWith(OCI_ORIGIN)).toBe(false)
    // The published host is forwarded so the DomainMapping resolves at Kourier.
    // (`Host` is a forbidden fetch header in this runtime, so assert the
    // explicit X-Forwarded-Host the worker also sets.)
    expect(calls[0].headers['x-forwarded-host']).toBe('august-29th-celebration-portal.shogo.one')
  })

  test('static path on a server-backed subdomain still serves from Object Storage', async () => {
    installFetch(() => ({ status: 200, body: '<html>app</html>' }))
    const env = makeEnv(['august-29th-celebration-portal'])
    const req = new Request('https://august-29th-celebration-portal.shogo.one/assets/app.js')

    const res = await workerModule.fetch(req, env)
    expect(res.status).toBe(200)
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe(`${OCI_ORIGIN}/august-29th-celebration-portal/assets/app.js`)
  })

  test('/api/* on a NON-server-backed subdomain is NOT proxied (legacy static behavior)', async () => {
    // Static app: /api/* 404s at OCI, then the worker SPA-fallbacks to index.html.
    installFetch((url) => {
      if (url.endsWith('/api/whatever')) return { status: 404 }
      return { status: 200, body: '<html>spa</html>' }
    })
    const env = makeEnv([]) // nothing server-backed
    const req = new Request('https://plain-static-site.shogo.one/api/whatever')

    const res = await workerModule.fetch(req, env)
    // Never touches the Kourier ingress.
    for (const c of calls) expect(c.url.startsWith(KOURIER_ORIGIN)).toBe(false)
    // First hit OCI for the /api path, then OCI again for the SPA fallback.
    expect(calls[0].url).toBe(`${OCI_ORIGIN}/plain-static-site/api/whatever`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>spa</html>')
  })

  test('root path serves index.html from Object Storage', async () => {
    installFetch(() => ({ status: 200, body: '<html>home</html>' }))
    const env = makeEnv(['august-29th-celebration-portal'])
    const req = new Request('https://august-29th-celebration-portal.shogo.one/')

    await workerModule.fetch(req, env)
    expect(calls[0].url).toBe(`${OCI_ORIGIN}/august-29th-celebration-portal/index.html`)
  })
})

// Wake-on-visit: a server-backed published app scales to zero when idle. The
// Worker serves a loading page for cold document navigations and exposes a
// /__shogo/wake control endpoint the page polls (which probes published-{id}
// /ready through Kourier, waking the pod via the activator).
describe('subdomain-router worker — wake-on-visit', () => {
  test('/__shogo/wake on a server-backed subdomain probes the pod /ready via Kourier', async () => {
    installFetch((url) => (url.endsWith('/ready') ? { status: 200 } : { status: 404 }))
    const env = makeEnv(['august-29th-celebration-portal'])
    const req = new Request('https://august-29th-celebration-portal.shogo.one/__shogo/wake')

    const res = await workerModule.fetch(req, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ready: true })
    // Probed the published host's /ready, resolving DNS to the Kourier ingress.
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('https://august-29th-celebration-portal.shogo.one/ready')
    expect(calls[0].cf?.resolveOverride).toBe(KOURIER_ORIGIN.replace(/^https?:\/\//, ''))
  })

  test('/__shogo/wake reports not-ready while the pod is cold (503)', async () => {
    installFetch(() => ({ status: 503 }))
    const env = makeEnv(['august-29th-celebration-portal'])
    const req = new Request('https://august-29th-celebration-portal.shogo.one/__shogo/wake')

    const res = await workerModule.fetch(req, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ready: false })
  })

  test('/__shogo/wake on a NON-server-backed subdomain is always ready (no pod to wake)', async () => {
    installFetch(() => ({ status: 200 }))
    const env = makeEnv([]) // nothing server-backed
    const req = new Request('https://plain-static-site.shogo.one/__shogo/wake')

    const res = await workerModule.fetch(req, env)
    expect(await res.json()).toEqual({ ready: true })
    expect(calls.length).toBe(0) // never probes upstream
  })

  test('document navigation on a COLD server-backed app returns the loading page', async () => {
    installFetch((url) => (url.endsWith('/ready') ? { status: 503 } : { status: 200, body: '<html>app</html>' }))
    const env = makeEnv(['august-29th-celebration-portal'])
    const req = new Request('https://august-29th-celebration-portal.shogo.one/', {
      headers: { Accept: 'text/html' },
    })

    const res = await workerModule.fetch(req, env)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Waking things up')
    expect(html).toContain('/__shogo/wake')
    // Only the readiness probe ran; the OCI shell was NOT served while cold.
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('https://august-29th-celebration-portal.shogo.one/ready')
  })

  test('document navigation on a WARM server-backed app serves the shell from OCI', async () => {
    installFetch((url) => (url.endsWith('/ready') ? { status: 200 } : { status: 200, body: '<html>home</html>' }))
    const env = makeEnv(['august-29th-celebration-portal'])
    const req = new Request('https://august-29th-celebration-portal.shogo.one/', {
      headers: { Accept: 'text/html' },
    })

    const res = await workerModule.fetch(req, env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>home</html>')
    // Probe first (warm), then OCI index.html.
    const ociCall = calls.find((c) => c.url.startsWith(OCI_ORIGIN))
    expect(ociCall?.url).toBe(`${OCI_ORIGIN}/august-29th-celebration-portal/index.html`)
  })

  test('document navigation on a STATIC app skips the wake probe entirely', async () => {
    installFetch(() => ({ status: 200, body: '<html>static</html>' }))
    const env = makeEnv([]) // not server-backed
    const req = new Request('https://plain-static-site.shogo.one/', {
      headers: { Accept: 'text/html' },
    })

    const res = await workerModule.fetch(req, env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>static</html>')
    // Straight to OCI — no /ready probe for a static app.
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe(`${OCI_ORIGIN}/plain-static-site/index.html`)
  })
})
