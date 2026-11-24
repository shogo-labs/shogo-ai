// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The publish wrappers in `internal-api.ts` are the agent's only window onto
 * publishing. When the API in front of them has no publish route at all, they
 * used to hand the tool a bare `HTTP 404`, and agents reacted by retrying
 * subdomain after subdomain (SHO-245). A 404 with no structured body now names
 * the real cause; a 404 that DOES carry an error body is still passed through
 * untouched, because `project_not_found` is a genuine 404.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { abilityDenial } from '@shogo/authz'
import { getPublishState, publishProject } from '../internal-api'

const realFetch = globalThis.fetch

let nextResponse: () => Response

function stubFetch() {
  globalThis.fetch = (async () => nextResponse()) as unknown as typeof fetch
}

beforeEach(() => {
  process.env.SHOGO_API_URL = 'http://api.test'
  nextResponse = () => Response.json({}, { status: 200 })
  stubFetch()
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.SHOGO_API_URL
})

describe('publishFetch error mapping', () => {
  test('a 404 with no body says the API has no publish route, not "HTTP 404"', async () => {
    nextResponse = () => new Response('<html>not found</html>', { status: 404, headers: { 'content-type': 'text/html' } })

    const res = await publishProject('p1', { subdomain: 'my-site' })

    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
    expect(res.code).toBe('publish_route_missing')
    expect(res.error).toMatch(/no publish route/i)
    expect(res.error).toMatch(/version mismatch/i)
    expect(res.error).not.toMatch(/^HTTP 404$/)
  })

  test('a 404 that carries a structured error is passed through unchanged', async () => {
    nextResponse = () =>
      Response.json({ error: { code: 'project_not_found', message: 'Project not found' } }, { status: 404 })

    const res = await getPublishState('gone')

    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
    expect(res.code).toBe('project_not_found')
    expect(res.error).toBe('Project not found')
  })

  test('a 409 keeps the cloud/desktop code and message', async () => {
    nextResponse = () =>
      Response.json(
        { error: { code: 'subdomain_taken', message: 'That subdomain is already in use' } },
        { status: 409 },
      )

    const res = await publishProject('p1', { subdomain: 'my-site' })

    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
    expect(res.code).toBe('subdomain_taken')
    expect(res.error).toBe('That subdomain is already in use')
  })

  test('a 503 cloud_signin_required reaches the tool as that code', async () => {
    nextResponse = () =>
      Response.json(
        { error: { code: 'cloud_signin_required', message: 'Sign in to Shogo Cloud to publish.' } },
        { status: 503 },
      )

    const res = await publishProject('p1', { subdomain: 'my-site' })

    expect(res.ok).toBe(false)
    expect(res.code).toBe('cloud_signin_required')
    expect(res.status).toBe(503)
  })

  test('a non-404 failure with no body still reports its status', async () => {
    nextResponse = () => new Response('boom', { status: 502 })

    const res = await publishProject('p1', { subdomain: 'my-site' })

    expect(res.ok).toBe(false)
    expect(res.status).toBe(502)
    expect(res.error).toBe('HTTP 502')
  })

  // SHO-539: the internal publish route refuses a project viewer with the
  // shared `abilityDenial` envelope (not `forbidden`). The tool keys on
  // `code`, so this hop is what makes its mapping fire at all.
  test('a 403 ability envelope reaches the caller as ability_not_allowed', async () => {
    nextResponse = () =>
      Response.json({ error: abilityDenial('project:publish') }, { status: 403 })

    const res = await publishProject('p1', { subdomain: 'my-site' })

    expect(res.ok).toBe(false)
    expect(res.status).toBe(403)
    expect(res.code).toBe('ability_not_allowed')
    expect(res.error).toBe('Ask a workspace admin for project:publish.')
  })
})

// ---------------------------------------------------------------------------
// A publish whose pipeline outlives one HTTP request (SHO-542).
//
// The API validates, records `building` and answers 202; the tool follows the
// internal GET until the publish is live or failed, so its result is exactly
// what it was when the whole pipeline ran inside the POST.
// ---------------------------------------------------------------------------

