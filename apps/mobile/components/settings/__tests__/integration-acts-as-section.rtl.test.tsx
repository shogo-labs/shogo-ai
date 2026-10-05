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
    Pressable: ({ accessibilityLabel, accessibilityState, children, disabled, onPress }: any) =>
      createElement(
        'div',
        {
          role: 'button',
          'aria-label': accessibilityLabel,
          'aria-pressed': accessibilityState?.selected ?? accessibilityState?.checked ?? undefined,
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

const { IntegrationActsAsSection, chainsFromChoices, choicesFromChains } = await import('../IntegrationActsAsSection')

let policy: any
let connections: any[]
let policyStatus = 200
let canEdit = true
const puts: any[] = []
const deletes: string[] = []
const realFetch = globalThis.fetch

beforeEach(() => {
  policy = { provider: 'github', writeChain: ['shared'], readChain: ['shared'], label: 'GitHub' }
  connections = []
  policyStatus = 200
  canEdit = true
  globalThis.fetch = (async (url: string, init: any = {}) => {
    if (init.method === 'PUT') {
      const patch = JSON.parse(init.body)
      puts.push({ url, patch })
      policy = { ...policy, ...patch }
      return new Response(JSON.stringify({ ok: true, policy }), { status: 200 })
    }
    if (init.method === 'DELETE') {
      deletes.push(url)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (policyStatus !== 200) return new Response('not found', { status: policyStatus })
    return new Response(JSON.stringify({ ok: true, canEdit, policies: [policy], me: { connections, grants: [] } }), { status: 200 })
  }) as any
})

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
  puts.length = 0
  deletes.length = 0
  opened.length = 0
})

describe('IntegrationActsAsSection', () => {
  test('defaults to the project account; switching to the person who asked saves and shows the follow-up choices', async () => {
    render(<IntegrationActsAsSection projectId="proj-1" />)
    expect(await screen.findByText('Agent acts as')).toBeTruthy()
    expect(screen.getByLabelText('Project account').getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByText(/If they haven't connected/)).toBeNull()

    fireEvent.click(screen.getByLabelText('Person who asked'))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toEqual({
      url: 'https://api.test/api/projects/proj-1/integrations/policies/github',
      patch: { writeChain: ['requester', 'ask', 'deny'], readChain: ['shared'] },
    })
    expect(await screen.findByText("If they haven't connected GitHub:")).toBeTruthy()
    expect(screen.getByLabelText('Ask them to connect').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(/When no one asked/)).toBeTruthy()

    fireEvent.click(screen.getAllByLabelText('Use the project account')[1])
    await waitFor(() => expect(puts.at(-1)?.patch.writeChain).toEqual(['requester', 'ask', 'shared']))

    fireEvent.click(screen.getByLabelText('Use their account for reading too'))
    await waitFor(() => expect(puts.at(-1)?.patch.readChain).toEqual(['requester', 'shared']))

    fireEvent.click(screen.getAllByLabelText("Don't do it")[0])
    await waitFor(() =>
      expect(puts.at(-1)?.patch).toEqual({ writeChain: ['requester', 'deny'], readChain: ['requester', 'deny'] }),
    )
    expect(screen.queryByText(/When no one asked/)).toBeNull()

    fireEvent.click(screen.getByLabelText('Project account'))
    await waitFor(() => expect(puts.at(-1)?.patch).toEqual({ writeChain: ['shared'], readChain: ['shared'] }))
  })

  test('is read-only for people who cannot change it', async () => {
    canEdit = false
    policy.writeChain = ['requester', 'ask', 'shared']
    render(<IntegrationActsAsSection projectId="proj-1" />)
    expect(await screen.findByText('Only the project owner and workspace admins can change this.')).toBeTruthy()
    expect(screen.getByLabelText('Person who asked').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByLabelText('Project account'))
    fireEvent.click(screen.getAllByLabelText("Don't do it")[0])
    await new Promise((r) => setTimeout(r, 10))
    expect(puts).toHaveLength(0)
    // Connecting your own account is still yours to do.
    expect(screen.getByLabelText('Connect my GitHub account').getAttribute('aria-disabled')).toBeNull()
  })

  test('settings and stored step lists convert both ways', () => {
    const lists: Array<[string[], string[]]> = [
      [['shared'], ['shared']],
      [['requester', 'ask', 'shared'], ['shared']],
      [['requester', 'ask', 'deny'], ['requester', 'shared']],
      [['requester', 'shared'], ['requester', 'shared']],
      [['requester', 'deny'], ['requester', 'deny']],
    ]
    for (const [writeChain, readChain] of lists) {
      expect(chainsFromChoices(choicesFromChains(writeChain as any, readChain as any))).toEqual({ writeChain, readChain } as any)
    }
  })

  test('offers to connect your own account, or shows it and lets you disconnect', async () => {
    policy.writeChain = ['requester', 'ask', 'deny']
    const { unmount } = render(<IntegrationActsAsSection projectId="proj-1" />)
    fireEvent.click(await screen.findByLabelText('Connect my GitHub account'))
    expect(opened).toEqual(['https://api.test/api/projects/proj-1/integrations/github/connect'])
    unmount()

    connections = [{ provider: 'github', externalLogin: 'bob-gh' }]
    render(<IntegrationActsAsSection projectId="proj-1" />)
    expect(await screen.findByText('You: connected as @bob-gh')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Disconnect my GitHub account'))
    await waitFor(() => expect(deletes).toEqual(['https://api.test/api/me/integrations/github']))
    expect(await screen.findByLabelText('Connect my GitHub account')).toBeTruthy()
  })

  test('renders nothing where the server has no such setting (desktop)', async () => {
    policyStatus = 404
    const { container } = render(<IntegrationActsAsSection projectId="proj-1" />)
    await new Promise((r) => setTimeout(r, 10))
    expect(container.textContent).toBe('')
  })
})
