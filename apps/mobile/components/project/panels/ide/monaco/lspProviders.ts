// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Monaco IDE → backend LSP providers.
 *
 * Wires Monaco's hover, completion, definition, references, document-symbol,
 * signature-help, and rename providers to the typescript-language-server
 * already running in the agent runtime, exposed via `/agent/lsp/*` routes.
 *
 * Why not the in-browser TS Web Worker? The worker only sees files we've
 * registered as Monaco models. The old "preload all 1000 TS/JS files into
 * Monaco" pass existed exclusively to feed it. Once Monaco asks the backend
 * LSP — which has native disk access — for everything semantic, we can
 * delete that preload.
 *
 * Wire format / coordinate convention:
 *   - Documents addressed by workspace-relative `path` (e.g. `src/App.tsx`).
 *     The Monaco model URI carries `<rootId>::<relPath>` in its `path`
 *     component (set by @monaco-editor/react via the `path` prop). We
 *     extract `<relPath>` for the wire and silently no-op on non-`agent`
 *     roots (local-FS workspaces have no backend LSP).
 *   - Positions: LSP is 0-indexed, Monaco is 1-indexed. Conversion happens
 *     in this file so consumers don't have to think about it.
 *   - Responses: backend already rewrites absolute `file://` URIs back to
 *     workspace-relative paths, so we map them straight to Monaco model
 *     URIs by re-encoding `<rootId>::<relPath>`.
 */

import type * as Monaco from 'monaco-editor'
import type { editor, languages, IDisposable } from 'monaco-editor'
import { SymbolCache } from './symbol-cache'

type MonacoT = typeof Monaco

/** Same shape as `agentFetch` from apps/mobile/lib/agent-fetch.ts. */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Module-scoped singleton. Two Monaco editor splits in the same Workbench
 * share one provider registration; re-running setup with the same agent
 * URL is a no-op so split-mounts don't double-register.
 */
let installed: { agentUrl: string; rootId: string; dispose: () => void } | null = null

const TS_LANGS = ['typescript', 'javascript', 'typescriptreact', 'javascriptreact']

/** Strip the `<rootId>::` prefix from a Monaco model URI to get the workspace path. Returns null if the rootId doesn't match the active LSP. */
function pathFromModel(model: editor.ITextModel, expectedRootId: string): string | null {
  let raw = model.uri.path ?? ''
  try {
    raw = decodeURIComponent(raw)
  } catch {
    /* leave raw as-is */
  }
  raw = raw.replace(/^\/+/, '')
  const idx = raw.indexOf('::')
  if (idx === -1) {
    // No rootId encoded — only safe to route if there's exactly one root we
    // could be talking to. We default to no-op so we never proxy a model
    // belonging to e.g. a Local FS root through to the agent LSP.
    return null
  }
  const rootId = raw.slice(0, idx)
  if (rootId !== expectedRootId) return null
  return raw.slice(idx + 2)
}

function makeAbortSignal(token: { isCancellationRequested: boolean; onCancellationRequested: (cb: () => void) => IDisposable }): AbortSignal {
  const ctrl = new AbortController()
  if (token.isCancellationRequested) ctrl.abort()
  token.onCancellationRequested(() => ctrl.abort())
  return ctrl.signal
}

/** Convert a 0-indexed LSP Range into Monaco's 1-indexed IRange. */
function toMonacoRange(range: { start: { line: number; character: number }; end: { line: number; character: number } }): Monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  }
}

/**
 * Convert a workspace-relative path into the Monaco model URI used by the
 * Workbench's editor groups. `@monaco-editor/react` does
 * `monaco.Uri.parse(pathKey)` where pathKey is `<rootId>::<relPath>`
 * (see the `EditorGroup` mount), so we round-trip through the exact same
 * call to guarantee URI equality with already-open models.
 */
function toMonacoUri(monaco: MonacoT, rootId: string, relPath: string): Monaco.Uri {
  return monaco.Uri.parse(`${rootId}::${relPath}`)
}

