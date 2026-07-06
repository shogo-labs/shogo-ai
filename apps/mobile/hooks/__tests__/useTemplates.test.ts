// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, test, expect } from 'bun:test'
import { renderHook } from '@testing-library/react'

import { useTemplates, type CanvasTemplate } from '../useTemplates'

describe('useTemplates', () => {
  test('returns a non-empty array of templates', () => {
    const { result } = renderHook(() => useTemplates())
    expect(result.current.templates.length).toBeGreaterThan(0)
  })

  test('isLoading is always false (templates are static)', () => {
    const { result } = renderHook(() => useTemplates())
    expect(result.current.isLoading).toBe(false)
  })

  test('every template has required fields', () => {
    const { result } = renderHook(() => useTemplates())
    for (const t of result.current.templates) {
      expect(typeof t.id).toBe('string')
      expect(t.id.length).toBeGreaterThan(0)
      expect(typeof t.user_request).toBe('string')
      expect(t.user_request.length).toBeGreaterThan(0)
      expect(typeof t.needs_api_schema).toBe('boolean')
      expect(Array.isArray(t.component_types)).toBe(true)
      expect(t.component_types.length).toBeGreaterThan(0)
      expect(typeof t.component_count).toBe('number')
      expect(t.component_count).toBeGreaterThan(0)
    }
  })

  test('template ids are unique', () => {
    const { result } = renderHook(() => useTemplates())
    const ids = result.current.templates.map((t: CanvasTemplate) => t.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })

  test('returns stable reference across re-renders', () => {
    const { result, rerender } = renderHook(() => useTemplates())
    const first = result.current.templates
    rerender({})
    expect(result.current.templates).toBe(first)
  })

  test('includes known template ids', () => {
    const { result } = renderHook(() => useTemplates())
    const ids = result.current.templates.map((t: CanvasTemplate) => t.id)
    expect(ids).toContain('analytics-dashboard')
    expect(ids).toContain('task-tracker-crud')
    expect(ids).toContain('crm-pipeline')
  })

  test('CRUD templates require api schema', () => {
    const { result } = renderHook(() => useTemplates())
    const crudTemplates = result.current.templates.filter(
      (t: CanvasTemplate) => t.id.includes('crud'),
    )
    expect(crudTemplates.length).toBeGreaterThan(0)
    for (const t of crudTemplates) {
      expect(t.needs_api_schema).toBe(true)
    }
  })
})
