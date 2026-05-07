// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `runtime-lsp-routes.ts` — covers:
 *   • Request validation (path traversal, missing fields, wrong types)
 *   • Workspace-relative `path` → absolute LSP file path resolution
 *   • Verbatim pass-through of LSP responses (with absolute `file://`
 *     URIs rewritten back to workspace-relative paths)
 *   • The `ready` health-check short-circuit during cold start
 *
 * The LSP manager is fully mocked — no tsserver process is spawned.
 */
import { describe, expect, test, beforeEach } from 'bun:test'
import { runtimeLspRoutes, __test } from '../runtime-lsp-routes'

const WORKSPACE_DIR = '/tmp/test-workspace-lsp-routes'

interface MockLsp {
  isTSReadyValue: boolean
  hover: (filePath: string, line: number, character: number) => Promise<unknown>
  completion: (filePath: string, line: number, character: number, ctx?: unknown) => Promise<unknown>
  definition: (filePath: string, line: number, character: number) => Promise<unknown>
  references: (filePath: string, line: number, character: number, includeDeclaration?: boolean) => Promise<unknown>
  documentSymbol: (filePath: string) => Promise<unknown>
  signatureHelp: (filePath: string, line: number, character: number) => Promise<unknown>
  rename: (filePath: string, line: number, character: number, newName: string) => Promise<unknown>
  didOpenDocument: (filePath: string, languageId: string, version: number, text: string) => void
  didChangeDocument: (filePath: string, version: number, text: string) => void
  didCloseDocument: (filePath: string) => void
  isTSReady: () => boolean
}

function makeMockLsp(): MockLsp & { calls: any[] } {
  const calls: any[] = []
  const lsp = {
    isTSReadyValue: true,
    isTSReady() { return this.isTSReadyValue },
    async hover(...args: any[]) { calls.push(['hover', ...args]); return { contents: { kind: 'markdown', value: 'hi' } } },
    async completion(...args: any[]) { calls.push(['completion', ...args]); return { isIncomplete: false, items: [] } },
    async definition(...args: any[]) { calls.push(['definition', ...args]); return [{ uri: `file://${WORKSPACE_DIR}/src/Other.tsx`, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }] },
    async references(...args: any[]) { calls.push(['references', ...args]); return [] },
    async documentSymbol(...args: any[]) { calls.push(['documentSymbol', ...args]); return [] },
    async signatureHelp(...args: any[]) { calls.push(['signatureHelp', ...args]); return null },
    async rename(...args: any[]) {
      calls.push(['rename', ...args])
      return {
        changes: {
          [`file://${WORKSPACE_DIR}/src/A.ts`]: [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'foo' },
          ],
        },
      }
    },
    didOpenDocument(...args: any[]) { calls.push(['didOpen', ...args]) },
    didChangeDocument(...args: any[]) { calls.push(['didChange', ...args]) },
    didCloseDocument(...args: any[]) { calls.push(['didClose', ...args]) },
    calls,
  }
  return lsp as MockLsp & { calls: any[] }
}

let mockLsp: ReturnType<typeof makeMockLsp>
let app: ReturnType<typeof runtimeLspRoutes>

beforeEach(() => {
  mockLsp = makeMockLsp()
  app = runtimeLspRoutes({
    workspaceDir: WORKSPACE_DIR,
    getLspManager: () => mockLsp as any,
  })
})

