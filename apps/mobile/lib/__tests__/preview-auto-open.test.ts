// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the folder-project Preview auto-open policy (SHO-200).
 *
 * The reproduced failures (Planner, origin/main 42ccf8728, 16 unrequested pops
 * in ~40 s) are S1–S6; each describe block below is named after its scenario.
 *
 * Run: bun run --cwd apps/mobile test apps/mobile/lib/__tests__/preview-auto-open.test.ts
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import {
  PREVIEW_AUTO_OPEN_GRACE_MS,
  PreviewAutoOpenTracker,
  decideAutoOpenPreview,
  previewTabUserPickKey,
  type AutoOpenInput,
} from '../preview-auto-open'

const PROJECT = 'proj_ext'

function input(overrides: Partial<AutoOpenInput> = {}): AutoOpenInput {
  return {
    projectId: PROJECT,
    isExternalProject: true,
    phoneLayout: false,
    isIdeChatEmbed: false,
    isDesktopShell: true,
    restoredFor: PROJECT,
    userPicked: false,
    detectedUrl: null,
    now: 0,
    ...overrides,
  }
}

/** Drive one observation the way the layout effect does. */
function tick(
  tracker: PreviewAutoOpenTracker,
  detectedUrl: string | null,
  now: number,
  overrides: Partial<AutoOpenInput> = {},
): boolean {
  return decideAutoOpenPreview(
    input({ detectedUrl, now, tracker, ...overrides }),
  ).open
}

describe('S1 — a short-lived server in the folder opens Preview once, not per server', () => {
  let tracker: PreviewAutoOpenTracker
  beforeEach(() => {
    tracker = new PreviewAutoOpenTracker()
  })

  test('a fixture server that starts and exits three times opens Preview once', () => {
    const opens: number[] = []
    let now = 0
    for (let run = 0; run < 3; run += 1) {
      // Server up for a poll, then gone for the next few polls, then a new one.
      if (tick(tracker, 'http://127.0.0.1:3333', now)) opens.push(now)
      now += 5_000
      if (tick(tracker, null, now)) opens.push(now)
      now += 5_000
      if (tick(tracker, null, now)) opens.push(now)
      now += 5_000
    }
    expect(opens).toEqual([0])
  })

  test('a server restarting after a full grace window still does not re-open', () => {
    let now = 0
    expect(tick(tracker, 'http://127.0.0.1:5173', now)).toBe(true)
    now += 5_000
    expect(tick(tracker, null, now)).toBe(false)
    // Longer than the grace window: production would now look "off" again.
    now += PREVIEW_AUTO_OPEN_GRACE_MS + 5_000
    expect(tick(tracker, 'http://127.0.0.1:5173', now)).toBe(false)
  })
})

describe('S2 — one missed probe is not the server stopping', () => {
  test('a URL that drops for one poll and returns does not re-open', () => {
    const tracker = new PreviewAutoOpenTracker()
    let now = 0
    expect(tick(tracker, 'http://127.0.0.1:5173', now)).toBe(true)
    now += 5_000
    expect(tick(tracker, null, now)).toBe(false)
    now += 5_000
    expect(tick(tracker, 'http://127.0.0.1:5173', now)).toBe(false)
  })

  test('a first URL that flickers on before the page settles opens exactly once', () => {
    const tracker = new PreviewAutoOpenTracker()
    // First two polls are empty (still restoring / server not up yet).
    expect(tick(tracker, null, 0)).toBe(false)
    expect(tick(tracker, null, 5_000)).toBe(false)
    expect(tick(tracker, 'http://127.0.0.1:5173', 10_000)).toBe(true)
    expect(tick(tracker, null, 15_000)).toBe(false)
    expect(tick(tracker, 'http://127.0.0.1:5173', 20_000)).toBe(false)
  })
})

