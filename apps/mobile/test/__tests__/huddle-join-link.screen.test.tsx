// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * QA acceptance spec for SHO-197 — what a visitor sees on the public huddle
 * join page (`/huddle/join/<token>`).
 *
 * `GET /api/huddle-links/:token` answers to the link alone, so the starter's
 * email must never reach this page. The API half is covered by
 * `apps/api/src/__tests__/huddles-multi.integration.test.ts`; this drives the
 * real route component (the same one the web export serves) against the
 * payload shapes that matter here:
 *
 *   - starter with no display name → "N people in the call", no "Started by",
 *     and no `@` anywhere on the page;
 *   - starter with a display name → "Started by <name> · N people in the call".
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'

let params: Record<string, unknown> = { token: 'link-token-1' }

mock.module('expo-router', () => ({
  useRouter: () => ({ replace: mock(() => {}), push: mock(() => {}), back: mock(() => {}) }),
  useLocalSearchParams: () => params,
}))

mock.module('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children, ...props }: any) => createElement('div', props, children),
}))

mock.module('lucide-react-native', () => ({
  AlertTriangle: (props: any) => createElement('span', props),
  Headphones: (props: any) => createElement('span', props),
}))

mock.module('../../contexts/auth', () => ({ useAuth: () => ({ isLoading: false, user: null }) }))
mock.module('../../components/team-chat/HuddleNotesPill', () => ({
  HuddleNotesNotice: () => createElement('p', null, 'This call is written down'),
}))
mock.module('../../components/team-chat/HuddleWindow', () => ({
  HuddlePanel: () => createElement('div', null, 'in the call'),
}))
mock.module('../../lib/huddle-call', () => ({
  joinHuddleAsGuest: mock(async () => {}),
  joinHuddleCall: mock(async () => {}),
  leaveHuddleCall: mock(async () => {}),
  setHuddleView: mock(() => {}),
  useHuddleCall: () => ({ guest: false, status: 'idle', error: null }),
}))

/** What the API answers for this link; each test sets the shape it is about. */
let linkInfo: Record<string, unknown> = {}
const huddleLinkInfo = mock(async () => linkInfo)
mock.module('../../lib/team-chat-api', () => ({
  teamChatApi: () => ({
    huddleLinkInfo,
    knockOnHuddle: mock(async () => ({ status: 'waiting', requestId: 'request-1' })),
    huddleJoinRequest: mock(async () => ({ status: 'waiting' })),
  }),
}))

const { default: HuddleJoinScreen } = await import('../../app/huddle/join/[token]')

beforeEach(() => {
  params = { token: 'link-token-1' }
  huddleLinkInfo.mockClear()
})

afterEach(() => cleanup())

describe('public huddle link page', () => {
  test('a starter with no display name shows only who is in the call — never an email', async () => {
    linkInfo = { enabled: true, live: true, access: 'knock', signedIn: false, participantCount: 2, startedBy: null }

    render(createElement(HuddleJoinScreen))

    await waitFor(() => expect(screen.getByText('2 people in the call')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Ask to join' })).toBeTruthy()
    const pageText = document.body.textContent ?? ''
    expect(pageText).not.toContain('Started by')
    expect(pageText).not.toContain('@')
  })

  test('a starter with a display name still reads "Started by <name>"', async () => {
    linkInfo = { enabled: true, live: true, access: 'knock', signedIn: false, participantCount: 1, startedBy: 'Ada Host' }

    render(createElement(HuddleJoinScreen))

    await waitFor(() => expect(screen.getByText('Started by Ada Host · 1 person in the call')).toBeTruthy())
    expect(document.body.textContent ?? '').not.toContain('@')
  })
})
