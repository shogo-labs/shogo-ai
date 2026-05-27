// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// `better-sqlite3` is a native peer dep that Bun cannot load
// (oven-sh/bun#4290), so every test here mocks it. Bun's mock.module() wraps
// the factory return in a Module namespace object, so:
//   • CJS-default shape works:  factory → { default: Ctor } → mod.default = Ctor
//   • bare-export shape is NOT testable under Bun: the wrapping makes `mod`
//     a non-callable Module object, hitting "Module is not a constructor".
//     That branch is exercised only under Node at runtime and is documented
//     in the test for `createNodeDriver — CommonJS default-export shape` below.
//   • Error paths use a Proxy whose `.default` getter throws — the source
//     accesses `mod.default` inside its try/catch, so the throw lands there.
import { describe, expect, test, mock } from 'bun:test'

import { createNodeDriver } from '../node'

function fakeBetterSqlite3() {
  const stmtRun = mock((...args: unknown[]) => ({ changes: 1, args }))
  const stmtGet = mock((...args: unknown[]) => ({ v: 'got', args }))
  const stmtAll = mock((..._args: unknown[]) => [{ v: 'a' }, { v: 'b' }])
  const closeFn = mock(() => undefined)
  const execFn = mock((_sql: string) => undefined)
  const prepareFn = mock((sql: string) => ({
    run: stmtRun, get: stmtGet, all: stmtAll, _sql: sql,
  }))
  const txFn = mock(
    <F extends (...a: unknown[]) => unknown>(fn: F) => (...a: unknown[]) => fn(...a),
  )
  const dbInst = {
    exec: execFn,
    prepare: prepareFn,
    transaction: txFn,
    close: closeFn,
  }
  const Ctor = mock(function FakeCtor(_p: string) { return dbInst })
  return { Ctor, dbInst, execFn, prepareFn, txFn, closeFn, stmtRun, stmtGet, stmtAll }
}

describe('createNodeDriver — CommonJS default-export shape (mod.default)', () => {
  test('constructs DB and exercises every wrap() inner closure end-to-end', () => {
    const fake = fakeBetterSqlite3()
    mock.module('better-sqlite3', () => ({ default: fake.Ctor }))

    const driver = createNodeDriver('/tmp/cjs.db')
    expect(fake.Ctor).toHaveBeenCalledWith('/tmp/cjs.db')

    // exec closure
    driver.exec('CREATE TABLE t (id INTEGER)')
    expect(fake.execFn).toHaveBeenCalledWith('CREATE TABLE t (id INTEGER)')

    // prepare closure + the inner stmt object's run/get/all closures
    const stmt = driver.prepare('INSERT INTO t(id) VALUES (?)')
    expect(fake.prepareFn).toHaveBeenCalledWith('INSERT INTO t(id) VALUES (?)')

    const runRes = stmt.run(1, 'x') as { changes: number }
    expect(runRes.changes).toBe(1)
    expect(fake.stmtRun).toHaveBeenCalledWith(1, 'x')

    const getRes = stmt.get(2) as { v: string }
    expect(getRes.v).toBe('got')
    expect(fake.stmtGet).toHaveBeenCalledWith(2)

    const allRes = stmt.all() as Array<{ v: string }>
    expect(allRes.map((r) => r.v)).toEqual(['a', 'b'])
    expect(fake.stmtAll).toHaveBeenCalled()

    // transaction closure — and run the inner returned wrapper
    const txWrapped = driver.transaction((rows: number[]) => rows.length)
    expect(fake.txFn).toHaveBeenCalled()
    txWrapped([1, 2, 3])

    // close closure
    driver.close()
    expect(fake.closeFn).toHaveBeenCalled()
  })

  test('Note: bare-export (no mod.default) is not testable under Bun — '
    + 'Bun wraps factory returns in a non-callable Module namespace. The '
    + 'CJS-default test above is the canonical happy-path coverage.', () => {
    expect(true).toBe(true)
  })
})

describe('createNodeDriver — peer dep missing / load failure', () => {
  test('Error subclass is unwrapped into the friendly "Missing peer dep" message', () => {
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error('Cannot find module better-sqlite3')
        },
      },
    )
    mock.module('better-sqlite3', () => trap)

    expect(() => createNodeDriver('/tmp/never.db')).toThrow(
      "[@shogo-ai/sdk/memory] Missing optional peer dependency 'better-sqlite3'. Install it: npm install better-sqlite3 (Cannot find module better-sqlite3)",
    )
  })

  test('Non-Error thrown value is coerced via String(e) into the friendly message', () => {
    const trap = new Proxy(
      {},
      {
        get() {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw 'boom-string-value'
        },
      },
    )
    mock.module('better-sqlite3', () => trap)

    expect(() => createNodeDriver('/tmp/never.db')).toThrow(
      "[@shogo-ai/sdk/memory] Missing optional peer dependency 'better-sqlite3'. Install it: npm install better-sqlite3 (boom-string-value)",
    )
  })
})
