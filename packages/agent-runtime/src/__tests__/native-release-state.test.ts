// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Every state of the native release flow, and the one thing to do in it.
 *
 * These are the acceptance criteria from the card, in code: each state asserts the
 * exact `next_action`, that `user_message` is non-empty, and that it names no
 * vendor — the user is shipping their own app through Shogo, not through Expo.
 */

import { describe, expect, it } from 'bun:test'
import {
  RELEASE_ONLY_FACTS,
  hasCustomStoreIcon,
  nativeNextStep,
  type NativeReleaseFacts,
  type NativeReleaseStatusFacts,
} from '../native-release-state'

const READY: NativeReleaseFacts = {
  needsBundleId: false,
  hasServerFiles: false,
  backend: { published: false, url: null },
  connections: {
    play: { keyAvailable: true, publisherEmail: 'publisher@shogo.test', firstUploadDone: true },
    asc: { keyAvailable: true, appRecord: true },
  },
  hasStoreIcon: true,
  bundleIdentifier: 'ai.shogo.app.cool',
  androidPackage: 'ai.shogo.app.cool',
}

const both: ('ios' | 'android')[] = ['ios', 'android']

function step(overrides: Partial<NativeReleaseFacts>, platforms = both, release: NativeReleaseStatusFacts | null = null) {
  return nativeNextStep({ facts: { ...READY, ...overrides }, platforms, release })
}

describe('the pre-release states', () => {
  it('asks for the bundle id first, and names both ids', () => {
    const s = step({ needsBundleId: true })
    expect(s.next_action).toBe('confirm_bundle_id')
    expect(s.user_message).toContain('ai.shogo.app.cool')
  })

  it('requires a published backend before building a device app', () => {
    const s = step({ hasServerFiles: true })
    expect(s.next_action).toBe('publish_web')
    expect(s.user_message.toLowerCase()).toContain('published')
  })

  it('does not require a backend for a project that has none', () => {
    expect(step({ hasServerFiles: false, backend: { published: false, url: null } }).next_action).toBe('building')
  })

  it('shows the publisher email to invite in Play Console, not a JSON key', () => {
    const s = step({ connections: { ...READY.connections, play: { keyAvailable: false, publisherEmail: 'publisher@shogo.test', firstUploadDone: false } } })
    expect(s.next_action).toBe('connect_play')
    expect(s.user_message).toContain('publisher@shogo.test')
    expect(s.user_message.toLowerCase()).toContain('invite')
    expect(s.user_message.toLowerCase()).not.toContain('json')
  })

  it('asks for a Play key in Project → App stores when there is no publisher to invite', () => {
    const s = step({
      connections: { ...READY.connections, play: { keyAvailable: false, publisherEmail: null, firstUploadDone: false } },
    })
    expect(s.next_action).toBe('connect_play')
    expect(s.user_message).toContain('Project → App stores')
    expect(s.user_message.toLowerCase()).not.toContain('invite')
    expect(s.user_message).not.toContain('the Shogo publisher account')
  })

  it('explains that the ASC key has to be the user’s', () => {
    const s = step({ connections: { ...READY.connections, asc: { keyAvailable: false, appRecord: false } } }, ['ios'])
    expect(s.next_action).toBe('connect_asc')
    expect(s.user_message).toContain('App Store Connect')
  })

  it('asks for the one-time Play first upload, and points at the build to upload', () => {
    const s = step({ connections: { ...READY.connections, play: { keyAvailable: true, publisherEmail: 'p@x', firstUploadDone: false } } })
    expect(s.next_action).toBe('play_first_upload')
    expect(s.user_message).toContain('ai.shogo.app.cool')
    expect(Object.keys(s.links)).toContain('download')
  })

  it('asks for the App Store Connect app record', () => {
    const s = step({ connections: { ...READY.connections, asc: { keyAvailable: true, appRecord: false } } }, ['ios'])
    expect(s.next_action).toBe('asc_app_record')
    expect(s.user_message).toContain('ai.shogo.app.cool')
  })

  it('asks for an icon before a listing with no artwork', () => {
    const s = step({ hasStoreIcon: false })
    expect(s.next_action).toBe('needs_icon')
    expect(s.user_message.toLowerCase()).toContain('logo')
  })

  it('follows the card’s order: bundle id, backend, store connections, icon', () => {
    // Everything missing at once must not jump to the icon.
    const s = step({
      needsBundleId: true,
      hasServerFiles: true,
      hasStoreIcon: false,
      connections: { play: { keyAvailable: false, publisherEmail: 'p@x', firstUploadDone: false }, asc: { keyAvailable: false, appRecord: false } },
    })
    expect(s.next_action).toBe('confirm_bundle_id')
  })

  it('ignores Play when only iOS was asked for', () => {
    const s = step(
      { connections: { ...READY.connections, play: { keyAvailable: false, publisherEmail: null, firstUploadDone: false } } },
      ['ios'],
    )
    expect(s.next_action).toBe('building')
  })
})

