// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

let projectName: string | null = 'New Project'
const projectFindUnique = mock(async () => (
  projectName ? { name: projectName } : null
))
const projectUpdate = mock(async (_args: any) => ({}))

mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: projectFindUnique,
      update: projectUpdate,
    },
  },
}))

const { localProjectMetadataRoutes } = await import('../routes/local-project-metadata')

const originalFetch = globalThis.fetch
const originalApiKey = process.env.SHOGO_API_KEY
const originalCloudUrl = process.env.SHOGO_CLOUD_URL

function buildApp() {
  const app = new Hono()
  app.route('/api', localProjectMetadataRoutes())
  return app
}

beforeEach(() => {
  projectName = 'New Project'
  projectFindUnique.mockClear()
  projectUpdate.mockClear()
  delete process.env.SHOGO_API_KEY
  process.env.SHOGO_CLOUD_URL = 'https://cloud.example'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalApiKey === undefined) delete process.env.SHOGO_API_KEY
  else process.env.SHOGO_API_KEY = originalApiKey
  if (originalCloudUrl === undefined) delete process.env.SHOGO_CLOUD_URL
  else process.env.SHOGO_CLOUD_URL = originalCloudUrl
})

describe('local project metadata naming', () => {
  test('forwards naming to Shogo Cloud and persists the AI result', async () => {
    process.env.SHOGO_API_KEY = 'shogo_sk_test'
    const requests: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: typeof input === 'string' ? input : input.toString(),
        init,
      })
      return new Response(JSON.stringify({
        name: 'Task Tracker',
        description: 'Organize daily tasks.',
        source: 'ai',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const response = await buildApp().fetch(new Request('http://local/api/generate-project-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Build a task tracker',
        workspaceId: 'local-workspace',
        projectId: 'local-project',
      }),
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      name: 'Task Tracker',
      description: 'Organize daily tasks.',
      source: 'ai',
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://cloud.example/api/generate-project-name')
    expect(new Headers(requests[0]?.init?.headers).get('Authorization'))
      .toBe('Bearer shogo_sk_test')
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      prompt: 'Build a task tracker',
    })
    expect(projectUpdate).toHaveBeenCalledWith({
      where: { id: 'local-project' },
      data: { name: 'Task Tracker', description: 'Organize daily tasks.' },
    })
  })

  test('uses the heuristic without a cloud key', async () => {
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      throw new Error('fetch should not be called')
    }) as typeof fetch

    const response = await buildApp().fetch(new Request('http://local/api/generate-project-name', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Build a recipe manager' }),
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      name: 'Recipe Manager',
      description: 'Build a recipe manager',
      source: 'heuristic',
    })
    expect(fetchCalled).toBe(false)
  })

  test('falls back to the heuristic when cloud naming fails', async () => {
    process.env.SHOGO_API_KEY = 'shogo_sk_test'
    globalThis.fetch = (async () => (
      new Response('upstream unavailable', { status: 503 })
    )) as typeof fetch

    const response = await buildApp().fetch(new Request('http://local/api/generate-project-name', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Build a server monitor' }),
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      name: 'Server Monitor',
      description: 'Build a server monitor',
      source: 'heuristic',
    })
  })

  test('does not rename a project that already has a name', async () => {
    process.env.SHOGO_API_KEY = 'shogo_sk_test'
    projectName = 'Existing Project'
    globalThis.fetch = (async () => new Response(JSON.stringify({
      name: 'New Cloud Name',
      description: 'Cloud description.',
      source: 'ai',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const response = await buildApp().fetch(new Request('http://local/api/generate-project-name', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Build a server monitor', projectId: 'local-project' }),
    }))

    expect(response.status).toBe(200)
    expect((await response.json() as any).source).toBe('ai')
    expect(projectUpdate).not.toHaveBeenCalled()
  })
})