/** LSP CompletionItemKind (1-indexed) → Monaco CompletionItemKind. */
function completionKind(monaco: MonacoT, lspKind?: number): languages.CompletionItemKind {
  const k = monaco.languages.CompletionItemKind
  switch (lspKind) {
    case 1: return k.Text
    case 2: return k.Method
    case 3: return k.Function
    case 4: return k.Constructor
    case 5: return k.Field
    case 6: return k.Variable
    case 7: return k.Class
    case 8: return k.Interface
    case 9: return k.Module
    case 10: return k.Property
    case 11: return k.Unit
    case 12: return k.Value
    case 13: return k.Enum
    case 14: return k.Keyword
    case 15: return k.Snippet
    case 16: return k.Color
    case 17: return k.File
    case 18: return k.Reference
    case 19: return k.Folder
    case 20: return k.EnumMember
    case 21: return k.Constant
    case 22: return k.Struct
    case 23: return k.Event
    case 24: return k.Operator
    case 25: return k.TypeParameter
    default: return k.Text
  }
}

/** LSP SymbolKind (1-indexed) → Monaco SymbolKind. */
function symbolKind(monaco: MonacoT, lspKind?: number): languages.SymbolKind {
  const k = monaco.languages.SymbolKind
  // LSP symbol kinds are 1-26; Monaco's enum is also 1:1 named.
  switch (lspKind) {
    case 1: return k.File
    case 2: return k.Module
    case 3: return k.Namespace
    case 4: return k.Package
    case 5: return k.Class
    case 6: return k.Method
    case 7: return k.Property
    case 8: return k.Field
    case 9: return k.Constructor
    case 10: return k.Enum
    case 11: return k.Interface
    case 12: return k.Function
    case 13: return k.Variable
    case 14: return k.Constant
    case 15: return k.String
    case 16: return k.Number
    case 17: return k.Boolean
    case 18: return k.Array
    case 19: return k.Object
    case 20: return k.Key
    case 21: return k.Null
    case 22: return k.EnumMember
    case 23: return k.Struct
    case 24: return k.Event
    case 25: return k.Operator
    case 26: return k.TypeParameter
    default: return k.Variable
  }
}

interface LspMarkupContent { kind: 'plaintext' | 'markdown'; value: string }
type LspMarkedString = string | { language: string; value: string }
type LspHoverContents = LspMarkupContent | LspMarkedString | LspMarkedString[]

interface LspHover {
  contents: LspHoverContents
  range?: { start: { line: number; character: number }; end: { line: number; character: number } }
}

interface LspLocation {
  uri: string
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
}

interface LspLocationLink {
  originSelectionRange?: { start: { line: number; character: number }; end: { line: number; character: number } }
  targetUri: string
  targetRange: { start: { line: number; character: number }; end: { line: number; character: number } }
  targetSelectionRange?: { start: { line: number; character: number }; end: { line: number; character: number } }
}

interface LspCompletionItem {
  label: string
  kind?: number
  detail?: string
  documentation?: string | LspMarkupContent
  insertText?: string
  insertTextFormat?: 1 | 2 // 1 = PlainText, 2 = Snippet
  textEdit?: { range: any; newText: string } | { insert: any; replace: any; newText: string }
  filterText?: string
  sortText?: string
  preselect?: boolean
  commitCharacters?: string[]
  data?: unknown
}

interface LspCompletionList {
  isIncomplete: boolean
  items: LspCompletionItem[]
}

interface LspDocumentSymbol {
  name: string
  detail?: string
  kind: number
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } }
  children?: LspDocumentSymbol[]
}

interface LspSymbolInformation {
  name: string
  kind: number
  location: LspLocation
  containerName?: string
}

interface LspSignatureHelp {
  signatures: Array<{
    label: string
    documentation?: string | LspMarkupContent
    parameters?: Array<{ label: string | [number, number]; documentation?: string | LspMarkupContent }>
  }>
  activeSignature?: number
  activeParameter?: number
}

interface LspWorkspaceEdit {
  changes?: Record<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>>
  documentChanges?: Array<{
    textDocument: { uri: string; version?: number }
    edits: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>
  }>
}

function extractDocumentation(doc: string | LspMarkupContent | undefined, monaco: MonacoT): string | Monaco.IMarkdownString | undefined {
  if (!doc) return undefined
  if (typeof doc === 'string') return doc
  if (doc.kind === 'markdown') return { value: doc.value, supportThemeIcons: false } as Monaco.IMarkdownString
  return doc.value
  // suppress unused-var warning on `monaco` — passed for symmetry with other helpers
  void monaco
}