describe('the release states', () => {
  const release = (over: Partial<NativeReleaseStatusFacts>): NativeReleaseStatusFacts => ({
    status: 'building',
    step: 'store_build',
    testOutcome: null,
    kind: 'build',
    error: null,
    ...over,
  })

  it('reports a build in progress without holding the turn open', () => {
    const s = nativeNextStep({ facts: RELEASE_ONLY_FACTS, platforms: both, release: release({}) })
    expect(s.next_action).toBe('building')
    expect(s.user_message.toLowerCase()).toContain('returns immediately')
  })

  it('reports the test stage as testing, and says nothing shipped yet', () => {
    const s = nativeNextStep({ facts: RELEASE_ONLY_FACTS, platforms: both, release: release({ status: 'testing', step: 'maestro' }) })
    expect(s.next_action).toBe('testing')
    expect(s.user_message.toLowerCase()).toContain('nothing has been sent to the store')
  })

  it('reports a failed test as failing, not as shipped', () => {
    const s = nativeNextStep({
      facts: RELEASE_ONLY_FACTS,
      platforms: both,
      release: release({ status: 'failed', step: 'maestro', testOutcome: 'failed', error: 'checkout flow' }),
    })
    expect(s.next_action).toBe('test_failed')
    expect(s.user_message).toContain('checkout flow')
    expect(s.user_message.toLowerCase()).not.toContain('submitted')
  })

  it('reports a submission as submitted', () => {
    const s = nativeNextStep({ facts: RELEASE_ONLY_FACTS, platforms: both, release: release({ status: 'submitting', step: 'store_submission' }) })
    expect(s.next_action).toBe('submitted')
  })

  it('reports done as live, and distinguishes an update', () => {
    const live = nativeNextStep({ facts: RELEASE_ONLY_FACTS, platforms: both, release: release({ status: 'done', step: 'live' }) })
    expect(live.next_action).toBe('live')
    expect(live.user_message.toLowerCase()).toContain('submitted')

    const updated = nativeNextStep({ facts: RELEASE_ONLY_FACTS, platforms: both, release: release({ status: 'done', kind: 'update' }) })
    expect(updated.user_message.toLowerCase()).toContain('existing installs')
  })
})

describe('every message', () => {
  const states = [
    step({ needsBundleId: true }),
    step({ hasServerFiles: true }),
    step({ connections: { ...READY.connections, play: { keyAvailable: false, publisherEmail: 'p@x', firstUploadDone: false } } }),
    step({ connections: { ...READY.connections, asc: { keyAvailable: false, appRecord: false } } }),
    step({ connections: { ...READY.connections, play: { keyAvailable: true, publisherEmail: 'p@x', firstUploadDone: false } } }),
    step({ connections: { ...READY.connections, asc: { keyAvailable: true, appRecord: false } } }, ['ios']),
    step({ hasStoreIcon: false }),
    nativeNextStep({ facts: RELEASE_ONLY_FACTS, platforms: both, release: { status: 'testing', step: 'maestro', testOutcome: null, kind: 'build' } }),
    nativeNextStep({ facts: RELEASE_ONLY_FACTS, platforms: both, release: { status: 'done', step: 'live', testOutcome: 'passed', kind: 'build' } }),
    nativeNextStep({ facts: RELEASE_ONLY_FACTS, platforms: both, release: { status: 'failed', step: 'maestro', testOutcome: 'failed', kind: 'build', error: 'boom' } }),
  ]

  it('is non-empty and names no vendor', () => {
    for (const s of states) {
      expect(s.user_message.length).toBeGreaterThan(20)
      // Word boundaries: "release" contains the letters of the build service's
      // name, and a naive substring test would flag the wrong messages.
      expect(s.user_message.toLowerCase()).not.toMatch(/\bexpo\b/)
      expect(s.user_message.toLowerCase()).not.toMatch(/\beas\b/)
    }
  })

  it('every state has an action from the card’s list', () => {
    const allowed = new Set([
      'confirm_bundle_id',
      'publish_web',
      'connect_play',
      'connect_asc',
      'play_first_upload',
      'asc_app_record',
      'needs_icon',
      'building',
      'testing',
      'submitted',
      'test_failed',
      'live',
    ])
    for (const s of states) expect(allowed.has(s.next_action)).toBe(true)
  })
})

describe('icon detection', () => {
  it('accepts an icon from the app config', () => {
    expect(hasCustomStoreIcon({ files: [], iconFromConfig: './assets/icon.png' })).toBe(true)
  })

  it('accepts the conventional paths', () => {
    expect(hasCustomStoreIcon({ files: ['assets/images/icon.png'] })).toBe(true)
  })

  it('refuses a project with none, which is what the templates ship', () => {
    expect(hasCustomStoreIcon({ files: ['app.json', 'App.tsx'] })).toBe(false)
  })
})
