// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { agentSessionSource, appHomeSurface } from '../root-destination'

describe('appHomeSurface', () => {
  test('the landing is the workspace agent for every kind and width', () => {
    for (const kind of ['team', 'personal', undefined, null]) {
      for (const narrow of [true, false]) {
        expect(
          appHomeSurface({ kind, narrow, runtimeEnabled: true }),
        ).toBe('agent')
      }
    }
  })

  test('the landing falls back to the builder when the runtime is off', () => {
    expect(
      appHomeSurface({ kind: 'team', narrow: true, runtimeEnabled: false }),
    ).toBe('builder')
    expect(
      appHomeSurface({ kind: 'personal', narrow: false, runtimeEnabled: false }),
    ).toBe('builder')
  })

  test('/(app)/home keeps the pre-landing team home', () => {
    expect(
      appHomeSurface({
        explicitHome: true,
        kind: 'team',
        narrow: true,
        runtimeEnabled: true,
      }),
    ).toBe('feed')
    expect(
      appHomeSurface({
        explicitHome: true,
        kind: 'team',
        narrow: false,
        runtimeEnabled: true,
      }),
    ).toBe('builder')
  })

  test('/(app)/home still opens the personal workspace chat', () => {
    expect(
      appHomeSurface({
        explicitHome: true,
        kind: 'personal',
        narrow: true,
        runtimeEnabled: true,
      }),
    ).toBe('agent')
    expect(
      appHomeSurface({
        explicitHome: true,
        kind: 'personal',
        narrow: false,
        runtimeEnabled: true,
      }),
    ).toBe('agent')
  })

  test('the builder entry point ignores everything else', () => {
    expect(
      appHomeSurface({
        forceBuilder: true,
        kind: 'team',
        narrow: true,
        runtimeEnabled: true,
      }),
    ).toBe('builder')
    expect(
      appHomeSurface({
        forceBuilder: true,
        explicitHome: true,
        kind: 'personal',
        narrow: true,
        runtimeEnabled: true,
      }),
    ).toBe('builder')
  })
})

describe('agentSessionSource', () => {
  test('an explicit chat session in the URL wins over everything', () => {
    expect(
      agentSessionSource({
        initialSessionId: 'session-1',
        startNewSession: true,
        kind: 'team',
      }),
    ).toBe('url')
    expect(agentSessionSource({ initialSessionId: 'session-1' })).toBe('url')
  })

  test('a team landing starts a new chat', () => {
    expect(agentSessionSource({ startNewSession: true, kind: 'team' })).toBe(
      'new',
    )
  })

  test('a personal landing keeps resuming the last chat', () => {
    expect(
      agentSessionSource({ startNewSession: true, kind: 'personal' }),
    ).toBe('primary')
    expect(agentSessionSource({ startNewSession: true })).toBe('primary')
  })

  test('a plain /agent resumes the primary chat', () => {
    expect(agentSessionSource({})).toBe('primary')
    expect(agentSessionSource({ kind: 'team' })).toBe('primary')
  })
})
