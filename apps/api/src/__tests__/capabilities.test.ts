// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Version Compatibility & Capabilities Tests (Phase 1 / Cross-cutting)
 *
 * Run: bun test apps/api/src/__tests__/capabilities.test.ts
 */

// Note: this tests the mobile lib module, but since it's pure TS with no
// React Native deps, it runs fine under Bun.

import { describe, test, expect } from 'bun:test'
import {
  semverGte,
  isCapabilityAvailable,
  getProtocolVersion,
  classifyLatency,
  CAPABILITIES,
  REMOTE_CONTROL_PROTOCOL_VERSION,
} from '../../mobile/lib/remote-control/capabilities'

describe('semverGte', () => {
  test('equal versions return true', () => {
    expect(semverGte('1.0.0', '1.0.0')).toBe(true)
    expect(semverGte('2.3.4', '2.3.4')).toBe(true)
  })

  test('greater versions return true', () => {
    expect(semverGte('2.0.0', '1.0.0')).toBe(true)
    expect(semverGte('1.1.0', '1.0.0')).toBe(true)
    expect(semverGte('1.0.1', '1.0.0')).toBe(true)
  })

  test('lesser versions return false', () => {
    expect(semverGte('0.9.0', '1.0.0')).toBe(false)
    expect(semverGte('1.0.0', '1.0.1')).toBe(false)
  })

  test('handles mismatched segment counts', () => {
    expect(semverGte('1.0', '1.0.0')).toBe(true)
    expect(semverGte('1', '1.0.0')).toBe(true)
    expect(semverGte('1.0.0', '2')).toBe(false)
  })
})

describe('isCapabilityAvailable', () => {
  test('returns false for undefined protocol version', () => {
    expect(isCapabilityAvailable('status', undefined)).toBe(false)
  })

  test('basic capabilities available at v1', () => {
    expect(isCapabilityAvailable('status', 1)).toBe(true)
    expect(isCapabilityAvailable('chat', 1)).toBe(true)
    expect(isCapabilityAvailable('files', 1)).toBe(true)
    expect(isCapabilityAvailable('controls', 1)).toBe(true)
  })

  test('v2 capabilities not available at v1', () => {
    expect(isCapabilityAvailable('logs', 1)).toBe(false)
    expect(isCapabilityAvailable('projectManagement', 1)).toBe(false)
    expect(isCapabilityAvailable('modelSwitch', 1)).toBe(false)
    expect(isCapabilityAvailable('fileEdit', 1)).toBe(false)
    expect(isCapabilityAvailable('fileUpload', 1)).toBe(false)
  })

  test('v2 capabilities available at v2', () => {
    expect(isCapabilityAvailable('logs', 2)).toBe(true)
    expect(isCapabilityAvailable('projectManagement', 2)).toBe(true)
    expect(isCapabilityAvailable('modelSwitch', 2)).toBe(true)
  })
})

describe('getProtocolVersion', () => {
  test('returns protocolVersion from metadata', () => {
    expect(getProtocolVersion({ protocolVersion: 2 })).toBe(2)
    expect(getProtocolVersion({ protocolVersion: 5 })).toBe(5)
  })

  test('defaults to 1 for missing metadata', () => {
    expect(getProtocolVersion(null)).toBe(1)
    expect(getProtocolVersion(undefined)).toBe(1)
    expect(getProtocolVersion({})).toBe(1)
  })

  test('defaults to 1 for non-numeric protocolVersion', () => {
    expect(getProtocolVersion({ protocolVersion: 'abc' })).toBe(1)
  })
})

describe('classifyLatency', () => {
  test('classifies low latency as good', () => {
    expect(classifyLatency(50)).toBe('good')
    expect(classifyLatency(150)).toBe('good')
  })

  test('classifies medium latency as fair', () => {
    expect(classifyLatency(200)).toBe('fair')
    expect(classifyLatency(400)).toBe('fair')
  })

  test('classifies high latency as poor', () => {
    expect(classifyLatency(500)).toBe('poor')
    expect(classifyLatency(1000)).toBe('poor')
  })
})

describe('CAPABILITIES config', () => {
  test('all v2 capabilities have softGate: true', () => {
    for (const [key, cap] of Object.entries(CAPABILITIES)) {
      if (cap.minProtocolVersion >= 2) {
        expect(cap.softGate).toBe(true)
      }
    }
  })

  test('REMOTE_CONTROL_PROTOCOL_VERSION >= 2', () => {
    expect(REMOTE_CONTROL_PROTOCOL_VERSION).toBeGreaterThanOrEqual(2)
  })
})
