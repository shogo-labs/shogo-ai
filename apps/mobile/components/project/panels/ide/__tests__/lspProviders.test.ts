/**
 * Tests for the Monaco LSP providers adapter (`monaco/lspProviders.ts`).
 *
 * Stands up a minimal Monaco mock that records provider registrations and
 * exposes the `provide*` callbacks. Each test then drives a callback and
 * inspects the request payload sent over the (mocked) fetch impl plus the
 * shape of the value returned to Monaco.
 *
 * What we're protecting:
 *   • Wire format: `{ path, line, character }` with LSP 0-indexed positions
 *     when Monaco hands us 1-indexed positions
 *   • Path extraction: Monaco model URIs of shape `<rootId>::<relPath>`
 *     produce the right workspace-relative `path` value
 *   • Response conversion: LSP `Hover` / `CompletionList` / `Location[]` /
 *     `WorkspaceEdit` map to Monaco's expected shapes (1-indexed ranges,
 *     CompletionItemKind enum mapping, MarkdownString)
 *   • rootId guard: a model whose URI doesn't carry the expected rootId
 *     never proxies through (so Local FS roots can't accidentally fire a
 *     POST against the agent LSP)
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";
import { setupLspProviders, __resetLspProvidersForTest, __test } from "../monaco/lspProviders";

// ─── Minimal Monaco mock ──────────────────────────────────────────────────

const CompletionItemKind = {
  Method: 0, Function: 1, Constructor: 2, Field: 3, Variable: 4, Class: 5,
  Struct: 6, Interface: 7, Module: 8, Property: 9, Event: 10, Operator: 11,
  Unit: 12, Value: 13, Constant: 14, Enum: 15, EnumMember: 16, Keyword: 17,
  Text: 18, Color: 19, File: 20, Reference: 21, Folder: 23,
  TypeParameter: 24, Snippet: 27,
} as const;

const SymbolKind = {
  File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5,
  Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10, Function: 11,
  Variable: 12, Constant: 13, String: 14, Number: 15, Boolean: 16, Array: 17,
  Object: 18, Key: 19, Null: 20, EnumMember: 21, Struct: 22, Event: 23,
  Operator: 24, TypeParameter: 25,
} as const;

interface ProviderHandle<T> { provider: T }

function makeMonacoMock() {
  const hovers: ProviderHandle<any>[] = [];
  const completions: ProviderHandle<any>[] = [];
  const definitions: ProviderHandle<any>[] = [];
  const references: ProviderHandle<any>[] = [];
  const documentSymbols: ProviderHandle<any>[] = [];
  const signatureHelps: ProviderHandle<any>[] = [];
  const renames: ProviderHandle<any>[] = [];
  const disposed = { count: 0 };

  const registerOnce = <T>(arr: ProviderHandle<T>[], provider: T) => {
    arr.push({ provider });
    return { dispose: () => { disposed.count += 1 } };
  };

  return {
    monaco: {
      Uri: {
        parse: (str: string) => {
          // Mimic Monaco's URI.parse just enough for our path extractor.
          // For inputs like "agent::src/App.tsx" the model.uri.path field
          // would be `:src/App.tsx` (scheme = "agent", remainder = path).
          // Real Monaco encodes as `monaco.Uri.parse(pathKey)` and the path
          // field reflects everything after the first ":". We mirror.
          const colonIdx = str.indexOf(":");
          const path = colonIdx >= 0 ? str.slice(colonIdx) : str;
          return { path, toString: () => str };
        },
      },
      languages: {
        CompletionItemKind,
        SymbolKind,
        CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
        registerHoverProvider: (_langs: string[], provider: any) => registerOnce(hovers, provider),
        registerCompletionItemProvider: (_langs: string[], provider: any) => registerOnce(completions, provider),
        registerDefinitionProvider: (_langs: string[], provider: any) => registerOnce(definitions, provider),
        registerReferenceProvider: (_langs: string[], provider: any) => registerOnce(references, provider),
        registerDocumentSymbolProvider: (_langs: string[], provider: any) => registerOnce(documentSymbols, provider),
        registerSignatureHelpProvider: (_langs: string[], provider: any) => registerOnce(signatureHelps, provider),
        registerRenameProvider: (_langs: string[], provider: any) => registerOnce(renames, provider),
      },
    },
    hovers, completions, definitions, references, documentSymbols, signatureHelps, renames, disposed,
  };
}

function fakeModel(pathKey: string) {
  // Simulate the URI shape @monaco-editor/react produces by calling
  // `monaco.Uri.parse(pathKey)` — in our mock the `path` field starts with
  // the first colon, so we reconstruct it manually here for clarity.
  return {
    uri: {
      // The path that pathFromModel reads — strip-leading-/ + decode +
      // split-on-:: yields the rootId/path pair. We hand it `/agent::foo`
      // to mirror real Monaco URIs from the workbench.
      path: `/${pathKey}`,
      toString: () => pathKey,
    },
    getValue: () => '',
    getWordUntilPosition: () => ({ word: '', startColumn: 1, endColumn: 1 }),
  } as any;
}

function token(): any {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => {} }),
  };
}

let monacoMock: ReturnType<typeof makeMonacoMock>;
let fetchMock: ReturnType<typeof mock>;

beforeEach(() => {
  __resetLspProvidersForTest();
  monacoMock = makeMonacoMock();
  fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    return new Response(JSON.stringify({ result: null }), { status: 200, headers: { 'content-type': 'application/json' } })
  });
});

function install(rootId = 'agent', agentUrl = 'http://test.local') {
  return setupLspProviders({
    monaco: monacoMock.monaco as any,
    agentUrl,
    rootId,
    fetchImpl: fetchMock as any,
  });
}

describe('lspProviders — registration', () => {
  test('installs all seven provider kinds on first call', () => {
    install();
    expect(monacoMock.hovers).toHaveLength(1);
    expect(monacoMock.completions).toHaveLength(1);
    expect(monacoMock.definitions).toHaveLength(1);
    expect(monacoMock.references).toHaveLength(1);
    expect(monacoMock.documentSymbols).toHaveLength(1);
    expect(monacoMock.signatureHelps).toHaveLength(1);
    expect(monacoMock.renames).toHaveLength(1);
  });

  test('repeat install with same agentUrl is a no-op', () => {
    install();
    install();
    expect(monacoMock.hovers).toHaveLength(1);
  });

  test('install with different agentUrl disposes previous registrations', () => {
    install('agent', 'http://test.local');
    install('agent', 'http://other.local');
    // First install registered 7 providers, second install disposed them
    // and registered 7 fresh ones.
    expect(monacoMock.disposed.count).toBe(7);
    expect(monacoMock.hovers).toHaveLength(2);
  });
});

describe('lspProviders — pathFromModel rootId guard', () => {
  test('returns null for models without a rootId prefix', () => {
    const m = { uri: { path: '/no-prefix-here.ts' } } as any;
    expect(__test.pathFromModel(m, 'agent')).toBeNull();
  });

  test('returns null for models whose rootId does not match', () => {
    const m = { uri: { path: '/local::src/A.ts' } } as any;
    expect(__test.pathFromModel(m, 'agent')).toBeNull();
  });

  test('extracts the relative path when rootId matches', () => {
    const m = { uri: { path: '/agent::src/App.tsx' } } as any;
    expect(__test.pathFromModel(m, 'agent')).toBe('src/App.tsx');
  });
});

describe('lspProviders — coordinate / range conversion', () => {
  test('toMonacoRange converts 0-indexed LSP → 1-indexed Monaco', () => {
    const r = __test.toMonacoRange({ start: { line: 4, character: 2 }, end: { line: 4, character: 9 } });
    expect(r).toEqual({ startLineNumber: 5, startColumn: 3, endLineNumber: 5, endColumn: 10 });
  });
});

describe('lspProviders — hover provider', () => {
  test('does not fire a request for non-agent rootId models', async () => {
    install();
    const provider = monacoMock.hovers[0]!.provider;
    const result = await provider.provideHover(fakeModel('local::src/A.ts'), { lineNumber: 1, column: 1 }, token());
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('sends 0-indexed position and converts contents to MarkdownString[]', async () => {
    fetchMock = mock(async () => new Response(JSON.stringify({
      result: { contents: { kind: 'markdown', value: '**foo** bar' } },
    }), { status: 200 }));
    install();
    const provider = monacoMock.hovers[0]!.provider;
    const out = await provider.provideHover(fakeModel('agent::src/A.ts'), { lineNumber: 5, column: 10 }, token());
    expect(out).not.toBeNull();
    expect(out.contents).toEqual([{ value: '**foo** bar' }]);
    const callArgs = (fetchMock as any).mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body).toEqual({ path: 'src/A.ts', line: 4, character: 9 });
  });

  test('handles MarkedString[] with language tag', async () => {
    fetchMock = mock(async () => new Response(JSON.stringify({
      result: { contents: [{ language: 'typescript', value: 'const x: string' }, 'plain text bit'] },
    }), { status: 200 }));
    install();
    const provider = monacoMock.hovers[0]!.provider;
    const out = await provider.provideHover(fakeModel('agent::a.ts'), { lineNumber: 1, column: 1 }, token());
    expect(out.contents[0].value).toContain('```typescript');
    expect(out.contents[1].value).toBe('plain text bit');
  });
});

describe('lspProviders — completion provider', () => {
  test('maps LSP CompletionItemKind to Monaco kinds', async () => {
    fetchMock = mock(async () => new Response(JSON.stringify({
      result: {
        isIncomplete: false,
        items: [
          { label: 'fn', kind: 3 /* LSP Function */, insertText: 'fn()' },
          { label: 'cls', kind: 7 /* LSP Class */ },
          { label: 'snip', kind: 15, insertText: 'for(${1:i})', insertTextFormat: 2 },
        ],
      },
    }), { status: 200 }));
    install();
    const provider = monacoMock.completions[0]!.provider;
    const result = await provider.provideCompletionItems(
      fakeModel('agent::a.ts'),
      { lineNumber: 1, column: 1 },
      { triggerKind: 1 },
      token(),
    );
    const kinds = result.suggestions.map((s: any) => s.kind);
    expect(kinds).toEqual([CompletionItemKind.Function, CompletionItemKind.Class, CompletionItemKind.Snippet]);
    // Snippet item gets the InsertAsSnippet rule
    expect(result.suggestions[2].insertTextRules).toBe(4);
    // Non-snippet item leaves rules undefined
    expect(result.suggestions[0].insertTextRules).toBeUndefined();
  });

  test('falls back to label as insertText when LSP omits insertText', async () => {
    fetchMock = mock(async () => new Response(JSON.stringify({
      result: { isIncomplete: false, items: [{ label: 'foo', kind: 6 }] },
    }), { status: 200 }));
    install();
    const provider = monacoMock.completions[0]!.provider;
    const result = await provider.provideCompletionItems(
      fakeModel('agent::a.ts'),
      { lineNumber: 1, column: 1 },
      { triggerKind: 1 },
      token(),
    );
    expect(result.suggestions[0].insertText).toBe('foo');
  });

  test('forwards triggerKind/triggerCharacter in body', async () => {
    install();
    const provider = monacoMock.completions[0]!.provider;
    await provider.provideCompletionItems(
      fakeModel('agent::a.ts'),
      { lineNumber: 1, column: 5 },
      { triggerKind: 2, triggerCharacter: '.' },
      token(),
    );
    const body = JSON.parse((fetchMock as any).mock.calls[0][1].body as string);
    expect(body.context).toEqual({ triggerKind: 2, triggerCharacter: '.' });
  });
});

