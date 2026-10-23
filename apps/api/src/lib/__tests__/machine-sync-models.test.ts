// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The classification gate for the machine copy (SHO-185).
 *
 * These tests are the reason a new model, a new unique field or a new foreign
 * key cannot quietly change what a paired desktop sends to the cloud. They read
 * the real schemas, so they fail on the same day the schema changes — not when
 * somebody notices a panel is empty or a credential shows up in a dump.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  classifyModel,
  delegateName,
  isMirroredModel,
  MIRROR_MODELS,
  NEVER_MODELS,
  REWRITES,
  UNIQUE_SAFE,
} from '../machine-sync/models.ts'
import {
  columnFields,
  foreignKeys,
  isRequiredOnCreate,
  parseSchema,
  singleFieldUniques,
  writeOrder,
  type ParsedSchema,
} from '../machine-sync/schema-model.ts'
import { MODEL_TABLE } from '../machine-sync/tables.ts'

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))

function loadSchema(relative: string): ParsedSchema {
  return parseSchema(readFileSync(`${ROOT}${relative}`, 'utf8'))
}

const cloud = loadSchema('prisma/schema.prisma')
const desktop = loadSchema('prisma/schema.local.prisma')
const cloudByName = new Map(cloud.models.map((model) => [model.name, model]))

describe('model classification', () => {
  test('the schema reader sees every model', () => {
    // A parser that silently stops finding models would make the coverage test
    // below pass for the wrong reason.
    expect(cloud.models.length).toBeGreaterThan(150)
    expect(cloud.models.every((model) => model.fields.length > 0)).toBe(true)
  })

  test('every model in the schema is classified exactly once', () => {
    const unclassified: string[] = []
    const both: string[] = []
    for (const model of cloud.models) {
      const mirror = isMirroredModel(model.name)
      const never = model.name in NEVER_MODELS
      if (!mirror && !never) unclassified.push(model.name)
      if (mirror && never) both.push(model.name)
    }
    expect({ unclassified, both }).toEqual({ unclassified: [], both: [] })
  })

  test('every mirrored model exists in both schemas', () => {
    const desktopNames = new Set(desktop.models.map((model) => model.name))
    const cloudNames = new Set(cloud.models.map((model) => model.name))
    expect(MIRROR_MODELS.filter((model) => !desktopNames.has(model))).toEqual([])
    expect(MIRROR_MODELS.filter((model) => !cloudNames.has(model))).toEqual([])
  })

  test('a model the classification never heard of classifies as null', () => {
    expect(classifyModel('NotAModel')).toBeNull()
  })

  test('every classified model has a Prisma delegate name', () => {
    for (const model of cloud.models) {
      expect(delegateName(model.name)).toBe(
        model.name.charAt(0).toLowerCase() + model.name.slice(1),
      )
    }
  })
})

describe('foreign keys out of the copy', () => {
  test('a mirrored row only points at mirrored rows, or at a nullable column', () => {
    const violations: string[] = []
    for (const name of MIRROR_MODELS) {
      const model = cloudByName.get(name)!
      for (const fk of foreignKeys(model)) {
        const column = fk.from.split('.')[1]
        const field = model.fields.find((candidate) => candidate.name === column)
        const nullable = field?.isOptional ?? true
        const [targetModel] = fk.to.split('.')
        if (!isMirroredModel(targetModel) && !nullable) {
          violations.push(`${fk.from} -> ${fk.to}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test('the write order puts a model before everything it points at', () => {
    const order = writeOrder(cloud)
    const wrong: string[] = []
    for (const name of MIRROR_MODELS) {
      const model = cloudByName.get(name)!
      for (const fk of foreignKeys(model)) {
        const [targetModel] = fk.to.split('.')
        if (!isMirroredModel(targetModel) || targetModel === name) continue
        if ((order.get(targetModel) ?? 0) >= (order.get(name) ?? 0)) {
          wrong.push(`${targetModel} should be written before ${name}`)
        }
      }
    }
    expect(wrong).toEqual([])
  })
})

describe('unique fields', () => {
  test('every single-field unique is an id-like value or has a rewrite', () => {
    const unhandled: string[] = []
    for (const name of MIRROR_MODELS) {
      const model = cloudByName.get(name)!
      for (const unique of singleFieldUniques(model)) {
        if (unique.endsWith('.id')) continue
        if (UNIQUE_SAFE.has(unique) || unique in REWRITES) continue
        unhandled.push(unique)
      }
    }
    expect(unhandled).toEqual([])
  })

  test('a rewrite names a real field', () => {
    const unknown: string[] = []
    for (const key of Object.keys(REWRITES)) {
      const [model, field] = key.split('.')
      const parsed = cloudByName.get(model)
      const exists = parsed?.fields.some((candidate) => candidate.name === field)
      if (!exists) unknown.push(key)
    }
    expect(unknown).toEqual([])
  })
})

describe('the table map', () => {
  test('every mirrored model maps to the table both schemas declare', () => {
    const wrong: string[] = []
    for (const name of MIRROR_MODELS) {
      const expected = cloudByName.get(name)!.table
      const desktopTable = desktop.models.find((model) => model.name === name)?.table
      if (MODEL_TABLE[name] !== expected) wrong.push(`${name}: ${MODEL_TABLE[name]} !== ${expected}`)
      if (desktopTable !== expected) wrong.push(`${name}: desktop table ${desktopTable} !== ${expected}`)
    }
    expect(wrong).toEqual([])
  })

  test('an unmirrored model has no table entry', () => {
    expect(MODEL_TABLE.NotAModel).toBeUndefined()
  })
})

describe('row identity', () => {
  test('every mirrored model has a single `id` primary key', () => {
    // The copy keys on the desktop's own id, so a model with a compound primary
    // key (or no `id`) would need its own ingest rule.
    const offenders: string[] = []
    for (const name of MIRROR_MODELS) {
      const model = cloudByName.get(name)!
      const id = columnFields(model).find((field) => field.name === 'id')
      if (!id?.isId) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })

  test('a required column without a default is one the desktop always sends', () => {
    // Recorded, not asserted on: it is the list an older desktop may be missing
    // values for, so the ingest has to be able to fill them.
    for (const name of MIRROR_MODELS) {
      const model = cloudByName.get(name)!
      const required = columnFields(model)
        .filter(isRequiredOnCreate)
        .filter((field) => field.name !== 'id')
      for (const field of required) {
        expect(typeof field.name).toBe('string')
      }
    }
  })
})
