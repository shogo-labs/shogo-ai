// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runtime-pod LSP routes for the Monaco IDE.
 *
 * The Monaco editor running in the browser delegates hover, completion,
 * go-to-definition, find-references, document-symbol, signature-help, and
 * rename to the typescript-language-server already running inside this
 * pod (started by the AgentGateway and used today only by the read_lints
 * diagnostic tool). Wiring those providers to a real LSP eliminates the
 * 1000-file Monaco bulk preload that used to be required for cross-file
 * IntelliSense — the LSP has native disk access and sees the workspace
 * without us shoveling files in.
 *
 * Wire format conventions (kept deliberately tight so the Monaco-side
 * adapter can be a thin translation layer):
 *
 *   - All requests are POST with JSON body. GETs are reserved for the
 *     `ready` health check.
 *   - Documents are addressed by workspace-relative `path` (no scheme,
 *     no leading slash, e.g. `src/App.tsx`). The handler resolves it to
 *     `${workspaceDir}/${path}` and rejects path traversal.
 *   - Positions use LSP's 0-indexed `{ line, character }`. Monaco's
 *     1-indexed conversion lives on the browser side.
 *   - Responses pass through tsserver's JSON verbatim — no shape
 *     translation here. The provider layer in the browser converts to
 *     Monaco's `Hover`, `CompletionList`, `Location[]`, etc.
 *
 * Mounted in `packages/agent-runtime/src/server.ts` BEFORE the SPA
 * static fallback. Path is `/agent/lsp/*` so the existing `/agent` auth
 * prefix and SPA-fallback skip-list both already cover it.
 */

import { Hono } from 'hono'
import { resolve, relative, sep } from 'path'
import type { WorkspaceLSPManager } from '@shogo/shared-runtime'

export interface RuntimeLspRoutesConfig {
  /** Absolute path to the workspace directory (per-project mount or overlay). */
  workspaceDir: string
  /** Returns the live LSP manager owned by AgentGateway, or null when not started. */
  getLspManager: () => WorkspaceLSPManager | null
}

/**
 * Resolve a workspace-relative path to an absolute path inside the
 * workspace, rejecting traversal attempts. Returns null if the path
 * would escape the workspace.
 */
function resolveWorkspacePath(workspaceDir: string, rawPath: string): string | null {
  if (!rawPath || typeof rawPath !== 'string') return null
  const cleaned = rawPath.replace(/^file:\/\//, '').replace(/^\/+/, '')
  if (!cleaned) return null
  const abs = resolve(workspaceDir, cleaned)
  const rel = relative(resolve(workspaceDir), abs)
  if (!rel || rel.startsWith('..' + sep) || rel === '..') return null
  if (rel.startsWith(sep)) return null
  if (sep === '\\' && /^[a-z]:/i.test(rel)) return null
  return abs
}

/**
 * Walk a JSON-shaped LSP response and rewrite any `file://` URI that
 * points inside `workspaceDir` to a workspace-relative path. This keeps
 * the client agnostic to where the workspace lives on disk — the browser
 * only ever sees paths like `src/App.tsx`.
 *
 * URIs outside the workspace (e.g. node_modules type definitions on the
 * pod's filesystem) are stripped to `null` so the IDE doesn't try to open
 * a path it can't reach. Rename / definition results into workspace-foreign
 * paths simply won't navigate, which is the correct degradation.
 */
function rewriteUrisInResponse(
  workspaceDir: string,
  value: unknown,
  depth = 0,
): unknown {
  // Defensive depth cap — LSP responses are bounded JSON, but we'd rather
  // bail than blow the stack on a server bug.
  if (depth > 64) return value
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    return rewriteUriString(workspaceDir, value)
  }
  if (Array.isArray(value)) {
    return value.map((v) => rewriteUrisInResponse(workspaceDir, v, depth + 1))
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    const obj = value as Record<string, unknown>
    for (const k of Object.keys(obj)) {
      const v = obj[k]
      if ((k === 'uri' || k === 'targetUri') && typeof v === 'string') {
        out[k] = rewriteUriString(workspaceDir, v)
        continue
      }
      if (k === 'changes' && v && typeof v === 'object' && !Array.isArray(v)) {
        // WorkspaceEdit.changes is `{ [uri: string]: TextEdit[] }` — rewrite
        // the keys too so the IDE doesn't have to know about absolute paths.
        const rewrittenChanges: Record<string, unknown> = {}
        const changes = v as Record<string, unknown>
        for (const ck of Object.keys(changes)) {
          const newKey = ck.startsWith('file://') ? rewriteUriString(workspaceDir, ck) : ck
          rewrittenChanges[newKey] = rewriteUrisInResponse(workspaceDir, changes[ck], depth + 2)
        }
        out[k] = rewrittenChanges
        continue
      }
      out[k] = rewriteUrisInResponse(workspaceDir, v, depth + 1)
    }
    return out
  }
  return value
}

