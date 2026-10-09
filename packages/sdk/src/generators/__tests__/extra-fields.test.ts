// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import { generateMSTModels } from '../mst-model-generator'
import { generateTypesPerModel } from '../types-generator'
import { withExtraFields, type PrismaModel, type PrismaField } from '../prisma-generator'

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

const project: PrismaModel = {
  name: 'Project',
  fields: [
    field({ name: 'id', isId: true, hasDefaultValue: true }),
    field({ name: 'name' }),
    field({ name: 'tags', isList: true }),
  ],
}
const workspace: PrismaModel = {
  name: 'Workspace',
  fields: [field({ name: 'id', isId: true, hasDefaultValue: true })],
}

const extraFields = {
  Project: { myPermissions: { type: 'String' as const, list: true } },
}

describe('withExtraFields', () => {
  it('appends optional scalar fields to the matching model only', () => {
    const [p, w] = withExtraFields([project, workspace], extraFields)
    const extra = p.fields.find((f) => f.name === 'myPermissions')
    expect(extra).toMatchObject({ kind: 'scalar', type: 'String', isList: true, isRequired: false, isExtra: true })
    expect(w).toBe(workspace)
    expect(project.fields.some((f) => f.name === 'myPermissions')).toBe(false)
  })

  it('returns models unchanged without config', () => {
    const models = [project]
    expect(withExtraFields(models, undefined)).toBe(models)
  })

  it('rejects names that collide with schema fields', () => {
    expect(() => withExtraFields([project], { Project: { name: { type: 'String' } } })).toThrow(
      /extraFields\.Project\.name collides/,
    )
  })
})

describe('extra fields in generated output', () => {
  const models = withExtraFields([project], extraFields)

  it('MST model declares the field as maybe so absence stays distinguishable from empty', () => {
    const [mst] = generateMSTModels(models, models, [], 'ts')
    expect(mst.code).toContain('myPermissions: types.maybe(types.array(types.string)),')
    expect(mst.code).toContain('tags: types.optional(types.array(types.string), []),')
  })

  it('read type includes the field; create/update inputs do not', () => {
    const [types] = generateTypesPerModel(models, [], 'ts')
    const readType = types.code.slice(types.code.indexOf('export interface ProjectType'))
    expect(readType.slice(0, readType.indexOf('}'))).toContain('myPermissions?: string[]')
    const inputs = types.code.slice(types.code.indexOf('export interface ProjectCreateInput'))
    expect(inputs).not.toContain('myPermissions')
  })

  it('scalar list columns are typed as arrays', () => {
    const [types] = generateTypesPerModel([project], [], 'ts')
    expect(types.code).toContain('tags: string[]')
    expect(types.code).not.toMatch(/tags\??: string\n/)
  })
})
