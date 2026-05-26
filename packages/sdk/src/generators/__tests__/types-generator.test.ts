// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import {
  generateTypes,
  generateModelTypes,
  generateTypesPerModel,
  generateTypesIndex,
} from '../types-generator'
import type { PrismaModel } from '../prisma-generator'

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeModel(name: string, extras: Partial<PrismaModel> = {}): PrismaModel {
  return {
    name,
    fields: [],
    uniqueFields: [],
    primaryKey: null,
    ...extras,
  } as unknown as PrismaModel
}

const USER_MODEL: PrismaModel = {
  name: 'User',
  fields: [
    { name: 'id', type: 'String', kind: 'scalar', isId: true, isRequired: true, hasDefaultValue: true, isList: false, isUnique: false, isReadOnly: false, default: { name: 'cuid' } },
    { name: 'email', type: 'String', kind: 'scalar', isId: false, isRequired: true, hasDefaultValue: false, isList: false, isUnique: true, isReadOnly: false },
    { name: 'name', type: 'String', kind: 'scalar', isId: false, isRequired: false, hasDefaultValue: false, isList: false, isUnique: false, isReadOnly: false },
    { name: 'createdAt', type: 'DateTime', kind: 'scalar', isId: false, isRequired: true, hasDefaultValue: true, isList: false, isUnique: false, isReadOnly: false },
    { name: 'updatedAt', type: 'DateTime', kind: 'scalar', isId: false, isRequired: true, hasDefaultValue: true, isList: false, isUnique: false, isReadOnly: false },
    { name: 'posts', type: 'Post', kind: 'object', isId: false, isRequired: false, hasDefaultValue: false, isList: true, isUnique: false, isReadOnly: false },
  ],
  uniqueFields: [],
  primaryKey: null,
} as unknown as PrismaModel

const POST_MODEL: PrismaModel = {
  name: 'Post',
  fields: [
    { name: 'id', type: 'Int', kind: 'scalar', isId: true, isRequired: true, hasDefaultValue: true, isList: false, isUnique: false, isReadOnly: false },
    { name: 'title', type: 'String', kind: 'scalar', isId: false, isRequired: true, hasDefaultValue: false, isList: false, isUnique: false, isReadOnly: false },
    { name: 'score', type: 'Float', kind: 'scalar', isId: false, isRequired: false, hasDefaultValue: false, isList: false, isUnique: false, isReadOnly: false },
    { name: 'views', type: 'Decimal', kind: 'scalar', isId: false, isRequired: false, hasDefaultValue: false, isList: false, isUnique: false, isReadOnly: false },
    { name: 'active', type: 'Boolean', kind: 'scalar', isId: false, isRequired: true, hasDefaultValue: false, isList: false, isUnique: false, isReadOnly: false },
    { name: 'meta', type: 'Json', kind: 'scalar', isId: false, isRequired: false, hasDefaultValue: false, isList: false, isUnique: false, isReadOnly: false },
    { name: 'big', type: 'BigInt', kind: 'scalar', isId: false, isRequired: false, hasDefaultValue: false, isList: false, isUnique: false, isReadOnly: false },
    { name: 'data', type: 'Bytes', kind: 'scalar', isId: false, isRequired: false, hasDefaultValue: false, isList: false, isUnique: false, isReadOnly: false },
    { name: 'weird', type: 'Unsupported', kind: 'scalar', isId: false, isRequired: false, hasDefaultValue: false, isList: false, isUnique: false, isReadOnly: false },
    { name: 'status', type: 'PostStatus', kind: 'enum', isId: false, isRequired: true, hasDefaultValue: false, isList: false, isUnique: false, isReadOnly: false },
    { name: 'author', type: 'User', kind: 'object', isId: false, isRequired: false, hasDefaultValue: false, isList: false, isUnique: false, isReadOnly: false },
  ],
  uniqueFields: [],
  primaryKey: null,
} as unknown as PrismaModel

const STATUS_ENUM = { name: 'PostStatus', values: [{ name: 'DRAFT' }, { name: 'PUBLISHED' }] }

// ─── generateTypes ──────────────────────────────────────────────────────────

