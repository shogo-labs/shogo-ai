// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const here = fileURLToPath(new URL('.', import.meta.url))
let posts: Array<{ url: string; body: unknown }> = []

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Pressable: ({ accessibilityLabel, children, onPress, testID, disabled }: any) =>
      createElement('button', { 'aria-label': accessibilityLabel, 'data-testid': testID, onClick: onPress, disabled }, children),
    TextInput: ({ value, onChangeText, accessibilityLabel }: any) =>
      createElement('textarea', { 'aria-label': accessibilityLabel, value, onChange: (e: any) => onChangeText(e.target.value) }),
  } as any),
)
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }))
mock.module('lucide-react-native', () => {
  const Icon = () => createElement('span')
  return { AlertTriangle: Icon, ArrowDownLeft: Icon, ArrowUpRight: Icon, Paperclip: Icon, ShieldAlert: Icon, ShieldCheck: Icon }
})
mock.module(resolve(here, '../../../lib/workspace-http'), () => ({
  workspaceHttpProxy: () => ({
    post: async (url: string, body: unknown) => {
      posts.push({ url, body })
      return { data: { mail: { id: 'm1', status: url.endsWith('/approve') ? 'scheduled' : 'cancelled' } } }
    },
    get: async () => ({ data: '' }),
  }),
}))

const { EmailCard } = await import('../EmailCard')

const base = {
  mailId: 'm1',
  threadId: 't1',
  mailboxId: 'mb1',
  to: [{ address: 'jane@customer.io', name: 'Jane' }],
  cc: [],
  subject: 'Order #42',
  hasHtml: false,
  attachments: [],
}

beforeEach(() => {
  posts = []
})

describe('EmailCard', () => {
  test('inbound mail is labelled as external, with a failed-auth warning', () => {
    render(createElement(EmailCard, {
      workspaceId: 'w1',
      body: 'Hi',
      email: { ...base, direction: 'inbound', status: 'received', from: { address: 'jane@customer.io', name: 'Jane' }, untrusted: true, auth: { spf: 'fail', dkim: 'pass', dmarc: 'fail' } } as any,
    }))
    expect(screen.getByText(/External email/)).toBeTruthy()
    expect(screen.getByText(/could not be verified/)).toBeTruthy()
  })

  test("an agent's draft is sent only when a person approves it, with their edits", async () => {
    render(createElement(EmailCard, {
      workspaceId: 'w1',
      body: 'Draft text',
      email: { ...base, direction: 'outbound', status: 'pending_approval', from: { address: 'support@acme.com' }, draftedBy: 'project:p1' } as any,
    }))
    expect(screen.getByText(/Nothing is sent until someone approves it/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('email-edit'))
    fireEvent.change(screen.getByLabelText('Edit draft'), { target: { value: 'Edited text' } })
    fireEvent.click(screen.getByTestId('email-approve'))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ url: '/api/workspaces/w1/mail/messages/m1/approve', body: { text: 'Edited text' } })
    await waitFor(() => expect(screen.queryByTestId('email-approval')).toBeNull())
  })

  test('discard cancels the draft', async () => {
    render(createElement(EmailCard, {
      workspaceId: 'w1',
      body: 'Draft text',
      email: { ...base, direction: 'outbound', status: 'pending_approval', from: { address: 'support@acme.com' } } as any,
    }))
    fireEvent.click(screen.getByTestId('email-discard'))
    await waitFor(() => expect(posts.map((p) => p.url)).toEqual(['/api/workspaces/w1/mail/messages/m1/discard']))
  })
})
