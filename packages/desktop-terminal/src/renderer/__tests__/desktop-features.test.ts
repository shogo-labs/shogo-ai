// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { isDesktop, getDesktopBridge } from '../desktop-features'

const g = globalThis as { shogoDesktopTerminal?: unknown }

describe('desktop-features — isDesktop', () => {
  beforeEach(() => { delete g.shogoDesktopTerminal })
  afterEach(() => { delete g.shogoDesktopTerminal })

  it('returns false when the bridge has never been installed', () => {
    expect(isDesktop()).toBe(false)
  })
  it('returns false when the bridge slot is explicitly null', () => {
    g.shogoDesktopTerminal = null
    expect(isDesktop()).toBe(false)
  })
  it('returns true when an object is mounted on the bridge slot', () => {
    g.shogoDesktopTerminal = {}
    expect(isDesktop()).toBe(true)
  })
})

describe('desktop-features — getDesktopBridge', () => {
  beforeEach(() => { delete g.shogoDesktopTerminal })
  afterEach(() => { delete g.shogoDesktopTerminal })

  it('throws a descriptive error when the bridge is missing', () => {
    expect(() => getDesktopBridge()).toThrow(/shogoDesktopTerminal bridge missing/)
  })
  it('throws when the bridge slot is null', () => {
    g.shogoDesktopTerminal = null
    expect(() => getDesktopBridge()).toThrow(/non-Electron context/)
  })
  it('returns the exact bridge object when present (identity-preserving)', () => {
    const fake = { spawn: () => {}, write: () => {} }
    g.shogoDesktopTerminal = fake
    expect(getDesktopBridge()).toBe(fake as never)
  })
})
