// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop routing for cloud team workspaces: which API calls go through the
 * local `/api/cloud/<id>` relay and which stay on this computer.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetWorkspaceRouteForTests,
  getCloudWorkspacesState,
  installWorkspaceFetchRouter,
  isActiveWorkspaceCloud,
  refreshCloudWorkspaces,
  routePath,
  routeUrl,
  setCloudWorkspacesState,
} from '../workspace-route'
import { clearActiveWorkspaceId, getActiveWorkspaceId, rememberWorkspaceKind, setActiveWorkspaceId } from '../workspace-store'

const API = 'http://localhost:8002'

function signedIn() {
  setCloudWorkspacesState({
    signedIn: true,
    cloudUrl: 'https://studio.shogo.ai',
    reachable: true,
    user: { id: 'cloud-user', name: 'Russ', email: 'russ@example.com' },
    workspaces: [{ id: 'ws-acme', name: 'Acme', slug: 'acme', kind: 'team' }],
  })
}

async function activate(id: string) {
  setActiveWorkspaceId(id)
  await Promise.resolve()
}

beforeEach(() => {
  localStorage.clear()
  _resetWorkspaceRouteForTests()
  clearActiveWorkspaceId()
})

afterEach(() => {
  localStorage.clear()
})

describe('routePath', () => {
  test('passes everything through when no cloud workspaces are known', async () => {
    await activate('ws-acme')
    expect(routePath('/api/projects?workspaceId=ws-acme')).toBe('/api/projects?workspaceId=ws-acme')
  })

  test('routes calls in the active cloud workspace through the relay', async () => {
    signedIn()
    await activate('ws-acme')
    expect(isActiveWorkspaceCloud()).toBe(true)
    expect(routePath('/api/projects')).toBe('/api/cloud/ws-acme/projects')
    expect(routePath('/api/conversations/c1/messages?limit=50')).toBe('/api/cloud/ws-acme/conversations/c1/messages?limit=50')
    expect(routePath('/api/chat-sessions/s1')).toBe('/api/cloud/ws-acme/chat-sessions/s1')
  })

  test('keeps this computer\'s endpoints local in a cloud workspace', async () => {
    signedIn()
    await activate('ws-acme')
    for (const path of [
      '/api/auth/get-session',
      '/api/local/shogo-key',
      '/api/workspaces',
      '/api/workspaces?limit=50',
      '/api/users/me',
      '/api/me/getting-started',
      '/api/config',
      '/api/ai/v1/chat/completions',
      '/api/api-keys',
      '/api/cloud/ws-acme/projects',
    ]) {
      expect(routePath(path)).toBe(path)
    }
  })

  test('a path that names a workspace follows it, whichever is active', async () => {
    signedIn()
    await activate('local-ws')
    expect(isActiveWorkspaceCloud()).toBe(false)
    expect(routePath('/api/projects')).toBe('/api/projects')
    expect(routePath('/api/workspaces/ws-acme/conversations')).toBe('/api/cloud/ws-acme/workspaces/ws-acme/conversations')
    expect(routePath('/api/members?workspaceId=ws-acme')).toBe('/api/cloud/ws-acme/members?workspaceId=ws-acme')
    expect(routePath('/api/workspaces/local-ws/conversations')).toBe('/api/workspaces/local-ws/conversations')

    await activate('ws-acme')
    expect(routePath('/api/workspaces/local-ws/visible-models')).toBe('/api/workspaces/local-ws/visible-models')
    expect(routePath('/api/projects?workspaceId=local-ws')).toBe('/api/projects?workspaceId=local-ws')
  })

  test('routeUrl only rewrites URLs on the API origin', async () => {
    signedIn()
    await activate('ws-acme')
    expect(routeUrl(`${API}/api/projects`, API)).toBe(`${API}/api/cloud/ws-acme/projects`)
    expect(routeUrl('https://example.com/api/projects', API)).toBe('https://example.com/api/projects')
  })

  test('the cloud list survives a reload, so early requests route correctly', async () => {
    signedIn()
    _resetWorkspaceRouteForTests()
    expect(getCloudWorkspacesState().workspaces.map((w) => w.id)).toEqual(['ws-acme'])
    await activate('ws-acme')
    expect(routePath('/api/projects')).toBe('/api/cloud/ws-acme/projects')
  })
})

describe('installWorkspaceFetchRouter + refreshCloudWorkspaces', () => {
  test('rewrites fetches and loads the cloud list from the local API', async () => {
    const calls: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push(url)
      if (url.endsWith('/api/local/cloud-workspaces')) {
        return new Response(JSON.stringify({
          signedIn: true,
          cloudUrl: 'https://studio.shogo.ai',
          reachable: false,
          user: { id: 'cloud-user', name: 'Russ', email: null },
          workspaces: [{ id: 'ws-acme', name: 'Acme', slug: 'acme', kind: 'team' }],
        }), { headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}')
    }) as typeof fetch
    try {
      installWorkspaceFetchRouter(API)
      await activate('ws-acme')
      await fetch(`${API}/api/projects`)
      expect(calls.pop()).toBe(`${API}/api/projects`)

      const state = await refreshCloudWorkspaces(API)
      expect(state).toMatchObject({ signedIn: true, reachable: false, user: { id: 'cloud-user' } })

      await fetch(`${API}/api/projects`)
      expect(calls.pop()).toBe(`${API}/api/cloud/ws-acme/projects`)
      await fetch(new Request(`${API}/api/conversations/c1/messages`, { method: 'POST', body: '{}' }))
      expect(calls.pop()).toBe(`${API}/api/cloud/ws-acme/conversations/c1/messages`)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('cloud Personal workspace', () => {
  function stubLocalApi(workspaces: unknown[], signedIn = true) {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ signedIn, cloudUrl: null, reachable: true, user: null, workspaces }), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    return () => {
      globalThis.fetch = realFetch
    }
  }

  test('someone in the local Personal moves to the cloud Personal when signed in, and back on sign-out', async () => {
    await activate('local-personal')
    rememberWorkspaceKind('local-personal', 'personal')

    let restore = stubLocalApi([
      { id: 'cloud-personal', name: 'Russ Personal', slug: 'p', kind: 'personal' },
      { id: 'ws-acme', name: 'Acme', slug: 'acme', kind: 'team' },
    ])
    try {
      await refreshCloudWorkspaces(API)
    } finally {
      restore()
    }
    await Promise.resolve()
    expect(getActiveWorkspaceId()).toBe('cloud-personal')
    expect(routePath('/api/projects')).toBe('/api/cloud/cloud-personal/projects')

    restore = stubLocalApi([], false)
    try {
      await refreshCloudWorkspaces(API)
    } finally {
      restore()
    }
    await Promise.resolve()
    expect(getActiveWorkspaceId()).toBeNull()
    expect(routePath('/api/projects')).toBe('/api/projects')
  })

  test('a local team workspace stays active', async () => {
    await activate('local-team')
    rememberWorkspaceKind('local-team', 'team')
    const restore = stubLocalApi([{ id: 'cloud-personal', name: 'Russ Personal', slug: 'p', kind: 'personal' }])
    try {
      await refreshCloudWorkspaces(API)
    } finally {
      restore()
    }
    await Promise.resolve()
    expect(getActiveWorkspaceId()).toBe('local-team')
  })
})
