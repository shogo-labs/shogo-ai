// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The size an image reports when it loads comes in two shapes: native's
 * `nativeEvent.source`, and — through react-native-web — the DOM load event,
 * whose target is the loader's own `<img>`.
 */

import { describe, expect, test } from 'bun:test'
import { imageSizeFromLoadEvent } from '../image-natural-size'

describe('imageSizeFromLoadEvent', () => {
  test('reads the size native puts in the event source', () => {
    expect(imageSizeFromLoadEvent({ nativeEvent: { source: { width: 1600, height: 900 } } })).toEqual(
      { width: 1600, height: 900 },
    )
  })

  test('reads the natural size off the target of a web load event', () => {
    expect(
      imageSizeFromLoadEvent({
        nativeEvent: { type: 'load', target: { naturalWidth: 1600, naturalHeight: 900 } },
      }),
    ).toEqual({ width: 1600, height: 900 })
  })

  test('reads a bare DOM load event too', () => {
    expect(
      imageSizeFromLoadEvent({ target: { naturalWidth: 800, naturalHeight: 600 } }),
    ).toEqual({ width: 800, height: 600 })
  })

  test('prefers the event source when both shapes are present', () => {
    expect(
      imageSizeFromLoadEvent({
        nativeEvent: { source: { width: 640, height: 480 }, target: { naturalWidth: 200, naturalHeight: 100 } },
      }),
    ).toEqual({ width: 640, height: 480 })
  })

  test('reports nothing when the event carries no usable size', () => {
    expect(imageSizeFromLoadEvent(null)).toBeNull()
    expect(imageSizeFromLoadEvent(undefined)).toBeNull()
    expect(imageSizeFromLoadEvent({})).toBeNull()
    expect(imageSizeFromLoadEvent({ nativeEvent: { type: 'load' } })).toBeNull()
    // A not-yet-decoded web image reports zeroes until it has pixels.
    expect(
      imageSizeFromLoadEvent({ nativeEvent: { target: { naturalWidth: 0, naturalHeight: 0 } } }),
    ).toBeNull()
    expect(
      imageSizeFromLoadEvent({ nativeEvent: { source: { width: 0, height: 900 } } }),
    ).toBeNull()
  })
})
