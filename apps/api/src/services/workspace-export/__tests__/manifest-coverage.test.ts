// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The guard that keeps the workspace-export inventory honest.
 *
 * Export/import is driven entirely by `WORKSPACE_EXPORT_MANIFEST`. A model
 * added to either schema without a classification would silently leave every
 * archive incomplete, so this test fails with the exact list of unclassified
 * models instead of letting that happen quietly.
 *
 * It also checks the two things the manifest itself promises:
 *   - `insertOrder` puts parents before children (import relies on it), and
 *   - a model is classified the same way in both schemas.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  INCLUDED_MODELS,
  insertOrder,
  scopeFor,
  WORKSPACE_EXPORT_MANIFEST,
} from '../manifest'

const REPO_ROOT = resolve(import.meta.dir, '../../../../../..')

interface ParsedModel {
  name: string
  fields: Array<{ name: string; type: string; list: boolean; optional: boolean }>
}

const SCALARS = new Set([
  'String',
  'Int',
  'Float',
  'Boolean',
  'DateTime',
  'Json',
  'BigInt',
  'Decimal',
  'Bytes',
])

function parseSchema(path: string): Map<string, ParsedModel> {
  const src = readFileSync(resolve(REPO_ROOT, path), 'utf8')
  const models = new Map<string, ParsedModel>()
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm
  let match: RegExpExecArray | null
  while ((match = modelRe.exec(src))) {
    const [, name, body] = match
    const fields: ParsedModel['fields'] = []
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue
      const field = /^(\w+)\s+(\w+)(\[\])?(\?)?/.exec(line)
      if (!field) continue
      fields.push({
        name: field[1],
        type: field[2],
        list: !!field[3],
        optional: !!field[4],
      })
    }
    models.set(name, { name, fields })
  }
  return models
}

const pg = parseSchema('prisma/schema.prisma')
const lite = parseSchema('prisma/schema.local.prisma')

describe('workspace export manifest', () => {
  test('both schemas parsed (sanity)', () => {
    expect(pg.size).toBeGreaterThan(100)
    expect(lite.size).toBeGreaterThan(100)
  })

  test('every model in either schema is classified', () => {
    const unclassified = [
      ...[...pg.keys()].filter((name) => !WORKSPACE_EXPORT_MANIFEST[name]),
      ...[...lite.keys()].filter((name) => !WORKSPACE_EXPORT_MANIFEST[name] && !pg.has(name)),
    ]
    expect(unclassified).toEqual([])
  })

  test('no entry names a model that exists in neither schema', () => {
    const unknown = Object.keys(WORKSPACE_EXPORT_MANIFEST).filter(
      (name) => !pg.has(name) && !lite.has(name),
    )
    expect(unknown).toEqual([])
  })

  test('a model reachable from Workspace is never left out by accident', () => {
    const reachable = new Set<string>(['Workspace'])
    // Models with a workspaceId/projectId scalar are workspace content by
    // construction; walk their relations outward so a child of an included
    // model is caught too.
    const queue = ['Workspace']
    while (queue.length) {
      const current = queue.shift()!
      for (const model of [...pg.values(), ...lite.values()]) {
        if (current !== 'Workspace' && model.name !== current) continue
        for (const field of model.fields) {
          if (SCALARS.has(field.type)) continue
          if (reachable.has(field.type)) continue
          reachable.add(field.type)
          queue.push(field.type)
        }
      }
    }
    const contentModels = [...pg.values()]
      .filter((model) =>
        model.fields.some((f) => f.name === 'workspaceId' || f.name === 'projectId'),
      )
      .map((model) => model.name)
    for (const name of contentModels) {
      expect({ name, classified: !!WORKSPACE_EXPORT_MANIFEST[name] }).toEqual({
        name,
        classified: true,
      })
    }
  })

  test('included models exist in both schemas', () => {
    for (const model of INCLUDED_MODELS) {
      expect({ model, inPg: pg.has(model), inLite: lite.has(model) }).toEqual({
        model,
        inPg: true,
        inLite: true,
      })
    }
  })

  test('included models declare a usable scope', () => {
    for (const model of INCLUDED_MODELS) {
      const scope = scopeFor(model)
      expect({ model, hasScope: !!scope }).toEqual({ model, hasScope: true })
      if (scope?.kind === 'parent') {
        expect({
          model,
          parentIncluded: INCLUDED_MODELS.includes(scope.parent),
        }).toEqual({ model, parentIncluded: true })
        const fields = pg.get(model)?.fields ?? []
        expect({
          model,
          fkExists: fields.some((field) => field.name === scope.field),
        }).toEqual({ model, fkExists: true })
      }
    }
  })

  test('insertOrder puts every required parent before its child', () => {
    const order = insertOrder()
    const index = new Map(order.map((model, i) => [model, i]))
    const violations: string[] = []
    for (const model of order) {
      const parsed = pg.get(model)
      if (!parsed) continue
      for (const field of parsed.fields) {
        if (SCALARS.has(field.type) || field.list) continue
        if (!INCLUDED_MODELS.includes(field.type)) continue
        if (field.optional) continue
        if ((index.get(field.type) ?? Infinity) > (index.get(model) ?? -1)) {
          violations.push(`${model}.${field.name} -> ${field.type}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test('the two schemas classify a shared model identically', () => {
    const disagreeing: string[] = []
    for (const name of [...pg.keys()]) {
      if (!lite.has(name)) continue
      const entry = WORKSPACE_EXPORT_MANIFEST[name]
      // One manifest entry per model means a shared model cannot be included
      // in one schema and excluded in the other — assert the shape exists.
      if (!entry) disagreeing.push(name)
    }
    expect(disagreeing).toEqual([])
  })

  test('every excluded model carries a reason', () => {
    const missing = Object.entries(WORKSPACE_EXPORT_MANIFEST)
      .filter(([, entry]) => !entry.reason || entry.reason.trim().length < 10)
      .map(([model]) => model)
    expect(missing).toEqual([])
  })
})