describe('lspProviders — definition / references locations', () => {
  test('locationsToMonaco converts LSP Location[] to Monaco Location[]', () => {
    const lsp = [
      { uri: 'src/A.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } },
    ];
    const out = __test.locationsToMonaco(monacoMock.monaco as any, 'agent', lsp);
    expect(out).toHaveLength(1);
    expect(out[0]!.range).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 });
  });

  test('locationsToMonaco prefers targetSelectionRange over targetRange for LocationLink', () => {
    const lsp = [{
      targetUri: 'src/A.ts',
      targetRange: { start: { line: 5, character: 0 }, end: { line: 9, character: 0 } },
      targetSelectionRange: { start: { line: 5, character: 4 }, end: { line: 5, character: 12 } },
    }];
    const out = __test.locationsToMonaco(monacoMock.monaco as any, 'agent', lsp);
    expect(out[0]!.range.startColumn).toBe(5); // 4 + 1
    expect(out[0]!.range.endColumn).toBe(13);  // 12 + 1
  });

  test('locationsToMonaco returns [] for null / empty', () => {
    expect(__test.locationsToMonaco(monacoMock.monaco as any, 'agent', null)).toEqual([]);
    expect(__test.locationsToMonaco(monacoMock.monaco as any, 'agent', [])).toEqual([]);
  });
});

