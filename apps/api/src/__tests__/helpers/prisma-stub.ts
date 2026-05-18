// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Lightweight in-memory Prisma stub for route and service tests.
 *
 * Why not a real sqlite-backed Prisma client?
 *
 *   The actual Prisma client takes ~1.5s per test process to boot, and
 *   bun's `mock.module('../lib/prisma', ...)` factory has to return its
 *   value synchronously. A real sqlite database also requires running
 *   migrations, which adds another ~3s per file. Multiplied across the
 *   ~80 test files apps/api ships, the runtime cost is unacceptable
 *   for what most route tests need (predictable row shapes, not
 *   actual SQL semantics).
 *
 * What this stub gives you:
 *
 *   1. A `prisma`-shaped object with `findFirst` / `findUnique` /
 *      `findMany` / `create` / `update` / `upsert` / `delete` / `count`
 *      / `aggregate` / `groupBy` implementations backed by a Map.
 *   2. A `$transaction(callback)` that just invokes the callback with
 *      the same client (no real isolation).
 *   3. A `$queryRaw` / `$executeRaw` that returns whatever a test
 *      configures via `setRawResponse`.
 *   4. Per-table seeding via `seed(table, rows)`.
 *
 * Use together with `withPrismaExports({ prisma })` from
 * `prisma-mock-exports.ts` so every named Prisma re-export is
 * satisfied.
 */

type Row = Record<string, any>

interface QueryOptions {
  where?: Record<string, any>
  orderBy?: any
  take?: number
  skip?: number
  include?: any
  select?: any
  data?: any
  create?: any
  update?: any
  by?: string[]
  _count?: any
  _sum?: any
  _avg?: any
  _min?: any
  _max?: any
}

function matchValue(value: any, criteria: any): boolean {
  if (criteria === undefined) return true
  if (criteria === null) return value === null || value === undefined
  if (typeof criteria !== 'object' || criteria instanceof Date) {
    return value === criteria
  }
  // Prisma-style operator object: { gt: 5, lte: 10, in: [...], not: ..., contains: '...' }
  for (const [op, opVal] of Object.entries(criteria)) {
    switch (op) {
      case 'equals': if (value !== opVal) return false; break
      case 'not': if (value === opVal) return false; break
      case 'in': if (!Array.isArray(opVal) || !opVal.includes(value)) return false; break
      case 'notIn': if (Array.isArray(opVal) && opVal.includes(value)) return false; break
      case 'gt': if (!(value > (opVal as any))) return false; break
      case 'gte': if (!(value >= (opVal as any))) return false; break
      case 'lt': if (!(value < (opVal as any))) return false; break
      case 'lte': if (!(value <= (opVal as any))) return false; break
      case 'contains': if (typeof value !== 'string' || !value.includes(String(opVal))) return false; break
      case 'startsWith': if (typeof value !== 'string' || !value.startsWith(String(opVal))) return false; break
      case 'endsWith': if (typeof value !== 'string' || !value.endsWith(String(opVal))) return false; break
      default:
        // Treat unrecognised keys as exact match on a nested field path
        if ((value as any)?.[op] !== opVal) return false
    }
  }
  return true
}

function matchesWhere(row: Row, where: Record<string, any> | undefined): boolean {
  if (!where) return true
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND') {
      if (!Array.isArray(v) || !v.every((sub: any) => matchesWhere(row, sub))) return false
      continue
    }
    if (k === 'OR') {
      if (!Array.isArray(v) || !v.some((sub: any) => matchesWhere(row, sub))) return false
      continue
    }
    if (k === 'NOT') {
      if (matchesWhere(row, v as Record<string, any>)) return false
      continue
    }
    if (!matchValue(row[k], v)) return false
  }
  return true
}

function applyOrderBy(rows: Row[], orderBy: any): Row[] {
  if (!orderBy) return rows
  const orders = Array.isArray(orderBy) ? orderBy : [orderBy]
  return [...rows].sort((a, b) => {
    for (const o of orders) {
      for (const [k, dir] of Object.entries(o)) {
        const av = a[k]
        const bv = b[k]
        if (av === bv) continue
        const cmp = av > bv ? 1 : -1
        return dir === 'desc' ? -cmp : cmp
      }
    }
    return 0
  })
}

export interface PrismaStubOptions {
  /** Optional initial rows keyed by table name. */
  seed?: Record<string, Row[]>
  /** Optional list of supported table names (auto-creates extra tables). */
  tables?: string[]
}

