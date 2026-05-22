// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _bunRuntimeGuardForTests, createBunDriver, isBunRuntime } from '../bun'

describe('bun sqlite driver', () => {
  let tmp: string | null = null

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true })
      tmp = null
    }
  })

  test('isBunRuntime returns true when running under Bun', () => {
    expect(isBunRuntime()).toBe(true)
  })

  test('createBunDriver throws when the runtime guard reports non-Bun', () => {
    // `globalThis.Bun` is a non-configurable, non-writable binding under
    // `bun test`, so we cannot trick `isBunRuntime()` itself into returning
    // false. The exported `_bunRuntimeGuardForTests` indirection is the test
    // seam — swap its `.check` for one tick, prove the throw fires, restore.
    const orig = _bunRuntimeGuardForTests.check
    _bunRuntimeGuardForTests.check = () => false
    try {
      expect(() => createBunDriver('/tmp/shogo-bun-driver-unreachable.db')).toThrow(
        '[@shogo-ai/sdk/memory] bun:sqlite driver requires Bun runtime',
      )
    } finally {
      _bunRuntimeGuardForTests.check = orig
    }
    // Sanity: the seam is restored — subsequent calls use the real
    // isBunRuntime() and would succeed.
    expect(_bunRuntimeGuardForTests.check()).toBe(true)
  })

  test('createBunDriver opens a real database and exposes exec/prepare', () => {
    tmp = mkdtempSync(join(tmpdir(), 'shogo-bun-driver-'))
    const driver = createBunDriver(join(tmp, 'test.db'))
    driver.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    const insert = driver.prepare('INSERT INTO t (v) VALUES (?)')
    insert.run('hello')
    const row = driver.prepare('SELECT v FROM t WHERE id = ?').get(1) as { v: string }
    expect(row.v).toBe('hello')
    driver.close()
  })

  test('wrapped driver exposes stmt.all and transaction()', () => {
    // Exercises the two inner-closure wrappers inside wrap() that the basic
    // round-trip test doesn't touch — `prepare(...).all` and the
    // `transaction()` factory. Bun's instrumentation counts each arrow inside
    // the returned object literal as its own function, so both need to be
    // physically invoked to flip the file from 80% funcs to 100%.
    tmp = mkdtempSync(join(tmpdir(), 'shogo-bun-driver-all-tx-'))
    const driver = createBunDriver(join(tmp, 'test.db'))
    driver.exec('CREATE TABLE k (id INTEGER PRIMARY KEY, v TEXT)')

    const insert = driver.prepare('INSERT INTO k (v) VALUES (?)')
    const seed = driver.transaction((rows: string[]) => {
      for (const r of rows) insert.run(r)
    })
    seed(['a', 'b', 'c'])

    const all = driver.prepare('SELECT v FROM k ORDER BY id').all() as Array<{ v: string }>
    expect(all.map((r) => r.v)).toEqual(['a', 'b', 'c'])

    driver.close()
  })
})
