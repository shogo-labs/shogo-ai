// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Schema-grading contract for the skill-server TEMPLATE evals.
 *
 * The canvas/STACK prompts mandate the additive Prisma workflow: `read_file`
 * the seeded schema, then `edit_file` to APPEND new models — never rewrite the
 * file. Earlier the graders only inspected `write_file('schema.prisma')`, so a
 * correct agent that appended `model Deal {...}` via `edit_file` scored 0 on
 * every schema criterion (confirmed in the sales-pipeline eval logs).
 *
 * These tests pin the fixed behavior:
 *  - `wrote-schema-with-models` / `deal-has-pipeline-fields` credit an
 *    `edit_file`-append.
 *  - `schema-prisma7` is a "did not regress" check: it passes when the seeded
 *    Prisma 7 generator is left intact and fails only when the agent
 *    reintroduces legacy Prisma 6 syntax (`prisma-client-js` / a `url =`).
 */

import { describe, test, expect } from 'bun:test'
import { SKILL_SERVER_TEMPLATE_EVALS } from './test-cases-skill-server-templates'
import type { EvalResult, ToolCallRecord, ValidationCriterion } from './types'

const salesPipeline = SKILL_SERVER_TEMPLATE_EVALS.find(
  (e) => e.id === 'skill-server-tpl-sales-pipeline',
)!

function criterion(id: string): ValidationCriterion {
  const c = salesPipeline.validationCriteria.find((c) => c.id === id)
  if (!c) throw new Error(`criterion ${id} not found`)
  return c
}

/** Build a minimal EvalResult; the schema graders only read `toolCalls`. */
function resultWith(toolCalls: ToolCallRecord[]): EvalResult {
  return { toolCalls, finalTurnToolCalls: toolCalls } as unknown as EvalResult
}

function editFile(path: string, newString: string): ToolCallRecord {
  return { name: 'edit_file', input: { path, new_string: newString }, output: { ok: true } }
}

function writeFile(path: string, content: string): ToolCallRecord {
  return { name: 'write_file', input: { path, content }, output: { ok: true } }
}

// A realistic edit_file-append: only the new models, generator/datasource untouched.
const DEAL_AND_CONTACT_APPEND = `
model Deal {
  id          Int      @id @default(autoincrement())
  value       Float
  stage       String
  probability Float
  closeDate   DateTime
  contactId   Int
  contact     Contact  @relation(fields: [contactId], references: [id])
}

model Contact {
  id      Int    @id @default(autoincrement())
  name    String
  email   String
  company String
  role    String
  deals   Deal[]
}
`

describe('skill-server template schema graders (edit_file-append workflow)', () => {
  test('wrote-schema-with-models credits an edit_file append of Deal + Contact', () => {
    const r = resultWith([
      { name: 'read_file', input: { path: 'prisma/schema.prisma' }, output: '' },
      editFile('prisma/schema.prisma', DEAL_AND_CONTACT_APPEND),
    ])
    expect(criterion('wrote-schema-with-models').validate(r)).toBe(true)
  })

  test('deal-has-pipeline-fields credits fields added via edit_file', () => {
    const r = resultWith([editFile('prisma/schema.prisma', DEAL_AND_CONTACT_APPEND)])
    expect(criterion('deal-has-pipeline-fields').validate(r)).toBe(true)
  })

  test('schema-prisma7 passes when the seeded generator is left intact (append only)', () => {
    const r = resultWith([editFile('prisma/schema.prisma', DEAL_AND_CONTACT_APPEND)])
    expect(criterion('schema-prisma7').validate(r)).toBe(true)
  })

  test('schema-prisma7 fails when the agent reintroduces the legacy prisma-client-js generator', () => {
    const legacy = `
generator client {
  provider = "prisma-client-js"
}
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
${DEAL_AND_CONTACT_APPEND}`
    const r = resultWith([writeFile('prisma/schema.prisma', legacy)])
    expect(criterion('schema-prisma7').validate(r)).toBe(false)
  })

  test('schema-prisma7 fails when a datasource url is introduced via edit_file', () => {
    const r = resultWith([
      editFile('prisma/schema.prisma', 'datasource db {\n  provider = "sqlite"\n  url = "file:./dev.db"\n}'),
    ])
    expect(criterion('schema-prisma7').validate(r)).toBe(false)
  })

  test('schema graders return false when the agent never touched schema.prisma', () => {
    const r = resultWith([writeFile('src/App.tsx', 'export default function App() {}')])
    expect(criterion('wrote-schema-with-models').validate(r)).toBe(false)
    expect(criterion('schema-prisma7').validate(r)).toBe(false)
    expect(criterion('deal-has-pipeline-fields').validate(r)).toBe(false)
  })
})