function rewriteUriString(workspaceDir: string, uri: string): string {
  if (!uri.startsWith('file://')) return uri
  const decoded = decodeURIComponent(uri.slice('file://'.length))
  const absRoot = resolve(workspaceDir)
  const rel = relative(absRoot, decoded)
  if (!rel || rel.startsWith('..' + sep) || rel === '..') {
    // Outside the workspace — return as-is so the client can decide what to
    // do (Monaco will fail to navigate, which is the safe default).
    return uri
  }
  // Use forward-slash form on the wire regardless of host platform; Monaco
  // and the providers normalize on POSIX paths internally.
  const posix = rel.split(sep).join('/')
  return posix
}

interface PositionPayload {
  path?: unknown
  line?: unknown
  character?: unknown
}

interface ParsedPosition {
  filePath: string
  line: number
  character: number
}

/** Validate `{ path, line, character }` payload, returning a typed result or an error object. */
function parsePosition(workspaceDir: string, body: PositionPayload): ParsedPosition | { error: string } {
  const filePath = typeof body.path === 'string' ? resolveWorkspacePath(workspaceDir, body.path) : null
  if (!filePath) return { error: 'Invalid or missing `path` (must be a workspace-relative file path)' }
  const line = typeof body.line === 'number' ? body.line : NaN
  const character = typeof body.character === 'number' ? body.character : NaN
  if (!Number.isFinite(line) || line < 0) return { error: '`line` must be a non-negative integer' }
  if (!Number.isFinite(character) || character < 0) return { error: '`character` must be a non-negative integer' }
  return { filePath, line: Math.floor(line), character: Math.floor(character) }
}

