// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { buildViewerContextPrompt, parseCanvasViewer, DESKTOP_HINT_WIDTH, PHONE_HINT_WIDTH } from '../viewer-context'
import { CANVAS_MOBILE_PREVIEW_GUIDE, canvasModeStableGuides } from '../canvas-v2-prompt'
import { CODE_AGENT_GENERAL_GUIDE } from '../code-agent-prompt'

describe('parseCanvasViewer', () => {
  test('accepts a phone payload from the mobile client', () => {
    expect(parseCanvasViewer({ formFactor: 'phone', platform: 'ios', width: 390 })).toEqual({
      formFactor: 'phone',
      platform: 'ios',
      width: 390,
    })
  })

  test('rejects missing formFactor so desktop stays the default', () => {
    expect(parseCanvasViewer({ platform: 'web', width: 1280 })).toBeNull()
    expect(parseCanvasViewer(null)).toBeNull()
  })

  test('fills phone width when the client omits it', () => {
    expect(parseCanvasViewer({ formFactor: 'phone', platform: 'android' })?.width).toBe(PHONE_HINT_WIDTH)
  })

  test('fills desktop width when the client omits it', () => {
    expect(parseCanvasViewer({ formFactor: 'desktop', platform: 'web' })?.width).toBe(DESKTOP_HINT_WIDTH)
  })

  test('rejects unknown form factors and non-objects', () => {
    expect(parseCanvasViewer({ formFactor: 'tablet', platform: 'web', width: 800 })).toBeNull()
    expect(parseCanvasViewer('phone')).toBeNull()
  })

  test('normalizes blank platform and non-finite width', () => {
    expect(parseCanvasViewer({ formFactor: 'phone', platform: '  ', width: Number.NaN })).toEqual({
      formFactor: 'phone',
      platform: 'unknown',
      width: PHONE_HINT_WIDTH,
    })
  })
})

describe('buildViewerContextPrompt', () => {
  test('tells the agent the live preview is a phone', () => {
    const text = buildViewerContextPrompt({ formFactor: 'phone', platform: 'ios', width: 390 })
    expect(text).toContain('## Viewer')
    expect(text).toContain('phone')
    expect(text).toContain('390')
    expect(text).toContain('Do not wait for the user to mention mobile')
  })

  test('desktop still requires a responsive canvas', () => {
    const text = buildViewerContextPrompt({ formFactor: 'desktop', platform: 'web', width: 1440 })
    expect(text).toContain('desktop')
    expect(text).toContain('iPhone')
  })
})

describe('canvasModeStableGuides', () => {
  test('canvas mode injects the live mobile preview contract', () => {
    const blocks = canvasModeStableGuides('canvas')
    expect(blocks).toEqual([['canvas-mobile-preview', CANVAS_MOBILE_PREVIEW_GUIDE]])
    expect(CANVAS_MOBILE_PREVIEW_GUIDE).toContain('flex flex-col md:flex-row')
    expect(CANVAS_MOBILE_PREVIEW_GUIDE).toContain('Do not wait to be asked')
    expect(CANVAS_MOBILE_PREVIEW_GUIDE).toContain('iPhone')
  })

  test('non-canvas modes keep the short file reference, which still includes phone rules', () => {
    const blocks = canvasModeStableGuides('none')
    expect(blocks[0]?.[0]).toBe('canvas-file-reference')
    expect(blocks[0]?.[1]).toContain('grid-cols-1 sm:grid-cols-2')
  })

  test('the always-on coding guide requires mobile-first canvas UI without being asked', () => {
    expect(CODE_AGENT_GENERAL_GUIDE).toContain('Mobile-first by default')
    expect(CODE_AGENT_GENERAL_GUIDE).toContain('do not wait for the user')
  })
})
