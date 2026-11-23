// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The shared `ability_not_allowed` decision (SHO-539). Both the runtime's tool
 * gate and the server's project-permission route report it, so the shape and
 * the wording are a contract: a tool keys on the code, and the model repeats
 * the message to the user.
 */

import { describe, expect, test } from 'bun:test'
import { abilityDenial } from '../denial'

describe('abilityDenial', () => {
  test('names the permission to ask an admin for', () => {
    expect(abilityDenial('agent.exec:use')).toEqual({
      code: 'ability_not_allowed',
      permission: 'agent.exec:use',
      message: 'Ask a workspace admin for agent.exec:use.',
    })
  })

  test('a project permission is reportable too', () => {
    const denial = abilityDenial('project:publish', 'Ask a workspace admin for publish access to this project.')
    expect(denial.code).toBe('ability_not_allowed')
    expect(denial.permission).toBe('project:publish')
    expect(denial.message).toMatch(/publish access/i)
  })
})
