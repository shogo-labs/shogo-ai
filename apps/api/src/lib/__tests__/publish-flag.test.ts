// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * §G2: `PUBLISH_POSTGRES` and `PUBLISH_BUILD_IMAGES` accept a list of project
 * ids, so a rollout moves the apps it names and nothing else. These pin the
 * parsing (a mistyped list must not read as "unset") and the per-project verdict
 * both switches share.
 */

import { describe, expect, it } from 'bun:test'
import {
  MIN_PREFIX_ID_LENGTH,
  listNamesProject,
  parsePublishFlag,
  publishFlagAllows,
} from '../publish-flag'

const KIF = '5925615d-0157-44d3-a114-41b35a14785e'
const NADA = 'c7d51ded-aa79-42a5-8e48-2b10222d743d'
const OTHER = '0c8a4d79-b3b2-4cfa-b2c1-95418f91d670'

describe('parsePublishFlag', () => {
  it('reads on / off in the spellings an overlay may carry', () => {
    for (const value of ['on', 'ON', 'true', '1', ' on ']) {
      expect(parsePublishFlag(value).kind).toBe('on')
    }
    for (const value of ['off', 'OFF', 'false', '0']) {
      expect(parsePublishFlag(value).kind).toBe('off')
    }
  })

  it('is unset for an empty value', () => {
    expect(parsePublishFlag(undefined).kind).toBe('unset')
    expect(parsePublishFlag('').kind).toBe('unset')
    expect(parsePublishFlag('   ').kind).toBe('unset')
  })

  it('reads a comma-separated list of project ids', () => {
    const flag = parsePublishFlag(`${KIF},${NADA}`)
    expect(flag).toEqual({ kind: 'list', ids: [KIF, NADA], raw: `${KIF},${NADA}` })
  })

  it('accepts short prefixes, so an overlay can stay readable', () => {
    const flag = parsePublishFlag('5925615d, c7d51ded')
    expect(flag.kind).toBe('list')
    expect(publishFlagAllows(flag, KIF)).toBe(true)
    expect(publishFlagAllows(flag, NADA)).toBe(true)
    expect(publishFlagAllows(flag, OTHER)).toBe(false)
  })

  it('treats a mistyped list as invalid, never as unset', () => {
    // A typo must not quietly fall back to the region default: the overlay would
    // read as applied while nothing moved.
    expect(parsePublishFlag(`${KIF},`, ).kind).toBe('list')
    expect(parsePublishFlag('kif-crm').kind).toBe('invalid')
    expect(parsePublishFlag('yes please').kind).toBe('invalid')
    expect(parsePublishFlag('5925').kind).toBe('invalid')
  })

  it(`uses a ${MIN_PREFIX_ID_LENGTH}-character minimum for a prefix`, () => {
    expect(parsePublishFlag('a'.repeat(MIN_PREFIX_ID_LENGTH)).kind).toBe('list')
    expect(parsePublishFlag('a'.repeat(MIN_PREFIX_ID_LENGTH - 1)).kind).toBe('invalid')
  })
})

describe('publishFlagAllows', () => {
  it('has no opinion when unset or invalid, so configuration decides', () => {
    expect(publishFlagAllows(parsePublishFlag(undefined), KIF)).toBeNull()
    expect(publishFlagAllows(parsePublishFlag('nonsense!'), KIF)).toBeNull()
  })

  it('forces on and off regardless of the project', () => {
    expect(publishFlagAllows(parsePublishFlag('on'), KIF)).toBe(true)
    expect(publishFlagAllows(parsePublishFlag('off'), KIF)).toBe(false)
  })

  it('is false for a project the list does not name', () => {
    const flag = parsePublishFlag(`${KIF},${NADA}`)
    expect(publishFlagAllows(flag, KIF)).toBe(true)
    expect(publishFlagAllows(flag, OTHER)).toBe(false)
  })

  it('is false for a list with no project to match (every publish is project-scoped)', () => {
    expect(publishFlagAllows(parsePublishFlag(`${KIF}`), undefined)).toBe(false)
    expect(publishFlagAllows(parsePublishFlag(`${KIF}`), null)).toBe(false)
  })
})

describe('listNamesProject', () => {
  it('matches exactly and by prefix, case-insensitively', () => {
    expect(listNamesProject([KIF], KIF)).toBe(true)
    expect(listNamesProject([KIF.toUpperCase()], KIF)).toBe(true)
    expect(listNamesProject(['5925615d'], KIF)).toBe(true)
    expect(listNamesProject(['5925615e'], KIF)).toBe(false)
  })
})
