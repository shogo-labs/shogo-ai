// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

let projectRow: any = null
let projectFindThrows: any = null
mock.module('../../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async (_args: any) => {
        if (projectFindThrows) throw projectFindThrows
        return projectRow
      },
    },
  },
}))

let podUrlImpl: (projectId: string) => Promise<string> = async () => 'https://pod.example.com'
mock.module('../../lib/knative-project-manager', () => ({
  getProjectPodUrl: (projectId: string) => podUrlImpl(projectId),
}))

mock.module('../../lib/runtime-token', () => ({
  deriveRuntimeToken: (projectId: string) => `rt_v1_${projectId}`,
}))

const evictCalls: any[] = []
mock.module('../../lib/warm-pool-self-heal', () => ({
  evictOnSingleMissingAuth: async (...args: any[]) => {
    evictCalls.push(args)
  },
}))

// agent-runtime re-export — voice-context re-exports composeVoiceSystemPrompt
mock.module('@shogo/agent-runtime/src/voice-mode/translator-persona', () => ({
  composeVoiceSystemPrompt: ({ contextBlock }: any) => `[persona]\n${contextBlock}`,
}))

// fetch responses queue keyed by URL substring; default 404
const responses: Map<string, { status?: number; jsonBody?: any; textBody?: string }> = new Map()
const fetchCalls: Array<{ url: string; init?: RequestInit }> = []
const origFetch = globalThis.fetch

function setFetch() {
  ;(globalThis as any).fetch = (async (url: any, init?: any) => {
    fetchCalls.push({ url: String(url), init })
    let r: any = { status: 404, textBody: '' }
    for (const [k, v] of responses) {
      if (String(url).includes(k)) {
        r = v
        break
      }
    }
    const status = r.status ?? 200
    const ok = status >= 200 && status < 300
    return {
      ok,
      status,
      json: async () => r.jsonBody ?? {},
      text: async () => r.textBody ?? '',
      headers: new Headers(),
    }
  }) as any
}

beforeEach(() => {
  projectRow = null
  projectFindThrows = null
  podUrlImpl = async () => 'https://pod.example.com'
  evictCalls.length = 0
  responses.clear()
  fetchCalls.length = 0
  setFetch()
})

afterEach(() => {
  ;(globalThis as any).fetch = origFetch
})

const { resolveVoiceContext, formatContextBlock } = await import('../voice-context')

describe('formatContextBlock (pure)', () => {
  it('returns empty string when nothing is provided', () => {
    expect(formatContextBlock({ metadata: null, memory: null, userMd: null })).toBe('')
  })

  it('emits project section with name + description', () => {
    const out = formatContextBlock({
      metadata: { name: 'Shogo', description: 'AI', siteTitle: null, siteDescription: null },
      memory: null,
      userMd: null,
    })
    expect(out).toContain('## About this project')
    expect(out).toContain('Name: Shogo')
    expect(out).toContain('Description: AI')
  })

  it('falls back to siteDescription when description is null', () => {
    const out = formatContextBlock({
      metadata: { name: 'X', description: null, siteTitle: null, siteDescription: 'sitey' },
      memory: null,
      userMd: null,
    })
    expect(out).toContain('Description: sitey')
  })

  it('includes site title only when distinct from name', () => {
    const sameOut = formatContextBlock({
      metadata: { name: 'Same', description: null, siteTitle: 'Same', siteDescription: null },
      memory: null,
      userMd: null,
    })
    expect(sameOut).not.toContain('Site title:')

    const diffOut = formatContextBlock({
      metadata: { name: 'A', description: 'd', siteTitle: 'B', siteDescription: null },
      memory: null,
      userMd: null,
    })
    expect(diffOut).toContain('Site title: B')
  })

  it('omits project section entirely when no usable fields', () => {
    const out = formatContextBlock({
      metadata: { name: null, description: null, siteTitle: null, siteDescription: null },
      memory: 'mem',
      userMd: null,
    })
    expect(out).not.toContain('## About this project')
    expect(out).toContain('## Long-lived memory')
  })

  it('trims and includes memory + userMd sections', () => {
    const out = formatContextBlock({
      metadata: null,
      memory: '  hello memory  ',
      userMd: '\nuser facts\n',
    })
    expect(out).toContain('## Long-lived memory\nhello memory')
    expect(out).toContain('## About this user\nuser facts')
  })

  it('skips memory/user sections when content is whitespace only', () => {
    const out = formatContextBlock({
      metadata: null,
      memory: '   \n  ',
      userMd: '',
    })
    expect(out).toBe('')
  })

  it('truncates memory above the 4000-byte cap with a marker', () => {
    const big = 'x'.repeat(8000)
    const out = formatContextBlock({ metadata: null, memory: big, userMd: null })
    expect(out).toContain('(truncated, original was 8000 bytes)')
    expect(out.length).toBeLessThan(big.length + 200)
  })

  it('truncates userMd above the 2000-byte cap with a marker', () => {
    const big = 'y'.repeat(3000)
    const out = formatContextBlock({ metadata: null, memory: null, userMd: big })
    expect(out).toContain('(truncated, original was 3000 bytes)')
  })
})

