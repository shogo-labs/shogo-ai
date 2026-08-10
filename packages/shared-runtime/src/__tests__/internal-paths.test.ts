// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which requests count as a user using the project.
 *
 * The guest records `lastRequestAt` on every non-internal request, the host
 * agent polls that value back, and its idle reaper suspends any VM quiet for
 * longer than the threshold. So anything misclassified as user traffic makes
 * the VM immortal.
 *
 * That is not hypothetical. `/pool/export-data` — the writable-state backup the
 * agent runs against every guest every 120 seconds — was not on the internal
 * list, so every sweep refreshed every VM and the reaper never fired once. In
 * production this left 164 guests resident for 5 active projects, including
 * ones whose owners had not sent a message in 41 days.
 */

import { describe, expect, test } from 'bun:test'

import { isInternalRuntimePath } from '../server-framework'

describe('isInternalRuntimePath', () => {
  test('the whole /pool control channel is the agent, not a user', () => {
    // Every route the host agent calls on the guest. The bug was a list that
    // covered the first two and none of the rest.
    for (const p of [
      '/pool/assign',
      '/pool/activity',
      '/pool/refresh-env',
      '/pool/hydrate',
      '/pool/hydrate-url',
      '/pool/export',
      '/pool/export-data',
    ]) {
      expect(isInternalRuntimePath(p)).toBe(true)
    }
  })

  test('a /pool endpoint that does not exist yet is still internal', () => {
    // The point of the prefix: the next maintenance endpoint is covered without
    // anyone remembering to come back here.
    expect(isInternalRuntimePath('/pool/some-future-maintenance-call')).toBe(true)
    expect(isInternalRuntimePath('/pool')).toBe(true)
  })

  test('probes are internal', () => {
    expect(isInternalRuntimePath('/health')).toBe(true)
    expect(isInternalRuntimePath('/ready')).toBe(true)
  })

  test('real user traffic still counts, or nothing would ever stay awake', () => {
    for (const p of [
      '/',
      '/api/messages',
      '/agent/chat',
      '/preview/index.html',
      '/poolside', // shares a prefix but is not under /pool
      '/x/pool/assign', // /pool appearing mid-path is not the control channel
    ]) {
      expect(isInternalRuntimePath(p)).toBe(false)
    }
  })

  test('a runtime can declare additional internal paths of its own', () => {
    // agent-runtime passes /agent/heartbeat/trigger this way.
    const extra = new Set(['/agent/heartbeat/trigger'])
    expect(isInternalRuntimePath('/agent/heartbeat/trigger', extra)).toBe(true)
    expect(isInternalRuntimePath('/agent/heartbeat/trigger')).toBe(false)
  })
})
