// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * stores-generator.ts — coverage tests.
 *
 *   bun test packages/sdk/src/generators/__tests__/stores-generator.test.ts
 */

import { describe, test, expect } from 'bun:test'
import {
  generateModelStore,
  generateStores,
  generateStoresIndex,
} from '../stores-generator'
import type { PrismaModel } from '../prisma-generator'

const projectModel: PrismaModel = {
  name: 'Project',
  dbName: null,
  fields: [
    { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: true, hasDefaultValue: true },
    { name: 'name', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
  ],
}

// Names ending in 's' / 'x' / 'ch' / 'sh' exercise the `+es` pluralization arm
// of toRoutePath (line 52). A name ending in 'y' is handled implicitly by other
// generators in the suite.
const addressModel: PrismaModel = {
  name: 'Address',
  dbName: null,
  fields: [
    { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: true, hasDefaultValue: true },
    { name: 'street', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
  ],
}

// Model with no @id field — exercises the early null-return on line 70.
const idlessModel: PrismaModel = {
  name: 'Tag',
  dbName: null,
  fields: [
    { name: 'label', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
  ],
}

describe('generateModelStore', () => {
  test('returns a store file for a model with an @id', () => {
    const file = generateModelStore(projectModel)
    expect(file).not.toBeNull()
    expect(file!.modelName).toBe('Project')
    expect(file!.fileName).toBe('project.store.tsx')
    expect(file!.code).toContain('getProjectStore')
  })

  test('returns null for a model without an @id', () => {
    expect(generateModelStore(idlessModel)).toBeNull()
  })

  test('respects basePath + fileExtension config', () => {
    const file = generateModelStore(projectModel, { basePath: '/v2', fileExtension: 'ts' })
    expect(file!.fileName.endsWith('.ts')).toBe(true)
    expect(file!.code).toContain('/v2/projects')
  })

  test('pluralizes route path for names ending in s/x/ch/sh (toRoutePath +es arm)', () => {
    const file = generateModelStore(addressModel)
    expect(file!.code).toContain('/api/addresses')
  })
})

describe('generateStores', () => {
  test('emits a file per model with an @id and skips idless models', () => {
    const out = generateStores([projectModel, idlessModel, addressModel])
    expect(out.map((f) => f.modelName).sort()).toEqual(['Address', 'Project'])
  })

  test('returns an empty array when all models are idless', () => {
    expect(generateStores([idlessModel])).toEqual([])
  })
})

describe('generateStoresIndex', () => {
  test('returns an index string that re-exports each store', () => {
    const code = generateStoresIndex([projectModel, addressModel])
    expect(typeof code).toBe('string')
    expect(code).toContain('project.store')
    expect(code).toContain('address.store')
  })
})
