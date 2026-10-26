// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { canManageMemberRow, roleOptionsFor } from '../workspace-member-role'

const owner = { canManageMembers: true, isOwner: true, isSelf: false }
const admin = { canManageMembers: true, isOwner: false, isSelf: false }
// What a super admin who is not a workspace owner resolves to: the permission
// set says yes, the seat says no.
const superAdminElsewhere = { canManageMembers: true, isOwner: false, isSelf: false }
const plainMember = { canManageMembers: false, isOwner: false, isSelf: false }

describe('canManageMemberRow', () => {
  test('an owner manages every other member, including owners', () => {
    expect(canManageMemberRow(owner, 'admin')).toBe(true)
    expect(canManageMemberRow(owner, 'member')).toBe(true)
    expect(canManageMemberRow(owner, 'viewer')).toBe(true)
    expect(canManageMemberRow(owner, 'owner')).toBe(true)
  })

  test('an admin never manages an owner row', () => {
    expect(canManageMemberRow(admin, 'owner')).toBe(false)
    expect(canManageMemberRow(admin, 'admin')).toBe(true)
    expect(canManageMemberRow(admin, 'viewer')).toBe(true)
  })

  test('holding the permission without an owner seat is not enough', () => {
    expect(canManageMemberRow(superAdminElsewhere, 'owner')).toBe(false)
    expect(canManageMemberRow(superAdminElsewhere, 'admin')).toBe(true)
  })

  test('nobody manages their own row', () => {
    expect(canManageMemberRow({ ...owner, isSelf: true }, 'admin')).toBe(false)
    expect(canManageMemberRow({ ...owner, isSelf: true }, 'owner')).toBe(false)
  })

  test('no members:manage means no row is manageable', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer']) {
      expect(canManageMemberRow(plainMember, role)).toBe(false)
    }
  })

  test('an unknown or missing role falls back to the plain member rule', () => {
    expect(canManageMemberRow(admin, null)).toBe(true)
    expect(canManageMemberRow(admin, undefined)).toBe(true)
  })
})

describe('roleOptionsFor', () => {
  test('only an owner is offered the owner role', () => {
    expect(roleOptionsFor({ isOwner: true })).toEqual(['owner', 'admin', 'member', 'viewer'])
    expect(roleOptionsFor({ isOwner: false })).toEqual(['admin', 'member', 'viewer'])
  })
})
