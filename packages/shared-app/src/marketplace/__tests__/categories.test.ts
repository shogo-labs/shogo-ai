// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'vitest'
import {
  MARKETPLACE_CATEGORIES,
  findCategory,
  categoryLabel,
  categoryAccent,
} from '../categories'

describe('MARKETPLACE_CATEGORIES', () => {
  it('is a non-empty array', () => {
    expect(MARKETPLACE_CATEGORIES.length).toBeGreaterThan(0)
  })

  it('every category has required fields', () => {
    for (const cat of MARKETPLACE_CATEGORIES) {
      expect(typeof cat.slug).toBe('string')
      expect(cat.slug.length).toBeGreaterThan(0)
      expect(typeof cat.label).toBe('string')
      expect(cat.label.length).toBeGreaterThan(0)
      expect(typeof cat.icon).toBe('string')
      expect(typeof cat.tagline).toBe('string')
      expect(cat.accent).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('has unique slugs', () => {
    const slugs = MARKETPLACE_CATEGORIES.map((c) => c.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('includes known categories', () => {
    const slugs = MARKETPLACE_CATEGORIES.map((c) => c.slug)
    expect(slugs).toContain('personal')
    expect(slugs).toContain('development')
    expect(slugs).toContain('business')
    expect(slugs).toContain('research')
  })
})

describe('findCategory', () => {
  it('returns category for known slug', () => {
    const result = findCategory('development')
    expect(result).not.toBeNull()
    expect(result!.label).toBe('Development')
    expect(result!.icon).toBe('Code')
  })

  it('is case-insensitive', () => {
    expect(findCategory('DEVELOPMENT')).not.toBeNull()
    expect(findCategory('Business')).not.toBeNull()
  })

  it('returns null for unknown slug', () => {
    expect(findCategory('nonexistent')).toBeNull()
  })

  it('returns null for null/undefined', () => {
    expect(findCategory(null)).toBeNull()
    expect(findCategory(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(findCategory('')).toBeNull()
  })
})

describe('categoryLabel', () => {
  it('returns label for known category', () => {
    expect(categoryLabel('personal')).toBe('Personal')
    expect(categoryLabel('sales')).toBe('Sales')
  })

  it('returns slug as fallback for unknown category', () => {
    expect(categoryLabel('custom')).toBe('custom')
  })

  it('returns "Uncategorized" for null/undefined', () => {
    expect(categoryLabel(null)).toBe('Uncategorized')
    expect(categoryLabel(undefined)).toBe('Uncategorized')
  })
})

describe('categoryAccent', () => {
  it('returns accent color for known category', () => {
    const accent = categoryAccent('development')
    expect(accent).toMatch(/^#[0-9a-f]{6}$/i)
    expect(accent).toBe('#06b6d4')
  })

  it('returns default gray for unknown category', () => {
    expect(categoryAccent('unknown')).toBe('#71717a')
  })

  it('returns default gray for null/undefined', () => {
    expect(categoryAccent(null)).toBe('#71717a')
    expect(categoryAccent(undefined)).toBe('#71717a')
  })
})