export class PrismaStub {
  // table name -> rows
  private tables = new Map<string, Row[]>()
  private rawResponses = new Map<string, any>()
  // For tests that want to introspect what was written/queried.
  public readonly calls: { table: string; op: string; args: any }[] = []

  constructor(opts: PrismaStubOptions = {}) {
    for (const name of opts.tables ?? []) {
      this.tables.set(name, [])
    }
    for (const [name, rows] of Object.entries(opts.seed ?? {})) {
      this.tables.set(name, [...rows])
    }
  }

  /** Insert (or replace) the contents of a table. */
  seed(table: string, rows: Row[]): void {
    this.tables.set(table, [...rows])
  }

  /** Read a table's current contents (defensive copy). */
  rows(table: string): Row[] {
    return [...(this.tables.get(table) ?? [])]
  }

  /** Configure the response for the next `$queryRaw` / `$executeRaw` call matching `match`. */
  setRawResponse(match: string, response: any): void {
    this.rawResponses.set(match, response)
  }

  /**
   * Returns a Prisma-like client. Each property access on the returned
   * object creates a "model accessor" with the standard methods.
   */
  client(): any {
    const self = this
    return new Proxy({}, {
      get(_t, prop: string) {
        if (prop === '$transaction') {
          return async (arg: any) => {
            if (typeof arg === 'function') return arg(self.client())
            if (Array.isArray(arg)) return Promise.all(arg)
            return arg
          }
        }
        if (prop === '$queryRaw' || prop === '$executeRaw' || prop === '$queryRawUnsafe' || prop === '$executeRawUnsafe') {
          return async (...args: any[]) => {
            const key = typeof args[0] === 'string' ? args[0] : (args[0]?.values ?? args[0]?.[0] ?? '').toString()
            for (const [match, resp] of self.rawResponses) {
              if (key.includes(match)) {
                return typeof resp === 'function' ? resp(...args) : resp
              }
            }
            // Default: empty result for SELECT-style, 0 for execute-style.
            return prop.startsWith('$query') ? [] : 0
          }
        }
        if (prop === '$connect' || prop === '$disconnect') return async () => {}
        if (prop === '$extends') return () => self.client()
        if (prop === '$on') return () => {}
        if (prop === '$use') return () => {}
        // Symbol / Promise-thenable interop guards (mock.module unwraps).
        if (typeof prop === 'symbol' || prop === 'then') return undefined
        return self.modelAccessor(prop)
      },
    })
  }

