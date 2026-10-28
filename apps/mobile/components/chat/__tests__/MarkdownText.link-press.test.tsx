// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A link in a rendered message that this app knows how to open has to be taken
 * over on web too. The native renderer honoured `onLinkPress` from the start;
 * the web one dropped it, so a message link did a full page navigation instead
 * of opening the message in place.
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

const MESSAGE_LINK = 'https://studio.shogo.ai/c/conv-1?msg=m-1'

function renderBody(onLinkPress?: (href: string) => boolean) {
  return render(
    <MarkdownText isStreaming={false} onLinkPress={onLinkPress}>
      {`see ${MESSAGE_LINK} for the notes`}
    </MarkdownText>,
  ).container
}

describe('a link the host handles', () => {
  test('is handed to the host and not followed', () => {
    const handled: string[] = []
    const container = renderBody((href) => {
      handled.push(href)
      return true
    })

    const link = container.querySelector('a')!
    expect(link.getAttribute('href')).toBe(MESSAGE_LINK)
    // `fireEvent` reports false when the default was prevented, which is what
    // stops the browser from navigating away.
    expect(fireEvent.click(link)).toBe(false)
    expect(handled).toEqual([MESSAGE_LINK])
  })

  test('is left alone when the host says it does not handle it', () => {
    const handled: string[] = []
    const container = renderBody((href) => {
      handled.push(href)
      return false
    })

    const link = container.querySelector('a')!
    expect(fireEvent.click(link)).toBe(true)
    expect(handled).toEqual([MESSAGE_LINK])
  })

  test('still renders as a plain link when nothing is listening', () => {
    const container = renderBody()
    const link = container.querySelector('a')!
    expect(link.getAttribute('href')).toBe(MESSAGE_LINK)
    expect(link.textContent).toContain(MESSAGE_LINK)
  })
})
