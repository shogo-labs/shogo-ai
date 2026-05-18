// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'vitest'
import { resolveChildDescriptors } from '../resolve-children'
import type { ComponentDefinition } from '../types'

function makeComponents(defs: ComponentDefinition[]): Map<string, ComponentDefinition> {
  const map = new Map<string, ComponentDefinition>()
  for (const d of defs) {
    map.set(d.id, d)
  }
  return map
}

describe('resolveChildDescriptors', () => {
  it('returns empty array when no child or children defined', () => {
    const def: ComponentDefinition = { id: 'root', component: 'Column' }
    const result = resolveChildDescriptors(def, new Map(), {})
    expect(result).toEqual([])
  })

  it('resolves a single child reference', () => {
    const parent: ComponentDefinition = { id: 'parent', component: 'Card', child: 'text-1' }
    const child: ComponentDefinition = { id: 'text-1', component: 'Text', text: 'Hello' }
    const components = makeComponents([parent, child])
    const result = resolveChildDescriptors(parent, components, {})
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('single')
    expect((result[0] as any).childId).toBe('text-1')
    expect((result[0] as any).definition).toBe(child)
  })

  it('returns empty when single child reference is missing from map', () => {
    const parent: ComponentDefinition = { id: 'parent', component: 'Card', child: 'missing' }
    const result = resolveChildDescriptors(parent, new Map(), {})
    expect(result).toEqual([])
  })

  it('resolves static children array', () => {
    const parent: ComponentDefinition = {
      id: 'col',
      component: 'Column',
      children: ['text-1', 'badge-1'],
    }
    const text: ComponentDefinition = { id: 'text-1', component: 'Text', text: 'Hi' }
    const badge: ComponentDefinition = { id: 'badge-1', component: 'Badge', text: 'New' }
    const components = makeComponents([parent, text, badge])

    const result = resolveChildDescriptors(parent, components, {})
    expect(result).toHaveLength(2)
    expect(result[0].kind).toBe('static')
    expect((result[0] as any).childId).toBe('text-1')
    expect(result[1].kind).toBe('static')
    expect((result[1] as any).childId).toBe('badge-1')
  })

  it('skips missing children in static array', () => {
    const parent: ComponentDefinition = {
      id: 'col',
      component: 'Column',
      children: ['exists', 'missing'],
    }
    const child: ComponentDefinition = { id: 'exists', component: 'Text', text: 'Hi' }
    const components = makeComponents([parent, child])

    const result = resolveChildDescriptors(parent, components, {})
    expect(result).toHaveLength(1)
    expect((result[0] as any).childId).toBe('exists')
  })

  it('resolves template children from data model', () => {
    const parent: ComponentDefinition = {
      id: 'list',
      component: 'DataList',
      children: { path: '/todos', templateId: 'todo-tmpl' },
    }
    const template: ComponentDefinition = { id: 'todo-tmpl', component: 'Card', title: 'Template' }
    const components = makeComponents([parent, template])
    const dataModel = {
      todos: [
        { title: 'Task 1', done: false },
        { title: 'Task 2', done: true },
      ],
    }

    const result = resolveChildDescriptors(parent, components, dataModel)
    expect(result).toHaveLength(2)
    expect(result[0].kind).toBe('template')
    expect((result[0] as any).index).toBe(0)
    expect((result[0] as any).scopeData).toEqual({ title: 'Task 1', done: false })
    expect((result[0] as any).scopePath).toBe('/todos/0')
    expect(result[1].kind).toBe('template')
    expect((result[1] as any).index).toBe(1)
    expect((result[1] as any).scopeData).toEqual({ title: 'Task 2', done: true })
    expect((result[1] as any).scopePath).toBe('/todos/1')
  })

  it('returns empty when template data is not an array', () => {
    const parent: ComponentDefinition = {
      id: 'list',
      component: 'DataList',
      children: { path: '/notArray', templateId: 'tmpl' },
    }
    const template: ComponentDefinition = { id: 'tmpl', component: 'Text', text: 'x' }
    const components = makeComponents([parent, template])
    const dataModel = { notArray: 'string-value' }

    const result = resolveChildDescriptors(parent, components, dataModel)
    expect(result).toEqual([])
  })

  it('returns empty when template id is not found', () => {
    const parent: ComponentDefinition = {
      id: 'list',
      component: 'DataList',
      children: { path: '/items', templateId: 'missing-tmpl' },
    }
    const components = makeComponents([parent])
    const dataModel = { items: [1, 2, 3] }

    const result = resolveChildDescriptors(parent, components, dataModel)
    expect(result).toEqual([])
  })

  it('wraps primitive items in { value: item } for template scope', () => {
    const parent: ComponentDefinition = {
      id: 'list',
      component: 'DataList',
      children: { path: '/tags', templateId: 'tag-tmpl' },
    }
    const template: ComponentDefinition = { id: 'tag-tmpl', component: 'Badge', text: 'x' }
    const components = makeComponents([parent, template])
    const dataModel = { tags: ['alpha', 'beta'] }

    const result = resolveChildDescriptors(parent, components, dataModel)
    expect(result).toHaveLength(2)
    expect((result[0] as any).scopeData).toEqual({ value: 'alpha' })
    expect((result[1] as any).scopeData).toEqual({ value: 'beta' })
  })
})