describe('generateTypes', () => {
  it('generates a header + enum + model + input + hook sections', () => {
    const out = generateTypes([USER_MODEL], [STATUS_ENUM])
    expect(out).toContain("export type PostStatus = 'DRAFT' | 'PUBLISHED'")
    expect(out).toContain('export interface UserType {')
    expect(out).toContain('export interface UserCreateInput {')
    expect(out).toContain('export interface UserUpdateInput {')
    expect(out).toContain('export interface HookContext {')
    expect(out).toContain('export interface ServerFunctionHooks {')
    expect(out).toContain('User?: ModelHooks<')
  })

  it('skips enum section when no enums provided', () => {
    const out = generateTypes([USER_MODEL], [])
    expect(out).not.toContain("export type Post")
    expect(out).toContain('// Model Types')
  })

  it('maps all Prisma scalar types correctly', () => {
    const out = generateTypes([POST_MODEL], [STATUS_ENUM])
    expect(out).toContain('id: number')
    expect(out).toContain('title: string')
    expect(out).toContain('score?: number')
    expect(out).toContain('active: boolean')
    expect(out).toContain("meta?: Record<string, unknown>")
    expect(out).toContain('big?: bigint')
    expect(out).toContain('data?: Buffer')
    expect(out).toContain('weird?: unknown')
  })

  it('resolveModelTypeName avoids collision with same-named enum (UserType enum)', () => {
    const clashEnum = { name: 'UserType', values: [{ name: 'ADMIN' }] }
    const out = generateTypes([USER_MODEL], [clashEnum])
    // When 'UserType' enum exists, model falls back to plain 'User'
    expect(out).toContain('export interface User {')
    expect(out).not.toContain('export interface UserType {')
  })
})

// ─── generateModelTypes ─────────────────────────────────────────────────────

describe('generateModelTypes', () => {
  it('returns modelName, fileName, and code', () => {
    const result = generateModelTypes(USER_MODEL, [])
    expect(result.modelName).toBe('User')
    expect(result.fileName).toBe('user.types.tsx')
    expect(result.code).toContain('export interface UserType {')
  })

  it('respects fileExtension ts', () => {
    const result = generateModelTypes(USER_MODEL, [], 'ts')
    expect(result.fileName).toBe('user.types.ts')
  })

  it('emits relevant enums used by the model', () => {
    const result = generateModelTypes(POST_MODEL, [STATUS_ENUM])
    expect(result.code).toContain("export type PostStatus = 'DRAFT' | 'PUBLISHED'")
  })

  it('skips enums not used by the model', () => {
    const otherEnum = { name: 'OtherEnum', values: [{ name: 'X' }] }
    const result = generateModelTypes(USER_MODEL, [otherEnum])
    expect(result.code).not.toContain('OtherEnum')
  })

  it('toFileName converts PascalCase to kebab-case', () => {
    const model = makeModel('UserProfile')
    const result = generateModelTypes(model as any)
    expect(result.fileName).toBe('user-profile.types.tsx')
  })

  it('handles model with no relevant enums', () => {
    const result = generateModelTypes(USER_MODEL, [STATUS_ENUM])
    // PostStatus enum is not used by USER_MODEL so should not be emitted
    expect(result.code).not.toContain("export type PostStatus")
  })
})

// ─── generateTypesPerModel ───────────────────────────────────────────────────

describe('generateTypesPerModel', () => {
  it('returns one GeneratedTypeFile per model', () => {
    const results = generateTypesPerModel([USER_MODEL, POST_MODEL], [STATUS_ENUM])
    expect(results).toHaveLength(2)
    expect(results[0]!.modelName).toBe('User')
    expect(results[1]!.modelName).toBe('Post')
  })

  it('passes enums and fileExtension through to each model', () => {
    const results = generateTypesPerModel([POST_MODEL], [STATUS_ENUM], 'ts')
    expect(results[0]!.fileName).toBe('post.types.ts')
    expect(results[0]!.code).toContain("export type PostStatus")
  })

  it('defaults fileExtension to tsx when not provided', () => {
    const results = generateTypesPerModel([USER_MODEL])
    expect(results[0]!.fileName).toContain('.tsx')
  })
})

// ─── generateTypesIndex ──────────────────────────────────────────────────────

describe('generateTypesIndex', () => {
  it('generates re-export lines for each model', () => {
    const out = generateTypesIndex([USER_MODEL, POST_MODEL])
    expect(out).toContain('export * from "./user.types"')
    expect(out).toContain('export * from "./post.types"')
  })

  it('returns empty re-exports for an empty model list', () => {
    const out = generateTypesIndex([])
    expect(out).toContain('// Re-export all types')
    expect(out).not.toContain('export * from')
  })
})

// Line 122: mapPrismaType object+isList branch (defensive dead code in callers)
describe('_mapPrismaTypeForTests — object isList branch', () => {
  it('returns Type[] for list object field', async () => {
    const { _mapPrismaTypeForTests } = await import('../types-generator')
    const field = { kind: 'object', type: 'Post', isList: true, isRequired: false, isId: false, hasDefaultValue: false, name: 'posts', isUnique: false, isReadOnly: false } as any
    expect(_mapPrismaTypeForTests(field)).toBe('PostType[]')
  })

  it('returns Type for non-list object field', async () => {
    const { _mapPrismaTypeForTests } = await import('../types-generator')
    const field = { kind: 'object', type: 'User', isList: false, isRequired: false, isId: false, hasDefaultValue: false, name: 'author', isUnique: false, isReadOnly: false } as any
    expect(_mapPrismaTypeForTests(field)).toBe('UserType')
  })
})