  private modelAccessor(table: string) {
    const self = this
    const ensure = () => {
      if (!self.tables.has(table)) self.tables.set(table, [])
      return self.tables.get(table)!
    }
    const record = (op: string, args: any) => {
      self.calls.push({ table, op, args })
    }
    return {
      findFirst: async (args: QueryOptions = {}) => {
        record('findFirst', args)
        const rows = applyOrderBy(ensure().filter((r) => matchesWhere(r, args.where)), args.orderBy)
        return rows[0] ?? null
      },
      findUnique: async (args: QueryOptions = {}) => {
        record('findUnique', args)
        const rows = ensure().filter((r) => matchesWhere(r, args.where))
        return rows[0] ?? null
      },
      findUniqueOrThrow: async (args: QueryOptions = {}) => {
        record('findUniqueOrThrow', args)
        const rows = ensure().filter((r) => matchesWhere(r, args.where))
        if (!rows[0]) throw new Error(`No ${table} record found`)
        return rows[0]
      },
      findMany: async (args: QueryOptions = {}) => {
        record('findMany', args)
        let rows = ensure().filter((r) => matchesWhere(r, args.where))
        rows = applyOrderBy(rows, args.orderBy)
        if (args.skip) rows = rows.slice(args.skip)
        if (args.take != null) rows = rows.slice(0, args.take)
        return rows
      },
      count: async (args: QueryOptions = {}) => {
        record('count', args)
        return ensure().filter((r) => matchesWhere(r, args.where)).length
      },
      aggregate: async (args: any = {}) => {
        record('aggregate', args)
        const rows = ensure().filter((r) => matchesWhere(r, args.where))
        const result: any = {}
        if (args._count) result._count = typeof args._count === 'object'
          ? Object.fromEntries(Object.keys(args._count).map((k) => [k, rows.filter((r) => r[k] != null).length]))
          : rows.length
        for (const fnName of ['_sum', '_avg', '_min', '_max'] as const) {
          if (!args[fnName]) continue
          const fields = args[fnName]
          const out: any = {}
          for (const f of Object.keys(fields)) {
            const vals = rows.map((r) => r[f]).filter((v) => typeof v === 'number')
            if (fnName === '_sum') out[f] = vals.reduce((a, b) => a + b, 0)
            else if (fnName === '_avg') out[f] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
            else if (fnName === '_min') out[f] = vals.length ? Math.min(...vals) : null
            else if (fnName === '_max') out[f] = vals.length ? Math.max(...vals) : null
          }
          result[fnName] = out
        }
        return result
      },
      groupBy: async (args: any = {}) => {
        record('groupBy', args)
        const rows = ensure().filter((r) => matchesWhere(r, args.where))
        const groups = new Map<string, Row[]>()
        for (const r of rows) {
          const key = (args.by ?? []).map((k: string) => r[k]).join('\u0000')
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key)!.push(r)
        }
        return [...groups.values()].map((grp) => {
          const sample = grp[0]
          const out: any = {}
          for (const k of args.by ?? []) out[k] = sample[k]
          if (args._count) out._count = typeof args._count === 'object'
            ? Object.fromEntries(Object.keys(args._count).map((k) => [k, grp.length]))
            : grp.length
          for (const fnName of ['_sum', '_avg', '_min', '_max'] as const) {
            if (!args[fnName]) continue
            const outFn: any = {}
            for (const f of Object.keys(args[fnName])) {
              const vals = grp.map((r) => r[f]).filter((v) => typeof v === 'number')
              if (fnName === '_sum') outFn[f] = vals.reduce((a, b) => a + b, 0)
              else if (fnName === '_avg') outFn[f] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
              else if (fnName === '_min') outFn[f] = vals.length ? Math.min(...vals) : null
              else if (fnName === '_max') outFn[f] = vals.length ? Math.max(...vals) : null
            }
            out[fnName] = outFn
          }
          return out
        })
      },
      create: async (args: any = {}) => {
        record('create', args)
        const row = { ...args.data }
        ensure().push(row)
        return row
      },
      createMany: async (args: any = {}) => {
        record('createMany', args)
        const rows = Array.isArray(args.data) ? args.data : [args.data]
        for (const r of rows) ensure().push({ ...r })
        return { count: rows.length }
      },
      update: async (args: any = {}) => {
        record('update', args)
        const rows = ensure()
        const idx = rows.findIndex((r) => matchesWhere(r, args.where))
        if (idx === -1) throw new Error(`No ${table} record to update`)
        rows[idx] = { ...rows[idx], ...args.data }
        return rows[idx]
      },
      updateMany: async (args: any = {}) => {
        record('updateMany', args)
        const rows = ensure()
        let count = 0
        for (let i = 0; i < rows.length; i++) {
          if (matchesWhere(rows[i], args.where)) {
            rows[i] = { ...rows[i], ...args.data }
            count++
          }
        }
        return { count }
      },
      upsert: async (args: any = {}) => {
        record('upsert', args)
        const rows = ensure()
        const idx = rows.findIndex((r) => matchesWhere(r, args.where))
        if (idx === -1) {
          const row = { ...args.create }
          rows.push(row)
          return row
        }
        rows[idx] = { ...rows[idx], ...args.update }
        return rows[idx]
      },
      delete: async (args: any = {}) => {
        record('delete', args)
        const rows = ensure()
        const idx = rows.findIndex((r) => matchesWhere(r, args.where))
        if (idx === -1) throw new Error(`No ${table} record to delete`)
        const [row] = rows.splice(idx, 1)
        return row
      },
      deleteMany: async (args: any = {}) => {
        record('deleteMany', args)
        const rows = ensure()
        let count = 0
        for (let i = rows.length - 1; i >= 0; i--) {
          if (matchesWhere(rows[i], args.where)) {
            rows.splice(i, 1)
            count++
          }
        }
        return { count }
      },
    }
  }
}

/**
 * Convenience helper: create a stub, seed it, and return it together
 * with the proxied client. Most tests want both.
 */
export function makePrismaStub(opts: PrismaStubOptions = {}): { stub: PrismaStub; prisma: any } {
  const stub = new PrismaStub(opts)
  return { stub, prisma: stub.client() }
}
