// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the preview "wait for the API before loading the UI" gate
 * (`lib/preview-gate.ts`). These pin the policy that the project layout
 * (`projects/[id]/_layout.tsx`) uses to hold the canvas iframe until the
 * project's API sidecar is actually responding — the fix for "UI loads but
 * `/api/*` calls fail because the server isn't up yet".
 *
 * Run: bun test apps/mobile/lib/__tests__/preview-gate.test.ts
 */

import { describe, test, expect } from 'bun:test'
import {
  resolveApiReady,
  shouldStopPreviewPoll,
  shouldShowCanvas,
  isPreviewFailed,
  previewStatusPollBase,
  canvasDocumentUrl,
  nativeCanvasBaseReady,
  projectIdFromAgentProxyUrl,
  previewWakeUrl,
} from '../preview-gate'

describe('resolveApiReady', () => {
  test('passes through an explicit boolean', () => {
    expect(resolveApiReady({ apiReady: true })).toBe(true)
    expect(resolveApiReady({ apiReady: false })).toBe(false)
  })

  test('defaults to true when the field is absent (older runtime)', () => {
    // Backwards-compat: a runtime whose /preview/status predates apiReady
    // must not permanently block the UI.
    expect(resolveApiReady({})).toBe(true)
    expect(resolveApiReady({ running: true })).toBe(true)
  })
})

describe('shouldStopPreviewPoll', () => {
  test('keeps polling while running but the API is not ready yet', () => {
    // The prebuilt-dist path reports running=true before the sidecar binds,
    // so we must NOT stop polling until apiReady flips true.
    expect(shouldStopPreviewPoll({ running: true, apiReady: false })).toBe(false)
  })

  test('keeps polling while the API is ready but the preview is not running', () => {
    expect(shouldStopPreviewPoll({ running: false, apiReady: true })).toBe(false)
  })

  test('stops once running AND the API is ready', () => {
    expect(shouldStopPreviewPoll({ running: true, apiReady: true })).toBe(true)
  })

  test('stops on an older runtime once running (absent apiReady → ready)', () => {
    expect(shouldStopPreviewPoll({ running: true })).toBe(true)
  })

  test('does not stop before the preview is running', () => {
    expect(shouldStopPreviewPoll({})).toBe(false)
    expect(shouldStopPreviewPoll({ apiReady: true })).toBe(false)
  })

  test('stops immediately when setup terminally failed (no infinite spinner)', () => {
    // phase=failed means the runtime will never come up on its own — stop
    // polling and let the UI render the error instead of spinning forever.
    expect(shouldStopPreviewPoll({ phase: 'failed' })).toBe(true)
    expect(shouldStopPreviewPoll({ phase: 'failed', running: false })).toBe(true)
  })
})

describe('isPreviewFailed', () => {
  test('true only for the terminal failed phase', () => {
    expect(isPreviewFailed({ phase: 'failed' })).toBe(true)
    expect(isPreviewFailed({ phase: 'building' })).toBe(false)
    expect(isPreviewFailed({ phase: 'ready' })).toBe(false)
    expect(isPreviewFailed({})).toBe(false)
  })
})

describe('shouldShowCanvas', () => {
  test('false until the dev server is reachable, regardless of API state', () => {
    expect(shouldShowCanvas({ baseReady: false, apiLatched: true, timedOut: false })).toBe(false)
    expect(shouldShowCanvas({ baseReady: false, apiLatched: false, timedOut: true })).toBe(false)
  })

  test('false while base is ready but the API has never been healthy', () => {
    expect(shouldShowCanvas({ baseReady: true, apiLatched: false, timedOut: false })).toBe(false)
  })

  test('true once base is ready and the API has been healthy (latched)', () => {
    expect(shouldShowCanvas({ baseReady: true, apiLatched: true, timedOut: false })).toBe(true)
  })

  test('timeout is a safety valve: loads even if the API never went healthy', () => {
    expect(shouldShowCanvas({ baseReady: true, apiLatched: false, timedOut: true })).toBe(true)
  })
})

