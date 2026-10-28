// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-185 — the relay must outlive the proxy it wraps, and the tunnel-owner
 * refresh must repair a key somebody deleted.
 *
 * Both were the difference between "this machine is slow" and "this machine is
 * offline" for the life of a WebSocket connection.
 */

import { describe, test, expect } from 'bun:test'
import { PROXY_TIMEOUT_MS, RELAY_GRACE_MS, RELAY_TIMEOUT_MS } from '../tunnel-timeouts'
import { MachineTimeoutError, RelayTimeoutError, isMachineTimeoutError } from '../tunnel-errors'

describe('tunnel timeouts', () => {
  test('the cross-pod relay always outlives the proxy it wraps', () => {
    // Equal timeouts (the old 30s/30s pair) meant the relay gave up at the same
    // instant the owner pod did, so the caller only ever saw "Cross-pod relay
    // timed out" and never the machine's real error.
    expect(RELAY_TIMEOUT_MS).toBeGreaterThan(PROXY_TIMEOUT_MS)
    expect(RELAY_TIMEOUT_MS).toBe(PROXY_TIMEOUT_MS + RELAY_GRACE_MS)
  })

  test('the default proxy timeout is 30s', () => {
    expect(PROXY_TIMEOUT_MS).toBe(30_000)
  })
})

describe('machine timeout errors', () => {
  test('a timeout is identifiable, so the relay can answer 504 instead of "offline"', () => {
    const err = new MachineTimeoutError('inst-1', 30_000)
    expect(isMachineTimeoutError(err)).toBe(true)
    expect(err.code).toBe('machine_timeout')
    expect(err.message).toBe('Machine did not answer within 30s')
  })

  test('a relay timeout is still a machine timeout', () => {
    const err = new RelayTimeoutError('inst-1', 35_000)
    expect(isMachineTimeoutError(err)).toBe(true)
    expect(err.code).toBe('machine_timeout')
    expect(err.name).toBe('RelayTimeoutError')
  })

  test('other errors are not mistaken for timeouts', () => {
    expect(isMachineTimeoutError(new Error('Instance is offline'))).toBe(false)
  })
})
