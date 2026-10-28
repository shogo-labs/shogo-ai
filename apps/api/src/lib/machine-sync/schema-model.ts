// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A reader for `prisma/schema.prisma` that yields the model metadata the machine
 * copy needs: which fields are real columns, which are required on create, which
 * carry a unique constraint, and in what order models must be written so that a
 * foreign key never points at a row that does not exist yet.
 *
 * Why not the DMMF
 * ----------------
 * Prisma 7's `prisma-client` generator does not emit the DMMF any more, and
 * `@prisma/internals` (the other way to ask for it) is not a dependency. Parsing
 * the schema file we already ship is the remaining honest option, and it keeps
 * the one thing that matters — "a model or a unique field nobody thought about
 * fails CI" — in a test instead of a runtime surprise. `machine-sync.test.ts`
 * fails if this reader and the real schema disagree about the model list.
 */

export type ScalarType =
  | 'String'
  | 'Int'
  | 'BigInt'
  | 'Float'
  | 'Decimal'
  | 'Boolean'
  | 'DateTime'
  | 'Json'
  | 'Bytes'

export const SCALAR_TYPES: readonly ScalarType[] = [
  'String',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'Boolean',
  'DateTime',
  'Json',
  'Bytes',
] as const

export interface ParsedField {
  name: string
  /** Scalar type name, enum name, or the name of the related model. */
  typeName: string
  /** `String` / `Int` / … — a real column. */
  isScalar: boolean
  /** The type is a model in this schema (a relation, not a column). */
  isRelation: boolean
  isEnum: boolean
  isList: boolean
  isOptional: boolean
  hasDefault: boolean
  /** `@updatedAt` — Prisma fills it, so it is never required on create. */
  isUpdatedAt: boolean
  isId: boolean
  isUnique: boolean
  /** From `@relation(fields: [...])`: the scalar columns that make up the FK. */
  relationFields: string[]
  /** From `@relation(fields: [...], references: [...])`: the target column(s). */
  relationReferences: string[]
}

export interface ParsedModel {
  name: string
  /** `@@map("…")` — the table name, or the model name in PascalCase default. */
  table: string
  fields: ParsedField[]
  /** `@@unique([a, b], …)` groups, in declaration order. */
  compoundUniques: string[][]
  /** Primary key columns; empty when the model uses a single `@id` field. */
  compoundId: string[]
  /** `@@index` columns, only used to keep the comparison output stable. */
  indexes: string[][]
}

export interface ParsedSchema {
  models: ParsedModel[]
  enums: string[]
}

/** Strip `///` docs and `//` comments without touching strings or `raw("…")`. */
function stripComments(source: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += source[i + 1] ?? ''
        i++
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
      out += '\n'
      continue
    }
    out += ch
  }
  return out
}

/** Names inside `[...]` of an attribute argument list. */
function bracketArgs(text: string): string[] {
  return text
    .replace(/[\[\]]/g, ' ')
    .split(',')
    .map((part) => part.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
}

/** `@@attr(...)` calls in a model body, by attribute name. */
function blockAttributes(body: string): Map<string, string[]> {
  const found = new Map<string, string[]>()
  const re = /@@(\w+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(body))) {
    const name = match[1]
    const argStart = body.indexOf('(', match.index)
    if (argStart < 0) {
      found.set(name, [])
      continue
    }
    // Walk to the matching `)` so nested `raw("…")` and `[...]` survive.
    let depth = 0
    let end = argStart
    for (let i = argStart; i < body.length; i++) {
      if (body[i] === '(') depth++
      else if (body[i] === ')') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    found.set(name, [body.slice(argStart + 1, end)])
  }
  return found
}

function parseField(line: string, modelNames: Set<string>, enumNames: Set<string>): ParsedField | null {
  // `name Type` + optional `?` / `[]`, then attributes.
  const match = line.match(/^(\w+)\s+([\w.]+)(\[\])?(\?)?\s*(.*)$/)
  if (!match) return null
  const [, name, typeName, listMark, optionalMark, attrs] = match
  const isList = Boolean(listMark)
  const isOptional = Boolean(optionalMark)
  const isScalar = (SCALAR_TYPES as readonly string[]).includes(typeName)
  const isRelation = modelNames.has(typeName)
  const isEnum = enumNames.has(typeName)

  const relationArgs = attrs.match(/@relation\(([^)]*)\)/)?.[1] ?? ''
  const relationFieldsArg = relationArgs.match(/fields:\s*\[([^\]]*)\]/)?.[1] ?? ''
  const relationReferencesArg = relationArgs.match(/references:\s*\[([^\]]*)\]/)?.[1] ?? ''

  return {
    name,
    typeName,
    isScalar,
    isRelation,
    isEnum,
    isList,
    isOptional,
    hasDefault: /@default\(/.test(attrs),
    isUpdatedAt: /@updatedAt\b/.test(attrs),
    isId: /@id\b/.test(attrs),
    isUnique: /@unique\b/.test(attrs),
    relationFields: relationFieldsArg ? bracketArgs(relationFieldsArg) : [],
    relationReferences: relationReferencesArg ? bracketArgs(relationReferencesArg) : [],
  }
}

