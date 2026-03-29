// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Python diagnostics smoke test — validates pyright CLI integration:
 *   1. Create WorkspaceLSPManager with pyright CLI path
 *   2. Write a .py file with a known type error
 *   3. Notify the manager → marks file dirty
 *   4. getDiagnosticsAsync triggers pyright CLI → verify errors
 *   5. Fix the file → verify diagnostics clear
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { realpathSync } from 'node:fs'
import { WorkspaceLSPManager } from '@shogo/shared-runtime'

const WORKSPACE = realpathSync('/tmp') + '/test-python-diag-smoke'
const PYRIGHT_BIN = resolve(__dirname, '../../node_modules/.bin/pyright')

const PYRIGHTCONFIG = JSON.stringify({
  pythonVersion: '3.11',
  typeCheckingMode: 'basic',
}, null, 2)

const BAD_PYTHON_CODE = `def greet(name: str) -> str:
    return "Hello, " + name

result: int = greet("world")
`

const GOOD_PYTHON_CODE = `def greet(name: str) -> str:
    return "Hello, " + name

result: str = greet("world")
`

let manager: WorkspaceLSPManager

describe('Python diagnostics smoke test (pyright CLI)', () => {
  beforeAll(async () => {
    rmSync(WORKSPACE, { recursive: true, force: true })
    mkdirSync(WORKSPACE, { recursive: true })
    writeFileSync(join(WORKSPACE, 'pyrightconfig.json'), PYRIGHTCONFIG, 'utf-8')

    manager = new WorkspaceLSPManager({
      projectDir: WORKSPACE,
      pyrightBin: PYRIGHT_BIN,
    })
    await manager.startAll()
  }, 15_000)

  afterAll(() => {
    manager?.stop()
    rmSync(WORKSPACE, { recursive: true, force: true })
  })

  test('detects type error in Python file', async () => {
    const filePath = join(WORKSPACE, 'main.py')
    writeFileSync(filePath, BAD_PYTHON_CODE, 'utf-8')
    manager.notifyFileChanged(filePath, BAD_PYTHON_CODE)

    const allDiags = await manager.getDiagnosticsAsync()

    let fileDiags: any[] = []
    for (const [uri, diags] of allDiags) {
      if (uri.endsWith('main.py')) {
        fileDiags = diags
        break
      }
    }

    console.log(`[py-smoke] Got ${fileDiags.length} diagnostics:`)
    fileDiags.forEach(d => {
      console.log(`  Line ${d.range.start.line + 1}: [sev=${d.severity}] ${d.message}`)
    })

    const typeError = fileDiags.find(d =>
      d.severity === 1 && (d.message.includes('int') || d.message.includes('str'))
    )
    expect(typeError).toBeTruthy()
  }, 15_000)

  test('diagnostics clear after fixing the type error', async () => {
    const filePath = join(WORKSPACE, 'main.py')
    writeFileSync(filePath, GOOD_PYTHON_CODE, 'utf-8')
    manager.notifyFileChanged(filePath, GOOD_PYTHON_CODE)

    const allDiags = await manager.getDiagnosticsAsync()

    let fileDiags: any[] = []
    for (const [uri, diags] of allDiags) {
      if (uri.endsWith('main.py')) {
        fileDiags = diags
        break
      }
    }

    const errors = fileDiags.filter(d => d.severity === 1)
    console.log(`[py-smoke] After fix: ${errors.length} errors remaining`)
    expect(errors.length).toBe(0)
  }, 15_000)
})
