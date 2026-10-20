// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A link in a message is offered to the host before the browser gets it.
 *
 * The web renderer used to accept `onLinkPress` and drop it on the floor, so
 * every link in a browser — including a link to one of our own messages — fell
 * through to the anchor and left the app. Native had this right; web did not.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import React from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    useWindowDimensions: () => ({ width: 900, height: 700, scale: 1, fontScale: 1 }),
  }),
)

const { MarkdownText } = await import('../MarkdownText.web')

afterEach(cleanup)

const LINK = 'https://studio.shogo.ai/c/c1?msg=m1'

function renderBody(text: string, onLinkPress?: (href: string) => boolean) {
  return render(
    <MarkdownText isStreaming={false} onLinkPress={onLinkPress}>
      {text}
    </MarkdownText>,
  ).container
}

function anchors(container: HTMLElement) {
  return Array.from(container.querySelectorAll('a'))
}

describe('a link in a message body', () => {
  test('is handed to the host, which can keep the reader in the app', () => {
    const onLinkPress = mock(() => true)
    const container = renderBody(`look at ${LINK}`, onLinkPress)
    const anchor = anchors(container).find((a) => a.getAttribute('href') === LINK)
    expect(anchor).toBeTruthy()

    // `dispatchEvent` reports false when the default was prevented — i.e. the
    // browser does not navigate and the host's in-place route wins.
    expect(fireEvent.click(anchor!)).toBe(false)
    expect(onLinkPress).toHaveBeenCalledWith(LINK)
  })

  test('falls back to the browser when the host does not handle it', () => {
    const onLinkPress = mock(() => false)
    const container = renderBody('outside https://example.com/thing', onLinkPress)
    const anchor = anchors(container).find((a) => a.getAttribute('href') === 'https://example.com/thing')
    expect(anchor).toBeTruthy()

    expect(fireEvent.click(anchor!)).toBe(true)
    expect(onLinkPress).toHaveBeenCalledWith('https://example.com/thing')
  })

  test('a modifier click is left alone, so "open in new tab" still works', () => {
    const onLinkPress = mock(() => true)
    const container = renderBody(`look at ${LINK}`, onLinkPress)
    const anchor = anchors(container).find((a) => a.getAttribute('href') === LINK)!

    fireEvent.click(anchor, { metaKey: true })
    expect(onLinkPress).not.toHaveBeenCalled()
  })

  test('with no host handler the anchor behaves exactly as before', () => {
    const container = renderBody('outside https://example.com/thing')
    const anchor = anchors(container).find((a) => a.getAttribute('href') === 'https://example.com/thing')
    expect(anchor).toBeTruthy()
    expect(fireEvent.click(anchor!)).toBe(true)
  })
})