/** Parse a Prisma schema string into models and enums. */
export function parseSchema(source: string): ParsedSchema {
  const text = stripComments(source)
  const enums: string[] = []
  const enumRe = /^\s*enum\s+(\w+)\s*\{/gm
  let enumMatch: RegExpExecArray | null
  while ((enumMatch = enumRe.exec(text))) enums.push(enumMatch[1])
  const enumNames = new Set(enums)

  const rawModels: Array<{ name: string; body: string }> = []
  const modelRe = /^\s*model\s+(\w+)\s*\{/gm
  let modelMatch: RegExpExecArray | null
  while ((modelMatch = modelRe.exec(text))) {
    const open = text.indexOf('{', modelMatch.index)
    let depth = 0
    let close = open
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    rawModels.push({ name: modelMatch[1], body: text.slice(open + 1, close) })
  }

  const modelNames = new Set(rawModels.map((m) => m.name))

  const models = rawModels.map(({ name, body }): ParsedModel => {
    const lines = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('@@'))

    const fields = lines
      .map((line) => parseField(line, modelNames, enumNames))
      .filter((field): field is ParsedField => field !== null)

    const attributes = blockAttributes(body)
    const mapArg = attributes.get('map')?.[0] ?? ''
    const table = mapArg.replace(/^"(.*)"$/, '$1') || name

    const compoundUniques = (attributes.get('unique') ?? [])
      .map((args) => args.match(/\[([^\]]*)\]/)?.[1] ?? '')
      .filter(Boolean)
      .map((inner) => bracketArgs(inner))

    const compoundId = (attributes.get('id') ?? [])
      .map((args) => args.match(/\[([^\]]*)\]/)?.[1] ?? '')
      .filter(Boolean)
      .map((inner) => bracketArgs(inner))[0] ?? []

    const indexes = (attributes.get('index') ?? [])
      .map((args) => args.match(/\[([^\]]*)\]/)?.[1] ?? '')
      .filter(Boolean)
      .map((inner) => bracketArgs(inner))

    return { name, table, fields, compoundUniques, compoundId, indexes }
  })

  return { models, enums }
}

/** The scalar columns of a model, i.e. the ones that exist in the database. */
export function columnFields(model: ParsedModel): ParsedField[] {
  return model.fields.filter((field) => field.isScalar || field.isEnum)
}

/**
 * Whether a value must be supplied on create: not optional, no `@default`, not
 * `@updatedAt`, and not the id when it has a default.
 */
export function isRequiredOnCreate(field: ParsedField): boolean {
  if (!(field.isScalar || field.isEnum)) return false
  if (field.isList) return false
  if (field.isOptional) return false
  if (field.hasDefault || field.isUpdatedAt) return false
  return true
}

/** Every `Model.field` single-field unique constraint, including `@id`. */
export function singleFieldUniques(model: ParsedModel): string[] {
  return columnFields(model)
    .filter((field) => field.isUnique || field.isId)
    .map((field) => `${model.name}.${field.name}`)
}

/**
 * Foreign keys as `{ from: 'Model.column', to: 'Model.column' }`.
 *
 * Taken from the relation fields, so a relation written as
 * `workspace Workspace @relation(fields: [workspaceId], references: [id])`
 * yields `Project.workspaceId → Workspace.id`.
 */
export function foreignKeys(model: ParsedModel): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = []
  for (const field of model.fields) {
    if (!field.isRelation || !field.relationFields.length) continue
    field.relationFields.forEach((column, index) => {
      const target = field.relationReferences[index] ?? 'id'
      out.push({ from: `${model.name}.${column}`, to: `${field.typeName}.${target}` })
    })
  }
  return out
}

/**
 * Write order: a model never precedes a model it points at.
 *
 * Computed as the longest path from a root, so `Workspace` is 0, `Project` is 1,
 * `ChatSession` is 2 and so on. Cycles (Prisma allows them through an optional
 * relation) are broken by leaving both members at the depth reached first — the
 * nullable side is then written with `null` and patched by a later change,
 * which the change log already handles.
 */
export function writeOrder(schema: ParsedSchema): Map<string, number> {
  const dependencies = new Map<string, Set<string>>()
  for (const model of schema.models) {
    const deps = new Set<string>()
    for (const fk of foreignKeys(model)) {
      const [targetModel] = fk.to.split('.')
      if (targetModel !== model.name) deps.add(targetModel)
    }
    dependencies.set(model.name, deps)
  }

  const order = new Map<string, number>()
  let changed = true
  let guard = 0
  while (changed && guard++ < 200) {
    changed = false
    for (const model of schema.models) {
      const deps = dependencies.get(model.name)!
      let depth = 0
      for (const dep of deps) depth = Math.max(depth, (order.get(dep) ?? 0) + 1)
      if (order.get(model.name) !== depth) {
        // Only grow, so a cycle settles instead of oscillating.
        if (depth > (order.get(model.name) ?? 0)) {
          order.set(model.name, depth)
          changed = true
        } else if (!order.has(model.name)) {
          order.set(model.name, depth)
          changed = true
        }
      }
    }
  }
  for (const model of schema.models) if (!order.has(model.name)) order.set(model.name, 0)
  return order
}
