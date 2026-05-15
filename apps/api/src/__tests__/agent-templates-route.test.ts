// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

// The route imports from "../../../../packages/agent-runtime/src/...".
// Resolve that to a path bun:test can intercept with mock.module.
const TEMPLATES_PATH = '../../../../packages/agent-runtime/src/agent-templates'
const STACKS_PATH = '../../../../packages/agent-runtime/src/workspace-defaults'

const TEMPLATES = [
  { id: 'tpl_a', name: 'Alpha', description: 'first' },
  { id: 'tpl_b', name: 'Beta', description: 'second' },
]
const CATEGORIES = [
  { id: 'cat_1', label: 'Category One' },
  { id: 'cat_2', label: 'Category Two' },
]
const FULL_TEMPLATE_BY_ID: Record<string, unknown> = {
  tpl_a: { id: 'tpl_a', name: 'Alpha', system: 'you are alpha', tools: ['Read'] },
  tpl_b: { id: 'tpl_b', name: 'Beta', system: 'you are beta', tools: ['Write'] },
}
const STACKS = [
  { id: 'stack_node', label: 'Node + TS' },
  { id: 'stack_py', label: 'Python' },
]
const STACK_META_BY_ID: Record<string, unknown> = {
  stack_node: { id: 'stack_node', label: 'Node + TS', dependencies: ['typescript'] },
  stack_py: { id: 'stack_py', label: 'Python', dependencies: ['pip'] },
}

const getTemplateSummariesMock = mock(() => TEMPLATES)
const getAgentTemplateByIdMock = mock((id: string) => FULL_TEMPLATE_BY_ID[id] ?? null)
const listTechStacksMock = mock(() => STACKS)
const loadTechStackMetaMock = mock((id: string) => STACK_META_BY_ID[id] ?? null)

mock.module(TEMPLATES_PATH, () => ({
  getTemplateSummaries: getTemplateSummariesMock,
  getAgentTemplateById: getAgentTemplateByIdMock,
  TEMPLATE_CATEGORIES: CATEGORIES,
}))
mock.module(STACKS_PATH, () => ({
  listTechStacks: listTechStacksMock,
  loadTechStackMeta: loadTechStackMetaMock,
}))

const { agentTemplateRoutes } = await import('../routes/agent-templates')

let app: ReturnType<typeof agentTemplateRoutes>

beforeEach(() => {
  getTemplateSummariesMock.mockClear()
  getAgentTemplateByIdMock.mockClear()
  listTechStacksMock.mockClear()
  loadTechStackMetaMock.mockClear()
  // Reset implementations between tests so per-test overrides don't leak.
  getTemplateSummariesMock.mockImplementation(() => TEMPLATES)
  getAgentTemplateByIdMock.mockImplementation((id) => FULL_TEMPLATE_BY_ID[id] ?? null)
  listTechStacksMock.mockImplementation(() => STACKS)
  loadTechStackMetaMock.mockImplementation((id) => STACK_META_BY_ID[id] ?? null)
  app = agentTemplateRoutes()
})

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await app.request(path)
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

describe('GET /agent-templates', () => {
  test('returns 200 with templates + categories', async () => {
    const { status, body } = await get('/agent-templates')
    expect(status).toBe(200)
    expect(body).toEqual({ templates: TEMPLATES, categories: CATEGORIES })
  })

  test('invokes getTemplateSummaries exactly once per request', async () => {
    await get('/agent-templates')
    expect(getTemplateSummariesMock).toHaveBeenCalledTimes(1)
    await get('/agent-templates')
    expect(getTemplateSummariesMock).toHaveBeenCalledTimes(2)
  })

  test('returns the empty list when there are no templates', async () => {
    getTemplateSummariesMock.mockImplementation(() => [] as any)
    const { status, body } = await get('/agent-templates')
    expect(status).toBe(200)
    expect(body.templates).toEqual([])
    expect(body.categories).toEqual(CATEGORIES)
  })
})

describe('GET /agent-templates/:id', () => {
  test('returns 200 with the full template when the id exists', async () => {
    const { status, body } = await get('/agent-templates/tpl_a')
    expect(status).toBe(200)
    expect(body).toEqual({ template: FULL_TEMPLATE_BY_ID.tpl_a })
  })

  test('passes the raw id to the lookup helper', async () => {
    await get('/agent-templates/tpl_a')
    expect(getAgentTemplateByIdMock).toHaveBeenCalledWith('tpl_a')
  })

  test('returns 404 with a JSON error envelope when the id is unknown', async () => {
    const { status, body } = await get('/agent-templates/does_not_exist')
    expect(status).toBe(404)
    expect(body).toEqual({ error: 'Template not found' })
  })

  test('returns 404 when the helper returns undefined (not just null)', async () => {
    getAgentTemplateByIdMock.mockImplementation(() => undefined as any)
    const { status, body } = await get('/agent-templates/tpl_a')
    expect(status).toBe(404)
    expect(body.error).toBe('Template not found')
  })

  test('URL-decodes the :id path param', async () => {
    // Register a template under an id with a space, then probe via percent-encoding.
    FULL_TEMPLATE_BY_ID['tpl with space'] = { id: 'tpl with space' }
    try {
      const { status, body } = await get('/agent-templates/tpl%20with%20space')
      expect(status).toBe(200)
      expect(body.template).toEqual({ id: 'tpl with space' })
    } finally {
      delete FULL_TEMPLATE_BY_ID['tpl with space']
    }
  })
})

describe('GET /tech-stacks', () => {
  test('returns 200 with the stacks array wrapped in { stacks }', async () => {
    const { status, body } = await get('/tech-stacks')
    expect(status).toBe(200)
    expect(body).toEqual({ stacks: STACKS })
  })

  test('invokes listTechStacks per request (no caching)', async () => {
    await get('/tech-stacks')
    await get('/tech-stacks')
    expect(listTechStacksMock).toHaveBeenCalledTimes(2)
  })
})

describe('GET /tech-stacks/:id', () => {
  test('returns 200 with the stack meta when the id exists', async () => {
    const { status, body } = await get('/tech-stacks/stack_node')
    expect(status).toBe(200)
    expect(body).toEqual({ stack: STACK_META_BY_ID.stack_node })
  })

  test('returns 404 with the documented error message when the id is unknown', async () => {
    const { status, body } = await get('/tech-stacks/unknown_stack')
    expect(status).toBe(404)
    expect(body).toEqual({ error: 'Tech stack not found' })
  })

  test('returns 404 when loadTechStackMeta returns undefined', async () => {
    loadTechStackMetaMock.mockImplementation(() => undefined as any)
    const { status, body } = await get('/tech-stacks/stack_node')
    expect(status).toBe(404)
    expect(body.error).toBe('Tech stack not found')
  })

  test('passes the id to loadTechStackMeta unchanged', async () => {
    await get('/tech-stacks/stack_py')
    expect(loadTechStackMetaMock).toHaveBeenCalledWith('stack_py')
  })
})

describe('agentTemplateRoutes — Hono app factory', () => {
  test('returns a fresh Hono app on each call (no shared state)', () => {
    const a = agentTemplateRoutes()
    const b = agentTemplateRoutes()
    expect(a).not.toBe(b)
  })

  test('returns 404 for unrelated paths (router doesn\'t catch-all)', async () => {
    const res = await app.request('/some/other/path')
    expect(res.status).toBe(404)
  })

  test('rejects non-GET methods on the registered paths', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await app.request('/agent-templates', { method })
      expect(res.status).toBe(404)
    }
  })
})