describe('resolveVoiceContext — integration', () => {
  it('returns empty string when project missing and pod fetches yield nothing', async () => {
    podUrlImpl = async () => { throw new Error('no pod') }
    const out = await resolveVoiceContext({ projectId: 'p1' })
    expect(out).toBe('')
  })

  it('returns project metadata only when pod is unreachable', async () => {
    projectRow = { name: 'Demo', description: 'D', siteTitle: null, siteDescription: null }
    podUrlImpl = async () => { throw new Error('cold-start') }
    const out = await resolveVoiceContext({ projectId: 'p1' })
    expect(out).toContain('Name: Demo')
    expect(out).not.toContain('## Long-lived memory')
  })

  it('logs and returns null metadata when prisma throws', async () => {
    projectFindThrows = new Error('db down')
    podUrlImpl = async () => { throw new Error('skip') }
    const origWarn = console.warn
    let warnings: any[] = []
    ;(console as any).warn = (...a: any[]) => warnings.push(a)
    try {
      const out = await resolveVoiceContext({ projectId: 'p1' })
      expect(out).toBe('')
      expect(warnings.some((w) => String(w[0]).includes('loadProjectMetadata'))).toBe(true)
    } finally {
      ;(console as any).warn = origWarn
    }
  })

  it('composes project + memory + user when all are reachable', async () => {
    projectRow = { name: 'Proj', description: 'desc', siteTitle: null, siteDescription: null }
    responses.set('MEMORY.md', { status: 200, jsonBody: { content: 'memory line' } })
    responses.set('USER.md', { status: 200, jsonBody: { content: 'user line' } })
    const out = await resolveVoiceContext({ projectId: 'p1' })
    expect(out).toContain('Name: Proj')
    expect(out).toContain('memory line')
    expect(out).toContain('user line')
    expect(fetchCalls.some((c) => c.url.includes('MEMORY.md'))).toBe(true)
    expect(fetchCalls.some((c) => c.url.includes('USER.md'))).toBe(true)
    const memCall = fetchCalls.find((c) => c.url.includes('MEMORY.md'))!
    expect((memCall.init as any)?.headers?.['x-runtime-token']).toBe('rt_v1_p1')
  })

  it('strips trailing slashes from pod URL when fetching', async () => {
    projectRow = null
    podUrlImpl = async () => 'https://pod.example.com//'
    responses.set('MEMORY.md', { status: 200, jsonBody: { content: 'm' } })
    await resolveVoiceContext({ projectId: 'p1' })
    expect(fetchCalls[0].url.startsWith('https://pod.example.com/agent/workspace/files/')).toBe(true)
  })

  it('returns null memory content when response body lacks content string', async () => {
    projectRow = null
    responses.set('MEMORY.md', { status: 200, jsonBody: { content: 42 } })
    responses.set('USER.md', { status: 200, jsonBody: { content: 'u' } })
    const out = await resolveVoiceContext({ projectId: 'p1' })
    expect(out).not.toContain('## Long-lived memory')
    expect(out).toContain('## About this user')
  })

  it('evicts on 401 missing-auth for pod fetch', async () => {
    projectRow = null
    responses.set('MEMORY.md', { status: 401, textBody: 'no token' })
    responses.set('USER.md', { status: 200, jsonBody: { content: 'u' } })
    await resolveVoiceContext({ projectId: 'p1' })
    expect(evictCalls.length).toBeGreaterThanOrEqual(1)
    const args = evictCalls[0]
    expect(args[0]).toBe('p1')
    expect(args[1]).toBe(401)
  })

  it('does not throw when upstream signal is already aborted', async () => {
    projectRow = null
    responses.set('MEMORY.md', { status: 200, jsonBody: { content: 'whatever' } })
    const ac = new AbortController()
    ac.abort()
    const out = await resolveVoiceContext({ projectId: 'p1', signal: ac.signal })
    expect(typeof out).toBe('string')
  })

  it('attaches an upstream signal so later aborts propagate', async () => {
    projectRow = null
    let captured: any
    ;(globalThis as any).fetch = (async (url: any, init?: any) => {
      captured = init?.signal
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: 'u' }),
        text: async () => '',
        headers: new Headers(),
      }
    }) as any
    const ac = new AbortController()
    await resolveVoiceContext({ projectId: 'p1', signal: ac.signal })
    expect(captured).toBeDefined()
  })
})
