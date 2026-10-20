// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The consent dialog itself: it must name the channels, and it must resolve to
 * the sender's actual answer — a dialog that silently resolves `true` would
 * disclose the very thing it was asked about.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const alerts: Array<{ title: string; body: string; buttons: Array<{ text: string; onPress?: () => void }> }> = []

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (o: any) => o.web ?? o.default },
    Alert: {
      alert: (title: string, body: string, buttons: Array<{ text: string; onPress?: () => void }>) =>
        alerts.push({ title, body, buttons }),
    },
  }),
)

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
  LINK_PREVIEW_CONSENT_TITLE,
  LinkPreviewConsentHost,
  linkPreviewConsentBody,
  requestLinkPreviewConsent,
  __resetLinkPreviewConsentForTest,
} = await import('../LinkPreviewConsent')

const { Platform } = await import('react-native')

afterEach(() => {
  cleanup()
  __resetLinkPreviewConsentForTest()
  alerts.length = 0
  ;(Platform as any).OS = 'web'
})

describe('link preview consent', () => {
  test('the question names the private channel, so it can be answered', () => {
    const body = linkPreviewConsentBody(['secret-plans'])
    expect(body).toContain('#secret-plans')
    expect(body).toContain('private')
    expect(linkPreviewConsentBody(['hiring', 'board'])).toContain('#hiring and #board')
    expect(linkPreviewConsentBody([])).toContain('a private channel')
  })

  test('choosing "Share preview" resolves true', async () => {
    render(createElement(LinkPreviewConsentHost))
    let answer: Promise<boolean>
    await act(async () => {
      answer = requestLinkPreviewConsent(['secret-plans'])
    })
    expect(await screen.findByText(LINK_PREVIEW_CONSENT_TITLE)).toBeTruthy()
    expect(screen.getByText(linkPreviewConsentBody(['secret-plans']))).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Share preview'))
    })
    expect(await answer!).toBe(true)
  })

  test('choosing "Don\u2019t preview" resolves false — the content stays hidden', async () => {
    render(createElement(LinkPreviewConsentHost))
    let answer: Promise<boolean>
    await act(async () => {
      answer = requestLinkPreviewConsent(['secret-plans'])
    })
    await screen.findByText(LINK_PREVIEW_CONSENT_TITLE)
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Don't preview"))
    })
    expect(await answer!).toBe(false)
  })

  test('on native it is a system alert with the same two answers', async () => {
    ;(Platform as any).OS = 'ios'
    const answer = requestLinkPreviewConsent(['secret-plans'])
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.body).toContain('#secret-plans')
    alerts[0]!.buttons.find((b) => b.text === "Don't preview")!.onPress!()
    expect(await answer).toBe(false)
  })

  test('dismissing the native alert counts as declining', async () => {
    ;(Platform as any).OS = 'android'
    const answer = requestLinkPreviewConsent(['secret-plans'])
    // `Alert.alert` was called with an onDismiss that resolves false.
    const request = alerts[0]!
    expect(request.buttons.map((b) => b.text)).toEqual(["Don't preview", 'Share preview'])
    request.buttons.find((b) => b.text === "Don't preview")!.onPress!()
    expect(await answer).toBe(false)
  })
})