export function runtimeLspRoutes(config: RuntimeLspRoutesConfig) {
  const { workspaceDir, getLspManager } = config
  const app = new Hono()

  // Quick guard middleware — every LSP route requires the manager to exist.
  // We keep `ready` separate so the IDE can poll it during cold-start without
  // spamming 503s on every hover.
  const requireLsp = async (c: any, next: any) => {
    const lsp = getLspManager()
    if (!lsp) {
      return c.json({ error: { code: 'lsp_not_started', message: 'LSP manager not initialized yet' } }, 503)
    }
    if (!lsp.isTSReady()) {
      return c.json({ error: { code: 'lsp_starting', message: 'TS language server is still starting' } }, 503)
    }
    c.set('lsp', lsp)
    return next()
  }

  app.get('/agent/lsp/ready', (c) => {
    const lsp = getLspManager()
    return c.json({
      ready: !!(lsp && lsp.isTSReady()),
      label: 'ts',
    })
  })

  // -------------------------------------------------------------------------
  // Document sync — Monaco drives version + content explicitly so the LSP
  // sees the live editor buffer (not just the last-saved file on disk).
  // -------------------------------------------------------------------------

  app.post('/agent/lsp/didOpen', requireLsp, async (c) => {
    const body = await c.req.json().catch(() => null) as {
      path?: string; languageId?: string; version?: number; text?: string
    } | null
    if (!body) return c.json({ error: { code: 'bad_request', message: 'Body must be JSON' } }, 400)
    const filePath = typeof body.path === 'string' ? resolveWorkspacePath(workspaceDir, body.path) : null
    if (!filePath) return c.json({ error: { code: 'bad_request', message: 'Invalid `path`' } }, 400)
    if (typeof body.text !== 'string') {
      return c.json({ error: { code: 'bad_request', message: '`text` is required' } }, 400)
    }
    const languageId = typeof body.languageId === 'string' && body.languageId
      ? body.languageId
      : inferLanguageIdFromPath(filePath)
    const version = typeof body.version === 'number' && Number.isFinite(body.version) ? body.version : 1
    const lsp = c.get('lsp') as WorkspaceLSPManager
    lsp.didOpenDocument(filePath, languageId, version, body.text)
    return c.json({ ok: true })
  })

  app.post('/agent/lsp/didChange', requireLsp, async (c) => {
    const body = await c.req.json().catch(() => null) as {
      path?: string; version?: number; text?: string
    } | null
    if (!body) return c.json({ error: { code: 'bad_request', message: 'Body must be JSON' } }, 400)
    const filePath = typeof body.path === 'string' ? resolveWorkspacePath(workspaceDir, body.path) : null
    if (!filePath) return c.json({ error: { code: 'bad_request', message: 'Invalid `path`' } }, 400)
    if (typeof body.text !== 'string') {
      return c.json({ error: { code: 'bad_request', message: '`text` is required' } }, 400)
    }
    const version = typeof body.version === 'number' && Number.isFinite(body.version) ? body.version : 2
    const lsp = c.get('lsp') as WorkspaceLSPManager
    lsp.didChangeDocument(filePath, version, body.text)
    return c.json({ ok: true })
  })

  app.post('/agent/lsp/didClose', requireLsp, async (c) => {
    const body = await c.req.json().catch(() => null) as { path?: string } | null
    if (!body) return c.json({ error: { code: 'bad_request', message: 'Body must be JSON' } }, 400)
    const filePath = typeof body.path === 'string' ? resolveWorkspacePath(workspaceDir, body.path) : null
    if (!filePath) return c.json({ error: { code: 'bad_request', message: 'Invalid `path`' } }, 400)
    const lsp = c.get('lsp') as WorkspaceLSPManager
    lsp.didCloseDocument(filePath)
    return c.json({ ok: true })
  })

  // -------------------------------------------------------------------------
  // Request methods — JSON in, LSP JSON out (verbatim).
  // -------------------------------------------------------------------------

  app.post('/agent/lsp/hover', requireLsp, async (c) => {
    const body = await c.req.json().catch(() => null) as PositionPayload | null
    if (!body) return c.json({ error: { code: 'bad_request', message: 'Body must be JSON' } }, 400)
    const parsed = parsePosition(workspaceDir, body)
    if ('error' in parsed) return c.json({ error: { code: 'bad_request', message: parsed.error } }, 400)
    const lsp = c.get('lsp') as WorkspaceLSPManager
    try {
      const result = await lsp.hover(parsed.filePath, parsed.line, parsed.character)
      return c.json({ result: rewriteUrisInResponse(workspaceDir, result ?? null) })
    } catch (err: any) {
      return c.json({ error: { code: 'lsp_error', message: err?.message || 'hover failed' } }, 500)
    }
  })

  app.post('/agent/lsp/completion', requireLsp, async (c) => {
    const body = await c.req.json().catch(() => null) as (PositionPayload & {
      context?: { triggerKind?: number; triggerCharacter?: string }
    }) | null
    if (!body) return c.json({ error: { code: 'bad_request', message: 'Body must be JSON' } }, 400)
    const parsed = parsePosition(workspaceDir, body)
    if ('error' in parsed) return c.json({ error: { code: 'bad_request', message: parsed.error } }, 400)
    const lsp = c.get('lsp') as WorkspaceLSPManager
    try {
      const result = await lsp.completion(parsed.filePath, parsed.line, parsed.character, body.context)
      return c.json({ result: rewriteUrisInResponse(workspaceDir, result ?? null) })
    } catch (err: any) {
      return c.json({ error: { code: 'lsp_error', message: err?.message || 'completion failed' } }, 500)
    }
  })

  app.post('/agent/lsp/definition', requireLsp, async (c) => {
    const body = await c.req.json().catch(() => null) as PositionPayload | null
    if (!body) return c.json({ error: { code: 'bad_request', message: 'Body must be JSON' } }, 400)
    const parsed = parsePosition(workspaceDir, body)
    if ('error' in parsed) return c.json({ error: { code: 'bad_request', message: parsed.error } }, 400)
    const lsp = c.get('lsp') as WorkspaceLSPManager
    try {
      const result = await lsp.definition(parsed.filePath, parsed.line, parsed.character)
      return c.json({ result: rewriteUrisInResponse(workspaceDir, result ?? null) })
    } catch (err: any) {
      return c.json({ error: { code: 'lsp_error', message: err?.message || 'definition failed' } }, 500)
    }
  })

  app.post('/agent/lsp/references', requireLsp, async (c) => {
    const body = await c.req.json().catch(() => null) as (PositionPayload & {
      includeDeclaration?: boolean
    }) | null
    if (!body) return c.json({ error: { code: 'bad_request', message: 'Body must be JSON' } }, 400)
    const parsed = parsePosition(workspaceDir, body)
    if ('error' in parsed) return c.json({ error: { code: 'bad_request', message: parsed.error } }, 400)
    const lsp = c.get('lsp') as WorkspaceLSPManager
    try {
      const result = await lsp.references(
        parsed.filePath,
        parsed.line,
        parsed.character,
        body.includeDeclaration !== false,
      )
      return c.json({ result: rewriteUrisInResponse(workspaceDir, result ?? null) })
    } catch (err: any) {
      return c.json({ error: { code: 'lsp_error', message: err?.message || 'references failed' } }, 500)
    }
  })

  app.post('/agent/lsp/documentSymbol', requireLsp, async (c) => {
    const body = await c.req.json().catch(() => null) as { path?: string } | null
    if (!body) return c.json({ error: { code: 'bad_request', message: 'Body must be JSON' } }, 400)
    const filePath = typeof body.path === 'string' ? resolveWorkspacePath(workspaceDir, body.path) : null
    if (!filePath) return c.json({ error: { code: 'bad_request', message: 'Invalid `path`' } }, 400)
    const lsp = c.get('lsp') as WorkspaceLSPManager
    try {
      const result = await lsp.documentSymbol(filePath)
      return c.json({ result: rewriteUrisInResponse(workspaceDir, result ?? null) })
    } catch (err: any) {
      return c.json({ error: { code: 'lsp_error', message: err?.message || 'documentSymbol failed' } }, 500)
    }
  })

  app.post('/agent/lsp/signatureHelp', requireLsp, async (c) => {
    const body = await c.req.json().catch(() => null) as PositionPayload | null
    if (!body) return c.json({ error: { code: 'bad_request', message: 'Body must be JSON' } }, 400)
    const parsed = parsePosition(workspaceDir, body)
    if ('error' in parsed) return c.json({ error: { code: 'bad_request', message: parsed.error } }, 400)
    const lsp = c.get('lsp') as WorkspaceLSPManager
    try {
      const result = await lsp.signatureHelp(parsed.filePath, parsed.line, parsed.character)
      return c.json({ result: rewriteUrisInResponse(workspaceDir, result ?? null) })
    } catch (err: any) {
      return c.json({ error: { code: 'lsp_error', message: err?.message || 'signatureHelp failed' } }, 500)
    }
  })

  app.post('/agent/lsp/rename', requireLsp, async (c) => {
    const body = await c.req.json().catch(() => null) as (PositionPayload & {
      newName?: string
    }) | null
    if (!body) return c.json({ error: { code: 'bad_request', message: 'Body must be JSON' } }, 400)
    const parsed = parsePosition(workspaceDir, body)
    if ('error' in parsed) return c.json({ error: { code: 'bad_request', message: parsed.error } }, 400)
    const newName = typeof body.newName === 'string' ? body.newName.trim() : ''
    if (!newName) return c.json({ error: { code: 'bad_request', message: '`newName` must be a non-empty string' } }, 400)
    const lsp = c.get('lsp') as WorkspaceLSPManager
    try {
      const result = await lsp.rename(parsed.filePath, parsed.line, parsed.character, newName)
      return c.json({ result: rewriteUrisInResponse(workspaceDir, result ?? null) })
    } catch (err: any) {
      return c.json({ error: { code: 'lsp_error', message: err?.message || 'rename failed' } }, 500)
    }
  })

  return app
}

function inferLanguageIdFromPath(filePath: string): string {
  if (/\.tsx$/i.test(filePath)) return 'typescriptreact'
  if (/\.ts$/i.test(filePath)) return 'typescript'
  if (/\.jsx$/i.test(filePath)) return 'javascriptreact'
  if (/\.js$/i.test(filePath)) return 'javascript'
  return 'typescript'
}

// Internal helpers exposed for unit tests so we can validate path-traversal
// rejection and payload parsing without standing up the full Hono app.
export const __test = { resolveWorkspacePath, parsePosition, inferLanguageIdFromPath }

export default runtimeLspRoutes
