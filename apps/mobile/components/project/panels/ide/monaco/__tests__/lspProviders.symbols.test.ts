/**
 * lspProviders — BUG-010 wiring integration test.
 *
 * Drives setupLspProviders end-to-end (real cache code, real provider
 * body) with stubbed Monaco surface + fetchImpl seam. Verifies the
 * provideDocumentSymbols handler actually consults the cache — not just
 * that the cache module exists.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { setupLspProviders } from "../lspProviders"

let fetchCalls: Array<{ url: string; body: any }> = []
let nextResult: unknown = []

const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : (input as URL).toString()
  fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null })
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ result: nextResult }),
  } as unknown as Response)
}

function makeMonacoStub() {
  const registered: Array<{ kind: string; provider: any }> = []
  const noop = () => ({ dispose: () => {} })
  const monaco = {
    Uri: { parse: (s: string) => ({ toString: () => s }) },
    KeyMod: { CtrlCmd: 1, Shift: 2 },
    KeyCode: { KeyP: 100 },
    languages: {
      SymbolKind: {
        File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5,
        Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10,
        Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15,
        Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21,
        Struct: 22, Event: 23, Operator: 24, TypeParameter: 25,
      },
      CompletionItemKind: {},
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1 },
      registerHoverProvider: noop,
      registerCompletionItemProvider: noop,
      registerDefinitionProvider: noop,
      registerReferenceProvider: noop,
      registerImplementationProvider: noop,
      registerTypeDefinitionProvider: noop,
      registerDocumentSymbolProvider: (_langs: string[], p: any) => {
        registered.push({ kind: "documentSymbol", provider: p })
        return { dispose: () => {} }
      },
      registerSignatureHelpProvider: noop,
      registerRenameProvider: noop,
      registerCodeActionProvider: noop,
      registerDocumentFormattingEditProvider: noop,
      registerDocumentRangeFormattingEditProvider: noop,
      registerOnTypeFormattingEditProvider: noop,
      registerFoldingRangeProvider: noop,
      registerSelectionRangeProvider: noop,
      registerLinkProvider: noop,
      registerColorProvider: noop,
      registerDocumentHighlightProvider: noop,
      registerInlayHintsProvider: noop,
      registerCodeLensProvider: noop,
      registerDeclarationProvider: noop,
    },
  } as any
  return { monaco, registered }
}

function makeModel(uri: string, versionId: number, pathSuffix: string) {
  // pathFromModel reads model.uri.path → strips leading /, then expects
  // "<rootId>::<rest>". We default rootId to "agent" in the wiring tests.
  return {
    uri: {
      toString: () => uri,
      path: `/agent::${pathSuffix}`,
    },
    getVersionId: () => versionId,
  } as any
}

const SAMPLE_RESULT = [
  {
    name: "foo",
    kind: 11,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
  },
]

let dispose: (() => void) | null = null

beforeEach(() => {
  fetchCalls = []
  nextResult = SAMPLE_RESULT
})
afterEach(() => {
  if (dispose) {
    try { dispose() } catch { /* idempotent */ }
    dispose = null
  }
})

function wire() {
  const stub = makeMonacoStub()
  const r = setupLspProviders({
    monaco: stub.monaco,
    agentUrl: "http://test",
    rootId: "agent",
    fetchImpl,
  })
  dispose = r.dispose
  const provider = stub.registered.find((x) => x.kind === "documentSymbol")?.provider
  if (!provider) throw new Error("documentSymbol provider not registered")
  return provider
}

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
} as any

describe("provideDocumentSymbols — BUG-010 cache wiring", () => {
  test("second call at same (uri, version) HITS the cache (no second LSP fetch)", async () => {
    const provider = wire()
    const model = makeModel("uri://A", 1, "src/a.ts")

    const first = await provider.provideDocumentSymbols(model, TOKEN)
    expect(first?.length).toBe(1)
    expect(fetchCalls.length).toBe(1)

    const second = await provider.provideDocumentSymbols(model, TOKEN)
    expect(second?.length).toBe(1)
    expect(fetchCalls.length).toBe(1) // STILL 1 — cache hit
    expect(second).toBe(first)         // same reference
  })

  test("after model.getVersionId bumps, the next call MISSES (re-fetches)", async () => {
    const provider = wire()
    const model = makeModel("uri://A", 1, "src/a.ts")
    await provider.provideDocumentSymbols(model, TOKEN)
    expect(fetchCalls.length).toBe(1)

    const modelEdited = makeModel("uri://A", 2, "src/a.ts")
    await provider.provideDocumentSymbols(modelEdited, TOKEN)
    expect(fetchCalls.length).toBe(2)
  })

  test("different uris cached independently (no cross-contamination)", async () => {
    const provider = wire()
    await provider.provideDocumentSymbols(makeModel("uri://A", 1, "a.ts"), TOKEN)
    await provider.provideDocumentSymbols(makeModel("uri://B", 1, "b.ts"), TOKEN)
    expect(fetchCalls.length).toBe(2)

    await provider.provideDocumentSymbols(makeModel("uri://A", 1, "a.ts"), TOKEN)
    await provider.provideDocumentSymbols(makeModel("uri://B", 1, "b.ts"), TOKEN)
    expect(fetchCalls.length).toBe(2) // both hits
  })

  test("null LSP response is NOT cached (next call re-fetches)", async () => {
    const provider = wire()
    nextResult = null
    const model = makeModel("uri://A", 1, "a.ts")
    const r1 = await provider.provideDocumentSymbols(model, TOKEN)
    expect(r1).toBeNull()
    expect(fetchCalls.length).toBe(1)

    nextResult = SAMPLE_RESULT
    const r2 = await provider.provideDocumentSymbols(model, TOKEN)
    expect(r2?.length).toBe(1)
    expect(fetchCalls.length).toBe(2) // re-fetched
  })

  test("model edits mid-await: result NOT cached against the stale version", async () => {
    const provider = wire()
    let currentVersion = 1
    const racyModel = {
      uri: { toString: () => "uri://A", path: "/agent::a.ts" },
      getVersionId: () => currentVersion,
    } as any

    // Bump version BETWEEN our snapshot and the post-await cache check.
    nextResult = SAMPLE_RESULT
    const fetchBefore = fetchCalls.length
    const promise = provider.provideDocumentSymbols(racyModel, TOKEN)
    currentVersion = 5  // user typed during the await
    const r = await promise
    expect(r?.length).toBe(1)
    expect(fetchCalls.length).toBe(fetchBefore + 1)

    // The result was NOT cached (we don't cache against a stale version).
    // A new call at v=5 misses → fetches again.
    await provider.provideDocumentSymbols(racyModel, TOKEN)
    expect(fetchCalls.length).toBe(fetchBefore + 2)
  })

  test("dispose() clears the cache (next call after re-wire misses)", async () => {
    const provider = wire()
    const model = makeModel("uri://A", 1, "a.ts")
    await provider.provideDocumentSymbols(model, TOKEN)
    expect(fetchCalls.length).toBe(1)

    // Tear down. The next wire installs a fresh cache → first call misses.
    dispose?.()
    dispose = null

    const provider2 = wire()
    await provider2.provideDocumentSymbols(model, TOKEN)
    expect(fetchCalls.length).toBe(2)
  })
})
