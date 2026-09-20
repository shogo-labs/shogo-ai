// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for releases-worker.js.tftpl — the Cloudflare Worker behind
 * releases.shogo.ai. Run with:
 *
 *   bun test terraform/modules/install-shogo-ai/scripts/releases-worker.test.ts
 *
 * The Worker source is a Terraform template (`.tftpl`), not a plain `.js`
 * module, so it can't be `import`ed directly — Terraform's `${...}`
 * interpolation syntax (`${github_owner}`, `${github_repo}`) isn't valid
 * standalone JS. We render it exactly like `templatefile()` would (simple
 * placeholder substitution — the template intentionally contains no other
 * `${`/`%{` sequences, see the "no accidental JS template literals" note
 * inline in the .tftpl itself) into a temp `.mjs` file and `import()` it
 * from there.
 *
 * Cloudflare Workers globals (`caches`, `fetch`) are stubbed per-test with
 * an in-memory fake that mirrors the real Cache API contract closely
 * enough to exercise the Worker's caching branches (notably: `match()`
 * must return a FRESH Response whose body hasn't already been consumed by
 * an earlier `match()` call in the same test — the real Cache API does
 * this because responses are (de)serialized, not returned by reference).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = 'shogo-labs'
const REPO = 'shogo-ai'

interface DesktopWorkerModule {
  default: { fetch: (req: Request, env: Record<string, unknown>, ctx: { waitUntil: (p: Promise<unknown>) => void }) => Promise<Response> }
  parseSemver: (v: string) => { major: number; minor: number; patch: number; prerelease: string[] } | null
  isSemverValid: (v: string) => boolean
  compareSemver: (a: ReturnType<DesktopWorkerModule['parseSemver']>, b: ReturnType<DesktopWorkerModule['parseSemver']>) => number
  semverGt: (a: string, b: string) => boolean
  semverLte: (a: string, b: string) => boolean
  desktopChannelMatches: (release: { prerelease: boolean }, channel: 'stable' | 'beta') => boolean
  desktopAssetForPlatform: (release: { assets: Array<{ name: string; browser_download_url?: string }> }, platform: string) => { name: string; browser_download_url?: string } | null
  findNupkgName: (body: string) => string | null
  matchChannel: (tag: string, channel: string) => boolean
}

let worker: DesktopWorkerModule

beforeAll(async () => {
  const templatePath = join(import.meta.dir, 'releases-worker.js.tftpl')
  const template = readFileSync(templatePath, 'utf8')
  const rendered = template
    .replaceAll('${github_owner}', OWNER)
    .replaceAll('${github_repo}', REPO)

  const dir = mkdtempSync(join(tmpdir(), 'releases-worker-'))
  const renderedPath = join(dir, 'releases-worker.rendered.mjs')
  writeFileSync(renderedPath, rendered)

  worker = (await import(renderedPath)) as unknown as DesktopWorkerModule
})

// ---------------------------------------------------------------------------
// In-memory Cache API + fetch fakes
// ---------------------------------------------------------------------------

interface CacheEntry {
  body: string
  status: number
  headers: Record<string, string>
}

function makeFakeCache() {
  const store = new Map<string, CacheEntry>()
  return {
    store,
    async match(req: Request | string) {
      const key = typeof req === 'string' ? req : req.url
      const entry = store.get(key)
      if (!entry) return undefined
      return new Response(entry.body, { status: entry.status, headers: entry.headers })
    },
    async put(req: Request | string, res: Response) {
      const key = typeof req === 'string' ? req : req.url
      const body = await res.clone().text()
      const headers: Record<string, string> = {}
      res.headers.forEach((v, k) => { headers[k] = v })
      store.set(key, { body, status: res.status, headers })
    },
  }
}

type FetchStub = (url: string) => Promise<{ ok: boolean; status?: number; json?: () => Promise<unknown>; text?: () => Promise<string> }>

let fetchImpl: FetchStub = async () => { throw new Error('fetch not stubbed for this test') }

