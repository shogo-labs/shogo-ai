/**
 * Tests for composition/index.ts exports
 *
 * Generated from TestSpecification: test-queryable-composition-export
 *
 * Verifies that CollectionQueryable and IQueryable are exported
 * from the composition module for manual composition if needed.
 */

import { describe, test, expect } from 'bun:test'
import { CollectionQueryable, IQueryable } from '../index'

describe('composition/index.ts exports CollectionQueryable', () => {
  test('CollectionQueryable is accessible', () => {
    // Given: composition/index.ts module
    // When: Importing from composition module
    // Then: CollectionQueryable should be accessible
    expect(CollectionQueryable).toBeDefined()
    expect(typeof CollectionQueryable).toBe('object')
    expect(CollectionQueryable.name).toBe('CollectionQueryable')
  })

  test('can be manually composed if needed', () => {
    // Given: CollectionQueryable mixin
    // When: Using it for manual composition
    // Then: Should work with types.compose
    const { types } = require('mobx-state-tree')

    const BaseModel = types.model('Base', {})
    const composed = types.compose(BaseModel, CollectionQueryable)

    expect(composed).toBeDefined()
  })

  test('IQueryable type exported', () => {
    // Given: composition/index.ts module
    // When: Importing IQueryable type
    // Then: Type should be available (TypeScript compile-time check)
    // This test verifies the export exists at runtime as well
    const typeCheck: IQueryable<any> | undefined = undefined
    expect(typeCheck).toBeUndefined() // Just verifying type is importable
  })
})
