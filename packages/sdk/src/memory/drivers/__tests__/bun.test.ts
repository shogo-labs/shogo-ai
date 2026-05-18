// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBunDriver, isBunRuntime } from '../bun'

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

  // Note: the `!isBunRuntime()` branch is unreachable from inside `bun test`
  // because `globalThis.Bun` is a hard binding owned by the runtime and
  // cannot be `delete`d. The branch is exercised in the Node-side driver
  // suite (`node.ts`) by symmetry.

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
})