/** Scripted fetch: the POST answer plus a queue of GET answers. */
function stubScripted(post: () => Response, states: Array<Record<string, unknown>>) {
  const calls: string[] = []
  let getIndex = 0
  globalThis.fetch = (async (url: any, init: any) => {
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${String(url)}`)
    if (method === 'POST') return post()
    const state = states[Math.min(getIndex, states.length - 1)]
    getIndex++
    return Response.json(state, { status: 200 })
  }) as unknown as typeof fetch
  return calls
}

const accepted = () =>
  Response.json(
    { ok: true, accepted: true, status: 'building', subdomain: 'my-site', url: 'https://my-site.shogo.one' },
    { status: 202 },
  )

const FAST: { startDelayMs: number; maxDelayMs: number } = { startDelayMs: 1, maxDelayMs: 2 }

describe('publishProject follows a background publish (202 → status)', () => {
  test('returns the live result after the pipeline moves building → uploading → configuring → live', async () => {
    const calls = stubScripted(accepted, [
      { publishStatus: 'building' },
      { publishStatus: 'uploading' },
      { publishStatus: 'configuring' },
      {
        publishStatus: 'live',
        published: true,
        subdomain: 'my-site',
        publishedAt: 1_700_000_000_000,
        accessLevel: 'anyone',
        hasPassword: false,
      },
    ])

    const res = await publishProject('p1', { subdomain: 'my-site' }, FAST)

    expect(res.ok).toBe(true)
    expect(res.data?.url).toBe('https://my-site.shogo.one')
    expect(res.data?.subdomain).toBe('my-site')
    expect(res.data?.publishedAt).toBe(1_700_000_000_000)
    // The POST returned immediately and four GETs followed it.
    expect(calls.filter((c) => c.startsWith('POST '))).toHaveLength(1)
    expect(calls.filter((c) => c.startsWith('GET '))).toHaveLength(4)
  })

  test('a failed publish surfaces its code and no site URL', async () => {
    stubScripted(accepted, [{ publishStatus: 'building' }, { publishStatus: 'failed', publishError: 'configure_failed' }])

    const res = await publishProject('p1', { subdomain: 'my-site' }, FAST)

    expect(res.ok).toBe(false)
    expect(res.code).toBe('configure_failed')
    expect(res.data).toBeUndefined()
    expect(res.error).toMatch(/hosting side/i)
  })

  test('a destructive-schema refusal keeps the changes the tool quotes', async () => {
    stubScripted(accepted, [
      {
        publishStatus: 'failed',
        publishError: 'destructive_schema_change',
        publishErrorDetails: {
          environment: 'production',
          changes: [{ kind: 'dropped_field', name: 'User.nickname', message: 'field User.nickname would be dropped' }],
        },
      },
    ])

    const res = await publishProject('p1', { subdomain: 'my-site' }, FAST)

    expect(res.ok).toBe(false)
    expect(res.code).toBe('destructive_schema_change')
    expect((res.details?.changes as any[])[0].message).toContain('User.nickname')
  })

  test('an API that still runs the pipeline inline (200 with the result) is passed through', async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { ok: true, url: 'https://my-site.shogo.one', subdomain: 'my-site', publishedAt: 1 },
        { status: 200 },
      )) as unknown as typeof fetch

    const res = await publishProject('p1', { subdomain: 'my-site' }, FAST)

    expect(res.ok).toBe(true)
    expect(res.data?.subdomain).toBe('my-site')
  })
})

// ---------------------------------------------------------------------------
// A staging deploy writes the STAGING environment row, never the project, so
// the follower has to ask for that row. Polling the project reported
// production's `live` about two seconds after the accept — "success" for a
// staging build that had not started — and swallowed a staging failure
// (SHO-542 QA round 1).
// ---------------------------------------------------------------------------

describe('publishProject follows the environment it accepted', () => {
  const stagingAccepted = () =>
    Response.json(
      {
        ok: true,
        accepted: true,
        status: 'building',
        subdomain: 'my-site--staging',
        url: 'https://my-site--staging.shogo.one',
        environment: 'staging',
      },
      { status: 202 },
    )

  test('a staging accept polls the staging row and reports its failure', async () => {
    const calls = stubScripted(stagingAccepted, [
      // What production is doing at the same moment: live and unchanged. A
      // follower reading the project would stop here and call it a success.
      { publishStatus: 'building' },
      { publishStatus: 'failed', publishError: 'build_failed' },
    ])

    const res = await publishProject('p1', { subdomain: 'my-site', environment: 'staging' }, FAST)

    expect(res.ok).toBe(false)
    expect(res.code).toBe('build_failed')
    expect(res.error).toMatch(/build failed/i)
    const gets = calls.filter((c) => c.startsWith('GET '))
    expect(gets.length).toBeGreaterThan(0)
    for (const call of gets) expect(call).toContain('?environment=staging')
  })

  test('a staging deploy that goes live returns the staging URL', async () => {
    const calls = stubScripted(stagingAccepted, [
      { publishStatus: 'uploading' },
      { publishStatus: 'live', published: true, subdomain: 'my-site--staging' },
    ])

    const res = await publishProject('p1', { subdomain: 'my-site', environment: 'staging' }, FAST)

    expect(res.ok).toBe(true)
    expect(res.data?.url).toBe('https://my-site--staging.shogo.one')
    expect(res.data?.subdomain).toBe('my-site--staging')
    for (const call of calls.filter((c) => c.startsWith('GET '))) {
      expect(call).toContain('?environment=staging')
    }
  })

  test('a production publish keeps polling the project row', async () => {
    const calls = stubScripted(accepted, [{ publishStatus: 'live', published: true, subdomain: 'my-site' }])

    const res = await publishProject('p1', { subdomain: 'my-site' }, FAST)

    expect(res.ok).toBe(true)
    for (const call of calls.filter((c) => c.startsWith('GET '))) {
      expect(call).not.toContain('environment=')
    }
  })
})
