// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-125 §4c — `preview_project` on metal.
 *
 * On metal each project is served by its OWN runtime and other projects are
 * never mounted into the caller's, so the mount-era flow (`POST
 * localhost:$PORT/p/<id>/preview/start`, then `mount_project` and retry) could
 * only ever answer 410 `mounting_removed`. The tool now asks the internal
 * preview route, which resolves the project's runtime, starts its build and
 * returns `<podUrl>/p/<projectId>/`.
 *
 * The merged-root (non-metal) flow must keep working byte-for-byte, so the
 * last test here is the old behaviour, unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createTools, type ToolContext } from '../gateway-tools'

const savedEnv = { ...process.env }

function wsCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceDir: '/app/workspace',
    channels: new Map(),
    config: {} as any,
    projectId: 'ws:ws-test',
    workspaceId: 'ws-test',
    sessionId: 'session-1',
    userId: 'user-1',
    ...overrides,
  }
}

interface Call {
  url: string
  method: string
  body?: any
  token?: string | null
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  process.env = { ...savedEnv }
  process.env.WORKSPACE_RUNTIME = 'true'
  process.env.WORKSPACE_ID = 'ws-test'
  process.env.SHOGO_API_URL = 'http://api.test'
  process.env.PORT = '37287'
  // The metal substrate, as the API injects it into the guest.
  process.env.SHOGO_RUNTIME_SUBSTRATE = 'metal'
  process.env.WORKSPACE_ANCHOR_PROJECT_ID = 'anchor-1'
  delete process.env.SHOGO_LOCAL_MODE
  delete process.env.WORKSPACE_PREVIEW_URLS
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = { ...savedEnv }
})

function stubFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method || 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      token: new Headers(init?.headers as any).get('x-runtime-token'),
    }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof fetch
  return calls
}

function previewTool(ctx: ToolContext = wsCtx()) {
  return createTools(ctx).find((tool) => tool.name === 'preview_project')!
}

describe('preview_project on metal', () => {
  it('asks the internal preview route and returns its URL — never its own port', async () => {
    const calls = stubFetch((call) => {
      expect(call.url).toBe('http://api.test/api/internal/workspaces/ws-test/sessions/session-1/projects/other-1/preview')
      expect(call.method).toBe('POST')
      return Response.json({ projectId: 'other-1', mode: 'metal', url: 'https://pod-7.example/p/other-1/', status: 'ready' })
    })

    const result = await previewTool().execute('t', { projectId: 'other-1' })

    expect(result.details.url).toBe('https://pod-7.example/p/other-1/')
    expect(result.details.status).toBe('ready')
    // Exactly one call, and it never touched the local multiplex.
    expect(calls).toHaveLength(1)
    expect(calls.some((call) => call.url.includes('/preview/start'))).toBe(false)
  })

  it('sends the caller identity so the API can authorize as that person', async () => {
    const calls = stubFetch(() =>
      Response.json({ projectId: 'other-1', url: 'https://pod-7.example/p/other-1/', status: 'running' }),
    )
    await previewTool().execute('t', { projectId: 'other-1' })
    expect(calls[0].body).toEqual({ userId: 'user-1', sessionId: 'session-1' })
  })

  it('never falls back to mounting when the project is not in the workspace', async () => {
    const calls = stubFetch(() =>
      Response.json(
        { error: { code: 'project_not_attached', message: 'Project ghost is not part of workspace ws-test.' } },
        { status: 404 },
      ),
    )

    const result = await previewTool().execute('t', { projectId: 'ghost' })

    expect(result.details.code).toBe('project_not_attached')
    expect(String(result.details.error)).toContain('ghost')
    expect(String(result.details.error)).not.toMatch(/mounting|410/i)
    // No `/members` call: mounting is gone on metal and must not be attempted.
    expect(calls.some((call) => call.url.includes('/members'))).toBe(false)
  })

  it('reports a warming target as retryable instead of failing hard', async () => {
    stubFetch(() =>
      Response.json(
        { error: { code: 'target_not_ready', message: 'Project other-1\'s runtime is not accepting requests yet.' } },
        { status: 503 },
      ),
    )

    const result = await previewTool().execute('t', { projectId: 'other-1' })

    expect(result.details.code).toBe('target_not_ready')
    expect(result.details.retryAfterSeconds).toBe(2)
    expect(result.details.noFallbackUrl).toBe(true)
  })

  it('reports an unreachable runtime without inventing a link', async () => {
    stubFetch(() =>
      Response.json(
        { error: { code: 'target_unavailable', message: "Project other-1's runtime is unavailable: no host" } },
        { status: 502 },
      ),
    )

    const result = await previewTool().execute('t', { projectId: 'other-1' })

    expect(result.details.code).toBe('target_unavailable')
    expect(result.details.url).toBeUndefined()
    expect(result.details.noFallbackUrl).toBe(true)
  })

  it('keeps the local flow for the anchor project this runtime serves', async () => {
    const calls = stubFetch(() => Response.json({ ok: true, phase: 'running' }))

    const result = await previewTool().execute('t', { projectId: 'anchor-1' })

    expect(calls).toEqual([
      { url: 'http://localhost:37287/p/anchor-1/preview/start', method: 'POST', body: undefined, token: null },
    ])
    expect(result.details.url).toBe('http://localhost:37287/p/anchor-1/')
  })
})

describe('preview_project on a merged-root runtime (unchanged)', () => {
  it('builds the mounted member locally and returns a /p/<id>/ url', async () => {
    process.env.SHOGO_RUNTIME_SUBSTRATE = 'cloud'
    const calls = stubFetch(() => Response.json({ ok: true, phase: 'running' }))

    const result = await previewTool().execute('t', { projectId: 'other-1' })

    expect(calls).toEqual([
      { url: 'http://localhost:37287/p/other-1/preview/start', method: 'POST', body: undefined, token: null },
    ])
    expect(result.details.url).toBe('http://localhost:37287/p/other-1/')
  })

  it('still mounts once on project_not_attached, then starts', async () => {
    process.env.SHOGO_RUNTIME_SUBSTRATE = 'cloud'
    let starts = 0
    const calls = stubFetch((call) => {
      if (call.url.includes('/preview/start')) {
        starts += 1
        if (starts === 1) return Response.json({ error: 'project_not_attached' }, { status: 404 })
        return Response.json({ ok: true, phase: 'running' })
      }
      expect(call.url).toContain('/sessions/session-1/members')
      return Response.json({ ok: true, attached: { projectId: 'other-1' } })
    })

    const result = await previewTool().execute('t', { projectId: 'other-1' })

    expect(starts).toBe(2)
    expect(calls.filter((call) => call.url.includes('/members'))).toHaveLength(1)
    expect(result.details.url).toBe('http://localhost:37287/p/other-1/')
  })
})
