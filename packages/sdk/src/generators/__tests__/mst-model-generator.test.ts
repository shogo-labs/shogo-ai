// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

// Tests `generateMSTModel` / `generateMSTModels` purely against the emitted
// TypeScript source. Does NOT import `mobx-state-tree` (which isn't installed
// in this workspace), so this file is independent of the existing
// mst-generator.test.ts that fails on the missing dependency.

import { describe, it, expect } from 'bun:test'
import { generateMSTModel, generateMSTModels, type PrismaEnum } from '../mst-model-generator'
import type { PrismaModel, PrismaField } from '../prisma-generator'

function field(over: Partial<PrismaField>): PrismaField {
  return {
    name: 'f',
    kind: 'scalar',
    type: 'String',
    isRequired: true,
    isList: false,
    isId: false,
    isUnique: false,
    hasDefaultValue: false,
    ...over,
  }
}

function model(name: string, fields: PrismaField[]): PrismaModel {
  return { name, fields }
}

describe('generateMSTModel — header, naming, type exports', () => {
  it('emits filename in kebab-case with the requested extension (default tsx)', () => {
    const out = generateMSTModel(
      model('UserAccount', [field({ name: 'id', type: 'String', isId: true })]),
      [],
      [],
    )
    expect(out.modelName).toBe('UserAccount')
    expect(out.fileName).toBe('user-account.model.tsx')
    expect(out.code).toContain('export const UserAccountModel = types')
    expect(out.code).toContain('Auto-generated UserAccount MST Model')
    expect(out.code).toContain('export interface IUserAccount extends Instance<typeof UserAccountModel> {}')
    expect(out.code).toContain('SnapshotIn<typeof UserAccountModel>')
    expect(out.code).toContain('SnapshotOut<typeof UserAccountModel>')
  })

  it('emits .ts extension when requested explicitly', () => {
    const out = generateMSTModel(
      model('Workspace', [field({ name: 'id', type: 'String', isId: true })]),
      [],
      [],
      undefined,
      'ts',
    )
    expect(out.fileName).toBe('workspace.model.ts')
  })
})

describe('generateMSTModel — scalar type mapping', () => {
  const allScalars: Array<{ type: string; expect: string }> = [
    { type: 'String', expect: 'types.string' },
    { type: 'Int', expect: 'types.number' },
    { type: 'Float', expect: 'types.number' },
    { type: 'Decimal', expect: 'types.number' },
    { type: 'Boolean', expect: 'types.boolean' },
    { type: 'DateTime', expect: 'types.number' },
    { type: 'Json', expect: 'types.frozen()' },
    { type: 'BigInt', expect: 'types.string' },
    { type: 'Bytes', expect: 'types.string' },
    { type: 'UnknownExoticType', expect: 'types.frozen()' }, // default branch
  ]

  for (const { type, expect: expected } of allScalars) {
    it(`maps Prisma ${type} → ${expected}`, () => {
      const out = generateMSTModel(
        model('M', [
          field({ name: 'id', type: 'String', isId: true }),
          field({ name: 'v', type, isRequired: true }),
        ]),
        [],
        [],
      )
      // For required, non-id, non-default fields the wrapper is identity.
      expect(out.code).toContain(`v: ${expected},`)
    })
  }

  it('wraps optional (non-required, non-id, no-default) scalars in types.optional with a zero', () => {
    const out = generateMSTModel(
      model('M', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'name', type: 'String', isRequired: false }),
        field({ name: 'age', type: 'Int', isRequired: false }),
        field({ name: 'active', type: 'Boolean', isRequired: false }),
        field({ name: 'createdAt', type: 'DateTime', isRequired: false }),
        field({ name: 'meta', type: 'Json', isRequired: false }),
      ]),
      [],
      [],
    )
    expect(out.code).toContain('name: types.optional(types.string, ""),')
    expect(out.code).toContain('age: types.optional(types.number, 0),')
    expect(out.code).toContain('active: types.optional(types.boolean, false),')
    expect(out.code).toContain('createdAt: types.optional(types.number, 0),')
    expect(out.code).toContain('meta: types.optional(types.frozen(), {}),')
  })

  it('emits types.identifier for the @id field via wrapOptional', () => {
    const out = generateMSTModel(
      model('M', [field({ name: 'id', type: 'String', isId: true })]),
      [],
      [],
    )
    expect(out.code).toContain('id: types.identifier,')
  })

  it('emits types.array for list scalar fields', () => {
    const out = generateMSTModel(
      model('M', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'tags', type: 'String', isList: true, isRequired: true }),
      ]),
      [],
      [],
    )
    expect(out.code).toContain('tags: types.optional(types.array(types.string), []),')
  })

  it('uses literal default from DMMF (string)', () => {
    const out = generateMSTModel(
      model('M', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'provider', type: 'String', isRequired: true, hasDefaultValue: true, default: 's3' }),
      ]),
      [],
      [],
    )
    expect(out.code).toContain('provider: types.optional(types.string, "s3"),')
  })

  it('uses literal default from DMMF (number)', () => {
    const out = generateMSTModel(
      model('M', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'count', type: 'Int', isRequired: true, hasDefaultValue: true, default: 42 }),
      ]),
      [],
      [],
    )
    expect(out.code).toContain('count: types.optional(types.number, 42),')
  })

  it('uses literal default from DMMF (boolean)', () => {
    const out = generateMSTModel(
      model('M', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'enabled', type: 'Boolean', isRequired: true, hasDefaultValue: true, default: true }),
      ]),
      [],
      [],
    )
    expect(out.code).toContain('enabled: types.optional(types.boolean, true),')
  })

  it('falls back to "undefined" for an unknown scalar type on the hasDefaultValue path (default switch arm)', () => {
    const out = generateMSTModel(
      model('M', [
        field({ name: 'id', type: 'String', isId: true }),
        // type='Bytes' is one of the cases; pick a type not in the switch and not an enum
        field({ name: 'weird', type: 'Geography', isRequired: true, hasDefaultValue: true, default: { name: 'computed' } as any }),
      ]),
      [],
      [],
    )
    // baseType maps to 'types.frozen()' for unknown scalars; default arm in getDefaultValue returns 'undefined'.
    expect(out.code).toContain('weird: types.optional(types.frozen(), undefined),')
  })


  it('falls back to type-zero when default is a DMMF function object (uuid/now/cuid)', () => {
    const out = generateMSTModel(
      model('M', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'created', type: 'DateTime', isRequired: true, hasDefaultValue: true, default: { name: 'now' } as any }),
        field({ name: 'rid', type: 'String', isRequired: true, hasDefaultValue: true, default: { name: 'uuid', args: [4] } as any }),
      ]),
      [],
      [],
    )
    expect(out.code).toContain('created: types.optional(types.number, 0),')
    expect(out.code).toContain('rid: types.optional(types.string, ""),')
  })
})

