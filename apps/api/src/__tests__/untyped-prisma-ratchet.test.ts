// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Ratchet on untyped Prisma clients (`prisma as any`, `(tx as any)`,
 * `db as unknown as …`) in API source.
 *
 * A cast client turns an invalid query (a field or relation the schema
 * doesn't have) from a type error into a runtime PrismaClientValidationError
 * that only shows up in production. SHO-459 shipped three that way: a
 * banned-linked count that 500'd /api/billing/workspace-plan and locked models
 * on every grant workspace, and two ban side effects that silently never ran.
 *
 * Counts per file may only go down. To add a genuinely dynamic access (e.g.
 * `tx[delegateName]`), raise that file's entry in untyped-prisma-baseline.json
 * in the same PR and say why in the review. When you remove one, lower it.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'

const SRC = resolve(import.meta.dir, '..')
const BASELINE_PATH = join(import.meta.dir, 'untyped-prisma-baseline.json')
const UNTYPED = /\b(?:prisma|tx|db|trx)\s+as\s+(?:any|unknown)\b/g

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      return name === '__tests__' || name === 'generated' || name === 'node_modules' ? [] : sourceFiles(path)
    }
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

export function countUntypedPrisma(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const file of sourceFiles(SRC)) {
    const n = readFileSync(file, 'utf-8').match(UNTYPED)?.length ?? 0
    if (n) counts[relative(SRC, file)] = n
  }
  return counts
}

describe('untyped Prisma client ratchet', () => {
  const baseline: Record<string, number> = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'))
  const current = countUntypedPrisma()

  test('no file gains an untyped Prisma client', () => {
    const grew = Object.entries(current)
      .filter(([file, n]) => n > (baseline[file] ?? 0))
      .map(([file, n]) => `${file}: ${baseline[file] ?? 0} → ${n}`)
    expect(grew, `Type these Prisma calls instead of casting the client (see the header of this test):\n${grew.join('\n')}`).toEqual([])
  })

  test('the baseline is tight (lower it when you remove a cast)', () => {
    const stale = Object.entries(baseline)
      .filter(([file, n]) => (current[file] ?? 0) < n)
      .map(([file, n]) => `${file}: baseline ${n}, now ${current[file] ?? 0}`)
    expect(stale, `Lower these entries in untyped-prisma-baseline.json:\n${stale.join('\n')}`).toEqual([])
  })
})
