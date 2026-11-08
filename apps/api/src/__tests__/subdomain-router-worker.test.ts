/**
 * The subdomain-router Worker lives inline in Terraform. These tests render
 * its script from main.tf and drive it with a mocked fetch + KV to pin the
 * custom-domain routing for Knative-backed apps: a custom domain runs the
 * Worker in the Cloudflare-for-SaaS zone, where a resolveOverride to the
 * publish zone's Kourier record is ignored and 522s, so those requests must
 * go to the platform host instead.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MAIN_TF = resolve(import.meta.dir, '../../../../terraform/modules/publish-hosting-oci/main.tf')

async function loadWorker() {
  const tf = readFileSync(MAIN_TF, 'utf8')
  const start = tf.indexOf('content = <<-JS\n')
  const end = tf.indexOf('\n  JS\n', start)
  const js = tf
    .slice(start + 'content = <<-JS\n'.length, end)
    .replaceAll("'${var.publish_domain}'", "'shogo.one'")
    .replaceAll("'${local.par_base_url}'", "'https://objectstorage.example/p/x/n/ns/b/bucket/o'")
    .replaceAll('$${', '${')
  const dir = mkdtempSync(join(tmpdir(), 'subdomain-router-'))
  const file = join(dir, 'worker.mjs')
  writeFileSync(file, js)
  try {
    return (await import(file)).default as { fetch(req: Request, env: unknown): Promise<Response> }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

type Call = { url: string; init?: { cf?: { resolveOverride?: string } } }
const realFetch = globalThis.fetch
let calls: Call[] = []

function mockFetch() {
  calls = []
  globalThis.fetch = (async (req: Request | string, init?: Call['init']) => {
    const url = typeof req === 'string' ? req : req.url
    calls.push({ url, init })
    if (url.endsWith('/__shogo/wake')) return new Response('{"ready":true}', { status: 200 })
    return new Response('ok', { status: 200 })
  }) as unknown as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
})

const kv = (m: Record<string, string>) => ({ get: async (k: string) => m[k] ?? null })
const env = {
  CUSTOM_DOMAINS: kv({ 'acme.example': '{"s":"acme","c":"acme.example"}' }),
  SERVER_BACKED: kv({ acme: 'knative' }),
  KOURIER_ORIGIN: 'https://kourier-us.shogo.one',
}

describe('subdomain-router worker: knative backend', () => {
  test('custom-domain wake probes the platform host without resolveOverride', async () => {
    const worker = await loadWorker()
    mockFetch()
    const res = await worker.fetch(new Request('https://acme.example/__shogo/wake'), env)
    expect(await res.json()).toEqual({ ready: true })
    expect(calls[0].url).toBe('https://acme.shogo.one/__shogo/wake')
    expect(calls[0].init?.cf).toBeUndefined()
  })

  test('custom-domain /api is forwarded to the platform host without resolveOverride', async () => {
    const worker = await loadWorker()
    mockFetch()
    await worker.fetch(new Request('https://acme.example/api/schedule?x=1'), env)
    expect(calls[0].url).toBe('https://acme.shogo.one/api/schedule?x=1')
    expect(calls[0].init?.cf).toBeUndefined()
  })

  test('custom-domain navigation serves the site once the platform reports ready', async () => {
    const worker = await loadWorker()
    mockFetch()
    const res = await worker.fetch(new Request('https://acme.example/', { headers: { accept: 'text/html' } }), env)
    expect(calls[0].url).toBe('https://acme.shogo.one/__shogo/wake')
    expect(await res.text()).not.toContain('Waking')
  })

  test('platform host keeps the same-zone Kourier resolveOverride', async () => {
    const worker = await loadWorker()
    mockFetch()
    await worker.fetch(new Request('https://acme.shogo.one/api/schedule'), env)
    expect(calls[0].url).toBe('https://acme.shogo.one/api/schedule')
    expect(calls[0].init?.cf?.resolveOverride).toBe('kourier-us.shogo.one')

    mockFetch()
    await worker.fetch(new Request('https://acme.shogo.one/__shogo/wake'), env)
    expect(calls[0].url).toBe('https://acme.shogo.one/ready')
    expect(calls[0].init?.cf?.resolveOverride).toBe('kourier-us.shogo.one')
  })
})
