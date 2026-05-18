// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/lib/voice-context.ts`.
 *
 * Covers:
 *   - formatContextBlock(): every combination of (metadata, memory, userMd)
 *     - omits the "About this project" header if no fields render
 *     - prefers description over siteDescription, omits siteTitle when equal to name
 *     - truncates MEMORY.md at 4_000 bytes and USER.md at 2_000 bytes
 *     - strips whitespace-only memory/user content
 *   - resolveVoiceContext():
 *     - happy path returns formatted block
 *     - missing prisma row → returns ''
 *     - getProjectPodUrl throws → still returns metadata-only block
 *     - pod fetch returns non-ok → swallowed, evictOnSingleMissingAuth invoked
 *     - timeout / fetch throws → null memory / userMd
 *     - body without `content` string → null
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// ─── Mock all imports BEFORE importing the module ─────────────────────

const prismaMock = {
  project: {
    findUnique: mock(async (_args: any) => null as any),
  },
}
mock.module('../lib/prisma', () => ({ prisma: prismaMock }))

const knativeMock = {
  getProjectPodUrl: mock(async (_id: string) => 'http://pod.local'),
}
mock.module('../lib/knative-project-manager', () => knativeMock)

const runtimeTokenMock = {
  deriveRuntimeToken: mock((_id: string) => 'rt_test'),
}
mock.module('../lib/runtime-token', () => runtimeTokenMock)

const selfHealMock = {
  evictOnSingleMissingAuth: mock(async (_id: string, _s: number, _b: string) => undefined),
}
mock.module('../lib/warm-pool-self-heal', () => selfHealMock)

// Stub the optional cross-package re-export so import doesn't fail if
// agent-runtime isn't installed in this slice of the workspace.
mock.module('@shogo/agent-runtime/src/voice-mode/translator-persona', () => ({
  composeVoiceSystemPrompt: () => '',
}))

const { resolveVoiceContext, formatContextBlock } = await import('../lib/voice-context')

// ─── Reset between tests ──────────────────────────────────────────────

const ORIG_FETCH = globalThis.fetch
let fetchImpl: (input: any, init?: any) => Promise<Response> = async () =>
  new Response('not impl', { status: 500 })

beforeEach(() => {
  prismaMock.project.findUnique.mockClear()
  prismaMock.project.findUnique.mockImplementation(async () => null)
  knativeMock.getProjectPodUrl.mockClear()
  knativeMock.getProjectPodUrl.mockImplementation(async () => 'http://pod.local')
  runtimeTokenMock.deriveRuntimeToken.mockClear()
  runtimeTokenMock.deriveRuntimeToken.mockImplementation(() => 'rt_test')
  selfHealMock.evictOnSingleMissingAuth.mockClear()
  selfHealMock.evictOnSingleMissingAuth.mockImplementation(async () => undefined)
  fetchImpl = async () => new Response('not impl', { status: 500 })
  globalThis.fetch = ((input: any, init?: any) => fetchImpl(input, init)) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = ORIG_FETCH
})

// ═══════════════════════════════════════════════════════════════════════
// formatContextBlock()
// ═══════════════════════════════════════════════════════════════════════

