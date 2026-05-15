// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'vitest'
import { isDynamicPath, isApiBinding } from '../types'

describe('isDynamicPath', () => {
  it('returns true for objects with a string path property', () => {
    expect(isDynamicPath({ path: '/data/name' })).toBe(true)
  })

  it('returns true even when extra properties exist', () => {
    expect(isDynamicPath({ path: '/x', other: 123 })).toBe(true)
  })

  it('returns false for null', () => {
    expect(isDynamicPath(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isDynamicPath(undefined)).toBe(false)
  })

  it('returns false for strings', () => {
    expect(isDynamicPath('/data/name')).toBe(false)
  })

  it('returns false for numbers', () => {
    expect(isDynamicPath(42)).toBe(false)
  })

  it('returns false for objects without path', () => {
    expect(isDynamicPath({ api: 'users' })).toBe(false)
  })

  it('returns false when path is not a string', () => {
    expect(isDynamicPath({ path: 123 })).toBe(false)
  })

  it('returns false for arrays', () => {
    expect(isDynamicPath([{ path: '/x' }])).toBe(false)
  })
})

describe('isApiBinding', () => {
  it('returns true for objects with a string api property', () => {
    expect(isApiBinding({ api: 'users' })).toBe(true)
  })

  it('returns true with optional params and refreshInterval', () => {
    expect(isApiBinding({ api: 'orders', params: { limit: 10 }, refreshInterval: 5000 })).toBe(true)
  })

  it('returns false for null', () => {
    expect(isApiBinding(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isApiBinding(undefined)).toBe(false)
  })

  it('returns false for strings', () => {
    expect(isApiBinding('users')).toBe(false)
  })

  it('returns false for objects without api', () => {
    expect(isApiBinding({ path: '/data' })).toBe(false)
  })

  it('returns false when api is not a string', () => {
    expect(isApiBinding({ api: 123 })).toBe(false)
  })

  it('returns false for arrays', () => {
    expect(isApiBinding([{ api: 'users' }])).toBe(false)
  })
})
