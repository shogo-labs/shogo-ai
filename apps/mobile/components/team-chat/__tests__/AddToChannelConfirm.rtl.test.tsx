// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const alerts: Array<{ title: string; body?: string; buttons: any[] }> = []

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Alert: { alert: (title: string, body?: string, buttons?: any[]) => alerts.push({ title, body, buttons: buttons ?? [] }) },
  } as any),
)

// The dialog chrome is not what this file is about — it is wired to Slack's
// copy and to resolving the caller's promise, so stand the chrome down.
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }))
mock.module('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children }: any) => createElement('div', null, children),
  AlertDialogBackdrop: () => null,
  AlertDialogContent: ({ children }: any) => createElement('div', null, children),
  AlertDialogHeader: ({ children }: any) => createElement('div', null, children),
  AlertDialogBody: ({ children }: any) => createElement('div', null, children),
  AlertDialogFooter: ({ children }: any) => createElement('div', null, children),
}))
mock.module('@/components/ui/heading', () => ({ Heading: ({ children }: any) => createElement('div', null, children) }))
mock.module('@/components/ui/text', () => ({ Text: ({ children }: any) => createElement('div', null, children) }))
mock.module('@/components/ui/button', () => ({
  Button: ({ children, onPress, accessibilityLabel }: any) =>
    createElement('div', { role: 'button', 'aria-label': accessibilityLabel, onClick: onPress }, children),
  ButtonText: ({ children }: any) => createElement('div', null, children),
}))

const {
  ADD_TO_CHANNEL_BODY,
  ADD_TO_CHANNEL_TITLE,
  AddToChannelConfirmHost,
  confirmsAddToChannel,
  requestAddToChannelConfirm,
  __resetAddToChannelConfirmForTest,
} = await import('../AddToChannelConfirm')
const { Platform } = await import('react-native')

afterEach(() => {
  cleanup()
  __resetAddToChannelConfirmForTest()
  alerts.length = 0
  ;(Platform as any).OS = 'web'
})

describe('add to channel confirmation', () => {
  test('warns about the history Slack warns about', () => {
    expect(ADD_TO_CHANNEL_TITLE).toBe('Are you sure you want to add them?')
    expect(ADD_TO_CHANNEL_BODY).toBe(
      "New members will be able to see all of the channel's history, including any files that have been shared in the channel.",
    )
  })

  test('on web the dialog asks, and Add resolves true', async () => {
    render(<AddToChannelConfirmHost />)
    let answer: Promise<boolean>
    await act(async () => {
      answer = requestAddToChannelConfirm()
    })
    expect(await screen.findByText(ADD_TO_CHANNEL_TITLE)).toBeTruthy()
    expect(screen.getByText(ADD_TO_CHANNEL_BODY)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Add'))
    expect(await answer!).toBe(true)
  })

  test('on web Cancel resolves false, and the add is skipped', async () => {
    render(<AddToChannelConfirmHost />)
    let answer: Promise<boolean>
    await act(async () => {
      answer = requestAddToChannelConfirm()
    })
    await screen.findByText(ADD_TO_CHANNEL_TITLE)
    fireEvent.click(screen.getByLabelText('Cancel'))
    expect(await answer!).toBe(false)
  })

  test('renders nothing until something asks', () => {
    render(<AddToChannelConfirmHost />)
    expect(screen.queryByText(ADD_TO_CHANNEL_TITLE)).toBeNull()
  })

  test('on native it falls back to a system alert with the same copy', async () => {
    ;(Platform as any).OS = 'android'
    const answer = requestAddToChannelConfirm()
    expect(alerts).toHaveLength(1)
    expect(alerts[0].title).toBe(ADD_TO_CHANNEL_TITLE)
    expect(alerts[0].body).toBe(ADD_TO_CHANNEL_BODY)
    expect(alerts[0].buttons.map((b) => b.text)).toEqual(['Cancel', 'Add'])
    alerts[0].buttons[1].onPress()
    expect(await answer).toBe(true)
  })
})

describe('confirmsAddToChannel', () => {
  test('a public channel is added to without asking', async () => {
    const ask = mock(async () => false)
    expect(await confirmsAddToChannel('public', ask)).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  test('a private channel asks, and a decline stops the add', async () => {
    expect(await confirmsAddToChannel('private', async () => false)).toBe(false)
  })

  test('a private channel asks, and a confirm goes through', async () => {
    expect(await confirmsAddToChannel('private', async () => true)).toBe(true)
  })
})