describe('S3 — a second server appearing or disappearing never re-opens', () => {
  test('attributedPorts flipping between two URLs does not open twice', () => {
    const tracker = new PreviewAutoOpenTracker()
    const urls = [
      'http://127.0.0.1:5173',
      'http://127.0.0.1:3001',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:3001',
      'http://127.0.0.1:5173',
    ]
    let now = 0
    const opens: string[] = []
    for (const url of urls) {
      if (tick(tracker, url, now)) opens.push(url)
      now += 5_000
    }
    expect(opens).toEqual(['http://127.0.0.1:5173'])
  })

  test('a URL that only changes is reported as url-changed, not a start', () => {
    const tracker = new PreviewAutoOpenTracker()
    expect(tick(tracker, 'http://127.0.0.1:5173', 0)).toBe(true)
    const decision = decideAutoOpenPreview(
      input({ detectedUrl: 'http://127.0.0.1:3001', now: 5_000, tracker }),
    )
    expect(decision.open).toBe(false)
    expect(decision.transition).toBe(false)
  })
})

describe('S4 — a dev server that restarts (bun --watch / crash loop) does not re-open', () => {
  test('a restart that leaves one or more empty polls behind opens once', () => {
    const tracker = new PreviewAutoOpenTracker()
    let now = 0
    expect(tick(tracker, 'http://127.0.0.1:5173', now)).toBe(true)
    // Crash loop: down for two polls, back, down, back.
    for (let i = 0; i < 4; i += 1) {
      now += 5_000
      expect(tick(tracker, null, now)).toBe(false)
      now += 5_000
      expect(tick(tracker, null, now)).toBe(false)
      now += 5_000
      expect(tick(tracker, 'http://127.0.0.1:5173', now)).toBe(false)
    }
  })
})

describe('S5 — a remount or reload with a server running does not override the restored tab', () => {
  test('a persisted user pick suppresses the very first observation', () => {
    // Fresh tracker == fresh page session; the project already recorded that
    // the user chose Chat, so the running server must not bring Preview back.
    const tracker = new PreviewAutoOpenTracker()
    const decision = decideAutoOpenPreview(
      input({ detectedUrl: 'http://127.0.0.1:5173', now: 0, tracker, userPicked: true }),
    )
    expect(decision.open).toBe(false)
    expect(decision.reason).toBe('user-picked')
  })

  test('without a user pick, a reload with a server running opens once', () => {
    const tracker = new PreviewAutoOpenTracker()
    expect(tick(tracker, 'http://127.0.0.1:5173', 0)).toBe(true)
  })

  test('the tab-restore read gates the decision, so a late read cannot be clobbered', () => {
    const tracker = new PreviewAutoOpenTracker()
    const decision = decideAutoOpenPreview(
      input({ detectedUrl: 'http://127.0.0.1:5173', now: 0, tracker, restoredFor: null }),
    )
    expect(decision.open).toBe(false)
    expect(decision.reason).toBe('tab-not-restored')
    // Once restored, the same observation decides normally.
    expect(tick(tracker, 'http://127.0.0.1:5173', 1_000)).toBe(true)
  })

  test('the user-pick storage key is per project', () => {
    expect(previewTabUserPickKey('a')).not.toBe(previewTabUserPickKey('b'))
    expect(previewTabUserPickKey('a')).toContain('a')
  })
})

describe('guards — the auto-open only ever applies to a desktop-shell external project', () => {
  test.each([
    ['phone layout', { phoneLayout: true }, 'phone-layout'],
    ['embedded IDE chat', { isIdeChatEmbed: true }, 'ide-chat-embed'],
    ['browser / no desktop shell', { isDesktopShell: false }, 'not-desktop-shell'],
    ['managed (non-external) project', { isExternalProject: false }, 'not-external'],
  ])('%s never opens Preview', (_label, overrides, reason) => {
    const tracker = new PreviewAutoOpenTracker()
    const decision = decideAutoOpenPreview(
      input({ detectedUrl: 'http://127.0.0.1:5173', now: 0, tracker, ...(overrides as object) }),
    )
    expect(decision.open).toBe(false)
    expect(decision.reason).toBe(reason as never)
  })

  test('no detected URL is never a start', () => {
    const tracker = new PreviewAutoOpenTracker()
    const decision = decideAutoOpenPreview(input({ detectedUrl: null, now: 0, tracker }))
    expect(decision.open).toBe(false)
    expect(decision.reason).toBe('no-url')
  })
})

describe('reset', () => {
  test('clearing one project leaves the others latched', () => {
    const tracker = new PreviewAutoOpenTracker()
    expect(tick(tracker, 'http://127.0.0.1:5173', 0)).toBe(true)
    tracker.reset(PROJECT)
    expect(tick(tracker, 'http://127.0.0.1:5173', 1_000)).toBe(true)
  })
})
