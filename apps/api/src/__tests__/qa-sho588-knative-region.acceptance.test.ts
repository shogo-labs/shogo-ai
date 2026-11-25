/**
 * SHO-588 acceptance — the seam between what the API WRITES into the
 * SERVER_BACKED KV namespace and how the `*.shogo.one` Worker ROUTES it.
 *
 * The bug lived exactly on that seam: the API wrote a region-less `knative`,
 * and the Worker had one Kourier, so every EU-homed Knative app was proxied to
 * US Kourier (no DomainMapping there → 404 on `/api/*`, and the wake probe
 * never reported ready). Each half was "correct" on its own, so a unit test of
 * either half alone could not catch it.
 *
 * These tests therefore drive the REAL write path (`setServerBackedFlag`, with
 * Cloudflare mocked) into the SERVER_BACKED map, then run the REAL Worker
 * script rendered from `terraform/modules/publish-hosting-oci/main.tf` with the
 * per-region Kourier maps production-us binds. They pin the acceptance
 * criteria that are checkable before rollout (AC3–AC5); AC1/AC2 (the live
 * `curl`s) and AC7 (`terraform plan` against real credentials) need the
 * rollout and are verified on the card.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setServerBackedFlag } from '../lib/cloudflare-server-backed-kv'
import { decideStamp } from '../../scripts/stamp-knative-region'

const MAIN_TF = resolve(import.meta.dir, '../../../../terraform/modules/publish-hosting-oci/main.tf')
const PUBLISH_DOMAIN = 'shogo.one'

/** Render the Worker the edge actually serves (the script is inline in Terraform). */
async function loadWorker() {
  const tf = readFileSync(MAIN_TF, 'utf8')
  const start = tf.indexOf('content = <<-JS\n')
  const end = tf.indexOf('\n  JS\n', start)
  const js = tf
    .slice(start + 'content = <<-JS\n'.length, end)
    .replaceAll("'${var.publish_domain}'", `'${PUBLISH_DOMAIN}'`)
    .replaceAll("'${local.par_base_url}'", "'https://objectstorage.example/p/x/n/ns/b/bucket/o'")
    .replaceAll('$${', '${')
  const dir = mkdtempSync(join(tmpdir(), 'qa-sho588-worker-'))
  const file = join(dir, 'worker.mjs')
  writeFileSync(file, js)
  try {
    return (await import(file)).default as {
      fetch(req: Request, env: unknown): Promise<Response>
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const realFetch = globalThis.fetch
let puts: Array<{ url: string; body: string | null }> = []
let edgeCalls: Array<{ url: string; override?: string }> = []

/** Mock the API's Cloudflare writes: capture the KV body and nothing else. */
function installKvFetch() {
  puts = []
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    puts.push({ url, body: (init?.body as string) ?? null })
    return new Response('{"success":true}', { status: 200 })
  }) as typeof fetch
}

/** Mock the Worker's outbound fetches: record where each request was aimed. */
function installEdgeFetch() {
  edgeCalls = []
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    edgeCalls.push({ url, override: init?.cf?.resolveOverride })
    return new Response('ok', { status: 200 })
  }) as typeof fetch
}

const CF_ENV = [
  'CF_API_TOKEN',
  'CF_CUSTOM_HOSTNAMES_TOKEN',
  'CF_ACCOUNT_ID',
  'CF_SERVER_BACKED_KV_NAMESPACE_ID',
  'REGION_ID',
] as const

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const k of CF_ENV) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  process.env.CF_API_TOKEN = 'cf-token'
  process.env.CF_ACCOUNT_ID = 'acct'
  process.env.CF_SERVER_BACKED_KV_NAMESPACE_ID = 'ns'
})

