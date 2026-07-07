// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  isMetalAllProjects,
  isMetalAuthoritative,
  isMetalDrainMode,
  isMetalEnabled,
  isMetalEligibleProject,
} from '../metal-eligibility'

const ENV_KEYS = [
  'SHOGO_METAL_ALL_PROJECTS',
  'SHOGO_METAL_DRAIN_MODE',
  'SHOGO_METAL_ENABLED',
  'METAL_PROJECT_ALLOWLIST',
  'METAL_ROLLOUT_PERCENT',
] as const

describe('metal-eligibility', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  describe('rollout mode (default)', () => {
    it('off by default', () => {
      expect(isMetalEnabled()).toBe(false)
      expect(isMetalAllProjects()).toBe(false)
      expect(isMetalEligibleProject('proj-1')).toBe(false)
    })

    it('allowlisted project is eligible when enabled', () => {
      process.env.SHOGO_METAL_ENABLED = 'true'
      process.env.METAL_PROJECT_ALLOWLIST = 'proj-a, proj-b'
      expect(isMetalEligibleProject('proj-a')).toBe(true)
      expect(isMetalEligibleProject('proj-c')).toBe(false)
    })

    it('percentage 100 makes all eligible; 0 makes none (allowlist-only)', () => {
      process.env.SHOGO_METAL_ENABLED = 'true'
      process.env.METAL_ROLLOUT_PERCENT = '100'
      expect(isMetalEligibleProject('anything')).toBe(true)
      process.env.METAL_ROLLOUT_PERCENT = '0'
      expect(isMetalEligibleProject('anything')).toBe(false)
    })
  })

  describe('metal-only mode (SHOGO_METAL_ALL_PROJECTS)', () => {
    it('implies enabled and makes every project eligible with no allowlist/percent', () => {
      process.env.SHOGO_METAL_ALL_PROJECTS = 'true'
      // No SHOGO_METAL_ENABLED, no allowlist, no percent set.
      expect(isMetalAllProjects()).toBe(true)
      expect(isMetalEnabled()).toBe(true)
      expect(isMetalEligibleProject('proj-1')).toBe(true)
      expect(isMetalEligibleProject('literally-any-id')).toBe(true)
    })

    it('still rejects empty project ids', () => {
      process.env.SHOGO_METAL_ALL_PROJECTS = 'true'
      expect(isMetalEligibleProject('')).toBe(false)
    })

    it('is authoritative (no Knative fallback on miss)', () => {
      process.env.SHOGO_METAL_ALL_PROJECTS = 'true'
      expect(isMetalAuthoritative()).toBe(true)
    })
  })

  describe('drain cutover mode (SHOGO_METAL_DRAIN_MODE)', () => {
    it('implies enabled and makes every project eligible with no allowlist/percent', () => {
      process.env.SHOGO_METAL_DRAIN_MODE = 'true'
      expect(isMetalDrainMode()).toBe(true)
      expect(isMetalAllProjects()).toBe(false)
      expect(isMetalEnabled()).toBe(true)
      expect(isMetalEligibleProject('proj-1')).toBe(true)
      expect(isMetalEligibleProject('literally-any-id')).toBe(true)
    })

    it('is authoritative (no Knative fallback once past the live-pod check)', () => {
      process.env.SHOGO_METAL_DRAIN_MODE = 'true'
      expect(isMetalAuthoritative()).toBe(true)
    })

    it('still rejects empty project ids', () => {
      process.env.SHOGO_METAL_DRAIN_MODE = 'true'
      expect(isMetalEligibleProject('')).toBe(false)
    })
  })

  describe('isMetalAuthoritative default', () => {
    it('is false in rollout mode (Knative fallback allowed)', () => {
      process.env.SHOGO_METAL_ENABLED = 'true'
      process.env.METAL_ROLLOUT_PERCENT = '100'
      expect(isMetalAuthoritative()).toBe(false)
    })
  })
})
