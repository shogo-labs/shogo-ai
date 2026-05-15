// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'vitest'
import {
  COMPONENT_SCHEMA,
  COMPONENT_CATEGORIES,
  getComponentSchema,
  getComponentsByCategory,
} from '../component-schema'

describe('COMPONENT_SCHEMA', () => {
  it('is a non-empty array', () => {
    expect(COMPONENT_SCHEMA.length).toBeGreaterThan(0)
  })

  it('every schema has required fields', () => {
    for (const s of COMPONENT_SCHEMA) {
      expect(typeof s.type).toBe('string')
      expect(s.type.length).toBeGreaterThan(0)
      expect(COMPONENT_CATEGORIES).toContain(s.category)
      expect(typeof s.description).toBe('string')
      expect(typeof s.hasChildren).toBe('boolean')
      expect(typeof s.props).toBe('object')
    }
  })

  it('has unique type names', () => {
    const types = COMPONENT_SCHEMA.map((s) => s.type)
    expect(new Set(types).size).toBe(types.length)
  })

  it('includes core component types', () => {
    const types = COMPONENT_SCHEMA.map((s) => s.type)
    expect(types).toContain('Row')
    expect(types).toContain('Column')
    expect(types).toContain('Text')
    expect(types).toContain('Button')
    expect(types).toContain('Table')
    expect(types).toContain('Card')
  })
})

describe('COMPONENT_CATEGORIES', () => {
  it('contains all expected categories', () => {
    expect(COMPONENT_CATEGORIES).toContain('layout')
    expect(COMPONENT_CATEGORIES).toContain('extended')
    expect(COMPONENT_CATEGORIES).toContain('display')
    expect(COMPONENT_CATEGORIES).toContain('data')
    expect(COMPONENT_CATEGORIES).toContain('interactive')
  })

  it('has exactly 5 categories', () => {
    expect(COMPONENT_CATEGORIES).toHaveLength(5)
  })
})

describe('getComponentSchema', () => {
  it('returns schema for a known type', () => {
    const schema = getComponentSchema('Button')
    expect(schema).toBeDefined()
    expect(schema!.type).toBe('Button')
    expect(schema!.category).toBe('interactive')
  })

  it('returns undefined for unknown type', () => {
    expect(getComponentSchema('NonExistent')).toBeUndefined()
  })

  it('returns schema with correct props for Text', () => {
    const schema = getComponentSchema('Text')
    expect(schema).toBeDefined()
    expect(schema!.props).toHaveProperty('text')
    expect(schema!.props.text.required).toBe(true)
  })

  it('returns schema with hasChildren=true for layout components', () => {
    const row = getComponentSchema('Row')
    expect(row!.hasChildren).toBe(true)
  })

  it('returns schema with hasChildren=false for leaf components', () => {
    const badge = getComponentSchema('Badge')
    expect(badge!.hasChildren).toBe(false)
  })
})

describe('getComponentsByCategory', () => {
  it('returns layout components', () => {
    const layouts = getComponentsByCategory('layout')
    expect(layouts.length).toBeGreaterThan(0)
    expect(layouts.every((s) => s.category === 'layout')).toBe(true)
  })

  it('returns interactive components', () => {
    const interactive = getComponentsByCategory('interactive')
    expect(interactive.length).toBeGreaterThan(0)
    expect(interactive.every((s) => s.category === 'interactive')).toBe(true)
    const types = interactive.map((s) => s.type)
    expect(types).toContain('Button')
    expect(types).toContain('TextField')
  })

  it('returns empty array for unknown category', () => {
    expect(getComponentsByCategory('unknown')).toEqual([])
  })

  it('all categories together equal the full schema', () => {
    let total = 0
    for (const cat of COMPONENT_CATEGORIES) {
      total += getComponentsByCategory(cat).length
    }
    expect(total).toBe(COMPONENT_SCHEMA.length)
  })
})
