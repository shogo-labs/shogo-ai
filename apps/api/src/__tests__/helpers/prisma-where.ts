// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The slice of Prisma's `where` these test fakes have to understand.
 *
 * A fake that only compares `where.workspaceId` stops working the moment a
 * route asks a real question — "this workspace, or any row of the caller's
 * desktop" is an `OR` with a nested `kind: { not: … }`, and a fake that ignores
 * it silently returns nothing, which reads as a broken route instead of a
 * broken fake (SHO-241).
 */

/** Equality, `not`, `in`, `equals`, plus `OR` / `AND` / `NOT` over the same shape. */
export function matchesWhere(row: Record<string, any>, where: any): boolean {
  if (!where) return true

  for (const [key, expected] of Object.entries(where)) {
    if (key === 'OR') {
      const clauses = expected as any[]
      if (Array.isArray(clauses) && clauses.length && !clauses.some((c) => matchesWhere(row, c))) {
        return false
      }
      continue
    }
    if (key === 'AND') {
      const clauses = Array.isArray(expected) ? expected : [expected]
      if (!clauses.every((c) => matchesWhere(row, c))) return false
      continue
    }
    if (key === 'NOT') {
      if (matchesWhere(row, expected)) return false
      continue
    }

    const actual = row[key]
    if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
      const operator = expected as Record<string, any>
      if ('not' in operator && actual === operator.not) return false
      if ('in' in operator && !(operator.in as any[]).includes(actual)) return false
      if ('equals' in operator && actual !== operator.equals) return false
      continue
    }
    if (actual !== expected) return false
  }

  return true
}
