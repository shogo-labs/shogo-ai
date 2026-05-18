// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'vitest'
import {
  KNOWN_INTEGRATIONS,
  TAG_PERMISSION_COPY,
  resolveIntegration,
  resolvePermissionCopy,
} from '../integrations'

describe('KNOWN_INTEGRATIONS', () => {
  it('is a non-empty record', () => {
    expect(Object.keys(KNOWN_INTEGRATIONS).length).toBeGreaterThan(0)
  })

  it('every entry has label and icon', () => {
    for (const [key, integration] of Object.entries(KNOWN_INTEGRATIONS)) {
      expect(typeof integration.label).toBe('string')
      expect(integration.label.length).toBeGreaterThan(0)
      expect(typeof integration.icon).toBe('string')
      expect(integration.icon.length).toBeGreaterThan(0)
    }
  })

  it('includes common integrations', () => {
    expect(KNOWN_INTEGRATIONS.github).toBeDefined()
    expect(KNOWN_INTEGRATIONS.slack).toBeDefined()
    expect(KNOWN_INTEGRATIONS.gmail).toBeDefined()
    expect(KNOWN_INTEGRATIONS.stripe).toBeDefined()
  })

  it('color values are valid hex when present', () => {
    for (const integration of Object.values(KNOWN_INTEGRATIONS)) {
      if (integration.color) {
        expect(integration.color).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })
})

describe('TAG_PERMISSION_COPY', () => {
  it('is a non-empty record', () => {
    expect(Object.keys(TAG_PERMISSION_COPY).length).toBeGreaterThan(0)
  })

  it('every permission copy key exists in KNOWN_INTEGRATIONS', () => {
    for (const key of Object.keys(TAG_PERMISSION_COPY)) {
      expect(KNOWN_INTEGRATIONS[key]).toBeDefined()
    }
  })

  it('permission copy is a full sentence (starts uppercase, non-empty)', () => {
    for (const copy of Object.values(TAG_PERMISSION_COPY)) {
      expect(copy.length).toBeGreaterThan(5)
      expect(copy[0]).toBe(copy[0].toUpperCase())
    }
  })
})

describe('resolveIntegration', () => {
  it('returns integration for known tags', () => {
    const result = resolveIntegration('github')
    expect(result).not.toBeNull()
    expect(result!.label).toBe('GitHub')
    expect(result!.icon).toBe('Github')
  })

  it('is case-insensitive', () => {
    expect(resolveIntegration('GitHub')).not.toBeNull()
    expect(resolveIntegration('SLACK')).not.toBeNull()
  })

  it('trims whitespace', () => {
    expect(resolveIntegration('  github  ')).not.toBeNull()
  })

  it('returns null for unknown tags', () => {
    expect(resolveIntegration('unknown-service')).toBeNull()
    expect(resolveIntegration('')).toBeNull()
  })
})

describe('resolvePermissionCopy', () => {
  it('returns copy for known tags', () => {
    const result = resolvePermissionCopy('github')
    expect(result).not.toBeNull()
    expect(result).toContain('repositories')
  })

  it('is case-insensitive', () => {
    expect(resolvePermissionCopy('Gmail')).not.toBeNull()
  })

  it('trims whitespace', () => {
    expect(resolvePermissionCopy('  slack  ')).not.toBeNull()
  })

  it('returns null for unknown tags', () => {
    expect(resolvePermissionCopy('nonexistent')).toBeNull()
  })
})
