// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'vitest'
import { resolveValue, resolveComponentProps, sanitizeForRender, RESERVED_KEYS } from '../resolve-props'
import type { ApiDataSourceLike } from '../resolve-props'
import type { ComponentDefinition } from '../types'

describe('RESERVED_KEYS', () => {
  it('contains id, component, child, children', () => {
    expect(RESERVED_KEYS.has('id')).toBe(true)
    expect(RESERVED_KEYS.has('component')).toBe(true)
    expect(RESERVED_KEYS.has('child')).toBe(true)
    expect(RESERVED_KEYS.has('children')).toBe(true)
  })
})

describe('resolveValue', () => {
  const dataModel = {
    user: { name: 'Alice', age: 30 },
    items: ['a', 'b', 'c'],
  }

  it('returns primitive values unchanged', () => {
    expect(resolveValue('hello', dataModel)).toBe('hello')
    expect(resolveValue(42, dataModel)).toBe(42)
    expect(resolveValue(true, dataModel)).toBe(true)
    expect(resolveValue(null, dataModel)).toBeNull()
    expect(resolveValue(undefined, dataModel)).toBeUndefined()
  })

  it('resolves dynamic path bindings from data model', () => {
    expect(resolveValue({ path: '/user/name' }, dataModel)).toBe('Alice')
    expect(resolveValue({ path: '/items/0' }, dataModel)).toBe('a')
  })

  it('resolves path against scope data for relative paths', () => {
    const scopeData = { title: 'Task 1' }
    expect(resolveValue({ path: 'title' }, dataModel, null, scopeData)).toBe('Task 1')
  })

  it('resolves api bindings using apiDataSource', () => {
    const apiSource: ApiDataSourceLike = {
      getData: (api: string) => `data-from-${api}`,
    }
    expect(resolveValue({ api: 'users' }, dataModel, apiSource)).toBe('data-from-users')
  })

  it('resolves arrays recursively', () => {
    const val = [{ path: '/user/name' }, 'static', { path: '/user/age' }]
    expect(resolveValue(val, dataModel)).toEqual(['Alice', 'static', 30])
  })

  it('resolves plain objects recursively', () => {
    const val = { label: { path: '/user/name' }, count: 5 }
    expect(resolveValue(val, dataModel)).toEqual({ label: 'Alice', count: 5 })
  })

  it('resolves action objects with context', () => {
    const action = {
      name: 'submit',
      context: { userName: { path: '/user/name' } },
    }
    const result = resolveValue(action, dataModel) as any
    expect(result.name).toBe('submit')
    expect(result.context.userName).toBe('Alice')
  })

  it('resolves action with sendToAgent flag', () => {
    const action = {
      name: 'ask',
      sendToAgent: true,
      context: { q: 'hello' },
    }
    const result = resolveValue(action, dataModel) as any
    expect(result.context._sendToAgent).toBe(true)
  })

  it('resolves action with mutation', () => {
    const action = {
      name: 'delete',
      mutation: { endpoint: '/api/items/:id', method: 'DELETE', params: { id: { path: '/user/name' } } },
      context: {},
    }
    const result = resolveValue(action, dataModel) as any
    expect(result.context._mutation.endpoint).toBe('/api/items/Alice')
    expect(result.context._mutation.method).toBe('DELETE')
  })
})

describe('sanitizeForRender', () => {
  it('converts objects in text-render props to JSON strings', () => {
    const resolved = { text: { nested: true }, label: 'ok', value: { x: 1 } }
    const result = sanitizeForRender({ ...resolved })
    expect(result.text).toBe('{"nested":true}')
    expect(result.label).toBe('ok')
    expect(result.value).toBe('{"x":1}')
  })

  it('leaves strings untouched', () => {
    const resolved = { text: 'hello', title: 'world' }
    const result = sanitizeForRender({ ...resolved })
    expect(result.text).toBe('hello')
    expect(result.title).toBe('world')
  })

  it('leaves arrays untouched in text props', () => {
    const resolved = { text: [1, 2, 3] }
    const result = sanitizeForRender({ ...resolved })
    expect(result.text).toEqual([1, 2, 3])
  })

  it('leaves null and undefined untouched', () => {
    const resolved = { text: null, title: undefined }
    const result = sanitizeForRender({ ...resolved })
    expect(result.text).toBeNull()
    expect(result.title).toBeUndefined()
  })

  it('does not touch non-text-render props', () => {
    const resolved = { onClick: { name: 'click' }, rows: [{ a: 1 }] }
    const result = sanitizeForRender({ ...resolved })
    expect(result.onClick).toEqual({ name: 'click' })
    expect(result.rows).toEqual([{ a: 1 }])
  })
})

describe('resolveComponentProps', () => {
  const dataModel = { title: 'Hello', count: 5 }

  it('resolves props from a component definition', () => {
    const def: ComponentDefinition = {
      id: 'text-1',
      component: 'Text',
      text: { path: '/title' },
    }
    const result = resolveComponentProps(def, dataModel)
    expect(result.text).toBe('Hello')
  })

  it('skips reserved keys (id, component, child, children)', () => {
    const def: ComponentDefinition = {
      id: 'card-1',
      component: 'Card',
      child: 'text-1',
      title: 'My Card',
    }
    const result = resolveComponentProps(def, dataModel)
    expect(result).not.toHaveProperty('id')
    expect(result).not.toHaveProperty('component')
    expect(result).not.toHaveProperty('child')
    expect(result.title).toBe('My Card')
  })

  it('sanitizes object values in text-render props', () => {
    const def: ComponentDefinition = {
      id: 'badge-1',
      component: 'Badge',
      text: { path: '/count' },
      label: { nested: true } as any,
    }
    const result = resolveComponentProps(def, dataModel)
    expect(result.text).toBe(5)
    expect(result.label).toBe('{"nested":true}')
  })

  it('uses apiDataSource when provided', () => {
    const apiSource: ApiDataSourceLike = {
      getData: () => [{ id: 1 }, { id: 2 }],
    }
    const def: ComponentDefinition = {
      id: 'table-1',
      component: 'Table',
      rows: { api: 'items' },
    }
    const result = resolveComponentProps(def, dataModel, apiSource)
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }])
  })
})
