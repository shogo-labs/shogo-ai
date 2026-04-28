// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for the centralized tech-stack registry. The registry replaces
// the brittle `techStackId.startsWith('expo')` heuristic — these tests pin
// the contract so a future stack rename / addition can't silently regress
// pod sizing or runtime image selection.

import { describe, test, expect } from 'bun:test'
import {
  TECH_STACK_REGISTRY,
  getStackEntry,
  isMobileTechStack,
  usesMetroBundler,
  stackSeedsItself,
} from '../tech-stack-registry'

describe('tech-stack-registry', () => {
  test('isMobileTechStack: known mobile stacks', () => {
    expect(isMobileTechStack('expo-app')).toBe(true)
    expect(isMobileTechStack('expo-three')).toBe(true)
    expect(isMobileTechStack('react-native')).toBe(true)
  })

  test('isMobileTechStack: known non-mobile stacks', () => {
    expect(isMobileTechStack('react-app')).toBe(false)
    expect(isMobileTechStack('threejs-game')).toBe(false)
    expect(isMobileTechStack('phaser-game')).toBe(false)
    expect(isMobileTechStack('python-data')).toBe(false)
    expect(isMobileTechStack('unity-game')).toBe(false)
    expect(isMobileTechStack('none')).toBe(false)
  })

  test('isMobileTechStack: unknown ids return false (does NOT match by prefix)', () => {
    // The whole point of replacing the `startsWith` heuristic.
    expect(isMobileTechStack('expo-cli-tools')).toBe(false)
    expect(isMobileTechStack('expo-something-future')).toBe(false)
    expect(isMobileTechStack('expoxide')).toBe(false)
  })

  test('isMobileTechStack: nullish input', () => {
    expect(isMobileTechStack(null)).toBe(false)
    expect(isMobileTechStack(undefined)).toBe(false)
    expect(isMobileTechStack('')).toBe(false)
  })

  test('usesMetroBundler: only Metro stacks return true', () => {
    expect(usesMetroBundler('expo-app')).toBe(true)
    expect(usesMetroBundler('expo-three')).toBe(true)
    expect(usesMetroBundler('react-native')).toBe(true)
    expect(usesMetroBundler('react-app')).toBe(false)
    expect(usesMetroBundler('unity-game')).toBe(false)
    expect(usesMetroBundler(null)).toBe(false)
  })

  test('getStackEntry: returns entry for known ids, null otherwise', () => {
    expect(getStackEntry('expo-three')?.target).toBe('mobile')
    expect(getStackEntry('react-app')?.target).toBe('web')
    expect(getStackEntry('python-data')?.target).toBe('data')
    expect(getStackEntry('unity-game')?.target).toBe('native')
    expect(getStackEntry('none')?.target).toBe('none')
    expect(getStackEntry('does-not-exist')).toBeNull()
    expect(getStackEntry(null)).toBeNull()
  })

  test('every registry entry has a non-empty id matching its key', () => {
    for (const [key, entry] of Object.entries(TECH_STACK_REGISTRY)) {
      expect(entry.id).toBe(key)
      expect(entry.target).toBeDefined()
    }
  })

  test('stackSeedsItself: only stacks owned by agent-runtime return true', () => {
    // Vite-bundled stacks: false (apps/api copies the bundled template).
    expect(stackSeedsItself('react-app')).toBe(false)
    expect(stackSeedsItself('threejs-game')).toBe(false)
    expect(stackSeedsItself('phaser-game')).toBe(false)
    // Everything else seeds itself.
    expect(stackSeedsItself('expo-app')).toBe(true)
    expect(stackSeedsItself('expo-three')).toBe(true)
    expect(stackSeedsItself('react-native')).toBe(true)
    expect(stackSeedsItself('python-data')).toBe(true)
    expect(stackSeedsItself('unity-game')).toBe(true)
    expect(stackSeedsItself('none')).toBe(true)
  })

  test('stackSeedsItself: unknown / nullish ids return false (safe default)', () => {
    expect(stackSeedsItself('does-not-exist')).toBe(false)
    expect(stackSeedsItself(null)).toBe(false)
    expect(stackSeedsItself(undefined)).toBe(false)
    expect(stackSeedsItself('')).toBe(false)
  })
})
