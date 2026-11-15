// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `defaultTabForProject` — the landing-tab policy the sidebar uses to
 * decide where a project-name click lands (Canvas / fullscreen Chat / external
 * preview). Pins the same inference rules the project layout (`_layout.tsx`)
 * uses so the sidebar and layout stay in lockstep.
 *
 * Run: bun test apps/mobile/lib/__tests__/project-preview-tab.test.ts
 */

import { describe, test, expect } from 'bun:test'
import {
  canvasDisabledRedirect,
  defaultTabForProject,
  forgetLandingTab,
  rememberLandingTab,
  rememberedLandingTab,
} from '../project-preview-tab'

describe('defaultTabForProject', () => {
  test('managed + canvas-enabled (default) → canvas', () => {
    expect(defaultTabForProject({})).toBe('canvas')
    expect(defaultTabForProject({ workingMode: 'managed' })).toBe('canvas')
    expect(defaultTabForProject({ settings: { canvasEnabled: true } })).toBe('canvas')
  })

  test('external workingMode → external-preview (even with canvas enabled)', () => {
    expect(defaultTabForProject({ workingMode: 'external' })).toBe('external-preview')
    expect(
      defaultTabForProject({ workingMode: 'external', settings: { canvasEnabled: true } }),
    ).toBe('external-preview')
  })

  test('canvas disabled → chat-fullscreen', () => {
    expect(defaultTabForProject({ settings: { canvasEnabled: false } })).toBe('chat-fullscreen')
  })

  test('activeMode none → chat-fullscreen', () => {
    expect(defaultTabForProject({ settings: { activeMode: 'none' } })).toBe('chat-fullscreen')
  })

  test("legacy activeMode 'app' collapses to chat-fullscreen", () => {
    expect(defaultTabForProject({ settings: { activeMode: 'app' } })).toBe('chat-fullscreen')
  })

  test('settings provided as a JSON string is parsed', () => {
    expect(defaultTabForProject({ settings: JSON.stringify({ canvasEnabled: false }) })).toBe(
      'chat-fullscreen',
    )
    expect(defaultTabForProject({ settings: JSON.stringify({ canvasEnabled: true }) })).toBe(
      'canvas',
    )
  })

  test('malformed settings string falls back to canvas defaults', () => {
    expect(defaultTabForProject({ settings: '{ not json' })).toBe('canvas')
  })

  test('null/undefined settings are tolerated', () => {
    expect(defaultTabForProject({ settings: null })).toBe('canvas')
    expect(defaultTabForProject({ settings: undefined })).toBe('canvas')
  })
})

describe('canvasDisabledRedirect', () => {
  test('does nothing when canvas is enabled', () => {
    expect(
      canvasDisabledRedirect({
        canvasEnabled: true,
        previewTab: 'canvas',
        isExternalProject: false,
        userRequestedCanvas: false,
      }),
    ).toBeNull()
  })

  test('bounces an unsolicited canvas tab back to chat-fullscreen', () => {
    expect(
      canvasDisabledRedirect({
        canvasEnabled: false,
        previewTab: 'canvas',
        isExternalProject: false,
        userRequestedCanvas: false,
      }),
    ).toBe('chat-fullscreen')
  })

  test('does not bounce after the user asked for canvas', () => {
    expect(
      canvasDisabledRedirect({
        canvasEnabled: false,
        previewTab: 'canvas',
        isExternalProject: false,
        userRequestedCanvas: true,
      }),
    ).toBeNull()
  })

  test('external projects bounce to external-preview, not chat', () => {
    expect(
      canvasDisabledRedirect({
        canvasEnabled: false,
        previewTab: 'canvas',
        isExternalProject: true,
        userRequestedCanvas: false,
      }),
    ).toBe('external-preview')
  })
})

describe('session landing tab (?tab= deep link survives a remount)', () => {
  test('a remembered deep-link tab is returned until the user picks a tab', () => {
    expect(rememberedLandingTab('p-1')).toBeUndefined()
    rememberLandingTab('p-1', 'settings')
    expect(rememberedLandingTab('p-1')).toBe('settings')
    expect(rememberedLandingTab('p-2')).toBeUndefined()
    forgetLandingTab('p-1')
    expect(rememberedLandingTab('p-1')).toBeUndefined()
  })

  test('a newer deep link replaces the older one', () => {
    rememberLandingTab('p-3', 'settings')
    rememberLandingTab('p-3', 'ide')
    expect(rememberedLandingTab('p-3')).toBe('ide')
    forgetLandingTab('p-3')
  })
})