async function jsonPost(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const req = new Request(`http://test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const res = await app.fetch(req)
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

describe('runtime-lsp-routes — internal helpers', () => {
  test('resolveWorkspacePath rejects traversal attempts', () => {
    expect(__test.resolveWorkspacePath(WORKSPACE_DIR, '../etc/passwd')).toBeNull()
    expect(__test.resolveWorkspacePath(WORKSPACE_DIR, '../../../../etc/passwd')).toBeNull()
    expect(__test.resolveWorkspacePath(WORKSPACE_DIR, 'src/../../etc/passwd')).toBeNull()
    // Empty / nonsense inputs
    expect(__test.resolveWorkspacePath(WORKSPACE_DIR, '')).toBeNull()
    expect(__test.resolveWorkspacePath(WORKSPACE_DIR, '..')).toBeNull()
  })

  test('resolveWorkspacePath strips leading slashes (matches `file:///` URI scheme)', () => {
    // `file:///` URIs from the wire decode to a leading-slash path that
    // we treat as workspace-relative — no host-absolute paths possible
    // because the resolve happens inside `WORKSPACE_DIR`.
    expect(__test.resolveWorkspacePath(WORKSPACE_DIR, '/src/App.tsx')).toBe(`${WORKSPACE_DIR}/src/App.tsx`)
  })

  test('resolveWorkspacePath accepts normal workspace paths and strips file://', () => {
    expect(__test.resolveWorkspacePath(WORKSPACE_DIR, 'src/App.tsx')).toBe(`${WORKSPACE_DIR}/src/App.tsx`)
    expect(__test.resolveWorkspacePath(WORKSPACE_DIR, '/src/App.tsx')).toBe(`${WORKSPACE_DIR}/src/App.tsx`)
    expect(__test.resolveWorkspacePath(WORKSPACE_DIR, 'file:///src/App.tsx')).toBe(`${WORKSPACE_DIR}/src/App.tsx`)
  })

  test('parsePosition rejects invalid payloads', () => {
    expect(__test.parsePosition(WORKSPACE_DIR, {} as any)).toEqual({ error: expect.any(String) } as any)
    expect(__test.parsePosition(WORKSPACE_DIR, { path: 'a.ts', line: -1, character: 0 } as any)).toEqual({ error: expect.any(String) } as any)
    expect(__test.parsePosition(WORKSPACE_DIR, { path: '../escape', line: 0, character: 0 } as any)).toEqual({ error: expect.any(String) } as any)
  })

  test('parsePosition floors fractional line/character values', () => {
    const r = __test.parsePosition(WORKSPACE_DIR, { path: 'a.ts', line: 3.7, character: 2.9 })
    expect(r).toMatchObject({ line: 3, character: 2 })
  })

  test('inferLanguageIdFromPath maps common TS/JS extensions', () => {
    expect(__test.inferLanguageIdFromPath('a.ts')).toBe('typescript')
    expect(__test.inferLanguageIdFromPath('a.tsx')).toBe('typescriptreact')
    expect(__test.inferLanguageIdFromPath('a.jsx')).toBe('javascriptreact')
    expect(__test.inferLanguageIdFromPath('a.js')).toBe('javascript')
    expect(__test.inferLanguageIdFromPath('Makefile')).toBe('typescript')
  })
})

describe('runtime-lsp-routes — /agent/lsp/ready', () => {
  test('returns ready=true when the manager is up', async () => {
    const req = new Request('http://test/agent/lsp/ready')
    const res = await app.fetch(req)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ready: true, label: 'ts' })
  })

  test('returns ready=false when the manager is missing', async () => {
    const localApp = runtimeLspRoutes({ workspaceDir: WORKSPACE_DIR, getLspManager: () => null })
    const res = await localApp.fetch(new Request('http://test/agent/lsp/ready'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ready: false, label: 'ts' })
  })

  test('returns ready=false when TS server is still starting', async () => {
    mockLsp.isTSReadyValue = false
    const res = await app.fetch(new Request('http://test/agent/lsp/ready'))
    expect(await res.json()).toEqual({ ready: false, label: 'ts' })
  })
})

describe('runtime-lsp-routes — request validation', () => {
  test('rejects non-JSON body with 400', async () => {
    const req = new Request('http://test/agent/lsp/hover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    const res = await app.fetch(req)
    expect(res.status).toBe(400)
  })

  test('rejects missing path with 400', async () => {
    const { status } = await jsonPost('/agent/lsp/hover', { line: 0, character: 0 })
    expect(status).toBe(400)
  })

  test('rejects path traversal with 400', async () => {
    const { status } = await jsonPost('/agent/lsp/hover', { path: '../../../etc/passwd', line: 0, character: 0 })
    expect(status).toBe(400)
  })

  test('rejects negative line numbers with 400', async () => {
    const { status } = await jsonPost('/agent/lsp/hover', { path: 'a.ts', line: -1, character: 0 })
    expect(status).toBe(400)
  })

  test('returns 503 when LSP manager is not started', async () => {
    const localApp = runtimeLspRoutes({ workspaceDir: WORKSPACE_DIR, getLspManager: () => null })
    const req = new Request('http://test/agent/lsp/hover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'a.ts', line: 0, character: 0 }),
    })
    const res = await localApp.fetch(req)
    expect(res.status).toBe(503)
  })

  test('returns 503 when TS server is still starting', async () => {
    mockLsp.isTSReadyValue = false
    const { status } = await jsonPost('/agent/lsp/hover', { path: 'a.ts', line: 0, character: 0 })
    expect(status).toBe(503)
  })
})