function hoverContentsToMarkdown(c: LspHoverContents): Monaco.IMarkdownString[] {
  const out: Monaco.IMarkdownString[] = []
  const push = (s: string) => { if (s) out.push({ value: s }) }
  if (typeof c === 'string') {
    push(c)
  } else if (Array.isArray(c)) {
    for (const item of c) {
      if (typeof item === 'string') push(item)
      else if (item && typeof item.value === 'string') {
        push(item.language ? '```' + item.language + '\n' + item.value + '\n```' : item.value)
      }
    }
  } else if (c && typeof (c as any).value === 'string') {
    const mc = c as LspMarkupContent | { language: string; value: string }
    if ('language' in mc) push('```' + mc.language + '\n' + mc.value + '\n```')
    else push(mc.value)
  }
  return out
}

function locationsToMonaco(monaco: MonacoT, rootId: string, lspResult: unknown): languages.Location[] {
  const out: languages.Location[] = []
  if (!lspResult) return out
  const arr = Array.isArray(lspResult) ? lspResult : [lspResult]
  for (const item of arr as Array<LspLocation | LspLocationLink>) {
    if (!item) continue
    if ('targetUri' in item) {
      out.push({
        uri: toMonacoUri(monaco, rootId, item.targetUri),
        range: toMonacoRange(item.targetSelectionRange ?? item.targetRange),
      })
    } else if ('uri' in item) {
      out.push({
        uri: toMonacoUri(monaco, rootId, item.uri),
        range: toMonacoRange(item.range),
      })
    }
  }
  return out
}

export interface LspProvidersConfig {
  monaco: MonacoT
  /** Base URL of the agent runtime (e.g. http://localhost:38587). */
  agentUrl: string
  /** Workspace `rootId` whose models should be routed to this LSP. Defaults to "agent". */
  rootId?: string
  /** Fetch implementation — defaults to global `fetch`; tests inject a mock. */
  fetchImpl?: FetchLike
}

/**
 * Register all backend-LSP-backed Monaco providers. Idempotent across
 * Workbench mounts and editor splits — calling with the same `agentUrl`
 * is a no-op. Calling with a different `agentUrl` disposes the previous
 * registration and installs a fresh one.
 */
