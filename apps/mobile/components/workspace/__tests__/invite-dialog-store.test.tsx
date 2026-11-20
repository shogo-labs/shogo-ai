// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The invite dialog's open/close channel (SHO-454) must work with **no
 * provider above it**.
 *
 * Gluestack renders popover content through its `PortalProvider`, which is
 * mounted at `GluestackUIProvider` — above `(app)/_layout.tsx`, where
 * `InviteDialogProvider` lives. The workspace menu, the + menu and the
 * team-chat pickers are all popovers, so a context read there threw
 * `useInviteDialog must be used inside <InviteDialogProvider>` and
 * `RootErrorBoundary` replaced the whole shell the moment the account menu
 * opened (CI run 44586672690, `E2E (local mode) 4/5`).
 *
 * The store has no tree position, so these tests render the real module with
 * nothing above it — exactly the portal's situation.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import {
  _resetInviteDialogForTests,
  closeInviteDialog,
  openInviteDialog,
  useInviteDialog,
  useInviteDialogRequest,
} from '../invite-dialog-context'

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web' },
    Pressable: ({ accessibilityLabel, children, onPress, ...props }: any) =>
      createElement('button', { ...props, 'aria-label': accessibilityLabel, onClick: onPress }, children),
    Text: ({ children, ...props }: any) => createElement('span', props, children),
  } as any),
)

afterEach(() => {
  cleanup()
  _resetInviteDialogForTests()
})

function InviteButton() {
  const { openInviteDialog: open } = useInviteDialog()
  return createElement(
    'button',
    { 'aria-label': 'Invite', onClick: () => open('ws-1') },
    'Invite',
  )
}

function RequestProbe() {
  const request = useInviteDialogRequest()
  return createElement('span', null, request ? `${request.workspaceId}:${request.emails.join(',')}` : 'closed')
}

describe('useInviteDialog', () => {
  test('opens the dialog with no provider mounted', () => {
    render(createElement(InviteButton))
    expect(() => fireEvent.click(screen.getByLabelText('Invite'))).not.toThrow()
  })

  test('carries the workspace and pre-filled addresses to the request', () => {
    render(createElement(RequestProbe))
    expect(screen.getByText('closed')).toBeTruthy()

    act(() => openInviteDialog('ws-9', { emails: ['a@x.com'] }))
    expect(screen.getByText('ws-9:a@x.com')).toBeTruthy()

    act(() => closeInviteDialog())
    expect(screen.getByText('closed')).toBeTruthy()
  })

  test('defaults the workspace to null and the addresses to none', () => {
    render(createElement(RequestProbe))
    act(() => openInviteDialog())
    expect(screen.getByText('null:')).toBeTruthy()
  })
})
