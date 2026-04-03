// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WorkspaceLSPManager integration test — validates multi-language routing:
 *   1. Start WorkspaceLSPManager with both TS LSP and Python CLI
 *   2. Notify a bad .ts file → verify TS diagnostics
 *   3. Notify a bad .py file → verify Python diagnostics
 *   4. getDiagnosticsAsync() aggregates from both backends
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, copyFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { realpathSync } from 'node:fs'
import { WorkspaceLSPManager, resolveBin } from '@shogo/shared-runtime'

const WORKSPACE = realpathSync('/tmp') + '/test-workspace-lsp-mgr'
const pkgDir = resolve(__dirname, '../..')
const tsResult = resolveBin('typescript-language-server', [pkgDir], 'lib/cli.mjs')
const pyResult = resolveBin('pyright', [pkgDir])
const TS_BIN = tsResult?.resolved ?? resolve(pkgDir, 'node_modules/.bin/typescript-language-server')
const PY_BIN = pyResult?.resolved ?? resolve(pkgDir, 'node_modules/.bin/pyright')
const CANVAS_GLOBALS_SRC = resolve(__dirname, '../../../canvas-runtime/src/canvas-globals.d.ts')

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2020', module: 'none', jsx: 'react', jsxFactory: 'h',
    strict: false, noEmit: true, skipLibCheck: true, noLib: false,
  },
  include: ['**/*.ts', '**/*.d.ts'],
  exclude: ['node_modules'],
}, null, 2)

const REACT_SHIM = `declare namespace React {
  type ReactNode = string | number | boolean | null | undefined;
  type ReactElement = { type: any; props: any; key: any };
  type FC<P = {}> = (props: P) => ReactElement | null;
  function createElement(type: any, props?: any, ...children: any[]): ReactElement;
}
`

const PYRIGHTCONFIG = JSON.stringify({
  pythonVersion: '3.11',
  typeCheckingMode: 'basic',
}, null, 2)

const BAD_TS = `const x: number = "not a number"\n`
const BAD_PY = `def add(a: int, b: int) -> int:\n    return a + b\n\nresult: str = add(1, 2)\n`

let manager: WorkspaceLSPManager

describe('WorkspaceLSPManager integration', () => {
  beforeAll(async () => {
    rmSync(WORKSPACE, { recursive: true, force: true })
    mkdirSync(join(WORKSPACE, 'canvas'), { recursive: true })

    writeFileSync(join(WORKSPACE, 'tsconfig.json'), TSCONFIG, 'utf-8')
    writeFileSync(join(WORKSPACE, 'react-shim.d.ts'), REACT_SHIM, 'utf-8')
    writeFileSync(join(WORKSPACE, 'pyrightconfig.json'), PYRIGHTCONFIG, 'utf-8')
    if (existsSync(CANVAS_GLOBALS_SRC)) {
      copyFileSync(CANVAS_GLOBALS_SRC, join(WORKSPACE, 'canvas-globals.d.ts'))
    }

    manager = new WorkspaceLSPManager({
      projectDir: WORKSPACE,
      tsServerBin: TS_BIN,
      pyrightBin: PY_BIN,
    })
    await manager.startAll()
  }, 30_000)

  afterAll(() => {
    manager?.stop()
    rmSync(WORKSPACE, { recursive: true, force: true })
  })

  test('routes .ts files to TypeScript LSP and detects errors', async () => {
    const filePath = join(WORKSPACE, 'bad.ts')
    writeFileSync(filePath, BAD_TS, 'utf-8')
    manager.notifyFileChanged(filePath, BAD_TS)

    await poll(async () => {
      const diags = manager.getDiagnostics(`file://${filePath}`)
      return diags.size > 0 && (diags.get(`file://${filePath}`)?.length ?? 0) > 0
    }, 15_000, 500)

    const diags = manager.getDiagnostics(`file://${filePath}`)
    const fileDiags = diags.get(`file://${filePath}`) ?? []

    console.log(`[mgr-ts] Got ${fileDiags.length} diagnostics`)
    fileDiags.forEach(d => console.log(`  ${d.message}`))

    expect(fileDiags.length).toBeGreaterThan(0)
    const typeError = fileDiags.find(d => (d.severity ?? 1) === 1)
    expect(typeError).toBeTruthy()
  }, 30_000)

  test('routes .py files to pyright CLI and detects errors', async () => {
    const filePath = join(WORKSPACE, 'bad.py')
    writeFileSync(filePath, BAD_PY, 'utf-8')
    manager.notifyFileChanged(filePath, BAD_PY)

    const allDiags = await manager.getDiagnosticsAsync(`file://${filePath}`)
    const fileDiags = allDiags.get(`file://${filePath}`) ?? []

    console.log(`[mgr-py] Got ${fileDiags.length} diagnostics`)
    fileDiags.forEach(d => console.log(`  ${d.message}`))

    expect(fileDiags.length).toBeGreaterThan(0)
    const typeError = fileDiags.find(d =>
      d.severity === 1 && (d.message.includes('int') || d.message.includes('str'))
    )
    expect(typeError).toBeTruthy()
  }, 15_000)

  test('getDiagnosticsAsync() aggregates from both backends', async () => {
    const allDiags = await manager.getDiagnosticsAsync()
    const uris = [...allDiags.keys()]

    console.log(`[mgr-all] Total URIs with diagnostics: ${uris.length}`)
    uris.forEach(u => console.log(`  ${u}: ${allDiags.get(u)?.length} diags`))

    const hasTsFile = uris.some(u => u.endsWith('.ts'))
    const hasPyFile = uris.some(u => u.endsWith('.py'))

    expect(hasTsFile).toBe(true)
    expect(hasPyFile).toBe(true)
  }, 10_000)
})

async function poll(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(`Poll timed out after ${timeoutMs}ms`)
}
