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

// The dialog chrome is not what this file is about — it is wired to the copy
// and to resolving the caller's promise, so stand the chrome down.
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

const { ChannelBroadcastConfirmHost, requestChannelBroadcastConfirm, __resetChannelBroadcastConfirmForTest } =
  await import('../ChannelBroadcastConfirm')
const { broadcastConfirmCopy } = await import('../../../lib/channel-broadcast-consent')
const { Platform } = await import('react-native')

const copy = broadcastConfirmCopy(['channel'], 'engineering')

afterEach(() => {
  cleanup()
  __resetChannelBroadcastConfirmForTest()
  alerts.length = 0
  ;(Platform as any).OS = 'web'
})

describe('channel broadcast confirmation', () => {
  test('renders nothing until something asks', () => {
    render(<ChannelBroadcastConfirmHost />)
    expect(screen.queryByText(copy.title)).toBeNull()
  })

  test('on web it names the channel it is warning about, and Send resolves true', async () => {
    render(<ChannelBroadcastConfirmHost />)
    let answer: Promise<boolean>
    await act(async () => {
      answer = requestChannelBroadcastConfirm(copy)
    })
    expect(await screen.findByText('Notify everyone in #engineering?')).toBeTruthy()
    expect(screen.getByText('Everyone in #engineering will get a notification for this message.')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Send'))
    expect(await answer!).toBe(true)
  })

  test('on web Cancel resolves false, so the message is held back', async () => {
    render(<ChannelBroadcastConfirmHost />)
    let answer: Promise<boolean>
    await act(async () => {
      answer = requestChannelBroadcastConfirm(copy)
    })
    await screen.findByText(copy.title)
    fireEvent.click(screen.getByLabelText('Cancel'))
    expect(await answer!).toBe(false)
  })

  test('on native it falls back to a system alert with the same copy', async () => {
    ;(Platform as any).OS = 'android'
    const answer = requestChannelBroadcastConfirm(copy)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.title).toBe(copy.title)
    expect(alerts[0]!.body).toBe(copy.body)
    expect(alerts[0]!.buttons.map((b: any) => b.text)).toEqual(['Cancel', 'Send'])
    alerts[0]!.buttons[1].onPress()
    expect(await answer).toBe(true)
  })

  test('a second ask collapses onto the latest rather than stacking dialogs', async () => {
    render(<ChannelBroadcastConfirmHost />)
    let first: Promise<boolean>
    let second: Promise<boolean>
    await act(async () => {
      first = requestChannelBroadcastConfirm(copy)
    })
    await act(async () => {
      second = requestChannelBroadcastConfirm(broadcastConfirmCopy(['here'], null))
    })
    // The superseded question resolves false, so the composer is never left
    // waiting on a dialog it can no longer see.
    expect(await first!).toBe(false)
    expect(await screen.findByText('Notify everyone online?')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Send'))
    expect(await second!).toBe(true)
  })
})