describe('lspProviders — rename provider', () => {
  test('flattens WorkspaceEdit.changes into Monaco edit list', async () => {
    fetchMock = mock(async () => new Response(JSON.stringify({
      result: {
        changes: {
          'src/A.ts': [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'foo' },
            { range: { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } }, newText: 'foo' },
          ],
          'src/B.ts': [
            { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: 'foo' },
          ],
        },
      },
    }), { status: 200 }));
    install();
    const provider = monacoMock.renames[0]!.provider;
    const out = await provider.provideRenameEdits(
      fakeModel('agent::src/A.ts'),
      { lineNumber: 1, column: 1 },
      'foo',
      token(),
    );
    expect(out.edits).toHaveLength(3);
    expect(out.edits[0].textEdit.text).toBe('foo');
    // Range should be 1-indexed Monaco
    expect(out.edits[0].textEdit.range.startLineNumber).toBe(1);
  });

  test('handles documentChanges form too', async () => {
    fetchMock = mock(async () => new Response(JSON.stringify({
      result: {
        documentChanges: [{
          textDocument: { uri: 'src/A.ts', version: 7 },
          edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'bar' }],
        }],
      },
    }), { status: 200 }));
    install();
    const provider = monacoMock.renames[0]!.provider;
    const out = await provider.provideRenameEdits(
      fakeModel('agent::src/A.ts'),
      { lineNumber: 1, column: 1 },
      'bar',
      token(),
    );
    expect(out.edits).toHaveLength(1);
    expect(out.edits[0].versionId).toBe(7);
  });
});

describe('lspProviders — error / fallback paths', () => {
  test('returns null when fetch rejects', async () => {
    fetchMock = mock(async () => { throw new Error('network down') });
    install();
    const result = await monacoMock.hovers[0]!.provider.provideHover(
      fakeModel('agent::a.ts'),
      { lineNumber: 1, column: 1 },
      token(),
    );
    expect(result).toBeNull();
  });

  test('returns null on non-2xx response', async () => {
    fetchMock = mock(async () => new Response('boom', { status: 503 }));
    install();
    const result = await monacoMock.hovers[0]!.provider.provideHover(
      fakeModel('agent::a.ts'),
      { lineNumber: 1, column: 1 },
      token(),
    );
    expect(result).toBeNull();
  });
});
