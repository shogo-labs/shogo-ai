// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent-chat attachments size to the message column, not the window: a wide
 * screenshot grows until the max height stops it, a narrow pane (a split view,
 * a side panel) shrinks it instead of overflowing, and a small image keeps its
 * own pixels.
 *
 * The box is decided from the size stored on the part, so it is final on the
 * first frame. It is expressed as a cap plus an aspect ratio — `width` is the
 * widest the box may be, `maxWidth: "100%"` fits it to the row, and
 * `aspectRatio` derives the height from whatever width the layout engine
 * settles on. Nothing here reads a measured width: `onLayout` on web is a
 * ResizeObserver callback that runs after the first paint, so a box sized from
 * it was wrong on the first frame and grew under the reader, which is what made
 * a resumed chat jump (SHO-407).
 *
 * A message sent before sizes were stored gets a fixed box that never resizes.
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

/** The box the image fills: it, not the <img>, carries the fitted size. */
const previewBox = (img: Element) => img.parentElement as HTMLElement

/** The box's style, as the layout engine would read it. */
const boxStyle = (img: Element) => {
  const style = previewBox(img).style
  // The DOM normalises `aspect-ratio: 1.777` to `1.777 / 1`.
  const [ratio] = style.aspectRatio.split('/')
  return {
    width: style.width,
    maxWidth: style.maxWidth,
    aspectRatio: Number(ratio),
  }
}

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

/** Every ancestor that would report a layout pass, so a test can prove none does. */
function measuredAncestors(img: Element): Element[] {
  const found: Element[] = []
  let node: Element | null = img.parentElement
  while (node) {
    if (layoutHandlers.has(node)) found.push(node)
    node = node.parentElement
  }
  return found
}

describe('agent chat image attachments', () => {
  test('a wide screenshot is capped by the max height, not a fixed thumbnail', () => {
    const img = renderImage({ width: 1600, height: 900 })

    // 1600×900 is height-capped at 260, which gives 462 wide.
    expect(boxStyle(img)).toEqual({
      width: '462px',
      maxWidth: '100%',
      aspectRatio: 462 / 260,
    })
  })

  test('a narrow pane fits the box without a layout pass', () => {
    const img = renderImage({ width: 1600, height: 900 })

    // The cap is the widest the box may be; `maxWidth` and `aspectRatio` let
    // the layout engine shrink it to the row and keep the height right, in the
    // same pass. Nothing here waits for a measurement.
    expect(boxStyle(img).maxWidth).toBe('100%')
    expect(boxStyle(img).aspectRatio).toBeCloseTo(462 / 260, 6)
    expect(measuredAncestors(img)).toEqual([])
  })

  test('a small image is not upscaled past its own pixels', () => {
    const img = renderImage({ width: 120, height: 80 })

    expect(boxStyle(img)).toEqual({
      width: '120px',
      maxWidth: '100%',
      aspectRatio: 120 / 80,
    })
  })

  test('a stored size makes the box final on the first frame', () => {
    const img = renderImage({ width: 1600, height: 900 })

    // Already the final size, before the image has loaded at all.
    expect(boxStyle(img).width).toBe('462px')
    expect(boxStyle(img).aspectRatio).toBeCloseTo(462 / 260, 6)
  })

  test('an image load with a known size does not change the box', () => {
    const img = renderImage({ width: 1600, height: 900 })
    const before = boxStyle(img)

    reportImageSize(img)

    // A stable box is what keeps `onContentSizeChange` from firing, which is
    // what used to queue a scroll to the end for every photo on resume.
    expect(boxStyle(img)).toEqual(before)
  })

  test('a legacy part with no stored size keeps a fixed box that never resizes', () => {
    const img = renderImage()
    const before = boxStyle(img)
    // The 4:3 fallback aspect, height-capped at 260.
    expect(before.width).toBe('347px')
    expect(before.aspectRatio).toBeCloseTo(347 / 260, 6)

    reportImageSize(img)

    expect(boxStyle(img)).toEqual(before)
  })

  /**
   * SHO-407 AC2: the box is final on the first frame, before any layout pass.
   *
   * The attachment row used to report its width from `onLayout`, which on web
   * is a ResizeObserver callback — it runs *after* the first paint. So the
   * first frame was sized against a fallback and every photo grew once the row
   * reported, which is the content growth that left a resumed chat above its
   * bottom (measured: 1530px on a 12-photo chat).
   */
  test('the box is already final before the attachment row is measured', () => {
    const img = renderImage({ width: 1600, height: 900 })
    const firstFrame = boxStyle(img)

    // Nothing above the image reports a layout pass at all, so there is no
    // later frame in which the box could change.
    expect(measuredAncestors(img)).toEqual([])
    expect(boxStyle(img)).toEqual(firstFrame)
  })

  test('a thumbnail never asks Image.getSize for the original', () => {
    const img = renderImage()
    reportImageSize(img)

    expect(imageGetSizeRequests).toHaveLength(0)
  })

  test('the thumbnail paints the stored preview, not the original', () => {
    const img = renderImage({ width: 1600, height: 900, previewUrl: '/agent/workspace/download/.previews/shot-preview.jpg' })

    expect(img.getAttribute('src')).toContain('.previews/shot-preview.jpg')
  })
})
