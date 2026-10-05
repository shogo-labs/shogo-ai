// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Modal: ({ visible, children }: any) => (visible ? createElement('div', null, children) : null),
    Pressable: ({ testID, accessibilityLabel, accessibilityState, children, onPress }: any) =>
      createElement(
        'div',
        { role: 'button', 'data-testid': testID, 'aria-label': accessibilityLabel, 'aria-checked': accessibilityState?.checked, onClick: onPress },
        children,
      ),
  } as any),
)

const { AppConsentSheet } = await import('../AppConsentSheet')

const request = {
  version: '1.2.0',
  scopes: [{ scope: 'members:read', description: 'See who joins and leaves the workspace' }],
  optionalScopes: [{ scope: 'members:read.email', description: "See members' email addresses" }],
  requiredToolkits: ['github'],
  events: [
    { type: 'member.joined', target: 'hook', name: 'Welcome' },
    { type: 'composio.github.GITHUB_ISSUE_ADDED_EVENT', target: 'agent' },
  ],
}

afterEach(cleanup)

describe('AppConsentSheet', () => {
  test('lists what the app asks for and accepts with the optional scopes the user ticked', () => {
    const accepted: any[] = []
    render(
      <AppConsentSheet visible appName="Welcome Bot" request={request} installing={false} onAccept={(c) => accepted.push(c)} onCancel={() => {}} />,
    )
    expect(screen.getByText('Allow Welcome Bot?')).toBeTruthy()
    expect(screen.getByText('See who joins and leaves the workspace')).toBeTruthy()
    expect(screen.getByText('Github')).toBeTruthy()
    expect(screen.getByText('• Welcome')).toBeTruthy()
    expect(screen.getByText('• Github: github issue added event')).toBeTruthy()

    fireEvent.click(screen.getByTestId('app-consent-accept'))
    fireEvent.click(screen.getByLabelText("See members' email addresses"))
    fireEvent.click(screen.getByTestId('app-consent-accept'))
    expect(accepted).toEqual([
      { accept: true, optionalScopes: [] },
      { accept: true, optionalScopes: ['members:read.email'] },
    ])
  })

  test('asks to connect missing apps before installing', () => {
    let connected = false
    render(
      <AppConsentSheet
        visible
        appName="Welcome Bot"
        request={request}
        installing={false}
        missingToolkits={['github']}
        onConnect={() => { connected = true }}
        onAccept={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByText('Connect Github to this workspace first, then install again.')).toBeTruthy()
    fireEvent.click(screen.getByText('Open Integrations'))
    expect(connected).toBe(true)
  })
})
