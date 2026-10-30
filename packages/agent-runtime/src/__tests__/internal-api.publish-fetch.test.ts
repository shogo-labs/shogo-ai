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
})
