// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent-chat attachments size to the message column, not the window: a wide
 * screenshot grows until the max height stops it, a narrow pane (a split view,
 * a side panel) shrinks it instead of overflowing, and a small image keeps its
 * own pixels.
 */

import { describe, expect, mock, test } from 'bun:test'
import { act, render } from '@testing-library/react'
import { createElement, forwardRef } from 'react'
import { createReactNativeMock } from '../../../../test/react-native-mock'

/** Layout and load handlers the shims captured, so a test can report sizes. */
const layoutHandlers = new WeakMap<Element, (event: unknown) => void>()
const imageLoadHandlers = new WeakMap<Element, (event: unknown) => void>()
/** `Image.getSize` requests: on web this is the only size that survives. */
const imageGetSizeRequests: { uri: string; success: (width: number, height: number) => void }[] = []

const flatten = (style: unknown) =>
  Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style

const chainRef =
  (handlers: WeakMap<Element, (event: unknown) => void>, onLayout: any, ref: any) => (node: any) => {
    if (node && onLayout) handlers.set(node, onLayout)
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }

// onLayout is not a DOM event, so the shims keep the handlers and the tests
// report what a real layout pass or an image load would.
mock.module('react-native', () =>
  createReactNativeMock({
    // RN-only props are mapped to DOM ones (or dropped) so the output is quiet.
    View: forwardRef(function LayoutView({ children, onLayout, testID, style, accessibilityRole, accessibilityHint, accessibilityLabel, ...props }: any, ref: any) {
      return createElement(
        'div',
        {
          ...props,
          style: flatten(style),
          'aria-label': accessibilityLabel,
          'data-rn-shim': testID ?? undefined,
          ref: chainRef(layoutHandlers, onLayout, ref),
        },
        children,
      )
    }),
    Image: (() => {
      const shim = forwardRef(function LayoutImage({ children, onLoad, testID, style, resizeMode, accessibilityLabel, ...props }: any, ref: any) {
        return createElement(
          'img',
          {
            ...props,
            style: flatten(style),
            alt: accessibilityLabel,
            'data-resize-mode': resizeMode,
            'data-rn-shim': testID ?? undefined,
            ref: chainRef(imageLoadHandlers, onLoad, ref),
          },
          children,
        )
      })
      // react-native-web measures through a retained <img>, because the load
      // event has no usable size by the time it is delivered.
      ;(shim as any).getSize = (uri: string, success: (width: number, height: number) => void) => {
        imageGetSizeRequests.push({ uri, success })
      }
      return shim
    })(),
    Pressable: (({ children, onPress, accessibilityLabel }: any) =>
      createElement('button', { 'aria-label': accessibilityLabel, onClick: onPress }, children)) as never,
  }),
)
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))
// The viewers pull in gestures and router chrome; these cases only size the preview.
mock.module('../../ImagePreviewModal', () => ({ ImagePreviewModal: () => null, ChatImageContextMenu: () => null }))
mock.module('../../FileViewerModal', () => ({ FileViewerModal: () => null }))
mock.module('../../VideoPreviewModal', () => ({ VideoPreviewModal: () => null }))
mock.module('expo-router', () => ({ useRouter: () => ({ push: () => {} }) }))
mock.module('expo-clipboard', () => ({ setStringAsync: async () => {} }))

const { MessageContent } = await import('../MessageContent')

const message = (name: string) => ({
  id: 'm1',
  role: 'user',
  parts: [{ type: 'file', mediaType: 'image/png', url: `/api/files/${name}` }],
})

function renderImage() {
  const { container } = render(createElement(MessageContent, { message: message('shot') as any }))
  const img = container.querySelector('img') as HTMLImageElement
  expect(img).toBeTruthy()
  return img
}

/** The column the image sits in reports its width the way a layout pass would. */
function reportColumnWidth(img: Element, width: number) {
  let node: Element | null = img
  while (node && !layoutHandlers.has(node)) node = node.parentElement
  const handler = node && layoutHandlers.get(node)
  if (!handler) throw new Error('no measured container above the image')
  act(() => handler({ nativeEvent: { layout: { width, height: 200 } } }))
}

/** The box the image fills: it, not the <img>, carries the fitted size. */
const previewBox = (img: Element) => img.parentElement as HTMLElement

/** An image reports its natural size once it loads; attachments carry none. */
function reportImageSize(
  img: Element,
  width: number,
  height: number,
  shape: 'native' | 'web' | 'nulled' = 'native',
) {
  const handler = imageLoadHandlers.get(img)
  if (!handler) throw new Error('the image registered no onLoad')
  // Native hands the size over in `nativeEvent.source`; a DOM load event carries
  // it on its target, which on web is already nulled after `decode()`.
  const event =
    shape === 'nulled'
      ? { nativeEvent: { type: 'load', target: null } }
      : shape === 'web'
        ? { nativeEvent: { type: 'load', target: { naturalWidth: width, naturalHeight: height } } }
        : { nativeEvent: { source: { width, height, uri: '' } } }
  act(() => handler(event))
}

/** What `Image.getSize` answers, the measurement that works on web. */
function reportGetSize(uriPart: string, width: number, height: number) {
  const request = [...imageGetSizeRequests].reverse().find((entry) => entry.uri.includes(uriPart))
  if (!request) throw new Error(`no Image.getSize request matching ${uriPart}`)
  act(() => request.success(width, height))
}

describe('agent chat image attachments', () => {
  test('a wide screenshot fills the column instead of a fixed thumbnail', () => {
    const img = renderImage()
    reportColumnWidth(img, 900)
    reportImageSize(img, 1600, 900)

    expect(previewBox(img).style.width).toBe('462px')
    expect(previewBox(img).style.height).toBe('260px')
  })

  test('it shrinks with a narrow pane rather than overflowing it', () => {
    const img = renderImage()
    reportColumnWidth(img, 320)
    reportImageSize(img, 1600, 900)

    expect(previewBox(img).style.width).toBe('320px')
    expect(previewBox(img).style.height).toBe('180px')
  })

  test('a small image is not upscaled past its own pixels', () => {
    const img = renderImage()
    reportColumnWidth(img, 900)
    reportImageSize(img, 120, 80)

    expect(previewBox(img).style.width).toBe('120px')
    expect(previewBox(img).style.height).toBe('80px')
  })

  test('before anything is measured it keeps the old 220px preview', () => {
    const img = renderImage()

    expect(previewBox(img).style.width).toBe('220px')
    expect(previewBox(img).style.height).toBe('165px')
  })

  test('web sizes an attachment with no stored dimensions from Image.getSize', () => {
    const img = renderImage()
    reportColumnWidth(img, 900)

    // The web load event arrives after `decode()` with a nulled target.
    reportImageSize(img, 0, 0, 'nulled')
    expect(previewBox(img).style.width).toBe('347px')

    reportGetSize('shot', 1600, 900)

    expect(previewBox(img).style.width).toBe('462px')
    expect(previewBox(img).style.height).toBe('260px')
  })
})
