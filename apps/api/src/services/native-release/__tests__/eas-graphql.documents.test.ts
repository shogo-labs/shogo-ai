// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Validate the EAS GraphQL *documents* against the schema snapshot.
 *
 * Why this exists: every other test in this directory hands `eas-graphql.ts` a
 * fake `EasClient`, and a fake accepts any string. Six documents shipped once
 * with a selection on `JSONObject!`, a `JobInput` type that does not exist, a
 * `SubmissionInput` that does not exist and singular root fields (`build`,
 * `workflowRun`) — every unit test green, and the API 400d on the first call of
 * every release. The only test that catches that class reads the document text
 * and checks it against the real schema.
 *
 * The snapshot is the Phase 0 fixture, refreshed from live introspection (no
 * auth needed, nothing mutated), so this is a shape check against Expo rather
 * than against our own assumptions.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOCUMENTS } from '../eas-graphql'

interface TypeRef {
  kind: string
  name: string | null
  ofType?: TypeRef | null
}
interface SchemaField {
  name: string
  args?: { name: string; type: TypeRef }[]
  type: TypeRef
}
interface SchemaType {
  kind: string
  name: string
  fields?: SchemaField[] | null
  enumValues?: { name: string }[] | null
}
interface Schema {
  root: {
    __schema: {
      mutationType: { fields: SchemaField[] }
      queryType: { fields: SchemaField[] }
    }
  }
  types: Record<string, SchemaType>
}

const schema: Schema = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../../../../scripts/__tests__/fixtures/eas-graphql-schema.json'), 'utf8'),
) as Schema

const BUILTIN_SCALARS = new Set(['ID', 'String', 'Int', 'Float', 'Boolean'])

/** The named type under any `NON_NULL` / `LIST` wrappers. */
function named(ref: TypeRef | null | undefined): { kind: string; name: string | null } {
  let cur = ref ?? null
  while (cur && !cur.name && cur.ofType) cur = cur.ofType
  return { kind: cur?.kind ?? 'UNKNOWN', name: cur?.name ?? null }
}

// ── a very small document reader ────────────────────────────────────────────
// Just what these documents use: one operation, variable definitions, fields
// with arguments, nested selections and inline fragments (`... on Robot`).