describe('previewStatusPollBase', () => {
  test('returns null without an agent proxy', () => {
    expect(previewStatusPollBase(null, 'https://p.preview.shogo.ai/p/abc')).toBe(null)
  })

  test('polls the agent-proxy, not the public preview host', () => {
    expect(
      previewStatusPollBase(
        'https://studio.shogo.ai/api/projects/abc/agent-proxy',
        'https://abc.preview.shogo.ai',
      ),
    ).toBe('https://studio.shogo.ai/api/projects/abc/agent-proxy')
  })

  test('scopes workspace runtimes to /p/<id> on the proxy', () => {
    expect(
      previewStatusPollBase(
        'https://studio.shogo.ai/api/projects/abc/agent-proxy/',
        'https://preview.example/p/abc',
      ),
    ).toBe('https://studio.shogo.ai/api/projects/abc/agent-proxy/p/abc')
  })
})

describe('canvasDocumentUrl', () => {
  test('web loads the canvas origin, not the tokenized preview link', () => {
    expect(
      canvasDocumentUrl({
        canvasBaseUrl: 'https://abc.preview.shogo.ai',
        agentUrl: 'https://studio.shogo.ai/api/projects/abc/agent-proxy',
        previewUrl: 'https://abc.preview.shogo.ai/?__preview_token=tok',
        native: false,
      }),
    ).toBe('https://abc.preview.shogo.ai/')
  })

  test('native WebView loads the tokenized preview URL', () => {
    expect(
      canvasDocumentUrl({
        canvasBaseUrl: 'https://abc.preview.shogo.ai',
        agentUrl: 'https://studio.shogo.ai/api/projects/abc/agent-proxy',
        previewUrl: 'https://abc.preview.shogo.ai/?__preview_token=tok',
        native: true,
      }),
    ).toBe('https://abc.preview.shogo.ai/?__preview_token=tok')
  })
})

describe('nativeCanvasBaseReady', () => {
  test('web still waits for /preview/status running', () => {
    expect(
      nativeCanvasBaseReady({
        native: false,
        agentUrl: 'https://studio.shogo.ai/api/projects/abc/agent-proxy',
        previewUrl: 'https://abc.preview.shogo.ai/?__preview_token=tok',
        canvasBaseUrl: 'https://abc.preview.shogo.ai',
      }),
    ).toBe(false)
  })

  test('native is ready once sandbox/url returned a document URL', () => {
    expect(
      nativeCanvasBaseReady({
        native: true,
        agentUrl: 'https://studio.shogo.ai/api/projects/abc/agent-proxy',
        previewUrl: 'https://abc.preview.shogo.ai/?__preview_token=tok',
        canvasBaseUrl: null,
      }),
    ).toBe(true)
  })

  test('native is not ready without a runtime or document URL', () => {
    expect(
      nativeCanvasBaseReady({
        native: true,
        agentUrl: null,
        previewUrl: 'https://abc.preview.shogo.ai/?__preview_token=tok',
      }),
    ).toBe(false)
    expect(
      nativeCanvasBaseReady({
        native: true,
        agentUrl: 'https://studio.shogo.ai/api/projects/abc/agent-proxy',
      }),
    ).toBe(false)
  })
})

describe('projectIdFromAgentProxyUrl', () => {
  test('extracts the project id from the proxy path', () => {
    expect(
      projectIdFromAgentProxyUrl('https://studio.shogo.ai/api/projects/abc-123/agent-proxy'),
    ).toBe('abc-123')
  })
})

describe('previewWakeUrl', () => {
  test('hits the anonymous wake endpoint', () => {
    expect(previewWakeUrl('https://studio.shogo.ai', 'abc-123')).toBe(
      'https://studio.shogo.ai/api/preview/abc-123/wake',
    )
  })
})