afterEach(() => {
  for (const k of CF_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  globalThis.fetch = realFetch
})

/**
 * The edge env production-us builds after this change: one Kourier per region
 * in each zone, plus the single default origin kept for bare/legacy values.
 */
function edgeEnv(serverBacked: Record<string, string>) {
  return {
    SERVER_BACKED: { get: async (k: string) => serverBacked[k] ?? null },
    CUSTOM_DOMAINS: {
      get: async (k: string) =>
        k === 'app.playsamsara.com'
          ? JSON.stringify({ s: 'play-samsara-api', c: 'app.playsamsara.com' })
          : null,
    },
    KOURIER_ORIGIN: 'http://kourier-us.shogo.one',
    CUSTOM_DOMAINS_KOURIER_ORIGIN: 'http://kourier-us.shogo.online',
    KOURIER_ORIGINS: JSON.stringify({
      us: 'http://kourier-us.shogo.one',
      eu: 'http://kourier-eu.shogo.one',
    }),
    CUSTOM_DOMAINS_KOURIER_ORIGINS: JSON.stringify({
      us: 'http://kourier-us.shogo.online',
      eu: 'http://kourier-eu.shogo.online',
    }),
    // Bound in production, so a value the Worker mis-parses as "unknown" would
    // be routed to the metal API proxy instead of Kourier.
    API_PUBLISHED_ORIGIN: 'https://api.shogo.ai',
  }
}

/** Write a publish flag the way a pod in `regionId` does, and return the KV value. */
async function publishFlagIn(regionId: string | null): Promise<string> {
  if (regionId) process.env.REGION_ID = regionId
  else delete process.env.REGION_ID
  installKvFetch()
  expect(await setServerBackedFlag('play-samsara-api')).toBe(true)
  expect(puts).toHaveLength(1)
  return puts[0].body as string
}

describe('SHO-588 acceptance: an EU publish is routed to the EU Kourier', () => {
  test('AC1 route: the value an EU pod writes sends /api/* to kourier-eu', async () => {
    const value = await publishFlagIn('eu-frankfurt-1')
    expect(value).toBe('knative:eu') // AC3: EU workspace → knative:eu

    const worker = await loadWorker()
    installEdgeFetch()
    await worker.fetch(
      new Request(`https://play-samsara-api.${PUBLISH_DOMAIN}/api/auth/session`),
      edgeEnv({ 'play-samsara-api': value }),
    )

    expect(edgeCalls).toHaveLength(1)
    // Same host (its DomainMapping resolves off it), aimed at the EU ingress —
    // never US Kourier, and never the metal API proxy.
    expect(edgeCalls[0].url).toBe(
      `https://play-samsara-api.${PUBLISH_DOMAIN}/api/auth/session`,
    )
    expect(edgeCalls[0].override).toBe('kourier-eu.shogo.one')
  })

  test('AC1 route: the same EU app on a custom domain uses the SaaS-zone EU record', async () => {
    const value = await publishFlagIn('eu-frankfurt-1')
    const worker = await loadWorker()
    installEdgeFetch()
    await worker.fetch(new Request('https://app.playsamsara.com/api/auth/session'), edgeEnv({
      'play-samsara-api': value,
    }))

    expect(edgeCalls[0].url).toBe('https://app.playsamsara.com/api/auth/session')
    expect(edgeCalls[0].override).toBe('kourier-eu.shogo.online')
  })

  test('AC4: the wake probe hits the same EU host, so an EU app can report ready', async () => {
    const value = await publishFlagIn('eu-frankfurt-1')
    const worker = await loadWorker()
    installEdgeFetch()
    const res = await worker.fetch(
      new Request(`https://play-samsara-api.${PUBLISH_DOMAIN}/__shogo/wake`),
      edgeEnv({ 'play-samsara-api': value }),
    )

    expect(await res.json()).toEqual({ ready: true })
    expect(edgeCalls[0].url).toBe(`https://play-samsara-api.${PUBLISH_DOMAIN}/ready`)
    expect(edgeCalls[0].override).toBe('kourier-eu.shogo.one')
  })
})

describe('SHO-588 acceptance: nothing that worked before changes behaviour', () => {
  test('AC2 a US publish stamps knative:us and still lands on kourier-us', async () => {
    const value = await publishFlagIn('us-ashburn-1')
    expect(value).toBe('knative:us')

    const worker = await loadWorker()
    installEdgeFetch()
    await worker.fetch(new Request(`https://kif-crm.${PUBLISH_DOMAIN}/api/auth/session`), edgeEnv({
      'kif-crm': value,
    }))
    expect(edgeCalls[0].override).toBe('kourier-us.shogo.one')
  })

  test('AC2 an un-swept legacy entry (bare `knative`) keeps the default (US) origin', async () => {
    const worker = await loadWorker()
    installEdgeFetch()
    await worker.fetch(new Request(`https://kif-crm.${PUBLISH_DOMAIN}/api/auth/session`), edgeEnv({
      'kif-crm': 'knative',
    }))
    expect(edgeCalls[0].override).toBe('kourier-us.shogo.one')
  })

  test('AC3 local/desktop (no REGION_ID) writes bare knative, which still routes', async () => {
    const value = await publishFlagIn(null)
    expect(value).toBe('knative')

    const worker = await loadWorker()
    installEdgeFetch()
    await worker.fetch(new Request(`https://local-app.${PUBLISH_DOMAIN}/api/health`), edgeEnv({
      'local-app': value,
    }))
    expect(edgeCalls[0].override).toBe('kourier-us.shogo.one')
  })

  test('staging (single cluster, no regional map bound) keeps its default origin', async () => {
    const worker = await loadWorker()
    installEdgeFetch()
    await worker.fetch(new Request('https://staging-app.staging.shogo.one/api/health'), {
      SERVER_BACKED: { get: async () => 'knative:staging' },
      KOURIER_ORIGIN: 'http://kourier-staging.shogo.one',
      // Deliberately no KOURIER_ORIGINS / CUSTOM_DOMAINS_KOURIER_ORIGINS.
    })
    expect(edgeCalls[0].override).toBe('kourier-staging.shogo.one')
  })
})

describe('SHO-588 acceptance: the sweep only writes region it can prove', () => {
  test('writes knative:eu when only the EU Kourier answers and EU is the home region', () => {
    expect(
      decideStamp({
        value: 'knative',
        homeRegion: 'eu-frankfurt-1',
        probes: { us: 404, eu: 401 },
      }),
    ).toEqual({
      action: 'write',
      region: 'eu',
      value: 'knative:eu',
      reason: 'only eu Kourier knows this app, matching home region',
    })
  })

  test('never contradicts the probe: home EU but only US answers → report, no write', () => {
    const d = decideStamp({
      value: 'knative',
      homeRegion: 'eu-frankfurt-1',
      probes: { us: 401, eu: 404 },
    })
    expect(d.action).toBe('report')
  })

  test('both Kouriers answering is ambiguous → report, no write', () => {
    const d = decideStamp({ value: 'knative', homeRegion: 'eu-frankfurt-1', probes: { us: 401, eu: 401 } })
    expect(d.action).toBe('report')
  })

  test('neither answering is unknown → report, no write', () => {
    const d = decideStamp({ value: 'knative', homeRegion: 'eu-frankfurt-1', probes: { us: 404, eu: 404 } })
    expect(d.action).toBe('report')
  })

  test('a legacy null homeRegion is treated as the primary region', () => {
    const d = decideStamp({ value: '1', homeRegion: null, probes: { us: 401, eu: 404 } })
    expect(d).toEqual({
      action: 'write',
      region: 'us',
      value: 'knative:us',
      reason: 'only us Kourier knows this app, matching home region',
    })
  })

  test('metal entries and already-stamped entries are left alone', () => {
    expect(decideStamp({ value: 'metal', homeRegion: 'eu-frankfurt-1', probes: {} }).action).toBe('skip')
    expect(decideStamp({ value: 'knative:eu', homeRegion: 'eu-frankfurt-1', probes: {} }).action).toBe('skip')
    expect(decideStamp({ value: 'metal:eu', homeRegion: 'eu-frankfurt-1', probes: {} }).action).toBe('skip')
  })
})