describe('formatContextBlock()', () => {
  test('returns "" when nothing supplied', () => {
    expect(formatContextBlock({ metadata: null, memory: null, userMd: null })).toBe('')
  })

  test('renders project name + description', () => {
    const block = formatContextBlock({
      metadata: { name: 'My App', description: 'cool', siteTitle: null, siteDescription: null },
      memory: null, userMd: null,
    })
    expect(block).toContain('## About this project')
    expect(block).toContain('Name: My App')
    expect(block).toContain('Description: cool')
  })

  test('falls back to siteDescription when description is null', () => {
    const block = formatContextBlock({
      metadata: { name: 'X', description: null, siteTitle: null, siteDescription: 'fallback desc' },
      memory: null, userMd: null,
    })
    expect(block).toContain('Description: fallback desc')
  })

  test('omits siteTitle when identical to name', () => {
    const block = formatContextBlock({
      metadata: { name: 'Same', description: 'd', siteTitle: 'Same', siteDescription: null },
      memory: null, userMd: null,
    })
    expect(block).not.toContain('Site title:')
  })

  test('includes siteTitle when different from name', () => {
    const block = formatContextBlock({
      metadata: { name: 'X', description: null, siteTitle: 'Y', siteDescription: null },
      memory: null, userMd: null,
    })
    expect(block).toContain('Site title: Y')
  })

  test('drops "About this project" section entirely if metadata has only header', () => {
    const block = formatContextBlock({
      metadata: { name: null, description: null, siteTitle: null, siteDescription: null },
      memory: null, userMd: null,
    })
    expect(block).toBe('')
  })

  test('includes Long-lived memory section when memory present', () => {
    const block = formatContextBlock({
      metadata: null, memory: '- preferred dark mode\n- uses bun', userMd: null,
    })
    expect(block).toContain('## Long-lived memory')
    expect(block).toContain('preferred dark mode')
  })

  test('skips Long-lived memory when memory is whitespace only', () => {
    const block = formatContextBlock({
      metadata: null, memory: '   \n\n', userMd: null,
    })
    expect(block).toBe('')
  })

  test('truncates memory beyond 4000 bytes with marker', () => {
    const long = 'x'.repeat(5_000)
    const block = formatContextBlock({ metadata: null, memory: long, userMd: null })
    expect(block).toContain('(truncated, original was 5000 bytes)')
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThan(5_500)
  })

  test('truncates userMd beyond 2000 bytes with marker', () => {
    const long = 'u'.repeat(2_500)
    const block = formatContextBlock({ metadata: null, memory: null, userMd: long })
    expect(block).toContain('(truncated, original was 2500 bytes)')
  })

  test('memory <= 4000 bytes is not truncated', () => {
    const exact = 'a'.repeat(3_999)
    const block = formatContextBlock({ metadata: null, memory: exact, userMd: null })
    expect(block).not.toContain('(truncated')
  })

  test('user section labelled "About this user"', () => {
    const block = formatContextBlock({
      metadata: null, memory: null, userMd: 'Name: Alice',
    })
    expect(block).toContain('## About this user')
    expect(block).toContain('Name: Alice')
  })

  test('full combo: all 3 sections joined with blank lines', () => {
    const block = formatContextBlock({
      metadata: { name: 'A', description: 'B', siteTitle: null, siteDescription: null },
      memory: 'mem',
      userMd: 'usr',
    })
    expect(block.split('\n\n').length).toBeGreaterThanOrEqual(3)
    expect(block).toContain('## About this project')
    expect(block).toContain('## Long-lived memory')
    expect(block).toContain('## About this user')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// resolveVoiceContext()
// ═══════════════════════════════════════════════════════════════════════

describe('resolveVoiceContext()', () => {
  test('returns "" when project missing AND no pod fetch results', async () => {
    prismaMock.project.findUnique.mockImplementation(async () => null)
    knativeMock.getProjectPodUrl.mockImplementation(async () => { throw new Error('cold') })
    const out = await resolveVoiceContext({ projectId: 'pX' })
    expect(out).toBe('')
  })

  test('happy path: project metadata + MEMORY.md + USER.md', async () => {
    prismaMock.project.findUnique.mockImplementation(async () => ({
      name: 'Lyra', description: 'voice app', siteTitle: null, siteDescription: null,
    }))
    fetchImpl = async (url: any) => {
      const s = String(url)
      if (s.includes('MEMORY.md')) return new Response(JSON.stringify({ content: 'past chat: ...' }), { status: 200 })
      if (s.includes('USER.md')) return new Response(JSON.stringify({ content: 'Name: Bob' }), { status: 200 })
      return new Response('?', { status: 404 })
    }
    const out = await resolveVoiceContext({ projectId: 'p1' })
    expect(out).toContain('Name: Lyra')
    expect(out).toContain('past chat:')
    expect(out).toContain('Name: Bob')
  })

  test('uses runtime-token in fetch headers', async () => {
    prismaMock.project.findUnique.mockImplementation(async () => ({
      name: 'X', description: null, siteTitle: null, siteDescription: null,
    }))
    let seenAuth: string | null = null
    fetchImpl = async (_url: any, init: any) => {
      seenAuth = init?.headers?.['x-runtime-token'] ?? null
      return new Response(JSON.stringify({ content: 'ok' }), { status: 200 })
    }
    await resolveVoiceContext({ projectId: 'p1' })
    expect(seenAuth).toBe('rt_test')
    expect(runtimeTokenMock.deriveRuntimeToken).toHaveBeenCalledWith('p1')
  })

  test('strips trailing slash from podUrl when constructing fetch URL', async () => {
    prismaMock.project.findUnique.mockImplementation(async () => ({
      name: 'X', description: null, siteTitle: null, siteDescription: null,
    }))
    knativeMock.getProjectPodUrl.mockImplementation(async () => 'http://pod.local///')
    const seenUrls: string[] = []
    fetchImpl = async (url: any) => {
      seenUrls.push(String(url))
      return new Response(JSON.stringify({ content: 'ok' }), { status: 200 })
    }
    await resolveVoiceContext({ projectId: 'p1' })
    for (const u of seenUrls) {
      expect(u.startsWith('http://pod.local/agent/workspace/files/')).toBe(true)
    }
  })

  test('pod fetch 401 triggers evictOnSingleMissingAuth and returns null', async () => {
    prismaMock.project.findUnique.mockImplementation(async () => ({
      name: 'X', description: null, siteTitle: null, siteDescription: null,
    }))
    fetchImpl = async () => new Response('missing auth', { status: 401 })
    const out = await resolveVoiceContext({ projectId: 'p1' })
    // The project metadata still renders even without memory
    expect(out).toContain('Name: X')
    expect(selfHealMock.evictOnSingleMissingAuth).toHaveBeenCalled()
  })

  test('pod fetch network error → memory section omitted, metadata still returned', async () => {
    prismaMock.project.findUnique.mockImplementation(async () => ({
      name: 'X', description: 'desc', siteTitle: null, siteDescription: null,
    }))
    fetchImpl = async () => { throw new Error('econnrefused') }
    const out = await resolveVoiceContext({ projectId: 'p1' })
    expect(out).toContain('Name: X')
    expect(out).not.toContain('## Long-lived memory')
    expect(out).not.toContain('## About this user')
  })

  test('pod returns JSON without content string → null', async () => {
    prismaMock.project.findUnique.mockImplementation(async () => ({
      name: 'X', description: null, siteTitle: null, siteDescription: null,
    }))
    fetchImpl = async () => new Response(JSON.stringify({ other: 'field' }), { status: 200 })
    const out = await resolveVoiceContext({ projectId: 'p1' })
    expect(out).toContain('Name: X')
    expect(out).not.toContain('## Long-lived memory')
  })

  test('getProjectPodUrl throws → still returns metadata block', async () => {
    prismaMock.project.findUnique.mockImplementation(async () => ({
      name: 'Solo', description: null, siteTitle: null, siteDescription: null,
    }))
    knativeMock.getProjectPodUrl.mockImplementation(async () => { throw new Error('no pod') })
    const out = await resolveVoiceContext({ projectId: 'p1' })
    expect(out).toContain('Name: Solo')
    expect(out).not.toContain('## Long-lived memory')
  })

  test('prisma throws → metadata becomes null, pod fetches still attempted', async () => {
    prismaMock.project.findUnique.mockImplementation(async () => { throw new Error('db') })
    fetchImpl = async () => new Response(JSON.stringify({ content: 'mem only' }), { status: 200 })
    const out = await resolveVoiceContext({ projectId: 'p1' })
    expect(out).toContain('## Long-lived memory')
    expect(out).toContain('mem only')
    expect(out).not.toContain('## About this project')
  })

  test('respects upstream abort signal: aborts in-flight fetches', async () => {
    prismaMock.project.findUnique.mockImplementation(async () => null)
    const controller = new AbortController()
    let aborted = false
    fetchImpl = async (_u: any, init: any) => {
      if (init?.signal?.aborted) {
        aborted = true
        throw new Error('aborted')
      }
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('aborted'))
        })
      })
    }
    controller.abort()
    await resolveVoiceContext({ projectId: 'p1', signal: controller.signal })
    expect(aborted).toBe(true)
  })

  test('encodes special characters in file path', async () => {
    prismaMock.project.findUnique.mockImplementation(async () => null)
    const seen: string[] = []
    fetchImpl = async (url: any) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ content: '' }), { status: 200 })
    }
    await resolveVoiceContext({ projectId: 'p1' })
    expect(seen[0]).toContain(encodeURIComponent('MEMORY.md'))
    expect(seen[1]).toContain(encodeURIComponent('USER.md'))
  })

  test('empty content strings are treated as no-data (skip section)', async () => {
    prismaMock.project.findUnique.mockImplementation(async () => null)
    fetchImpl = async () => new Response(JSON.stringify({ content: '   ' }), { status: 200 })
    const out = await resolveVoiceContext({ projectId: 'p1' })
    expect(out).toBe('')
  })
})