type Token = { t: 'name' | 'punct' | 'var' | 'string'; v: string }

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s|,/.test(ch)) {
      i += 1
      continue
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    if (ch === '"') {
      let v = ''
      i += 1
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') {
          v += src[i + 1] ?? ''
          i += 2
          continue
        }
        v += src[i]
        i += 1
      }
      i += 1
      tokens.push({ t: 'string', v })
      continue
    }
    if ('{}()[]:!='.includes(ch)) {
      tokens.push({ t: 'punct', v: ch })
      i += 1
      continue
    }
    if (ch === '$') {
      tokens.push({ t: 'var', v: '$' })
      i += 1
      continue
    }
    if (ch === '.') {
      while (src[i] === '.') i += 1
      tokens.push({ t: 'punct', v: '...' })
      continue
    }
    if (ch === '@') {
      i += 1
      while (i < src.length && /\w/.test(src[i])) i += 1
      if (src[i] === '(') {
        let depth = 0
        do {
          if (src[i] === '(') depth += 1
          if (src[i] === ')') depth -= 1
          i += 1
        } while (depth > 0 && i < src.length)
      }
      continue
    }
    if (/\w/.test(ch)) {
      let v = ''
      while (i < src.length && /\w/.test(src[i])) {
        v += src[i]
        i += 1
      }
      tokens.push({ t: 'name', v })
      continue
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${i}`)
  }
  return tokens
}

interface FieldSel {
  name: string
  args: { name: string; varName?: string }[]
  selection: FieldSel[]
  inlineType?: string
}

interface Doc {
  kind: 'query' | 'mutation'
  variables: { name: string; typeName: string }[]
  selection: FieldSel[]
}

function parseDocument(src: string): Doc {
  const tokens = tokenize(src)
  let p = 0
  const peek = () => tokens[p]
  const isName = (v?: string) => peek()?.t === 'name' && (v === undefined || peek()!.v === v)
  const expect = (v: string) => {
    if (peek()?.v !== v) throw new Error(`expected ${v} but found ${JSON.stringify(peek()?.v)}`)
    p += 1
  }

  let kind: 'query' | 'mutation' = 'query'
  if (isName('mutation')) {
    kind = 'mutation'
    p += 1
  } else if (isName('query')) {
    p += 1
  }
  if (isName()) p += 1 // operation name

  const variables: { name: string; typeName: string }[] = []
  if (peek()?.v === '(') {
    p += 1
    while (peek() && peek()!.v !== ')') {
      if (peek()!.t === 'var') {
        const name = tokens[p + 1]?.v
        p += 2
        expect(':')
        // Commas are whitespace to this tokenizer, so a new `$var` is the only
        // reliable end of a variable definition.
        let typeName = ''
        while (peek() && peek()!.v !== ')' && peek()!.v !== '=' && !(typeName && peek()!.t === 'var')) {
          if (peek()!.t === 'name') typeName = peek()!.v
          p += 1
        }
        variables.push({ name, typeName })
      } else {
        p += 1
      }
    }
    expect(')')
  }

  function parseSelectionSet(): FieldSel[] {
    expect('{')
    const out: FieldSel[] = []
    while (peek() && peek()!.v !== '}') {
      if (peek()!.v === '...') {
        p += 1
        if (isName('on')) {
          p += 1
          const inlineType = tokens[p]?.v
          p += 1
          out.push({ name: '...', args: [], selection: parseSelectionSet(), inlineType })
        }
        continue
      }
      const name = tokens[p]?.v
      if (!name || tokens[p].t !== 'name') throw new Error(`expected a field name, found ${JSON.stringify(name)}`)
      p += 1
      const args: FieldSel['args'] = []
      if (peek()?.v === '(') {
        p += 1
        while (peek() && peek()!.v !== ')') {
          if (peek()!.t === 'name') {
            const argName = peek()!.v
            p += 1
            expect(':')
            if (peek()?.t === 'var') {
              args.push({ name: argName, varName: tokens[p + 1]?.v })
              p += 2
            } else {
              p += 1
            }
          } else {
            p += 1
          }
        }
        expect(')')
      }
      const selection = peek()?.v === '{' ? parseSelectionSet() : []
      out.push({ name, args, selection })
    }
    expect('}')
    return out
  }

  const selection = parseSelectionSet()
  if (p !== tokens.length) throw new Error('trailing tokens after the operation')
  return { kind, variables, selection }
}

// ── validation ──────────────────────────────────────────────────────────────

interface Problem {
  doc: string
  path: string
  problem: string
}

function validateDocument(name: string, src: string): Problem[] {
  const problems: Problem[] = []
  const add = (path: string, problem: string) => problems.push({ doc: name, path, problem })

  let doc: Doc
  try {
    doc = parseDocument(src)
  } catch (err) {
    add('(document)', `could not be parsed: ${err instanceof Error ? err.message : String(err)}`)
    return problems
  }

  const declared = new Map(doc.variables.map((v) => [v.name, v.typeName]))
  for (const v of doc.variables) {
    if (BUILTIN_SCALARS.has(v.typeName) || schema.types[v.typeName]) continue
    add(`$${v.name}`, `declares type "${v.typeName}", which does not exist in the schema`)
  }

  // The operation's own root field list stands in for a "root type".
  const rootFields = doc.kind === 'mutation' ? schema.root.__schema.mutationType.fields : schema.root.__schema.queryType.fields
  const root = { kind: 'OBJECT', name: `Root${doc.kind}`, fields: rootFields } as SchemaType

  function walk(selection: FieldSel[], type: SchemaType, path: string) {
    for (const field of selection) {
      if (field.name === '...') {
        const inline = field.inlineType ? schema.types[field.inlineType] : undefined
        if (!inline) {
          add(`${path}... on ${field.inlineType}`, 'inline fragment names a type that is not in the snapshot')
          continue
        }
        walk(field.selection, inline, `${path}... on ${field.inlineType}.`)
        continue
      }

      // `__typename` is a meta field on every composite type.
      if (field.name === '__typename') continue

      const def = (type.fields ?? []).find((f) => f.name === field.name)
      if (!def) {
        const where = type.name === `Root${doc.kind}` ? `a root ${doc.kind} field (the root fields are plural: builds, workflowRuns, submissions, uploadSession)` : `a field of ${type.name}`
        add(`${path}${field.name}`, `"${field.name}" is not ${where}`)
        continue
      }

      for (const arg of field.args) {
        const argDef = (def.args ?? []).find((a) => a.name === arg.name)
        if (!argDef) {
          add(`${path}${field.name}(${arg.name}:)`, `"${arg.name}" is not an argument of ${type.name}.${field.name}`)
          continue
        }
        if (!arg.varName) continue
        const varType = declared.get(arg.varName)
        if (!varType) {
          add(`${path}${field.name}(${arg.name}: $${arg.varName})`, `$${arg.varName} is not declared`)
          continue
        }
        const expected = named(argDef.type).name
        if (expected && expected !== varType) {
          add(
            `${path}${field.name}(${arg.name}: $${arg.varName})`,
            `the argument is ${expected} but $${arg.varName} is ${varType}`,
          )
        }
      }

      const target = named(def.type)
      const targetType = target.name ? schema.types[target.name] : undefined
      if (field.selection.length > 0) {
        if (!targetType) {
          add(
            `${path}${field.name}`,
            `selects subfields on ${target.name ?? target.kind}, which has none — select the field bare and read the object it returns`,
          )
          continue
        }
        walk(field.selection, targetType, `${path}${field.name}.`)
      } else if (targetType && targetType.kind !== 'SCALAR' && targetType.kind !== 'ENUM') {
        add(`${path}${field.name}`, `selects ${targetType.name} but has no sub-selection`)
      }
    }
  }

  walk(doc.selection, root, '')
  return problems
}

describe('every EAS document is valid against the schema snapshot', () => {
  for (const [name, src] of Object.entries(DOCUMENTS)) {
    it(`${name}`, () => {
      expect(validateDocument(name, src)).toEqual([])
    })
  }

  it('covers the documents a release actually sends', () => {
    for (const required of [
      'createUploadSession',
      'createAccountScopedUploadSession',
      'createIosBuild',
      'createAndroidBuild',
      'createWorkflowRun',
      'getWorkflowRun',
      'getBuild',
      'createIosSubmission',
      'createAndroidSubmission',
    ]) {
      expect(Object.keys(DOCUMENTS)).toContain(required)
    }
  })
})

describe('the validator rejects the six defects it was written for', () => {
  const broken: Record<string, string> = {
    'a selection on JSONObject!': `mutation M($type: UploadSessionType!, $filename: String) {
      uploadSession { createUploadSession(type: $type, filename: $filename) { url bucketKey } }
    }`,
    'a JobInput type that does not exist': `mutation M($appId: ID!, $job: JobInput!) {
      build { createIosBuild(appId: $appId, job: $job) { build { id } } }
    }`,
    'the CreateBuildResult shape without its build wrapper': `mutation M($appId: ID!, $job: IosJobInput!) {
      build { createIosBuild(appId: $appId, job: $job) { id status } }
    }`,
    'a SubmissionInput that does not exist': `mutation M($input: SubmissionInput!) {
      submission { createIosSubmission(input: $input) { submission { id } } }
    }`,
    'the CreateSubmissionResult shape without its submission wrapper': `mutation M($input: CreateIosSubmissionInput!) {
      submission { createIosSubmission(input: $input) { id status } }
    }`,
    'a singular build root field': `query M($buildId: ID!) { build { byId(buildId: $buildId) { id status } } }`,
    'a singular workflow root field': `query M($workflowRunId: ID!) { workflowRun { byId(workflowRunId: $workflowRunId) { id } } }`,
    'the wrong argument type': `mutation M($appId: String!, $job: IosJobInput!) {
      build { createIosBuild(appId: $appId, job: $job) { build { id } } }
    }`,
  }

  for (const [label, src] of Object.entries(broken)) {
    it(`rejects ${label}`, () => {
      const problems = validateDocument('broken', src)
      expect(problems.length).toBeGreaterThan(0)
    })
  }
})
