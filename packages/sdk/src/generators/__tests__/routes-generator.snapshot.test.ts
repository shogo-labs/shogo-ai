// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Whole-file snapshots of generated routes. Every generated app ships this
 * code, so any change to its shape should be a reviewed snapshot update
 * (`bun test -u`), not a side effect.
 */

import { describe, expect, it } from 'bun:test'
import { generateModelHooks, generateModelRoutes, generateRoutesIndex } from '../routes-generator'
import type { PrismaModel } from '../prisma-generator'

const scalar = (name: string, type: string, extra: Partial<PrismaModel['fields'][number]> = {}) => ({
  name,
  kind: 'scalar' as const,
  type,
  isRequired: true,
  isList: false,
  isId: false,
  isUnique: false,
  hasDefaultValue: false,
  ...extra,
})

const project: PrismaModel = {
  name: 'Project',
  dbName: null,
  fields: [
    scalar('id', 'String', { isId: true, isUnique: true, hasDefaultValue: true }),
    scalar('name', 'String'),
    scalar('completed', 'Boolean'),
    scalar('priority', 'Int'),
    scalar('createdAt', 'DateTime', { hasDefaultValue: true }),
    scalar('workspaceId', 'String'),
    {
      name: 'workspace',
      kind: 'object',
      type: 'Workspace',
      isRequired: true,
      isList: false,
      isId: false,
      isUnique: false,
      hasDefaultValue: false,
      relationName: 'ProjectToWorkspace',
      relationFromFields: ['workspaceId'],
      relationToFields: ['id'],
    } as PrismaModel['fields'][number],
  ],
}

const workspace: PrismaModel = {
  name: 'Workspace',
  dbName: null,
  fields: [scalar('id', 'String', { isId: true, isUnique: true, hasDefaultValue: true }), scalar('name', 'String')],
}

describe('generated route output', () => {
  it('model routes', () => {
    expect(generateModelRoutes(project)!.code).toMatchSnapshot()
  })

  it('model hooks', () => {
    expect(generateModelHooks(project).code).toMatchSnapshot()
  })

  it('routes index', () => {
    expect(generateRoutesIndex([project, workspace])).toMatchSnapshot()
  })

  it('create and update hand Prisma the picked data without casting it away', () => {
    const code = generateModelRoutes(project)!.code
    expect(code.match(/data: picked\.data,/g)?.length).toBe(2)
    expect(code).not.toMatch(/data: [^\n]* as any/)
  })
})