describe('generateMSTModel — enums', () => {
  const enums: PrismaEnum[] = [
    { name: 'StorageProvider', values: [{ name: 's3' }, { name: 'gcs' }, { name: 'local' }] },
    { name: 'EmptyEnum', values: [] },
  ]

  it('emits types.enumeration with values for an enum scalar', () => {
    const out = generateMSTModel(
      model('M', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'provider', type: 'StorageProvider', kind: 'enum', isRequired: true }),
      ]),
      [],
      enums,
    )
    expect(out.code).toContain(
      'provider: types.enumeration("StorageProvider", ["s3", "gcs", "local"]),',
    )
  })

  it('emits types.string fallback when enum def has zero values', () => {
    const out = generateMSTModel(
      model('M', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'flag', type: 'EmptyEnum', kind: 'enum', isRequired: true }),
      ]),
      [],
      enums,
    )
    expect(out.code).toContain('flag: types.string,')
  })

  it('emits types.string fallback when enum def is missing entirely', () => {
    const out = generateMSTModel(
      model('M', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'flag', type: 'UnknownEnum', kind: 'enum', isRequired: true }),
      ]),
      [],
      enums,
    )
    expect(out.code).toContain('flag: types.string,')
  })

  it('wraps enum arrays in types.array', () => {
    const out = generateMSTModel(
      model('M', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'providers', type: 'StorageProvider', kind: 'enum', isList: true, isRequired: true }),
      ]),
      [],
      enums,
    )
    expect(out.code).toContain('providers: types.optional(types.array(types.enumeration("StorageProvider", ["s3", "gcs", "local"])), []),')
  })

  it('uses types.maybeNull for non-required enum without default', () => {
    const out = generateMSTModel(
      model('M', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'provider', type: 'StorageProvider', kind: 'enum', isRequired: false }),
      ]),
      [],
      enums,
    )
    expect(out.code).toContain('provider: types.maybeNull(types.enumeration("StorageProvider", ["s3", "gcs", "local"])),')
  })

  it('honors literal enum default when present (hasDefaultValue branch)', () => {
    const out = generateMSTModel(
      model('M', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'provider', type: 'StorageProvider', kind: 'enum', isRequired: true, hasDefaultValue: true, default: 's3' }),
      ]),
      [],
      enums,
    )
    expect(out.code).toContain('provider: types.optional(types.enumeration("StorageProvider", ["s3", "gcs", "local"]), "s3"),')
  })

  it('emits "undefined" for an enum field on the hasDefaultValue=true path with a function default (no literal)', () => {
    const out = generateMSTModel(
      model('M', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'provider', type: 'StorageProvider', kind: 'enum', isRequired: true, hasDefaultValue: true, default: { name: 'computed' } as any }),
      ]),
      [],
      enums,
    )
    expect(out.code).toContain('provider: types.optional(types.enumeration("StorageProvider", ["s3", "gcs", "local"]), undefined),')
  })
})

