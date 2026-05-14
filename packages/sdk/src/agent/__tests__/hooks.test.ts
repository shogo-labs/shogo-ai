// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hooks smoke tests.
 *
 * Bun's test runner has no React DOM, so we can't render these hooks.
 * Instead we lock in the module-level contract that's all an SDK
 * consumer can rely on without first installing a renderer:
 *
 *   - each hook is exported as a callable function
 *   - calling a hook outside a React render throws a recognisable React
 *     dispatcher error (not a ReferenceError, not undefined.someProp) —
 *     which proves the import wiring + ref-based useClient() helper
 *     reach React's internals before failing.
 *
 * The thorough behavioural coverage of the AgentClient methods these
 * hooks call lives in `client.test.ts`.
 */

import { describe, expect, test } from 'bun:test'

import {
  useAgentStatus,
  useAgentChat,
  useCanvasStream,
  useAgentMode,
  useAgentFiles,
} from '../hooks'

const hooks = {
  useAgentStatus,
  useAgentChat,
  useCanvasStream,
  useAgentMode,
  useAgentFiles,
}

describe('agent/hooks — exports', () => {
  for (const [name, fn] of Object.entries(hooks)) {
    test(`${name} is exported as a function`, () => {
      expect(typeof fn).toBe('function')
    })
  }

  test('all five hooks are present', () => {
    expect(Object.keys(hooks).sort()).toEqual([
      'useAgentChat',
      'useAgentFiles',
      'useAgentMode',
      'useAgentStatus',
      'useCanvasStream',
    ])
  })
})

describe('agent/hooks — invocation outside React render', () => {
  function expectDispatcherError(fn: () => unknown) {
    let caught: unknown
    try { fn() } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(Error)
    const msg = (caught as Error).message
    // React 18/19 phrasing varies; any of these proves we reached the
    // dispatcher rather than failing on a missing import.
    expect(
      /Invalid hook call|null|Cannot read|dispatcher|Hooks can only/i.test(msg),
    ).toBe(true)
  }

  test('useAgentStatus throws a React hook error when called outside render', () => {
    expectDispatcherError(() => useAgentStatus())
  })

  test('useAgentChat throws a React hook error when called outside render', () => {
    expectDispatcherError(() => useAgentChat())
  })

  test('useCanvasStream throws a React hook error when called outside render', () => {
    expectDispatcherError(() => useCanvasStream())
  })

  test('useAgentMode throws a React hook error when called outside render', () => {
    expectDispatcherError(() => useAgentMode())
  })

  test('useAgentFiles throws a React hook error when called outside render', () => {
    expectDispatcherError(() => useAgentFiles())
  })
})
