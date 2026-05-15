// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'vitest'
import { getByPointer, setByPointer } from '../pointer'

describe('getByPointer', () => {
  it('returns undefined for empty pointer', () => {
    expect(getByPointer({ a: 1 }, '')).toEqual({ a: 1 })
  })

  it('returns the root object for "/" pointer', () => {
    expect(getByPointer({ a: 1 }, '/')).toEqual({ a: 1 })
  })

  it('resolves a simple top-level key', () => {
    expect(getByPointer({ name: 'hello' }, '/name')).toBe('hello')
  })

  it('resolves nested keys', () => {
    const obj = { user: { profile: { age: 30 } } }
    expect(getByPointer(obj, '/user/profile/age')).toBe(30)
  })

  it('resolves array indices', () => {
    const obj = { items: ['a', 'b', 'c'] }
    expect(getByPointer(obj, '/items/1')).toBe('b')
  })

  it('returns undefined for missing paths', () => {
    expect(getByPointer({ a: 1 }, '/b')).toBeUndefined()
  })

  it('returns undefined for deeply missing paths', () => {
    expect(getByPointer({ a: { b: 1 } }, '/a/c/d')).toBeUndefined()
  })

  it('handles RFC 6901 escaped characters (~0 for ~ and ~1 for /)', () => {
    const obj = { 'a/b': { '~c': 'found' } }
    expect(getByPointer(obj, '/a~1b/~0c')).toBe('found')
  })

  it('returns undefined when traversing through null', () => {
    const obj = { a: null } as any
    expect(getByPointer(obj, '/a/b')).toBeUndefined()
  })

  it('resolves to a nested object', () => {
    const obj = { data: { list: [1, 2, 3] } }
    expect(getByPointer(obj, '/data/list')).toEqual([1, 2, 3])
  })
})

describe('setByPointer', () => {
  it('sets a top-level key', () => {
    const obj: Record<string, unknown> = {}
    setByPointer(obj, '/name', 'hello')
    expect(obj.name).toBe('hello')
  })

  it('sets a nested key, creating intermediate objects', () => {
    const obj: Record<string, unknown> = {}
    setByPointer(obj, '/a/b/c', 42)
    expect((obj as any).a.b.c).toBe(42)
  })

  it('creates arrays when next segment is numeric', () => {
    const obj: Record<string, unknown> = {}
    setByPointer(obj, '/items/0', 'first')
    expect(Array.isArray((obj as any).items)).toBe(true)
    expect((obj as any).items[0]).toBe('first')
  })

  it('overwrites existing values', () => {
    const obj: Record<string, unknown> = { x: 'old' }
    setByPointer(obj, '/x', 'new')
    expect(obj.x).toBe('new')
  })

  it('does nothing for empty pointer', () => {
    const obj: Record<string, unknown> = { a: 1 }
    setByPointer(obj, '', 'ignored')
    expect(obj).toEqual({ a: 1 })
  })

  it('does nothing for "/" pointer', () => {
    const obj: Record<string, unknown> = { a: 1 }
    setByPointer(obj, '/', 'ignored')
    expect(obj).toEqual({ a: 1 })
  })

  it('handles escaped characters', () => {
    const obj: Record<string, unknown> = {}
    setByPointer(obj, '/a~1b', 'value')
    expect(obj['a/b']).toBe('value')
  })

  it('handles setting into existing nested objects', () => {
    const obj: Record<string, unknown> = { user: { name: 'Alice' } }
    setByPointer(obj, '/user/age', 25)
    expect((obj as any).user.name).toBe('Alice')
    expect((obj as any).user.age).toBe(25)
  })
})
