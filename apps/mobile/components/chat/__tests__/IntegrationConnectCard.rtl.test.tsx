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
    Pressable: ({ accessibilityLabel, children, onPress }: any) =>
      createElement('div', { role: 'button', 'aria-label': accessibilityLabel, onClick: onPress }, children),
    Text: ({ children }: any) => createElement('span', null, children),
    View: ({ children }: any) => createElement('div', null, children),
    Linking: { openURL: async (url: string) => { opened.push(url) } },
  } as any),
)

let mine: { connections: any[]; grants: any[] }
let polls = 0
mock.module('../../../lib/api', () => ({
  API_URL: 'https://api.test',
  createHttpClient: () => ({
    get: async (path: string) => {
      expect(path).toBe('/api/me/integrations')
      polls += 1
      return { data: mine, status: 200, headers: new Headers() }
    },
  }),
}))

const { IntegrationConnectCard, integrationLabel } = await import('../IntegrationConnectCard')

const LINK = 'https://studio.test/api/projects/proj-1/integrations/github/connect?resume=tok'

beforeEach(() => {
  mine = { connections: [], grants: [] }
  polls = 0
})

afterEach(() => {
  cleanup()
  opened.length = 0
})

describe('IntegrationConnectCard', () => {
  test('opens the link, waits until the account is connected and allowed for this project, then continues once', async () => {
    const continued: string[] = []
    render(
      <IntegrationConnectCard
        request={{ provider: 'github', connectUrl: LINK }}
        onContinue={(label) => continued.push(label)}
        pollMs={5}
      />,
    )
    expect(screen.getByText(/This agent acts as you on GitHub/)).toBeTruthy()
    expect(polls).toBe(0)

    fireEvent.click(screen.getByLabelText('Connect GitHub'))
    expect(opened).toEqual([LINK])
    await waitFor(() => expect(polls).toBeGreaterThan(1))
    expect(continued).toEqual([])

    // Connected, but this project isn't allowed yet: keep waiting.
    mine = { connections: [{ provider: 'github' }], grants: [{ provider: 'github', projectId: 'other', revokedAt: null }] }
    const seen = polls
    await waitFor(() => expect(polls).toBeGreaterThan(seen + 1))
    expect(continued).toEqual([])

    mine.grants.push({ provider: 'github', projectId: 'proj-1', revokedAt: null })
    await waitFor(() => expect(continued).toEqual(['GitHub']))
    fireEvent.click(screen.getByLabelText("I've connected, continue"))
    await new Promise((r) => setTimeout(r, 20))
    expect(continued).toEqual(['GitHub'])
  })

  test('the person can say they are done (e.g. accounts the app cannot see)', async () => {
    const continued: string[] = []
    render(
      <IntegrationConnectCard
        request={{ provider: 'composio:google_calendar', connectUrl: 'https://studio.test/x' }}
        onContinue={(label) => continued.push(label)}
        pollMs={60_000}
      />,
    )
    expect(screen.queryByLabelText("I've connected, continue")).toBeNull()
    fireEvent.click(screen.getByLabelText('Connect Google Calendar'))
    fireEvent.click(screen.getByLabelText("I've connected, continue"))
    expect(continued).toEqual(['Google Calendar'])
  })

  test('labels', () => {
    expect(integrationLabel('github')).toBe('GitHub')
    expect(integrationLabel('composio:gmail')).toBe('Gmail')
    expect(integrationLabel('mcp:linear-issues')).toBe('Linear Issues')
  })
})
