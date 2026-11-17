// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent-chat attachments size to the message column, not the window: a wide
 * screenshot grows until the max height stops it, a narrow pane (a split view,
 * a side panel) shrinks it instead of overflowing, and a small image keeps its
 * own pixels.
 *
 * The box is decided from the size stored on the part, so it is final on the
 * first frame. A message sent before sizes were stored gets a fixed box that
 * never resizes — measuring it after the load is what changed the content
 * height under a resumed chat and made it jump (SHO-407).
 */

import { describe, expect, mock, test } from 'bun:test'
import { act, render } from '@testing-library/react'
import { createElement, forwardRef } from 'react'
import { createReactNativeMock } from '../../../../test/react-native-mock'

/** Layout and load handlers the shims captured, so a test can report sizes. */
const layoutHandlers = new WeakMap<Element, (event: unknown) => void>()
const imageLoadHandlers = new WeakMap<Element, (event: unknown) => void>()
/** `Image.getSize` requests: a thumbnail must never make one. */
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
      const shim = forwardRef(function LayoutImage({ children, onLoad, testID, style, resizeMode, accessibilityLabel, source, ...props }: any, ref: any) {
        return createElement(
          'img',
          {
            ...props,
            src: source?.uri,
            style: flatten(style),
            alt: accessibilityLabel,
            'data-resize-mode': resizeMode,
            'data-rn-shim': testID ?? undefined,
            ref: chainRef(imageLoadHandlers, onLoad, ref),
          },
          children,
        )
      })
      // react-native-web measures through a retained <img>. A thumbnail with a
      // stored size must not ask, and a legacy one must not either.
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
// The loader is covered by its own test; here it only has to hand the URL
// straight through so the sizing is observable synchronously.
mock.module('../../../../lib/agent-image-source', () => ({
  useAgentImageSource: (uri: string | null) => (uri ? { uri } : null),
  getAgentImageSource: (uri: string) => ({ uri }),
  createAgentImageSource: (uri: string) => ({ uri }),
  needsAgentImageLoad: () => false,
}))

const { MessageContent } = await import('../MessageContent')

const message = (part: Record<string, unknown>) => ({
  id: 'm1',
  role: 'user',
  parts: [{ type: 'file', mediaType: 'image/png', url: '/api/files/shot', ...part }],
})

function renderImage(part: Record<string, unknown> = {}) {
  const { container } = render(createElement(MessageContent, { message: message(part) as any }))
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

/**
 * The image finishes loading. The thumbnail deliberately registers no `onLoad`
 * — nothing about a load may change the box — so this only fires the DOM event
 * a real `<img>` would and lets the test assert the box did not move.
 */
function reportImageSize(img: Element) {
  act(() => {
    img.dispatchEvent(new Event('load'))
  })
}

describe('agent chat image attachments', () => {
  test('a wide screenshot fills the column instead of a fixed thumbnail', () => {
    const img = renderImage({ width: 1600, height: 900 })
    reportColumnWidth(img, 900)

    expect(previewBox(img).style.width).toBe('462px')
    expect(previewBox(img).style.height).toBe('260px')
  })

  test('it shrinks with a narrow pane rather than overflowing it', () => {
    const img = renderImage({ width: 1600, height: 900 })
    reportColumnWidth(img, 320)

    expect(previewBox(img).style.width).toBe('320px')
    expect(previewBox(img).style.height).toBe('180px')
  })

  test('a small image is not upscaled past its own pixels', () => {
    const img = renderImage({ width: 120, height: 80 })
    reportColumnWidth(img, 900)

    expect(previewBox(img).style.width).toBe('120px')
    expect(previewBox(img).style.height).toBe('80px')
  })

  test('a stored size makes the box final on the first frame', () => {
    const img = renderImage({ width: 1600, height: 900 })
    reportColumnWidth(img, 900)

    // Already the final size, before the image has loaded at all.
    expect(previewBox(img).style.width).toBe('462px')
    expect(previewBox(img).style.height).toBe('260px')
  })

  test('an image load with a known size does not change the box', () => {
    const img = renderImage({ width: 1600, height: 900 })
    reportColumnWidth(img, 900)
    const before = { width: previewBox(img).style.width, height: previewBox(img).style.height }

    reportImageSize(img)

    // A stable box is what keeps `onContentSizeChange` from firing, which is
    // what used to queue a scroll to the end for every photo on resume.
    expect(previewBox(img).style.width).toBe(before.width)
    expect(previewBox(img).style.height).toBe(before.height)
  })

  test('a legacy part with no stored size keeps a fixed box that never resizes', () => {
    const img = renderImage()
    reportColumnWidth(img, 900)
    const before = { width: previewBox(img).style.width, height: previewBox(img).style.height }
    expect(before.width).toBe('347px')

    reportImageSize(img)

    expect(previewBox(img).style.width).toBe(before.width)
    expect(previewBox(img).style.height).toBe(before.height)
  })

  /**
   * SHO-407 AC2: the box is final on the first frame, before any layout pass.
   *
   * The attachment row reports its width from `onLayout`, which on web is a
   * ResizeObserver callback — it runs *after* the first paint. So the first
   * frame is sized against the 220px fallback and every photo grows by 136px
   * once the row reports, which is the content growth that leaves a resumed
   * chat above its bottom (measured: 1530px on a 12-photo chat).
   */
  test('the box is already final before the attachment row is measured', () => {
    const img = renderImage({ width: 1600, height: 900 })
    const firstFrame = { width: previewBox(img).style.width, height: previewBox(img).style.height }

    reportColumnWidth(img, 900)

    expect(firstFrame).toEqual({
      width: previewBox(img).style.width,
      height: previewBox(img).style.height,
    })
  })

  test('a thumbnail never asks Image.getSize for the original', () => {
    const img = renderImage()
    reportColumnWidth(img, 900)
    reportImageSize(img)

    expect(imageGetSizeRequests).toHaveLength(0)
  })

  test('the thumbnail paints the stored preview, not the original', () => {
    const img = renderImage({ width: 1600, height: 900, previewUrl: '/agent/workspace/download/.previews/shot-preview.jpg' })

    expect(img.getAttribute('src')).toContain('.previews/shot-preview.jpg')
  })
})
