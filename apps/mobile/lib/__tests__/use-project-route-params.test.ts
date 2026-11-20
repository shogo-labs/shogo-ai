// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `mergeProjectRouteParams` (SHO-174).
 *
 * The hook itself (`useProjectRouteParams`) is React + expo-router glue tested
 * in e2e; the pure function captures all the interesting logic and is easy to
 * unit-test here.
 */
import { describe, expect, it } from 'bun:test'
import { mergeProjectRouteParams } from '../project-route-params-core'

const ID = 'proj-abc'
const PROJECT_PATH = `/projects/${ID}`

type Params = Record<string, string | string[] | undefined>

function params(overrides: Params = {}): Params {
  return { id: ID, ...overrides }
}

describe('mergeProjectRouteParams', () => {
  it('cold-load: leaf params fill what local is missing', () => {
    const local = params({})
    const global = params({ tab: 'settings', chatSessionId: 'chat-x' })
    const result = mergeProjectRouteParams({
      local,
      global,
      pathname: PROJECT_PATH,
      projectId: ID,
    })
    expect(result.tab).toBe('settings')
    expect(result.chatSessionId).toBe('chat-x')
    expect(result.id).toBe(ID)
  })

  it('in-app push: local params win over leaf when both set', () => {
    const local = params({ tab: 'canvas', chatSessionId: 'local-chat' })
    const global = params({ tab: 'settings', chatSessionId: 'leaf-chat' })
    const result = mergeProjectRouteParams({
      local,
      global,
      pathname: PROJECT_PATH,
      projectId: ID,
    })
    expect(result.tab).toBe('canvas')
    expect(result.chatSessionId).toBe('local-chat')
  })

  it('cross-talk guard: foreign pathname — only local params returned', () => {
    const local = params({})
    const global = params({ tab: 'settings', chatSessionId: 'chat-x' })
    const result = mergeProjectRouteParams({
      local,
      global,
      pathname: '/settings',
      projectId: ID,
    })
    expect(result.tab).toBeUndefined()
    expect(result.chatSessionId).toBeUndefined()
  })

  it('cross-talk guard: different project pathname — only local params returned', () => {
    const local = params({})
    const global = params({ tab: 'settings', chatSessionId: 'chat-x' })
    const result = mergeProjectRouteParams({
      local,
      global,
      pathname: `/projects/other-project`,
      projectId: ID,
    })
    expect(result.tab).toBeUndefined()
    expect(result.chatSessionId).toBeUndefined()
  })

  it('missing projectId: returns local unchanged', () => {
    const local = { tab: 'canvas' } as Params
    const global = { tab: 'settings' } as Params
    const result = mergeProjectRouteParams({
      local,
      global,
      pathname: PROJECT_PATH,
      projectId: undefined,
    })
    expect(result.tab).toBe('canvas')
  })

  it('cold-load: file param arrives from leaf and is forwarded', () => {
    const local = params({})
    const global = params({ tab: 'ide', file: 'src/index.ts' })
    const result = mergeProjectRouteParams({
      local,
      global,
      pathname: PROJECT_PATH,
      projectId: ID,
    })
    expect(result.tab).toBe('ide')
    expect(result.file).toBe('src/index.ts')
  })

  it('cold-load: embed=ide arrives from leaf', () => {
    const local = params({})
    const global = params({ embed: 'ide' })
    const result = mergeProjectRouteParams({
      local,
      global,
      pathname: PROJECT_PATH,
      projectId: ID,
    })
    expect(result.embed).toBe('ide')
  })

  // --- first-render fallback: store not yet ready (global = {}) ---

  it('first-render: global empty + arrivalHref delivers chatSessionId', () => {
    const local = params({})
    const global = {} as Params
    const result = mergeProjectRouteParams({
      local,
      global,
      pathname: '/',
      projectId: ID,
      arrivalHref: `http://localhost:3000/projects/${ID}?chatSessionId=chat-bravo`,
    })
    expect(result.chatSessionId).toBe('chat-bravo')
    expect(result.id).toBe(ID)
  })

  it('first-render: global empty + arrivalHref delivers tab=settings', () => {
    const local = params({})
    const global = {} as Params
    const result = mergeProjectRouteParams({
      local,
      global,
      pathname: '/',
      projectId: ID,
      arrivalHref: `http://localhost:3000/projects/${ID}?tab=settings`,
    })
    expect(result.tab).toBe('settings')
  })

  it('first-render: global empty + arrivalHref delivers multiple params', () => {
    const local = params({})
    const global = {} as Params
    const result = mergeProjectRouteParams({
      local,
      global,
      pathname: '/',
      projectId: ID,
      arrivalHref: `http://localhost:3000/projects/${ID}?chatSessionId=abc&chatScope=workspace`,
    })
    expect(result.chatSessionId).toBe('abc')
    expect(result.chatScope).toBe('workspace')
  })

  it('first-render: global empty, local wins over arrivalHref', () => {
    const local = params({ tab: 'canvas' })
    const global = {} as Params
    const result = mergeProjectRouteParams({
      local,
      global,
      pathname: '/',
      projectId: ID,
      arrivalHref: `http://localhost:3000/projects/${ID}?tab=settings`,
    })
    expect(result.tab).toBe('canvas')
  })

  it('first-render: global empty, arrivalHref for wrong project — only local', () => {
    const local = params({})
    const global = {} as Params
    const result = mergeProjectRouteParams({
      local,
      global,
      pathname: '/',
      projectId: ID,
      arrivalHref: `http://localhost:3000/projects/other-project?chatSessionId=xyz`,
    })
    expect(result.chatSessionId).toBeUndefined()
  })

  it('first-render: global empty, no arrivalHref — only local', () => {
    const local = params({})
    const global = {} as Params
    const result = mergeProjectRouteParams({
      local,
      global,
      pathname: '/',
      projectId: ID,
    })
    expect(result.chatSessionId).toBeUndefined()
    expect(result.id).toBe(ID)
  })
})