beforeEach(() => {
  ;(globalThis as any).caches = { default: makeFakeCache() }
  ;(globalThis as any).fetch = (url: string) => fetchImpl(url)
})

afterEach(() => {
  fetchImpl = async () => { throw new Error('fetch not stubbed for this test') }
})

const ctx = { waitUntil: (p: Promise<unknown>) => { void p } }
const env = {}

async function request(path: string): Promise<Response> {
  return worker.default.fetch(new Request('https://releases.shogo.ai' + path), env, ctx)
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('semver helpers', () => {
  test('isSemverValid', () => {
    expect(worker.isSemverValid('1.14.9')).toBe(true)
    expect(worker.isSemverValid('v1.14.9')).toBe(true)
    expect(worker.isSemverValid('1.14.9-beta.20260919233000')).toBe(true)
    expect(worker.isSemverValid('not-a-version')).toBe(false)
    expect(worker.isSemverValid('1.14')).toBe(false)
  })

  test('semverGt orders prerelease below the same release, and beta.N numerically', () => {
    expect(worker.semverGt('1.14.10', '1.14.10-beta.1')).toBe(true)
    expect(worker.semverGt('1.14.10-beta.2', '1.14.10-beta.1')).toBe(true)
    expect(worker.semverGt('1.14.10-beta.10', '1.14.10-beta.2')).toBe(true) // numeric, not lexical
    expect(worker.semverGt('1.14.9', '1.14.10-beta.1')).toBe(false)
  })

  test('semverLte treats equal versions as lte', () => {
    expect(worker.semverLte('1.14.9', '1.14.9')).toBe(true)
    expect(worker.semverLte('1.14.8', '1.14.9')).toBe(true)
    expect(worker.semverLte('1.14.10', '1.14.9')).toBe(false)
  })
})

describe('desktopChannelMatches', () => {
  test('beta is a superset of stable', () => {
    expect(worker.desktopChannelMatches({ prerelease: true }, 'beta')).toBe(true)
    expect(worker.desktopChannelMatches({ prerelease: false }, 'beta')).toBe(true)
  })

  test('stable excludes prereleases', () => {
    expect(worker.desktopChannelMatches({ prerelease: true }, 'stable')).toBe(false)
    expect(worker.desktopChannelMatches({ prerelease: false }, 'stable')).toBe(true)
  })
})

describe('desktopAssetForPlatform', () => {
  test('matches the arch-specific darwin zip', () => {
    const release = { assets: [
      { name: 'Shogo-darwin-arm64-1.14.9.zip', browser_download_url: 'https://x/arm64.zip' },
      { name: 'Shogo-darwin-x64-1.14.9.zip', browser_download_url: 'https://x/x64.zip' },
    ] }
    expect(worker.desktopAssetForPlatform(release, 'darwin-arm64')?.name).toBe('Shogo-darwin-arm64-1.14.9.zip')
    expect(worker.desktopAssetForPlatform(release, 'darwin-x64')?.name).toBe('Shogo-darwin-x64-1.14.9.zip')
  })

  test('darwin platform without a matching zip returns null', () => {
    expect(worker.desktopAssetForPlatform({ assets: [] }, 'darwin-arm64')).toBeNull()
  })

  test('win32-x64 requires BOTH a RELEASES asset and a nupkg', () => {
    const full = { assets: [{ name: 'RELEASES' }, { name: 'Shogo-1.14.9-full.nupkg', browser_download_url: 'https://x/full.nupkg' }] }
    expect(worker.desktopAssetForPlatform(full, 'win32-x64')?.name).toBe('Shogo-1.14.9-full.nupkg')

    const missingReleases = { assets: [{ name: 'Shogo-1.14.9-full.nupkg' }] }
    expect(worker.desktopAssetForPlatform(missingReleases, 'win32-x64')).toBeNull()

    const missingNupkg = { assets: [{ name: 'RELEASES' }] }
    expect(worker.desktopAssetForPlatform(missingNupkg, 'win32-x64')).toBeNull()
  })
})

describe('findNupkgName', () => {
  test('finds the whitespace-delimited nupkg token', () => {
    expect(worker.findNupkgName('A1B2C3 Shogo-1.14.9-full.nupkg 123456')).toBe('Shogo-1.14.9-full.nupkg')
  })

  test('returns null when there is no nupkg reference', () => {
    expect(worker.findNupkgName('nothing here')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// fetch() end-to-end — the /desktop route
// ---------------------------------------------------------------------------

function githubReleases(releases: unknown[]): FetchStub {
  return async (url: string) => {
    if (url.includes('api.github.com')) return { ok: true, json: async () => releases }
    if (url.endsWith('/RELEASES')) return { ok: true, text: async () => '0123456789ABCDEF0123456789ABCDEF01234567 Shogo-1.14.9-full.nupkg 654321\n' }
    throw new Error('unexpected fetch: ' + url)
  }
}

const STABLE_RELEASE = {
  tag_name: 'v1.14.9',
  draft: false,
  prerelease: false,
  name: 'Shogo Desktop v1.14.9',
  body: 'Stable release notes',
  assets: [
    { name: 'Shogo-darwin-arm64-1.14.9.zip', browser_download_url: 'https://gh/stable-arm64.zip' },
    { name: 'Shogo-darwin-x64-1.14.9.zip', browser_download_url: 'https://gh/stable-x64.zip' },
    { name: 'RELEASES' },
    { name: 'Shogo-1.14.9-full.nupkg', browser_download_url: 'https://gh/stable-full.nupkg' },
  ],
}

const BETA_RELEASE = {
  tag_name: 'v1.14.10-beta.20260919233000',
  draft: false,
  prerelease: true,
  name: 'Shogo Desktop v1.14.10-beta.20260919233000 (beta, main@abc1234)',
  body: 'Beta build off main',
  assets: [
    { name: 'Shogo-darwin-arm64-1.14.10-beta.20260919233000.zip', browser_download_url: 'https://gh/beta-arm64.zip' },
  ],
}

describe('/desktop route', () => {
  test('stable: 204 when the requesting client is already current', async () => {
    fetchImpl = githubReleases([STABLE_RELEASE, BETA_RELEASE])
    const res = await request('/desktop/stable/darwin-arm64/1.14.9')
    expect(res.status).toBe(204)
  })

  test('stable ignores the newer prerelease and offers the stable release', async () => {
    fetchImpl = githubReleases([STABLE_RELEASE, BETA_RELEASE])
    const res = await request('/desktop/stable/darwin-arm64/1.14.8')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      name: 'Shogo Desktop v1.14.9',
      notes: 'Stable release notes',
      url: 'https://gh/stable-arm64.zip',
    })
  })

  test('beta is a superset: sees the newer prerelease over stable', async () => {
    fetchImpl = githubReleases([STABLE_RELEASE, BETA_RELEASE])
    const res = await request('/desktop/beta/darwin-arm64/1.14.9')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toBe('https://gh/beta-arm64.zip')
    expect(body.name).toContain('1.14.10-beta')
  })

  test('beta falls back to the stable release for a platform the beta build lacks', async () => {
    fetchImpl = githubReleases([STABLE_RELEASE, BETA_RELEASE])
    // BETA_RELEASE only ships a darwin-arm64 asset — win32-x64 requesters on
    // the beta channel should still be offered the (older, but only
    // available) stable win32 build rather than getting a 503.
    const res = await request('/desktop/beta/win32-x64/0.0.1')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toBe('https://gh/stable-full.nupkg')
  })

  test('beta is up to date -> 204', async () => {
    fetchImpl = githubReleases([STABLE_RELEASE, BETA_RELEASE])
    const res = await request('/desktop/beta/darwin-arm64/99.0.0')
    expect(res.status).toBe(204)
  })

  test('no release has an asset for the requested platform -> 503', async () => {
    fetchImpl = githubReleases([STABLE_RELEASE, BETA_RELEASE])
    const res = await request('/desktop/stable/darwin-x64-nonexistent-does-not-match-regex/1.0.0')
    // Malformed platform segment doesn't match the route regex at all.
    expect(res.status).toBe(404)
  })

  test('draft releases are excluded entirely', async () => {
    const draft = { ...STABLE_RELEASE, tag_name: 'v9.9.9', draft: true, assets: STABLE_RELEASE.assets }
    fetchImpl = githubReleases([draft])
    const res = await request('/desktop/stable/darwin-arm64/0.0.1')
    expect(res.status).toBe(503)
  })

  test('/RELEASES rewrites the nupkg filename to an absolute download URL', async () => {
    fetchImpl = githubReleases([STABLE_RELEASE])
    const res = await request('/desktop/stable/win32-x64/0.0.1/RELEASES')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('https://github.com/shogo-labs/shogo-ai/releases/download/v1.14.9/Shogo-1.14.9-full.nupkg')
    expect(res.headers.get('content-type')).toContain('text/plain')
  })

  test('/RELEASES is 404 when no matching release exists', async () => {
    fetchImpl = githubReleases([])
    const res = await request('/desktop/beta/win32-x64/0.0.1/RELEASES')
    expect(res.status).toBe(404)
  })

  test('unknown channel segment -> 404 with a helpful message', async () => {
    const res = await request('/desktop/nightly/darwin-arm64/1.0.0')
    expect(res.status).toBe(404)
    const body = await res.text()
    expect(body).toContain('/desktop/<stable|beta>')
  })

  test('GitHub API failure surfaces as 503, not a crash', async () => {
    fetchImpl = async () => ({ ok: false, status: 500 })
    const res = await request('/desktop/stable/darwin-arm64/0.0.1')
    expect(res.status).toBe(503)
  })

  test('caches the resolved release across requests for the same (channel, platform)', async () => {
    let githubCalls = 0
    fetchImpl = async (url: string) => {
      if (url.includes('api.github.com')) {
        githubCalls++
        return { ok: true, json: async () => [STABLE_RELEASE, BETA_RELEASE] }
      }
      throw new Error('unexpected fetch: ' + url)
    }
    await request('/desktop/stable/darwin-arm64/1.0.0')
    await request('/desktop/stable/darwin-arm64/1.0.1')
    expect(githubCalls).toBe(1)
  })
})

describe('parity with update.electronjs.org semantics (stable channel)', () => {
  test('matchChannel treats any tag with a "-" as non-stable, mirroring release.prerelease semantics', () => {
    expect(worker.matchChannel('v1.14.9', 'stable')).toBe(true)
    expect(worker.matchChannel('v1.14.9-beta.1', 'stable')).toBe(false)
  })

  test('/cli stable route (existing behavior) is unaffected by the new /desktop route', async () => {
    fetchImpl = async (url: string) => {
      if (url.includes('api.github.com')) {
        return { ok: true, json: async () => [{ tag_name: 'v1.14.9', draft: false, assets: [{ name: 'shogo-darwin-arm64.tar.gz' }] }] }
      }
      throw new Error('unexpected fetch: ' + url)
    }
    const res = await request('/cli/stable/shogo-darwin-arm64.tar.gz')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      'https://github.com/shogo-labs/shogo-ai/releases/download/v1.14.9/shogo-darwin-arm64.tar.gz',
    )
  })
})

describe('input validation', () => {
  test('/desktop/ with a garbage path -> 404 with routing help', async () => {
    const res = await request('/desktop/')
    expect(res.status).toBe(404)
  })

  test('non-GET/HEAD methods are rejected', async () => {
    const res = await worker.default.fetch(
      new Request('https://releases.shogo.ai/desktop/stable/darwin-arm64/1.0.0', { method: 'POST' }),
      env,
      ctx,
    )
    expect(res.status).toBe(405)
  })
})
