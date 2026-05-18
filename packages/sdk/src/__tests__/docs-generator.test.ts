// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `docs-generator.ts` — output snapshot tests.
 *
 * `packages/sdk/src/generators/docs-generator.ts` was at 1% line
 * coverage (503 missing lines). Generator output is deterministic so a
 * single fixture model exercises ~80% of the surface in one pass.
 *
 *   bun test packages/sdk/src/__tests__/docs-generator.test.ts
 */

import { describe, test, expect } from 'bun:test'
import {
  generateModelDoc,
  generateModelsIndex,
  generateApiOverview,
  generateModelsCategoryMeta,
  generateDocs,
} from '../generators/docs-generator'

const fixtureModel = {
  name: 'Workspace',
  fields: [
    { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: false, hasDefaultValue: true },
    { name: 'name', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    { name: 'email', kind: 'scalar', type: 'String', isRequired: false, isList: false, isId: false, isUnique: true, hasDefaultValue: false },
    { name: 'url', kind: 'scalar', type: 'String', isRequired: false, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    { name: 'seats', kind: 'scalar', type: 'Int', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    { name: 'rate', kind: 'scalar', type: 'Float', isRequired: false, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    { name: 'active', kind: 'scalar', type: 'Boolean', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: true },
    { name: 'createdAt', kind: 'scalar', type: 'DateTime', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: true },
    { name: 'updatedAt', kind: 'scalar', type: 'DateTime', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: true },
    { name: 'settings', kind: 'scalar', type: 'Json', isRequired: false, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    { name: 'status', kind: 'enum', type: 'Status', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    { name: 'projects', kind: 'object', type: 'Project', isRequired: false, isList: true, isId: false, isUnique: false, hasDefaultValue: false, relationName: 'WorkspaceProjects' },
  ],
} as any

const fixtureProjectModel = {
  name: 'Story',
  fields: [
    { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: false, hasDefaultValue: true },
    { name: 'title', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
  ],
} as any

const fixtureEnums = [
  { name: 'Status', values: [{ name: 'ACTIVE' }, { name: 'INACTIVE' }] },
]

describe('generateModelDoc', () => {
  test('emits Docusaurus front-matter for a model page', () => {
    const file = generateModelDoc(fixtureModel, [fixtureModel, fixtureProjectModel], fixtureEnums, {
      projectName: 'TestApp',
      apiBasePath: '/api',
    })
    expect(file.path).toBe('docs/models/workspace.md')
    expect(file.content).toMatch(/^---/)
    expect(file.content).toContain('title: Workspace')
  })

  test('includes a Fields section listing every scalar / enum field', () => {
    const file = generateModelDoc(fixtureModel, [fixtureModel], fixtureEnums)
    expect(file.content).toContain('## Fields')
    expect(file.content).toContain('`name`')
    expect(file.content).toContain('`email`')
    expect(file.content).toContain('Unique')
    expect(file.content).toContain('Primary key')
  })

  test('routes plural the model name when generating endpoint paths', () => {
    const file = generateModelDoc(fixtureModel, [fixtureModel], fixtureEnums)
    expect(file.content).toContain('/api/workspaces')
  })

  test('handles models ending in y (regular → ies)', () => {
    const yModel = { ...fixtureModel, name: 'Story', fields: fixtureProjectModel.fields }
    const file = generateModelDoc(yModel, [yModel], [])
    expect(file.content).toContain('/api/stories')
  })

  test('handles models ending in s/x/sh/ch (→ +es)', () => {
    const variants = ['Class', 'Box', 'Brush', 'Watch']
    for (const name of variants) {
      const m = { ...fixtureModel, name }
      const f = generateModelDoc(m, [m], [])
      // Each should not produce a plural of e.g. 'classs' — instead 'classes'.
      const lower = name.toLowerCase() + 'es'
      expect(f.content).toContain(`/api/${lower}`)
    }
  })
})

describe('generateModelsIndex', () => {
  test('produces a header-rich Markdown table over the models', () => {
    const out = generateModelsIndex([fixtureModel, fixtureProjectModel])
    expect(out.path).toBe('docs/models-overview.md')
    expect(out.content).toContain('# Models Overview')
    expect(out.content).toContain('| Model | Fields | Relations | Description |')
    expect(out.content).toContain('[**Workspace**]')
    expect(out.content).toContain('[**Story**]')
  })
})

describe('generateApiOverview', () => {
  test('lists CRUD endpoints for every model with an id field', () => {
    const out = generateApiOverview([fixtureModel, fixtureProjectModel])
    expect(out.path).toBe('docs/api-reference.md')
    expect(out.content).toContain('`GET` | `/api/workspaces`')
    expect(out.content).toContain('`POST` | `/api/workspaces`')
    expect(out.content).toContain('`PATCH` | `/api/workspaces/:id`')
    expect(out.content).toContain('`DELETE` | `/api/workspaces/:id`')
    expect(out.content).toContain('`GET` | `/api/stories`')
  })

  test('honours the apiBasePath config override', () => {
    const out = generateApiOverview([fixtureModel], { apiBasePath: '/v2' })
    expect(out.content).toContain('| `GET` | `/v2/workspaces`')
  })

  test('skips models without an id field', () => {
    const idless = { name: 'Tag', fields: [{ name: 'label', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false }] } as any
    const out = generateApiOverview([idless])
    expect(out.content).not.toContain('/api/tags')
  })
})

describe('exotic field types', () => {
  // Cover mapFieldType BigInt / Bytes / default arms and the
  // getExampleValue / getExampleValueTS default + Float/Decimal/Boolean/DateTime/Json arms.
  const exoticModel = {
    name: 'Sample',
    fields: [
      { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: false, hasDefaultValue: true },
      { name: 'amount', kind: 'scalar', type: 'Decimal', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
      { name: 'ratio', kind: 'scalar', type: 'Float', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
      { name: 'flag', kind: 'scalar', type: 'Boolean', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
      { name: 'when', kind: 'scalar', type: 'DateTime', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
      { name: 'meta', kind: 'scalar', type: 'Json', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
      { name: 'big', kind: 'scalar', type: 'BigInt', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
      { name: 'blob', kind: 'scalar', type: 'Bytes', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
      { name: 'mystery', kind: 'scalar', type: 'CustomType', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    ],
  } as any

  test('renders BigInt, Bytes and unknown scalar types in the model doc', () => {
    const file = generateModelDoc(exoticModel, [exoticModel], [], { projectName: 'TestApp', apiBasePath: '/api' })
    expect(file.content).toContain('bigint')
    expect(file.content).toContain('Buffer')
    expect(file.content).toContain('unknown')
  })

  test('emits example JSON values for Float/Decimal/Boolean/DateTime/Json and default arms', () => {
    const file = generateModelDoc(exoticModel, [exoticModel], [], { projectName: 'TestApp', apiBasePath: '/api' })
    expect(file.content).toContain('1.0')
    expect(file.content).toMatch(/"flag":\s*true/)
    expect(file.content).toMatch(/"meta":\s*\{\}/)
    expect(file.content).toContain('2025-01-01T00:00:00Z')
    expect(file.content).toMatch(/"mystery":\s*null/)
  })

  test('emits example TS values for Float/Decimal/Boolean/DateTime/Json and default arms', () => {
    const file = generateModelDoc(exoticModel, [exoticModel], [], { projectName: 'TestApp', apiBasePath: '/api' })
    expect(file.content).toContain('ratio: 1.0')
    expect(file.content).toContain('flag: true')
    expect(file.content).toContain('when: new Date()')
    expect(file.content).toContain('meta: {}')
    expect(file.content).toContain('mystery: null')
  })
})

describe('generateModelsCategoryMeta', () => {
  test('emits Docusaurus _category_.json', () => {
    const out = generateModelsCategoryMeta()
    expect(out.path).toBe('docs/models/_category_.json')
    const parsed = JSON.parse(out.content)
    expect(parsed.label).toBe('Models')
    expect(parsed.position).toBe(3)
  })
})

describe('generateDocs', () => {
  test('returns the overview + reference + category + per-model docs', () => {
    const files = generateDocs([fixtureModel, fixtureProjectModel], fixtureEnums, { projectName: 'TestApp' })
    expect(files).toHaveLength(2 + 1 + 2) // overview + api-reference + category + 2 model pages
    const paths = files.map((f) => f.path).sort()
    expect(paths).toContain('docs/models-overview.md')
    expect(paths).toContain('docs/api-reference.md')
    expect(paths).toContain('docs/models/_category_.json')
    expect(paths).toContain('docs/models/workspace.md')
    expect(paths).toContain('docs/models/story.md')
  })
})
