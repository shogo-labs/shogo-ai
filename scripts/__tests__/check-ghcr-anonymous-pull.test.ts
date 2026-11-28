// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `.github/scripts/check-ghcr-anonymous-pull.sh` is the only thing that notices
 * when the GHCR package's visibility regresses: the publish and smoke jobs both
 * log in, so a private package still passes them while every partner's
 * `docker pull` fails with 403 (SHO-608). These run the real script against a
 * stub registry and assert it never authenticates and reads the status the way
 * an anonymous pull would.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SCRIPT = resolve(import.meta.dir, '../../.github/scripts/check-ghcr-anonymous-pull.sh')
const REPO = 'shogo-labs/shogo-runtime'
const TAG = 'v2.6.8'
const DIGEST = 'sha256:0123456789abcdef'

type Seen = { path: string; method: string; authorization: string | null; accept: string | null }

let server: ReturnType<typeof Bun.serve>
let base: string
let seen: Seen[] = []
let tokenStatus = 200
let tokenBody = JSON.stringify({ token: 'anonymous-token' })
let manifestStatus = 200

/** The script shells out to curl and the stub registry lives in THIS process,
 * so it has to run off the event loop (spawnSync would deadlock the server). */
async function check(args: string[] = [`ghcr.io/${REPO}`, TAG]) {
  const proc = Bun.spawn([SCRIPT, ...args], {
    env: { ...process.env, GHCR_BASE_URL: base },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, status }
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      seen.push({
        path: url.pathname,
        method: request.method,
        authorization: request.headers.get('authorization'),
        accept: request.headers.get('accept'),
      })
      if (url.pathname === '/token') {
        return new Response(tokenBody, {
          status: tokenStatus,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.pathname === `/v2/${REPO}/manifests/${TAG}`) {
        const headers: Record<string, string> = {
          'content-type': 'application/vnd.oci.image.index.v1+json',
        }
        if (manifestStatus === 200) headers['docker-content-digest'] = DIGEST
        return new Response(null, { status: manifestStatus, headers })
      }
      return new Response('not found', { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})

afterEach(() => {
  seen = []
  tokenStatus = 200
  tokenBody = JSON.stringify({ token: 'anonymous-token' })
  manifestStatus = 200
})

afterAll(() => {
  server.stop(true)
})

describe('check-ghcr-anonymous-pull', () => {
  test('a public package passes and reports the digest', async () => {
    const result = await check()

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`anonymous pull OK: ghcr.io/${REPO}:${TAG}`)
    expect(result.stdout).toContain(DIGEST)
  })

  test('it asks for a token with no credentials at all', async () => {
    await check()

    const token = seen.find((r) => r.path === '/token')
    expect(token).toBeDefined()
    expect(token?.authorization).toBe(null)
    // Anonymous JWT from the public token endpoint is the only thing it sends,
    // and never to the token endpoint itself.
    const manifest = seen.find((r) => r.path === `/v2/${REPO}/manifests/${TAG}`)
    expect(manifest?.method).toBe('HEAD')
    expect(manifest?.authorization).toBe('Bearer anonymous-token')
    expect(manifest?.accept).toContain('application/vnd.oci.image.index.v1+json')
    expect(manifest?.accept).toContain('application/vnd.docker.distribution.manifest.list.v2+json')
  })

  test('a private package (manifest 403) fails with the visibility hint', async () => {
    manifestStatus = 403

    const result = await check()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('::error::GHCR package is not public: ')
    expect(result.stderr).toContain('403')
    expect(result.stderr).toContain('Change visibility')
    expect(result.stderr).toContain('org admin')
  })

  test('a refused token (401) fails with the visibility hint', async () => {
    tokenStatus = 401
    tokenBody = JSON.stringify({ errors: [{ code: 'UNAUTHORIZED' }] })

    const result = await check()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('::error::GHCR package is not public: ')
    expect(result.stderr).toContain('401')
    expect(result.stderr).toContain('Change visibility')
    // Nothing to ask about the manifest when the token never came back.
    expect(seen.some((r) => r.path.startsWith('/v2/'))).toBe(false)
  })

  test('a token response without a token fails instead of sending "Bearer "', async () => {
    tokenBody = JSON.stringify({ errors: [{ code: 'DENIED' }] })

    const result = await check()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('returned no token')
    expect(seen.some((r) => r.path.startsWith('/v2/'))).toBe(false)
  })

  test('a missing tag (404) fails rather than passing silently', async () => {
    manifestStatus = 404

    const result = await check()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('404')
  })

  test('a malformed image reference is a usage error, not a green check', async () => {
    const result = await check(['ghcr.io/shogo-runtime', TAG])

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('expected <registry>/<owner>/<package>')
    expect(seen).toHaveLength(0)
  })
})

describe('workflow wiring', () => {
  const runtime = readFileSync(
    resolve(import.meta.dir, '../../.github/workflows/runtime-multiarch.yml'),
    'utf8',
  )

  test('the publish job runs the check on every tag', () => {
    expect(runtime).toContain(
      'run: .github/scripts/check-ghcr-anonymous-pull.sh ghcr.io/shogo-labs/shogo-runtime "${GITHUB_REF_NAME}"',
    )
  })

  test('the docker login stays for smoke, never for the anonymous check', () => {
    const anonymous = runtime.slice(runtime.indexOf('name: Verify anonymous pull'))
    const step = anonymous.split('\n      - name: ')[0] ?? ''
    expect(step).not.toContain('docker login')
    expect(step).not.toContain('secrets.GITHUB_TOKEN')
  })
})
