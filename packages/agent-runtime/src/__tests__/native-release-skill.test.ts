// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The bundled `native-release` skill: the release procedure, written down where a
 * fresh agent will find it.
 *
 * Round 3's lesson was that a procedure living in docs and in an agent's memory is
 * not a procedure. The card's acceptance criterion is that an agent given only
 * "ship this to Google Play" can follow `next_action` to `submitted`; that only
 * works if every action the state machine can return is explained here, in the
 * same words.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadBundledSkills } from '../skills'
import { nativeNextStep, RELEASE_ONLY_FACTS } from '../native-release-state'

describe('native-release bundled skill', () => {
  const skill = loadBundledSkills(new Set()).find((s) => s.name === 'native-release')

  test('ships with the runtime and triggers on store requests', () => {
    expect(skill).toBeDefined()
    for (const phrase of ['app store', 'google play', 'testflight', 'bundle id']) {
      expect(skill!.trigger).toContain(phrase)
    }
  })

  test('documents every next_action the state machine can return', () => {
    // Every state the flow can reach, in one list.
    const actions = [
      nativeNextStep({ facts: { ...RELEASE_ONLY_FACTS, needsBundleId: true }, platforms: ['ios'] }),
      nativeNextStep({ facts: { ...RELEASE_ONLY_FACTS, hasServerFiles: true }, platforms: ['ios'] }),
      nativeNextStep({
        facts: {
          ...RELEASE_ONLY_FACTS,
          connections: {
            play: { keyAvailable: false, publisherEmail: null, firstUploadDone: false },
            asc: { keyAvailable: true, appRecord: true },
          },
        },
        platforms: ['android'],
      }),
      nativeNextStep({
        facts: {
          ...RELEASE_ONLY_FACTS,
          connections: { ...RELEASE_ONLY_FACTS.connections, asc: { keyAvailable: false, appRecord: false } },
        },
        platforms: ['ios'],
      }),
      nativeNextStep({
        facts: {
          ...RELEASE_ONLY_FACTS,
          connections: { ...RELEASE_ONLY_FACTS.connections, play: { keyAvailable: true, publisherEmail: 'p@x', firstUploadDone: false } },
        },
        platforms: ['android'],
      }),
      nativeNextStep({
        facts: {
          ...RELEASE_ONLY_FACTS,
          connections: { ...RELEASE_ONLY_FACTS.connections, asc: { keyAvailable: true, appRecord: false } },
        },
        platforms: ['ios'],
      }),
      nativeNextStep({ facts: { ...RELEASE_ONLY_FACTS, hasStoreIcon: false }, platforms: ['ios'] }),
      ...['building', 'testing', 'submitting', 'done'].map((status) =>
        nativeNextStep({
          facts: RELEASE_ONLY_FACTS,
          platforms: ['ios'],
          release: { status, step: status, testOutcome: null, kind: 'build' },
        }),
      ),
      nativeNextStep({
        facts: RELEASE_ONLY_FACTS,
        platforms: ['ios'],
        release: { status: 'failed', step: 'maestro', testOutcome: 'failed', kind: 'build' },
      }),
    ]

    const missing = actions
      .map((a) => a.next_action)
      .filter((action) => !skill!.content.includes(`\`${action}\``))
    expect(missing).toEqual([])
  })

  test('tells the agent not to wait on a build, and not to shell out', () => {
    expect(skill!.content).toContain('release_id')
    expect(skill!.content).toMatch(/never\s+start a background process|Never\*\* start a background process/i)
    expect(skill!.content).toMatch(/eas-cli/)
  })

  test('names the two hand steps as the only user actions', () => {
    expect(skill!.content).toContain('play_first_upload')
    expect(skill!.content).toContain('asc_app_record')
  })
})

describe('the stack notes', () => {
  const stacks = ['expo-app', 'expo-three', 'react-native']

  test('tell the agent how to ship, on every native stack', () => {
    for (const stack of stacks) {
      const path = join(__dirname, '..', '..', 'tech-stacks', stack, '.shogo', 'STACK.md')
      const text = readFileSync(path, 'utf8')
      expect(text).toContain('Shipping to the App Store')
      expect(text).toContain('EXPO_PUBLIC_API_URL')
      expect(text).toContain('.maestro/')
    }
  })

  test('did not lose their existing content', () => {
    const path = join(__dirname, '..', '..', 'tech-stacks', 'expo-app', '.shogo', 'STACK.md')
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('# Stack: Expo')
  })
})