describe('generateMSTModel — relations and references', () => {
  const userModel = model('User', [field({ name: 'id', type: 'String', isId: true })])
  const postModel = model('Post', [field({ name: 'id', type: 'String', isId: true })])

  it('emits types.safeReference + types.late for a single object field with the other model included', () => {
    const out = generateMSTModel(
      model('Post', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'author', type: 'User', kind: 'object', isRequired: true }),
      ]),
      [userModel, postModel],
      [],
      new Set(['User', 'Post']),
    )
    expect(out.code).toContain('import { UserModel } from "./user.model"')
    expect(out.code).toContain('author: types.safeReference(types.late(() => UserModel)),')
  })

  it('emits types.array(safeReference) for list relations', () => {
    const out = generateMSTModel(
      model('User', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'posts', type: 'Post', kind: 'object', isList: true, isRequired: true }),
      ]),
      [userModel, postModel],
      [],
      new Set(['User', 'Post']),
    )
    expect(out.code).toContain('import { PostModel } from "./post.model"')
    expect(out.code).toContain('posts: types.optional(types.array(types.safeReference(types.late(() => PostModel))), []),')
  })

  it('skips imports + relation fields whose target model is NOT in includedModelNames', () => {
    const out = generateMSTModel(
      model('Post', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'author', type: 'User', kind: 'object', isRequired: true }),
        field({ name: 'co', type: 'CoAuthor', kind: 'object', isRequired: false }),
      ]),
      [userModel, postModel],
      [],
      new Set(['Post']), // neither User nor CoAuthor included
    )
    expect(out.code).not.toContain('import { UserModel }')
    expect(out.code).not.toContain('import { CoAuthorModel }')
    expect(out.code).not.toContain('author:')
    expect(out.code).not.toContain('co:')
  })

  it('skips self-referential relation (field.type === modelName) from imports + fields', () => {
    const out = generateMSTModel(
      model('Node', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'parent', type: 'Node', kind: 'object', isRequired: false }),
      ]),
      [model('Node', [])],
      [],
      new Set(['Node']),
    )
    expect(out.code).not.toContain('import { NodeModel }')
    expect(out.code).not.toContain('parent:')
  })

  it('with no includedModelNames passed, all referenced models are imported (default behaviour)', () => {
    const out = generateMSTModel(
      model('Post', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'author', type: 'User', kind: 'object', isRequired: true }),
      ]),
      [userModel, postModel],
      [],
    )
    expect(out.code).toContain('import { UserModel } from "./user.model"')
    expect(out.code).toContain('author: types.safeReference(types.late(() => UserModel)),')
  })

  it('emits non-required relation field without a default wrapper (passthrough)', () => {
    const out = generateMSTModel(
      model('Post', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'author', type: 'User', kind: 'object', isRequired: false }),
      ]),
      [userModel, postModel],
      [],
      new Set(['User', 'Post']),
    )
    // Non-required relation field path
    expect(out.code).toContain('author: types.safeReference(types.late(() => UserModel)),')
  })
})

describe('generateMSTModels (batch)', () => {
  it('returns one entry per model that has an @id', () => {
    const ok = model('User', [field({ name: 'id', type: 'String', isId: true })])
    const noId = model('Junk', [field({ name: 'data', type: 'String' })])
    const out = generateMSTModels([ok, noId])
    expect(out).toHaveLength(1)
    expect(out[0].modelName).toBe('User')
  })

  it('uses the passed allModels for reference resolution, not just the filtered set', () => {
    const post = model('Post', [
      field({ name: 'id', type: 'String', isId: true }),
      field({ name: 'author', type: 'User', kind: 'object', isRequired: true }),
    ])
    const user = model('User', [field({ name: 'id', type: 'String', isId: true })])
    const out = generateMSTModels([post], [post, user])
    expect(out).toHaveLength(1)
    // 'User' is NOT in the configured set [post], so the import is skipped.
    expect(out[0].code).not.toContain('import { UserModel }')
  })

  it('passes through fileExtension (ts)', () => {
    const user = model('User', [field({ name: 'id', type: 'String', isId: true })])
    const [out] = generateMSTModels([user], undefined, [], 'ts')
    expect(out.fileName).toBe('user.model.ts')
  })

  it('returns [] when no models have an @id', () => {
    const out = generateMSTModels([model('NoId', [field({ name: 'data', type: 'String' })])])
    expect(out).toEqual([])
  })

  it('defaults fileExtension to tsx when not provided', () => {
    const user = model('User', [field({ name: 'id', type: 'String', isId: true })])
    const [out] = generateMSTModels([user])
    expect(out.fileName).toBe('user.model.tsx')
  })
})
