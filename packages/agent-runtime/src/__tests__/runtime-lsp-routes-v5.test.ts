// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * runtime-lsp-routes.ts v5 coverage — closes 17 remaining uncovered lines:
 *   - Lines 315-323: signatureHelp route handler
 *   - Line   124:    rewriteUriString outside-workspace return path
 *   - Line   214:    didChange missing-`text` error return
 *   - Lines 261,275,296,310,324,342: catch openers for completion/definition/
 *     references/documentSymbol/signatureHelp/rename error paths
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { runtimeLspRoutes, __test } from '../runtime-lsp-routes'

const WS = '/tmp/test-workspace-lsp-v5'

type LspMock = {
  calls: [string, ...unknown[]][]
  isTSReady: () => boolean
  hover: (...a: unknown[]) => Promise<unknown>
  completion: (...a: unknown[]) => Promise<unknown>
  definition: (...a: unknown[]) => Promise<unknown>
  references: (...a: unknown[]) => Promise<unknown>
  documentSymbol: (...a: unknown[]) => Promise<unknown>
  signatureHelp: (...a: unknown[]) => Promise<unknown>
  rename: (...a: unknown[]) => Promise<unknown>
  didOpenDocument: (...a: unknown[]) => void
  didChangeDocument: (...a: unknown[]) => void
  didCloseDocument: (...a: unknown[]) => void
}

function makeLsp(overrides: Partial<LspMock> = {}): LspMock {
  const calls: [string, ...unknown[]][] = []
  return {
    calls,
    isTSReady: () => true,
    hover: async (...a) => { calls.push(['hover', ...a]); return null },
    completion: async (...a) => { calls.push(['completion', ...a]); return null },
    definition: async (...a) => { calls.push(['definition', ...a]); return null },
    references: async (...a) => { calls.push(['references', ...a]); return [] },
    documentSymbol: async (...a) => { calls.push(['documentSymbol', ...a]); return [] },
    signatureHelp: async (...a) => { calls.push(['signatureHelp', ...a]); return null },
    rename: async (...a) => { calls.push(['rename', ...a]); return null },
    didOpenDocument: (...a) => { calls.push(['didOpen', ...a]) },
    didChangeDocument: (...a) => { calls.push(['didChange', ...a]) },
    didCloseDocument: (...a) => { calls.push(['didClose', ...a]) },
    ...overrides,
  }
}

let lsp: LspMock
let app: ReturnType<typeof runtimeLspRoutes>

beforeEach(() => {
  lsp = makeLsp()
  app = runtimeLspRoutes({ workspaceDir: WS, getLspManager: () => lsp as any })
})

async function post(path: string, body: unknown) {
  const req = new Request(`http://t${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const res = await app.fetch(req)
  return { status: res.status, json: await res.json().catch(() => null) }
}

const POS = { path: 'src/a.ts', line: 1, character: 0 }

// ─── signatureHelp route (lines 315-323) ─────────────────────────────────
describe('signatureHelp route', () => {
  test('valid body → 200 with result', async () => {
    lsp.signatureHelp = async () => ({ signatures: [] })
    const r = await post('/agent/lsp/signatureHelp', POS)
    expect(r.status).toBe(200)
    expect(r.json.result).toEqual({ signatures: [] })
  })

  test('invalid JSON body → 400', async () => {
    const req = new Request('http://t/agent/lsp/signatureHelp', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'bad',
    })
    const res = await app.fetch(req)
    expect(res.status).toBe(400)
  })

  test('signatureHelp throws → 500 with lsp_error (line 324 catch)', async () => {
    lsp.signatureHelp = async () => { throw new Error('sigHelp boom') }
    const r = await post('/agent/lsp/signatureHelp', POS)
    expect(r.status).toBe(500)
    expect(r.json.error.message).toContain('sigHelp boom')
  })
})

// ─── line 124: rewriteUriString outside-workspace return ─────────────────
describe('rewriteUriString outside-workspace path (line 124)', () => {
  test('definition returning file:// URI outside workspace → returned as-is', async () => {
    lsp.definition = async () => ([{
      uri: 'file:///etc/outside.ts',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    }])
    const r = await post('/agent/lsp/definition', POS)
    expect(r.status).toBe(200)
    // The outside-workspace URI should be preserved as-is (not rewritten to relative)
    expect(JSON.stringify(r.json.result)).toContain('file:///etc/outside.ts')
  })
})

// ─── line 214: didChange missing `text` ──────────────────────────────────
describe('didChange missing text (line 214)', () => {
  test('valid path but no text field → 400 text required', async () => {
    const r = await post('/agent/lsp/didChange', { path: 'src/a.ts', version: 1 })
    expect(r.status).toBe(400)
    expect(r.json.error.message).toContain('`text` is required')
  })
})

// ─── catch openers (lines 261, 275, 296, 310, 342) ───────────────────────
describe('LSP method error paths (catch openers)', () => {
  test('completion throws → 500 (line 261)', async () => {
    lsp.completion = async () => { throw new Error('comp err') }
    const r = await post('/agent/lsp/completion', POS)
    expect(r.status).toBe(500)
    expect(r.json.error.code).toBe('lsp_error')
  })

  test('definition throws → 500 (line 275)', async () => {
    lsp.definition = async () => { throw new Error('def err') }
    const r = await post('/agent/lsp/definition', POS)
    expect(r.status).toBe(500)
    expect(r.json.error.code).toBe('lsp_error')
  })

  test('references throws → 500 (line 296)', async () => {
    lsp.references = async () => { throw new Error('ref err') }
    const r = await post('/agent/lsp/references', { ...POS, includeDeclaration: false })
    expect(r.status).toBe(500)
    expect(r.json.error.code).toBe('lsp_error')
  })

  test('documentSymbol throws → 500 (line 310)', async () => {
    lsp.documentSymbol = async () => { throw new Error('sym err') }
    const r = await post('/agent/lsp/documentSymbol', { path: 'src/a.ts' })
    expect(r.status).toBe(500)
    expect(r.json.error.code).toBe('lsp_error')
  })

  test('rename throws → 500 (line 342)', async () => {
    lsp.rename = async () => { throw new Error('rename err') }
    const r = await post('/agent/lsp/rename', { ...POS, newName: 'newFoo' })
    expect(r.status).toBe(500)
    expect(r.json.error.code).toBe('lsp_error')
  })
})
