// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

let projectRow: any = null
let projectFindUniqueError: Error | null = null
let podUrl: string | Error = 'http://pod.local/'
const evictions: any[] = []
const projectFindUniqueMock = mock(async () => {
  if (projectFindUniqueError) throw projectFindUniqueError
  return projectRow
})

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findUnique: projectFindUniqueMock,
    },
  },
}))

mock.module('../lib/knative-project-manager', () => ({
  getProjectPodUrl: mock(async () => {
    if (podUrl instanceof Error) throw podUrl
    return podUrl
  }),
}))

mock.module('../lib/runtime-token', () => ({
  deriveRuntimeToken: (projectId: string) => `runtime-${projectId}`,
}))

mock.module('../lib/warm-pool-self-heal', () => ({
  evictOnSingleMissingAuth: mock(async (...args: any[]) => {
    evictions.push(args)
  }),
}))

let formatContextBlock: typeof import('../lib/voice-context').formatContextBlock
let resolveVoiceContext: typeof import('../lib/voice-context').resolveVoiceContext

beforeEach(async () => {
  projectRow = null
  projectFindUniqueError = null
  podUrl = 'http://pod.local/'
  evictions.length = 0
  projectFindUniqueMock.mockClear()
  delete (globalThis as any).fetch
  const mod = await import('../lib/voice-context')
  formatContextBlock = mod.formatContextBlock
  resolveVoiceContext = mod.resolveVoiceContext
})

describe('formatContextBlock', () => {
  test('omits empty metadata but includes memory and user sections', () => {
    const block = formatContextBlock({
      metadata: { name: null, description: null, siteTitle: null, siteDescription: null },
      memory: '  Remember the billing question.  ',
      userMd: '  Prefers terse answers. ',
    })

    expect(block).not.toContain('About this project')
    expect(block).toContain('## Long-lived memory\nRemember the billing question.')
    expect(block).toContain('## About this user\nPrefers terse answers.')
  })

  test('uses siteDescription fallback and avoids duplicate site title', () => {
    const block = formatContextBlock({
      metadata: {
        name: 'Acme',
        description: null,
        siteTitle: 'Acme',
        siteDescription: 'A support agent',
      },
      memory: null,
      userMd: null,
    })

    expect(block).toContain('Name: Acme')
    expect(block).toContain('Description: A support agent')
    expect(block).not.toContain('Site title: Acme')
  })

  test('truncates large memory and user files', () => {
    const block = formatContextBlock({
      metadata: null,
      memory: 'm'.repeat(4100),
      userMd: 'u'.repeat(2100),
    })

    expect(block).toContain('truncated, original was 4100 bytes')
    expect(block).toContain('truncated, original was 2100 bytes')
  })
})

describe('resolveVoiceContext', () => {
  test('combines metadata with pod MEMORY.md and USER.md', async () => {
    projectRow = {
      name: 'Agent App',
      description: 'Builds agents',
      siteTitle: 'Agent Site',
      siteDescription: 'Ignored when description exists',
    }
    const fetched: any[] = []
    globalThis.fetch = (async (url: string, init: any) => {
      fetched.push({ url, init })
      if (url.includes('MEMORY.md')) return Response.json({ content: 'Memory text' })
      return Response.json({ content: 'User text' })
    }) as any

    const block = await resolveVoiceContext({ projectId: 'project-1' })

    expect(block).toContain('Name: Agent App')
    expect(block).toContain('Description: Builds agents')
    expect(block).toContain('Site title: Agent Site')
    expect(block).toContain('Memory text')
    expect(block).toContain('User text')
    expect(fetched[0].init.headers['x-runtime-token']).toBe('runtime-project-1')
  })

  test('falls back to metadata when pod URL lookup fails', async () => {
    projectRow = { name: 'Solo', description: null, siteTitle: null, siteDescription: null }
    podUrl = new Error('cold pod')

    const block = await resolveVoiceContext({ projectId: 'project-1' })

    expect(block).toBe('## About this project\nName: Solo')
  })

  test('treats failed pod file responses as absent and triggers self-heal hook', async () => {
    projectRow = null
    globalThis.fetch = (async () => new Response('missing auth', { status: 401 })) as any

    const block = await resolveVoiceContext({ projectId: 'project-1' })

    expect(block).toBe('')
    expect(evictions).toHaveLength(2)
    expect(evictions[0]).toEqual(['project-1', 401, 'missing auth'])
  })

  test('returns empty context when metadata lookup and pod file fetches fail', async () => {
    projectFindUniqueError = new Error('database offline')
    globalThis.fetch = (async () => {
      throw new Error('pod offline')
    }) as any

    const block = await resolveVoiceContext({ projectId: 'project-1' })

    expect(block).toBe('')
  })

  test('handles an already-aborted caller signal during pod file fetch', async () => {
    projectRow = { name: 'Aborted', description: null, siteTitle: null, siteDescription: null }
    const controller = new AbortController()
    controller.abort()
    globalThis.fetch = (async (_url: string, init: any) => {
      expect(init.signal.aborted).toBe(true)
      return Response.json({ content: 'ignored' })
    }) as any

    const block = await resolveVoiceContext({
      projectId: 'project-1',
      signal: controller.signal,
    })

    expect(block).toContain('Name: Aborted')
  })

  test('removes upstream abort listeners after successful pod file fetches', async () => {
    projectRow = null
    const controller = new AbortController()
    const addSpy = mock(controller.signal.addEventListener.bind(controller.signal))
    const removeSpy = mock(controller.signal.removeEventListener.bind(controller.signal))
    ;(controller.signal as any).addEventListener = addSpy
    ;(controller.signal as any).removeEventListener = removeSpy
    globalThis.fetch = (async () => Response.json({ content: 'file text' })) as any

    const block = await resolveVoiceContext({
      projectId: 'project-1',
      signal: controller.signal,
    })

    expect(block).toContain('file text')
    expect(addSpy).toHaveBeenCalledTimes(2)
    expect(removeSpy).toHaveBeenCalledTimes(2)
  })
})
