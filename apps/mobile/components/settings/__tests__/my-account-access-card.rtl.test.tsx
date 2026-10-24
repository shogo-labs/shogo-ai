// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const opened: string[] = []

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Pressable: ({ accessibilityLabel, 'aria-selected': ariaSelected, 'aria-checked': ariaChecked, children, disabled, onPress }: any) =>
      createElement(
        'div',
        {
          role: 'button',
          'aria-label': accessibilityLabel,
          'aria-pressed': ariaSelected ?? ariaChecked ?? undefined,
          'aria-disabled': disabled ? 'true' : undefined,
          onClick: disabled ? undefined : onPress,
        },
        children,
      ),
    Linking: { openURL: async (url: string) => { opened.push(url) } },
  } as any),
)
mock.module('../account-sheet-chrome', () => ({
  Text: ({ children }: any) => createElement('span', null, children),
}))
mock.module('../../../lib/api', () => ({ API_URL: 'https://api.test' }))

const { MyAccountAccessCard, coveredByScope, overrideFor } = await import('../MyAccountAccessCard')

const BASE = 'https://api.test/api/workspaces/ws-1/integrations/github/my-access'

type Agent = { projectId: string; name: string; createdByMe: boolean; override: 'allow' | 'deny' | null }
let state: { connected: boolean; login: string | null; scope: 'own' | 'all' | 'selected' | null; agents: Agent[] }
let getStatus = 200
const writes: Array<{ method: string; url: string; body: any }> = []
const realFetch = globalThis.fetch

function view() {
  return {
    ok: true,
    label: 'GitHub',
    scopes: ['own', 'all', 'selected'],
    connected: state.connected,
    login: state.login,
    scope: state.scope,
    agents: state.agents.map((a) => ({
      ...a,
      allowed: a.override ? a.override === 'allow' : coveredByScope(state.scope, a.createdByMe),
    })),
  }
}

beforeEach(() => {
  getStatus = 200
  state = {
    connected: true,
    login: 'hana-gh',
    scope: null,
    agents: [
      { projectId: 'p-mine', name: 'Hana Bot', createdByMe: true, override: null },
      { projectId: 'p-team', name: 'Ivan Bot', createdByMe: false, override: null },
    ],
  }
  globalThis.fetch = (async (url: string, init: any = {}) => {
    const method = init.method ?? 'GET'
    if (method === 'GET') {
      if (getStatus !== 200) return new Response('{}', { status: getStatus })
      return new Response(JSON.stringify(view()), { status: 200 })
    }
    const body = init.body ? JSON.parse(init.body) : undefined
    writes.push({ method, url, body })
    if (url === BASE && method === 'PUT') {
      if (body.scope !== state.scope) state.agents.forEach((a) => (a.override = null))
      state.scope = body.scope
    } else if (url === BASE && method === 'DELETE') {
      state.scope = null
      state.agents.forEach((a) => (a.override = null))
    } else if (url.startsWith(`${BASE}/agents/`)) {
      const agent = state.agents.find((a) => url.endsWith(`/${a.projectId}`))!
      agent.override = body.allowed === null ? null : body.allowed ? 'allow' : 'deny'
    } else if (url === 'https://api.test/api/me/integrations/github') {
      state = { ...state, connected: false, login: null, scope: null }
      state.agents.forEach((a) => (a.override = null))
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as any
})

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
  writes.length = 0
  opened.length = 0
})

const pressed = (label: string) => screen.getByLabelText(label).getAttribute('aria-pressed')

describe('MyAccountAccessCard', () => {
  test('picking "Agents I create" covers only my agents; switches store just the exceptions', async () => {
    render(<MyAccountAccessCard workspaceId="ws-1" />)
    expect(await screen.findByText(/Connected as @hana-gh\. No agents here act as you yet\./)).toBeTruthy()
    expect(pressed('Hana Bot acts as me')).toBe('false')

    fireEvent.click(screen.getByLabelText('Agents I create'))
    await waitFor(() => expect(pressed('Hana Bot acts as me')).toBe('true'))
    expect(writes[0]).toEqual({ method: 'PUT', url: BASE, body: { scope: 'own' } })
    expect(pressed('Agents I create')).toBe('true')
    expect(pressed('Ivan Bot acts as me')).toBe('false')
    expect(screen.getByText(/1 of 2 agents act as you/)).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Ivan Bot acts as me'))
    await waitFor(() => expect(pressed('Ivan Bot acts as me')).toBe('true'))
    expect(writes.at(-1)).toEqual({ method: 'PUT', url: `${BASE}/agents/p-team`, body: { allowed: true } })

    fireEvent.click(screen.getByLabelText('Hana Bot acts as me'))
    await waitFor(() => expect(pressed('Hana Bot acts as me')).toBe('false'))
    expect(writes.at(-1)?.body).toEqual({ allowed: false })

    // Turning it back on matches the workspace choice again, so the exception is cleared rather than stored.
    fireEvent.click(screen.getByLabelText('Hana Bot acts as me'))
    await waitFor(() => expect(pressed('Hana Bot acts as me')).toBe('true'))
    expect(writes.at(-1)?.body).toEqual({ allowed: null })
  })

  test('"Only ones I pick" starts with none; stop and disconnect', async () => {
    state.scope = 'all'
    render(<MyAccountAccessCard workspaceId="ws-1" />)
    expect(await screen.findByText(/2 of 2 agents act as you/)).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Only ones I pick'))
    await waitFor(() => expect(pressed('Ivan Bot acts as me')).toBe('false'))
    expect(pressed('Hana Bot acts as me')).toBe('false')
    fireEvent.click(screen.getByLabelText('Ivan Bot acts as me'))
    await waitFor(() => expect(pressed('Ivan Bot acts as me')).toBe('true'))

    fireEvent.click(screen.getByLabelText('Stop every agent here acting as me'))
    await waitFor(() => expect(screen.getByText(/No agents here act as you yet/)).toBeTruthy())
    expect(writes.at(-1)).toEqual({ method: 'DELETE', url: BASE, body: undefined })
    expect(screen.queryByLabelText('Stop every agent here acting as me')).toBeNull()

    fireEvent.click(screen.getByLabelText('Disconnect my GitHub account'))
    expect(await screen.findByLabelText('Connect my GitHub account')).toBeTruthy()
  })

  test('not connected: Connect goes through one of my agents so the same consent page records the choice', async () => {
    state = { ...state, connected: false, login: null }
    state.agents.reverse()
    render(<MyAccountAccessCard workspaceId="ws-1" />)
    fireEvent.click(await screen.findByLabelText('Connect my GitHub account'))
    expect(opened).toEqual(['https://api.test/api/projects/p-mine/integrations/github/connect'])
    expect(screen.queryByLabelText('Agents I create')).toBeNull()
  })

  test('hidden when the server has no such setting', async () => {
    getStatus = 400
    const { container } = render(<MyAccountAccessCard workspaceId="ws-1" />)
    await new Promise((r) => setTimeout(r, 10))
    expect(container.textContent).toBe('')
  })

  test('overrideFor stores only what differs from the workspace choice', () => {
    expect(overrideFor('own', true, true)).toBeNull()
    expect(overrideFor('own', true, false)).toBe(false)
    expect(overrideFor('own', false, true)).toBe(true)
    expect(overrideFor('all', false, false)).toBe(false)
    expect(overrideFor('selected', true, true)).toBe(true)
    expect(overrideFor(null, true, false)).toBeNull()
  })
})