export function setupLspProviders(config: LspProvidersConfig): { dispose: () => void } {
  const { monaco, agentUrl } = config
  const rootId = config.rootId ?? 'agent'
  const fetchImpl: FetchLike = config.fetchImpl ?? ((input, init) => fetch(input, init))

  if (installed) {
    if (installed.agentUrl === agentUrl && installed.rootId === rootId) {
      return { dispose: installed.dispose }
    }
    installed.dispose()
    installed = null
  }

  const post = async <T>(path: string, body: unknown, signal?: AbortSignal): Promise<T | null> => {
    try {
      const res = await fetchImpl(`${agentUrl}/agent/lsp/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      if (!res.ok) return null
      const json = (await res.json()) as { result?: T | null; error?: unknown }
      return (json?.result ?? null) as T | null
    } catch {
      // Aborted or network error — let Monaco fall back gracefully.
      return null
    }
  }

  const disposables: IDisposable[] = []

  // BUG-010: cache document-symbol results by (uri, versionId). Without a
  // cache every breadcrumb hover / cursor move re-hits the backend LSP.
  // Version-keyed caching means any edit (which bumps model.getVersionId)
  // auto-invalidates, AND a stale-after-edit hit is structurally impossible
  // because SymbolCache.set drops any prior version of the same URI in the
  // same call.
  const symbolCache = new SymbolCache<languages.DocumentSymbol[]>()
  disposables.push({ dispose: () => symbolCache.clear() })

  // ─── Hover ────────────────────────────────────────────────────────────
  disposables.push(
    monaco.languages.registerHoverProvider(TS_LANGS, {
      provideHover: async (model, position, token) => {
        const path = pathFromModel(model, rootId)
        if (!path) return null
        const result = await post<LspHover>('hover', {
          path,
          line: position.lineNumber - 1,
          character: position.column - 1,
        }, makeAbortSignal(token))
        if (!result || !result.contents) return null
        return {
          contents: hoverContentsToMarkdown(result.contents),
          range: result.range ? toMonacoRange(result.range) : undefined,
        }
      },
    }),
  )

  // ─── Completion ───────────────────────────────────────────────────────
  disposables.push(
    monaco.languages.registerCompletionItemProvider(TS_LANGS, {
      // Trigger on the same characters tsserver advertises during init.
      triggerCharacters: ['.', '"', "'", '`', '/', '@', '<', '#', ' '],
      provideCompletionItems: async (model, position, _ctx, token) => {
        const path = pathFromModel(model, rootId)
        if (!path) return null
        const word = model.getWordUntilPosition(position)
        const replaceRange: Monaco.IRange = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn,
        }
        const result = await post<LspCompletionList | LspCompletionItem[]>('completion', {
          path,
          line: position.lineNumber - 1,
          character: position.column - 1,
          context: _ctx ? { triggerKind: _ctx.triggerKind, triggerCharacter: _ctx.triggerCharacter } : undefined,
        }, makeAbortSignal(token))
        if (!result) return null
        const items = Array.isArray(result) ? result : result.items
        const isIncomplete = Array.isArray(result) ? false : !!result.isIncomplete
        const suggestions: languages.CompletionItem[] = items.map((it) => {
          const insertText = it.insertText ?? it.label
          const isSnippet = it.insertTextFormat === 2
          return {
            label: it.label,
            kind: completionKind(monaco, it.kind),
            insertText,
            detail: it.detail,
            documentation: extractDocumentation(it.documentation, monaco),
            filterText: it.filterText,
            sortText: it.sortText,
            preselect: it.preselect,
            commitCharacters: it.commitCharacters,
            range: replaceRange,
            insertTextRules: isSnippet
              ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
              : undefined,
          } as languages.CompletionItem
        })
        return { suggestions, incomplete: isIncomplete }
      },
    }),
  )

  // ─── Definition (Cmd-click, "Go to Definition") ───────────────────────
  disposables.push(
    monaco.languages.registerDefinitionProvider(TS_LANGS, {
      provideDefinition: async (model, position, token) => {
        const path = pathFromModel(model, rootId)
        if (!path) return null
        const result = await post<LspLocation | LspLocation[] | LspLocationLink[]>('definition', {
          path,
          line: position.lineNumber - 1,
          character: position.column - 1,
        }, makeAbortSignal(token))
        const locs = locationsToMonaco(monaco, rootId, result)
        return locs.length ? locs : null
      },
    }),
  )

  // ─── References (Find All References) ─────────────────────────────────
  disposables.push(
    monaco.languages.registerReferenceProvider(TS_LANGS, {
      provideReferences: async (model, position, ctx, token) => {
        const path = pathFromModel(model, rootId)
        if (!path) return null
        const result = await post<LspLocation[]>('references', {
          path,
          line: position.lineNumber - 1,
          character: position.column - 1,
          includeDeclaration: ctx.includeDeclaration !== false,
        }, makeAbortSignal(token))
        const locs = locationsToMonaco(monaco, rootId, result)
        return locs.length ? locs : null
      },
    }),
  )

  // ─── Document Symbols (breadcrumb) ───────────────────────────────────
  const provideDocumentSymbols = async (
    model: editor.ITextModel,
    token?: { isCancellationRequested: boolean; onCancellationRequested: (cb: () => void) => IDisposable },
  ): Promise<languages.DocumentSymbol[] | null> => {
        const path = pathFromModel(model, rootId)
        if (!path) return null

        // Snapshot uri + version BEFORE the await — Monaco may have moved
        // on by the time the LSP responds. We cache against the snapshot;
        // the next provideDocumentSymbols call at the new version misses.
        const uri = model.uri.toString()
        const versionId = model.getVersionId()
        const cached = symbolCache.get({ uri, versionId })
        if (cached) return cached

        const result = await post<LspDocumentSymbol[] | LspSymbolInformation[]>('documentSymbol', {
          path,
        }, token ? makeAbortSignal(token) : undefined)
        if (!result || !Array.isArray(result)) return null
        // tsserver returns DocumentSymbol[] (hierarchical). Older servers
        // return SymbolInformation[]; handle both for safety.
        const isHierarchical = result.length === 0 || 'range' in (result[0] as any)
        let symbols: languages.DocumentSymbol[]
        if (isHierarchical) {
          const arr = result as LspDocumentSymbol[]
          const map = (s: LspDocumentSymbol): languages.DocumentSymbol => ({
            name: s.name,
            detail: s.detail ?? '',
            kind: symbolKind(monaco, s.kind),
            tags: [],
            range: toMonacoRange(s.range),
            selectionRange: toMonacoRange(s.selectionRange),
            children: s.children?.map(map) ?? [],
          })
          symbols = arr.map(map)
        } else {
          const arr = result as LspSymbolInformation[]
          symbols = arr.map((s) => ({
            name: s.name,
            detail: s.containerName ?? '',
            kind: symbolKind(monaco, s.kind),
            tags: [],
            range: toMonacoRange(s.location.range),
            selectionRange: toMonacoRange(s.location.range),
            children: [],
          }))
        }

        // Only cache if the model is still at the version we fetched for.
        // If the user typed during the await, the new version's request
        // will arrive next and we'd just store stale data otherwise.
        if (model.getVersionId() === versionId) {
          symbolCache.set({ uri, versionId }, symbols)
        }
        return symbols
  }

  disposables.push(
    monaco.languages.registerDocumentSymbolProvider(TS_LANGS, {
      displayName: 'Shogo Backend LSP',
      provideDocumentSymbols: (model, token) => provideDocumentSymbols(model, token),
    }),
  )

  // ─── Signature Help (parameter hints while typing args) ───────────────
  disposables.push(
    monaco.languages.registerSignatureHelpProvider(TS_LANGS, {
      signatureHelpTriggerCharacters: ['(', ','],
      provideSignatureHelp: async (model, position, token, _ctx) => {
        const path = pathFromModel(model, rootId)
        if (!path) return null
        const result = await post<LspSignatureHelp>('signatureHelp', {
          path,
          line: position.lineNumber - 1,
          character: position.column - 1,
        }, makeAbortSignal(token))
        if (!result || !Array.isArray(result.signatures) || result.signatures.length === 0) return null
        const value: languages.SignatureHelp = {
          signatures: result.signatures.map((s) => ({
            label: s.label,
            documentation: extractDocumentation(s.documentation, monaco),
            parameters: (s.parameters ?? []).map((p) => ({
              label: p.label,
              documentation: extractDocumentation(p.documentation, monaco),
            })),
          })),
          activeSignature: result.activeSignature ?? 0,
          activeParameter: result.activeParameter ?? 0,
        }
        return { value, dispose: () => {} }
      },
    }),
  )

  // ─── Rename ───────────────────────────────────────────────────────────
  disposables.push(
    monaco.languages.registerRenameProvider(TS_LANGS, {
      provideRenameEdits: async (model, position, newName, token) => {
        const path = pathFromModel(model, rootId)
        if (!path) return null
        const result = await post<LspWorkspaceEdit>('rename', {
          path,
          line: position.lineNumber - 1,
          character: position.column - 1,
          newName,
        }, makeAbortSignal(token))
        if (!result) return null
        const edits: languages.IWorkspaceTextEdit[] = []
        if (result.changes) {
          for (const [uri, textEdits] of Object.entries(result.changes)) {
            for (const e of textEdits) {
              edits.push({
                resource: toMonacoUri(monaco, rootId, uri),
                versionId: undefined,
                textEdit: { range: toMonacoRange(e.range), text: e.newText },
              })
            }
          }
        }
        if (result.documentChanges) {
          for (const dc of result.documentChanges) {
            for (const e of dc.edits) {
              edits.push({
                resource: toMonacoUri(monaco, rootId, dc.textDocument.uri),
                versionId: dc.textDocument.version ?? undefined,
                textEdit: { range: toMonacoRange(e.range), text: e.newText },
              })
            }
          }
        }
        return { edits } as languages.WorkspaceEdit
      },
    }),
  )

  const dispose = () => {
    for (const d of disposables) {
      try { d.dispose() } catch { /* best-effort */ }
    }
    if (installed?.dispose === dispose) installed = null
  }

  installed = { agentUrl, rootId, dispose }
  return { dispose }
}

/** Test hook — drops the installed providers without re-registering. */
export function __resetLspProvidersForTest(): void {
  if (installed) {
    try { installed.dispose() } catch { /* ignore */ }
    installed = null
  }
}

// Test-only re-exports for the URI / kind conversion helpers (the two pieces
// most likely to drift if the LSP spec or Monaco enum order changes).
export const __test = {
  pathFromModel,
  toMonacoRange,
  toMonacoUri,
  hoverContentsToMarkdown,
  locationsToMonaco,
}
