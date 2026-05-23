// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, mock } from 'bun:test'

describe('createNodeDriver — missing peer dependency', () => {
  test('catches require failure and rethrows with peer-dep guidance', async () => {
    mock.module('better-sqlite3', () => {
      throw new Error('Cannot find module \'better-sqlite3\'')
    })
    const { createNodeDriver } = await import('../node')
    expect(() => createNodeDriver('/tmp/should-not-be-created.db')).toThrow(
      /Missing optional peer dependency 'better-sqlite3'/,
    )
  })

  test('catches non-Error throwable from require (String fallback)', async () => {
    mock.module('better-sqlite3', () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'plain string failure'
    })
    const { createNodeDriver } = await import('../node')
    expect(() => createNodeDriver('/tmp/should-not-be-created-2.db')).toThrow(
      /plain string failure/,
    )
  })
})

describe('createNodeDriver — happy path via mocked better-sqlite3', () => {
  test('wraps better-sqlite3 statements through SqliteDriver methods', async () => {
    const execCalls: string[] = []
    const runCalls: unknown[][] = []
    const getCalls: unknown[][] = []
    const allCalls: unknown[][] = []
    let txWrapped: ((...args: unknown[]) => void) | null = null
    let closeCalled = false

    class FakeDB {
      constructor(public path: string) {}
      exec(sql: string) { execCalls.push(sql) }
      prepare(_sql: string) {
        return {
          run: (...args: unknown[]) => { runCalls.push(args); return { changes: 1 } },
          get: (...args: unknown[]) => { getCalls.push(args); return { value: 42 } },
          all: (...args: unknown[]) => { allCalls.push(args); return [{ id: 1 }, { id: 2 }] },
        }
      }
      transaction<F extends (...args: unknown[]) => unknown>(fn: F) {
        txWrapped = (...args: unknown[]) => { fn(...args) }
        return txWrapped as (...args: Parameters<F>) => void
      }
      close() { closeCalled = true }
    }

    mock.module('better-sqlite3', () => ({ default: FakeDB }))

    const { createNodeDriver } = await import('../node')
    const driver = createNodeDriver('/tmp/fake.db')

    driver.exec('CREATE TABLE t (id INTEGER)')
    expect(execCalls).toEqual(['CREATE TABLE t (id INTEGER)'])

    const stmt = driver.prepare('SELECT * FROM t WHERE id = ?')
    expect(stmt.run(1)).toEqual({ changes: 1 })
    expect(runCalls).toEqual([[1]])
    expect(stmt.get(2)).toEqual({ value: 42 })
    expect(getCalls).toEqual([[2]])
    expect(stmt.all(3, 4)).toEqual([{ id: 1 }, { id: 2 }])
    expect(allCalls).toEqual([[3, 4]])

    const txFn = (a: number, b: number) => a + b
    const wrapped = driver.transaction(txFn)
    expect(typeof wrapped).toBe('function')
    wrapped(2, 3)
    expect(txWrapped).not.toBeNull()

    driver.close()
    expect(closeCalled).toBe(true)
  })

  test('handles CJS modules where better-sqlite3 has no `default` export', async () => {
    class FakeDBCjs {
      constructor(_path: string) {}
      exec() {}
      prepare() {
        return { run: () => undefined, get: () => undefined, all: () => [] }
      }
      transaction<F extends (...args: unknown[]) => unknown>(_fn: F) {
        return ((..._args: unknown[]) => undefined) as (...args: Parameters<F>) => void
      }
      close() {}
    }

    mock.module('better-sqlite3', () => FakeDBCjs)

    const { createNodeDriver } = await import('../node')
    const driver = createNodeDriver('/tmp/fake-cjs.db')
    expect(driver).toBeDefined()
    expect(typeof driver.exec).toBe('function')
    expect(typeof driver.prepare).toBe('function')
    expect(typeof driver.transaction).toBe('function')
    expect(typeof driver.close).toBe('function')
  })
})
