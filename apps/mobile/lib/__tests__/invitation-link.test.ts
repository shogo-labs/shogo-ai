// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  invitationAcceptPath,
  invitationPhase,
  normalizeInvitationId,
  paramToString,
} from '../invitation-link'

describe('normalizeInvitationId', () => {
  test('accepts a plain string id', () => {
    expect(normalizeInvitationId('inv-123')).toBe('inv-123')
  })

  test('takes the first element of an array param (Expo can hand back both)', () => {
    expect(normalizeInvitationId(['inv-123', 'inv-456'])).toBe('inv-123')
  })

  test('trims surrounding whitespace', () => {
    expect(normalizeInvitationId('  inv-123 ')).toBe('inv-123')
  })

  test('returns null for a missing or empty id (so the page never fetches //info)', () => {
    expect(normalizeInvitationId(undefined)).toBeNull()
    expect(normalizeInvitationId(null)).toBeNull()
    expect(normalizeInvitationId('')).toBeNull()
    expect(normalizeInvitationId('   ')).toBeNull()
    expect(normalizeInvitationId([])).toBeNull()
  })
})

describe('paramToString', () => {
  test('passes through single values and rejects non-strings', () => {
    expect(paramToString('abc')).toBe('abc')
    expect(paramToString(['abc'])).toBe('abc')
    expect(paramToString(undefined)).toBeUndefined()
  })
})

describe('invitationAcceptPath', () => {
  test('builds the path the invitation email already uses', () => {
    expect(invitationAcceptPath('inv-123')).toBe('/invitations/inv-123/accept')
  })

  test('is a relative path sign-in can honour via ?next=', () => {
    const path = invitationAcceptPath('inv-123')
    expect(path.startsWith('/')).toBe(true)
    expect(path.startsWith('//')).toBe(false)
  })

  test('encodes ids that would otherwise break the URL', () => {
    expect(invitationAcceptPath('a/b?c')).toBe('/invitations/a%2Fb%3Fc/accept')
  })
})

describe('invitationPhase', () => {
  test('a live pending invitation is acceptable', () => {
    expect(invitationPhase({ status: 'pending', expired: false })).toBe('pending')
  })

  test('a pending invitation past expiresAt is expired', () => {
    expect(invitationPhase({ status: 'pending', expired: true })).toBe('expired')
  })

  test('an accepted invitation is already used', () => {
    expect(invitationPhase({ status: 'accepted', expired: false })).toBe('accepted')
  })

  test('explicitly expired / declined / cancelled invitations are unavailable', () => {
    expect(invitationPhase({ status: 'expired', expired: true })).toBe('expired')
    expect(invitationPhase({ status: 'declined', expired: false })).toBe('unavailable')
    expect(invitationPhase({ status: 'cancelled', expired: false })).toBe('unavailable')
  })
})
