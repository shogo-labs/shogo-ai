// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the production_web Sentry noise filter (`lib/sentry-noise-filter`).
 *
 * Primary regression: Sentry REACT-3K — `AsyncRequireError: Loading module
 * https://studio.shogo.ai/_expo/static/js/web/highlighted-body-<hash>.js
 * failed.` A stale-deploy / transient chunk-load failure (here from streamdown's
 * lazy syntax highlighter) that must be classified as noise so it stops flooding
 * the dashboard. Also pins the pre-existing branches (preview iframe, transient
 * backend) so the extraction from `_layout.tsx` didn't regress them, and that
 * genuine app errors are NOT dropped.
 */
import { describe, test, expect } from 'bun:test'
import { isNoiseEvent, type NoiseFilterEvent } from '../sentry-noise-filter'

const exc = (type: string, value: string, frames: { filename?: string }[] = []): NoiseFilterEvent => ({
  exception: { values: [{ type, value, stacktrace: { frames } }] },
})

describe('isNoiseEvent — chunk-load failures (REACT-3K)', () => {
  test('drops the exact REACT-3K AsyncRequireError', () => {
    expect(
      isNoiseEvent(
        exc(
          'AsyncRequireError',
          'Loading module https://studio.shogo.ai/_expo/static/js/web/highlighted-body-B3W2YXNL-e74a7410c5f23801efd5d98e34a886b6.js failed.',
        ),
      ),
    ).toBe(true)
  })

  test('drops other browser dynamic-import failure phrasings', () => {
    expect(isNoiseEvent(exc('TypeError', 'Failed to fetch dynamically imported module: https://x/y.js'))).toBe(true)
    expect(isNoiseEvent(exc('TypeError', 'error loading dynamically imported module'))).toBe(true)
    expect(isNoiseEvent(exc('Error', 'Importing a module script failed.'))).toBe(true)
    expect(isNoiseEvent(exc('ChunkLoadError', 'Loading chunk 42 failed.'))).toBe(true)
  })
})

describe('isNoiseEvent — Monaco listener-leak diagnostic (REACT-1B)', () => {
  test('drops the exact Monaco LeakageMonitor error', () => {
    expect(
      isNoiseEvent(
        exc(
          'Error',
          '[001] potential listener LEAK detected, having 200 listeners already. MOST frequent listener (1):',
          [{ filename: 'https://studio.shogo.ai/vs/editor.api-CalNCsUg.js' }],
        ),
      ),
    ).toBe(true)
  })
})

describe('isNoiseEvent — pre-existing branches still classified (no regression from extraction)', () => {
  test('preview-iframe frame_ant frame', () => {
    expect(
      isNoiseEvent(exc('TypeError', 'Failed to fetch', [{ filename: 'app:///frame_ant.js' }])),
    ).toBe(true)
  })

  test('preview host in the message', () => {
    expect(
      isNoiseEvent(exc('TypeError', 'Failed to fetch (preview--abc.shogo.ai)')),
    ).toBe(true)
  })

  test('transient backend: TimeoutError / signal timed out', () => {
    expect(isNoiseEvent(exc('TimeoutError', 'signal timed out'))).toBe(true)
    expect(isNoiseEvent(exc('ShogoError', 'Request failed with status 503'))).toBe(true)
  })

  test('browser-extension DOM race', () => {
    expect(
      isNoiseEvent(
        exc(
          'NotFoundError',
          "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
        ),
      ),
    ).toBe(true)
  })
})

describe('isNoiseEvent — intentional Shogo captures bypass the filter', () => {
  test('a chat_stream_error telemetry event survives even with a "Failed to fetch" message', () => {
    // Exactly the collision we must not silence: the raw message matches the
    // transient-network noise branch, but the marker tag marks it intentional.
    const event: NoiseFilterEvent = {
      ...exc('TypeError', 'Failed to fetch'),
      tags: { shogo_telemetry: 'chat_stream_error', chatErrorClass: 'connection' },
    }
    expect(isNoiseEvent(event)).toBe(false)
  })

  test('TimeoutError chat telemetry also survives', () => {
    const event: NoiseFilterEvent = {
      ...exc('TimeoutError', 'signal timed out'),
      tags: { shogo_telemetry: 'chat_stream_error' },
    }
    expect(isNoiseEvent(event)).toBe(false)
  })

  test('the SAME message WITHOUT the marker tag is still filtered as noise', () => {
    expect(isNoiseEvent(exc('TypeError', 'Failed to fetch'))).toBe(true)
  })
})

describe('isNoiseEvent — genuine app errors are NOT dropped', () => {
  test('a real TypeError from app code passes through', () => {
    expect(
      isNoiseEvent(exc('TypeError', "Cannot read properties of undefined (reading 'map')", [
        { filename: 'app:///index.js' },
      ])),
    ).toBe(false)
  })

  test('empty event is not noise', () => {
    expect(isNoiseEvent({})).toBe(false)
  })

  test('MST "Update already in progress" is a real bug, not noise', () => {
    expect(isNoiseEvent(exc('Error', 'Update already in progress'))).toBe(false)
  })
})
