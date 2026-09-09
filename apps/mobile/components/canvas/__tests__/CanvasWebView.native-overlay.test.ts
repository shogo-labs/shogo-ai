// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(import.meta.dir, '../CanvasWebView.tsx'), 'utf8')

describe('native canvas loading overlay', () => {
  test('dismisses on WebView loadEnd because canvas-ready never fires in a top-level WebView', () => {
    expect(source).toContain('onNativeLoadEnd')
    expect(source).toContain('dismissLoading()')
    expect(source).toContain('window.parent === window')
    expect(source).toContain('injectedJavaScript={NATIVE_CANVAS_MESSAGE_BRIDGE}')
  })

  test('forwards iframe postMessages through ReactNativeWebView', () => {
    expect(source).toContain('ReactNativeWebView.postMessage')
    expect(source).toContain('canvas-ready')
  })
})