describe('runtime-lsp-routes — request methods pass through to LSP', () => {
  test('hover routes path → absolute file path', async () => {
    const { status, json } = await jsonPost('/agent/lsp/hover', { path: 'src/App.tsx', line: 5, character: 10 })
    expect(status).toBe(200)
    expect(json.result).toEqual({ contents: { kind: 'markdown', value: 'hi' } })
    expect(mockLsp.calls).toContainEqual(['hover', `${WORKSPACE_DIR}/src/App.tsx`, 5, 10])
  })

  test('completion forwards optional `context` payload', async () => {
    const { status } = await jsonPost('/agent/lsp/completion', {
      path: 'src/App.tsx', line: 1, character: 2,
      context: { triggerKind: 2, triggerCharacter: '.' },
    })
    expect(status).toBe(200)
    const call = mockLsp.calls.find((c: any[]) => c[0] === 'completion')!
    expect(call[4]).toEqual({ triggerKind: 2, triggerCharacter: '.' })
  })

  test('references defaults includeDeclaration to true', async () => {
    const { status } = await jsonPost('/agent/lsp/references', { path: 'a.ts', line: 0, character: 0 })
    expect(status).toBe(200)
    const call = mockLsp.calls.find((c: any[]) => c[0] === 'references')!
    expect(call[4]).toBe(true)
  })

  test('references honors explicit includeDeclaration=false', async () => {
    const { status } = await jsonPost('/agent/lsp/references', {
      path: 'a.ts', line: 0, character: 0, includeDeclaration: false,
    })
    expect(status).toBe(200)
    const call = mockLsp.calls.find((c: any[]) => c[0] === 'references')!
    expect(call[4]).toBe(false)
  })

  test('rename rejects empty newName', async () => {
    const { status } = await jsonPost('/agent/lsp/rename', {
      path: 'a.ts', line: 0, character: 0, newName: '',
    })
    expect(status).toBe(400)
  })

  test('documentSymbol only requires path', async () => {
    const { status } = await jsonPost('/agent/lsp/documentSymbol', { path: 'a.ts' })
    expect(status).toBe(200)
    expect(mockLsp.calls).toContainEqual(['documentSymbol', `${WORKSPACE_DIR}/a.ts`])
  })
})

describe('runtime-lsp-routes — URI rewriting in responses', () => {
  test('rewrites absolute file:// URIs in definition results to workspace-relative paths', async () => {
    const { status, json } = await jsonPost('/agent/lsp/definition', { path: 'src/App.tsx', line: 0, character: 0 })
    expect(status).toBe(200)
    expect(json.result).toEqual([
      { uri: 'src/Other.tsx', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } },
    ])
  })

  test('rewrites both keys and contents of WorkspaceEdit.changes', async () => {
    const { status, json } = await jsonPost('/agent/lsp/rename', {
      path: 'src/A.ts', line: 0, character: 0, newName: 'foo',
    })
    expect(status).toBe(200)
    expect(Object.keys(json.result.changes)).toEqual(['src/A.ts'])
    expect(json.result.changes['src/A.ts']).toHaveLength(1)
  })
})

describe('runtime-lsp-routes — document sync notifications', () => {
  test('didOpen forwards path + content + version + languageId', async () => {
    const { status } = await jsonPost('/agent/lsp/didOpen', {
      path: 'src/App.tsx',
      languageId: 'typescriptreact',
      version: 1,
      text: 'export {}',
    })
    expect(status).toBe(200)
    expect(mockLsp.calls).toContainEqual(['didOpen', `${WORKSPACE_DIR}/src/App.tsx`, 'typescriptreact', 1, 'export {}'])
  })

  test('didOpen infers languageId from extension when not provided', async () => {
    await jsonPost('/agent/lsp/didOpen', { path: 'src/util.ts', text: 'x' })
    const call = mockLsp.calls.find((c: any[]) => c[0] === 'didOpen')!
    expect(call[2]).toBe('typescript')
  })

  test('didOpen rejects missing text with 400', async () => {
    const { status } = await jsonPost('/agent/lsp/didOpen', { path: 'src/App.tsx' })
    expect(status).toBe(400)
  })

  test('didChange forwards path + version + text', async () => {
    const { status } = await jsonPost('/agent/lsp/didChange', { path: 'src/App.tsx', version: 7, text: 'edited' })
    expect(status).toBe(200)
    expect(mockLsp.calls).toContainEqual(['didChange', `${WORKSPACE_DIR}/src/App.tsx`, 7, 'edited'])
  })

  test('didClose forwards path', async () => {
    const { status } = await jsonPost('/agent/lsp/didClose', { path: 'src/App.tsx' })
    expect(status).toBe(200)
    expect(mockLsp.calls).toContainEqual(['didClose', `${WORKSPACE_DIR}/src/App.tsx`])
  })
})

describe('runtime-lsp-routes — error path', () => {
  test('returns 500 with an error envelope when the LSP throws', async () => {
    const breakingLsp = {
      ...mockLsp,
      hover: async () => { throw new Error('lsp blew up') },
    }
    const localApp = runtimeLspRoutes({
      workspaceDir: WORKSPACE_DIR,
      getLspManager: () => breakingLsp as any,
    })
    const req = new Request('http://test/agent/lsp/hover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'a.ts', line: 0, character: 0 }),
    })
    const res = await localApp.fetch(req)
    expect(res.status).toBe(500)
    const json = await res.json() as any
    expect(json.error?.code).toBe('lsp_error')
    expect(json.error?.message).toContain('lsp blew up')
  })
})
