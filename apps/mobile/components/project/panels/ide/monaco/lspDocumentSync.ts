// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Monaco → backend LSP document synchronization.
 *
 * Watches Monaco model lifecycle events and pushes the corresponding
 * LSP notifications (didOpen / didChange / didClose) so tsserver sees
 * the live editor buffer rather than only what's saved on disk.
 *
 * Without this, hover/completion/definition would always reflect the
 * last-saved version of a file — typing in a buffer wouldn't update
 * the LSP's view of it. The sync runs alongside the existing
 * file-watcher path on the runtime (which keeps tsserver in sync with
 * agent disk writes); explicit didOpen/didChange/didClose let the IDE
 * own client-side document state without fighting the watcher.
 *
 * Filtered by `rootId` exactly the same way as `lspProviders.ts` so we
 * don't accidentally push a Local FS model into the agent LSP.
 */

import type * as Monaco from 'monaco-editor'
import type { editor, IDisposable } from 'monaco-editor'

type MonacoT = typeof Monaco

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Debounce window for didChange — collapses keystrokes within ~150ms into one notification. */
const DID_CHANGE_DEBOUNCE_MS = 150

const TS_PATH_RE = /\.(tsx?|jsx?)$/i

interface InstalledSync {
  agentUrl: string
  rootId: string
  dispose: () => void
}

let installed: InstalledSync | null = null

function pathFromModel(model: editor.ITextModel, expectedRootId: string): string | null {
  let raw = model.uri.path ?? ''
  try {
    raw = decodeURIComponent(raw)
  } catch {
    /* leave raw as-is */
  }
  raw = raw.replace(/^\/+/, '')
  const idx = raw.indexOf('::')
  if (idx === -1) return null
  if (raw.slice(0, idx) !== expectedRootId) return null
  return raw.slice(idx + 2)
}

function inferLanguageId(path: string): string {
  if (/\.tsx$/i.test(path)) return 'typescriptreact'
  if (/\.ts$/i.test(path)) return 'typescript'
  if (/\.jsx$/i.test(path)) return 'javascriptreact'
  if (/\.js$/i.test(path)) return 'javascript'
  return 'typescript'
}

export interface LspDocumentSyncConfig {
  monaco: MonacoT
  agentUrl: string
  /** Workspace `rootId` whose models should be synced to this LSP. Defaults to "agent". */
  rootId?: string
  fetchImpl?: FetchLike
}

/**
 * Install the sync handlers. Idempotent across repeat calls with the same
 * `agentUrl` + `rootId`. Returns a disposer that tears down all event
 * subscriptions and best-effort sends `didClose` for every currently-open
 * managed model so the LSP doesn't accumulate orphaned document state.
 */
export function setupLspDocumentSync(config: LspDocumentSyncConfig): { dispose: () => void } {
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

  const post = (path: string, body: unknown) => {
    // Fire-and-forget — failures are non-fatal (next change resyncs).
    return fetchImpl(`${agentUrl}/agent/lsp/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => undefined)
  }

  const tracked = new Map<string, {
    relPath: string
    version: number
    contentChangeSub: IDisposable
    willDisposeSub: IDisposable
    debounceTimer: ReturnType<typeof setTimeout> | null
  }>()

  const handleNewModel = (model: editor.ITextModel) => {
    const relPath = pathFromModel(model, rootId)
    if (!relPath) return
    if (!TS_PATH_RE.test(relPath)) return
    const key = model.uri.toString()
    if (tracked.has(key)) return

    const startVersion = 1
    const text = model.getValue()
    void post('didOpen', {
      path: relPath,
      languageId: inferLanguageId(relPath),
      version: startVersion,
      text,
    })

    const flush = () => {
      const entry = tracked.get(key)
      if (!entry) return
      entry.debounceTimer = null
      const fresh = monaco.editor.getModel(model.uri)
      if (!fresh) return
      entry.version += 1
      void post('didChange', {
        path: entry.relPath,
        version: entry.version,
        text: fresh.getValue(),
      })
    }

    const contentChangeSub = model.onDidChangeContent(() => {
      const entry = tracked.get(key)
      if (!entry) return
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      entry.debounceTimer = setTimeout(flush, DID_CHANGE_DEBOUNCE_MS)
    })

    const willDisposeSub = model.onWillDispose(() => {
      const entry = tracked.get(key)
      if (!entry) return
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      entry.contentChangeSub.dispose()
      entry.willDisposeSub.dispose()
      tracked.delete(key)
      void post('didClose', { path: entry.relPath })
    })

    tracked.set(key, {
      relPath,
      version: startVersion,
      contentChangeSub,
      willDisposeSub,
      debounceTimer: null,
    })
  }

  // Catch every model that already exists at install time…
  for (const m of monaco.editor.getModels()) {
    handleNewModel(m)
  }
  // …and every one created after.
  const onCreate = monaco.editor.onDidCreateModel(handleNewModel)

  const dispose = () => {
    onCreate.dispose()
    for (const entry of tracked.values()) {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      entry.contentChangeSub.dispose()
      entry.willDisposeSub.dispose()
      // Best-effort: tell the LSP we're no longer managing these so
      // tsserver can release the document state.
      void post('didClose', { path: entry.relPath })
    }
    tracked.clear()
    if (installed?.dispose === dispose) installed = null
  }

  installed = { agentUrl, rootId, dispose }
  return { dispose }
}

/**
 * Test hook so unit tests can drop the singleton between cases without
 * mounting a real Monaco instance.
 */
export function __resetLspDocumentSyncForTest(): void {
  if (installed) {
    try { installed.dispose() } catch { /* ignore */ }
    installed = null
  }
}

export const __test = { pathFromModel, inferLanguageId }
