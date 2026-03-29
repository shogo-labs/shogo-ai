// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * LSP Smoke Test — validates the full typescript-language-server pipeline:
 *   1. Start TSLanguageServer pointed at a temp workspace
 *   2. Initialize LSP handshake
 *   3. Open a canvas file with a known bad reference
 *   4. Verify diagnostics arrive via publishDiagnostics
 *   5. Fix the file and verify diagnostics clear
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { TSLanguageServer } from '@shogo/shared-runtime'

const WORKSPACE = '/tmp/test-lsp-smoke'
const CANVAS_GLOBALS_SRC = resolve(__dirname, '../../../canvas-runtime/src/canvas-globals.d.ts')
const TS_LS_BIN = resolve(__dirname, '../../node_modules/.bin/typescript-language-server')

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2020',
    module: 'none',
    jsx: 'react',
    jsxFactory: 'h',
    strict: false,
    noEmit: true,
    skipLibCheck: true,
    noLib: false,
  },
  include: ['canvas/**/*.ts', '**/*.d.ts'],
  exclude: ['node_modules', '.shogo'],
}, null, 2)

const REACT_SHIM = `declare namespace React {
  type ReactNode = ReactElement | string | number | boolean | null | undefined | ReactNode[];
  type ReactElement = { type: any; props: any; key: any };
  type FC<P = {}> = (props: P & { children?: ReactNode }) => ReactElement | null;
  type SetStateAction<S> = S | ((prevState: S) => S);
  type Dispatch<A> = (value: A) => void;
  function createElement(type: any, props?: any, ...children: any[]): ReactElement;
  const Fragment: any;
  function useState<S>(initialState: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  function useState<S = undefined>(): [S | undefined, Dispatch<SetStateAction<S | undefined>>];
  function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  function useCallback<T extends (...args: any[]) => any>(callback: T, deps: readonly unknown[]): T;
  function useRef<T>(initialValue: T): { current: T };
}
`

// Canvas code that references an icon that does NOT exist in canvas-globals.d.ts
const BAD_CANVAS_CODE = `
var metrics = [
  { label: 'Revenue', value: '$32K', icon: FakeIcon },
  { label: 'Users', value: '1.2K', icon: Activity },
]

return h('div', { className: 'p-4' },
  metrics.map((m, i) =>
    h(Card, { key: i },
      h(CardContent, null,
        h('div', { className: 'flex items-center gap-2' },
          h(m.icon, { size: 16 }),
          h('span', null, m.label),
          h('span', { className: 'font-bold' }, m.value)
        )
      )
    )
  )
)
`

// Fixed version: FakeIcon → Activity (which IS in canvas-globals.d.ts)
const GOOD_CANVAS_CODE = BAD_CANVAS_CODE.replace('FakeIcon', 'Activity')

let server: TSLanguageServer

describe('LSP smoke test', () => {
  beforeAll(async () => {
    rmSync(WORKSPACE, { recursive: true, force: true })
    mkdirSync(join(WORKSPACE, 'canvas'), { recursive: true })

    writeFileSync(join(WORKSPACE, 'tsconfig.json'), TSCONFIG, 'utf-8')
    writeFileSync(join(WORKSPACE, 'react-shim.d.ts'), REACT_SHIM, 'utf-8')
    if (existsSync(CANVAS_GLOBALS_SRC)) {
      copyFileSync(CANVAS_GLOBALS_SRC, join(WORKSPACE, 'canvas-globals.d.ts'))
    } else {
      console.warn('canvas-globals.d.ts not found at', CANVAS_GLOBALS_SRC)
    }

    server = new TSLanguageServer(WORKSPACE, { serverBin: TS_LS_BIN })
    await server.start()
    await server.initialize()
  }, 30_000)

  afterAll(() => {
    server?.stop()
    rmSync(WORKSPACE, { recursive: true, force: true })
  })

  test('detects undefined reference in canvas file', async () => {
    const filePath = join(WORKSPACE, 'canvas', 'dashboard.ts')
    writeFileSync(filePath, BAD_CANVAS_CODE, 'utf-8')
    server.notifyFileChanged(filePath, BAD_CANVAS_CODE)

    // Wait for LSP to process — publishDiagnostics is async
    await poll(async () => {
      const diags = server.getDiagnostics(`file://${filePath}`)
      return diags.size > 0 && (diags.get(`file://${filePath}`)?.length ?? 0) > 0
    }, 15_000, 500)

    const diags = server.getDiagnostics(`file://${filePath}`)
    const fileDiags = diags.get(`file://${filePath}`) ?? []

    console.log(`[smoke] Got ${fileDiags.length} diagnostics:`)
    fileDiags.forEach(d => {
      console.log(`  Line ${d.range.start.line + 1}: [${d.severity}] ${d.message}`)
    })

    // Should have at least one error about FakeIcon
    const fakeIconError = fileDiags.find(d =>
      d.message.includes('FakeIcon') && (d.severity ?? 1) === 1
    )
    expect(fakeIconError).toBeTruthy()
  }, 30_000)

  test('diagnostics clear after fixing the error', async () => {
    const filePath = join(WORKSPACE, 'canvas', 'dashboard.ts')
    writeFileSync(filePath, GOOD_CANVAS_CODE, 'utf-8')
    server.notifyFileChanged(filePath, GOOD_CANVAS_CODE)

    // Wait for diagnostics to update
    await poll(async () => {
      const diags = server.getDiagnostics(`file://${filePath}`)
      const fileDiags = diags.get(`file://${filePath}`) ?? []
      const fakeIconError = fileDiags.find(d =>
        d.message.includes('FakeIcon') && (d.severity ?? 1) === 1
      )
      return !fakeIconError
    }, 15_000, 500)

    const diags = server.getDiagnostics(`file://${filePath}`)
    const fileDiags = diags.get(`file://${filePath}`) ?? []
    const errors = fileDiags.filter(d => (d.severity ?? 1) === 1)

    // Filter out TS1108 (top-level return) which is expected in canvas files
    const realErrors = errors.filter(d => d.code !== 1108)

    console.log(`[smoke] After fix: ${realErrors.length} real errors remaining`)
    realErrors.forEach(d => {
      console.log(`  Line ${d.range.start.line + 1}: [${d.code}] ${d.message}`)
    })

    expect(realErrors.length).toBe(0)
  }, 30_000)

  test('returns empty diagnostics for non-existent URI', () => {
    const diags = server.getDiagnostics('file:///nonexistent/file.ts')
    expect(diags.size).toBe(0)
  })
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
