// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import { generateServerFunctions } from '../server-functions'
import type { PrismaModel, PrismaField } from '../prisma-generator'

const idField = (): PrismaField => ({
  name: 'id',
  kind: 'scalar',
  type: 'String',
  isRequired: true,
  isList: false,
  isId: true,
  isUnique: true,
  hasDefaultValue: true,
})

const scalarField = (name: string, type = 'String'): PrismaField => ({
  name,
  kind: 'scalar',
  type,
  isRequired: true,
  isList: false,
  isId: false,
  isUnique: false,
  hasDefaultValue: false,
})

describe('generateServerFunctions', () => {
  test('emits a skip comment for models missing an @id field', () => {
    const model: PrismaModel = {
      name: 'NoIdModel',
      fields: [scalarField('name')],
    }
    const out = generateServerFunctions([model])
    expect(out).toContain('// Skipped NoIdModel - no @id field found')
    // No CRUD functions should be emitted for the skipped model.
    expect(out).not.toContain('listNoIdModel')
  })

  test('pluralises route paths for names ending in s/x/ch/sh (e.g. Box → boxes)', () => {
    const model: PrismaModel = {
      name: 'Box',
      fields: [idField(), scalarField('label')],
    }
    const out = generateServerFunctions([model])
    // toRoutePath('Box') should yield 'boxes' → fetch URL contains /api/boxes
    expect(out).toContain('/api/boxes')
  })

  test('emits full CRUD scaffolding for a normal model', () => {
    const model: PrismaModel = {
      name: 'User',
      fields: [idField(), scalarField('email')],
    }
    const out = generateServerFunctions([model])
    expect(out).toContain('// User Client Functions')
    expect(out).toContain('/api/users')
  })
})
