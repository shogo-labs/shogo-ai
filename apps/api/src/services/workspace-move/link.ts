// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The two ends of a move, behind one interface.
 *
 * The desktop always drives (decision in the plan: the cloud cannot reach a
 * laptop), and `direction` only decides which end is local and which is remote:
 *
 *   desktop -> cloud : source = Local, target = Http
 *   cloud -> desktop : source = Http,  target = Local
 *
 * Because both ends implement the same interface, the runner below is one code
 * path. The HTTP implementations talk to `/api/workspace-moves/serve/*` and
 * `/api/workspace-moves/receive/*`, which are mounted on both composers.
 */

import { prisma } from '../../lib/prisma'
import { workspacesDir } from '../workspace-export/files'
import type { HandoverKind } from './handover'
import {
  flushTargetProject,
  initTargetWorkspace,
  receiveFile,
  relinkTargetProject,
  setEnabledAtTarget,
  targetFileManifest,
  writeRecordChunk,
} from './receive'
import {
  markSourceMoved,
  readSourceFile,
  setEnabledAtSource,
  sourceFileManifest,
  streamSourceRecords,
  type RecordsChunk,
  type SourceScope,
} from './serve'
import type { MoveFileManifest, MoveRow, MoveSelection } from './types'
import { WorkspaceMoveError } from './types'

export interface MoveSource {
  /** The narrowed snapshot, as a plain object so it can cross the wire. */
  planRows(scope: SourceScope): Promise<{ rows: Record<string, MoveRow[]> }>
  streamRecords(
    scope: SourceScope & { moveId: string; targetWorkspaceId: string },
    from?: { model?: string; cursor?: number },
  ): AsyncIterable<RecordsChunk>
  fileManifest(input: { workspaceId: string; projectId: string }): Promise<MoveFileManifest>
  readFile(input: { workspaceId: string; projectId: string; path: string }): Promise<Uint8Array>
  setEnabled(input: { workspaceId: string; kind: HandoverKind; ids: string[]; enabled: boolean }): Promise<void>
  markMoved(input: { workspaceId: string; targetWorkspaceId: string | null }): Promise<void>
}

export interface MoveTarget {
  init(input: {
    name: string
    sourceWorkspaceId: string
    ownerUserId: string
    instanceSize?: string | null
  }): Promise<{ workspaceId: string }>
  writeRecords(input: { workspaceId: string; model: string; rows: MoveRow[] }): Promise<{ inserted: number }>
  fileManifest(input: { workspaceId: string; projectId: string }): Promise<MoveFileManifest>
  writeFile(input: { workspaceId: string; projectId: string; path: string; bytes: Uint8Array }): Promise<void>
  /**
   * Hand a project's received files to whatever the target's runtime reads.
   *
   * A local target's directory *is* that store, so it does nothing there. A
   * Kubernetes target has to push to S3 after the files land, or the runtime pod
   * never sees them (SHO-252).
   */
  flushFiles(input: { workspaceId: string; projectId: string }): Promise<{ notices: string[] }>
  setEnabled(input: { workspaceId: string; kind: HandoverKind; ids: string[]; enabled: boolean }): Promise<void>
  relink(input: {
    workspaceId: string
    projectId: string
    name: string
    remote: string
    branch: string
  }): Promise<void>
}

// ─── Local (this process owns the data) ─────────────────────────────

export class LocalMoveSource implements MoveSource {
  constructor(
    private readonly db: any = prisma,
    private readonly base = workspacesDir(),
  ) {}

  async planRows(scope: SourceScope) {
    const { collectMoveRows } = await import('./plan')
    const result = await collectMoveRows({ ...scope, db: this.db })
    const rows: Record<string, MoveRow[]> = {}
    for (const [model, list] of result.rows) rows[model] = list
    return { rows }
  }

  streamRecords(
    scope: SourceScope & { moveId: string; targetWorkspaceId: string },
    from?: { model?: string; cursor?: number },
  ): AsyncIterable<RecordsChunk> {
    return streamSourceRecords(this.db, scope, from)
  }

  fileManifest(input: { workspaceId: string; projectId: string }) {
    return sourceFileManifest(this.db, { ...input, base: this.base })
  }

  async readFile(input: { workspaceId: string; projectId: string; path: string }) {
    return readSourceFile(this.db, { ...input, base: this.base })
  }

  setEnabled(input: { workspaceId: string; kind: HandoverKind; ids: string[]; enabled: boolean }) {
    return setEnabledAtSource(this.db, input)
  }

  markMoved(input: { workspaceId: string; targetWorkspaceId: string | null }) {
    return markSourceMoved(this.db, input.workspaceId, input.targetWorkspaceId)
  }
}

export class LocalMoveTarget implements MoveTarget {
  constructor(
    private readonly db: any = prisma,
    private readonly base = workspacesDir(),
  ) {}

  init(input: { name: string; sourceWorkspaceId: string; ownerUserId: string; instanceSize?: string | null }) {
    return initTargetWorkspace(this.db, input)
  }

  writeRecords(input: { workspaceId: string; model: string; rows: MoveRow[] }) {
    return writeRecordChunk(this.db, input.model, input.rows)
  }

  fileManifest(input: { workspaceId: string; projectId: string }) {
    return targetFileManifest(input.projectId, input.workspaceId, this.base)
  }

  async writeFile(input: { workspaceId: string; projectId: string; path: string; bytes: Uint8Array }) {
    await receiveFile(input.projectId, input.workspaceId, input.path, input.bytes, this.base)
  }

  flushFiles(input: { workspaceId: string; projectId: string }) {
    return flushTargetProject(input.projectId, input.workspaceId, this.base)
  }

  setEnabled(input: { workspaceId: string; kind: HandoverKind; ids: string[]; enabled: boolean }) {
    return setEnabledAtTarget(this.db, input)
  }

  async relink(input: { workspaceId: string; projectId: string; name: string; remote: string; branch: string }) {
    await relinkTargetProject(this.db, input)
  }
}

// ─── Remote (the other side of the signed-in link) ──────────────────

export interface RemoteOptions {
  apiUrl: string
  apiKey: string
  moveId: string
  fetchImpl?: typeof fetch
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

async function readNdjson<T>(body: ReadableStream<Uint8Array> | null): Promise<T[]> {
  if (!body) return []
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const out: T[] = []
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) out.push(JSON.parse(line) as T)
      index = buffer.indexOf('\n')
    }
  }
  const tail = buffer.trim()
  if (tail) out.push(JSON.parse(tail) as T)
  return out
}

export class HttpMoveSource implements MoveSource {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly opts: RemoteOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  private headers(json = true): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.apiKey}`,
      ...(json ? { 'content-type': 'application/json' } : {}),
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(joinUrl(this.opts.apiUrl, path), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new WorkspaceMoveError(await describe(res, path), res.status, 'workspace_move_remote_failed')
    return (await res.json()) as T
  }

  async planRows(scope: SourceScope) {
    return this.post<{ rows: Record<string, MoveRow[]> }>('/api/workspace-moves/serve/plan', scope)
  }

  async *streamRecords(
    scope: SourceScope & { moveId: string; targetWorkspaceId: string },
    from: { model?: string; cursor?: number } = {},
  ): AsyncGenerator<RecordsChunk> {
    const res = await this.fetchImpl(joinUrl(this.opts.apiUrl, '/api/workspace-moves/serve/records'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ ...scope, fromModel: from.model ?? null, cursor: from.cursor ?? 0 }),
    })
    if (!res.ok) throw new WorkspaceMoveError(await describe(res, 'records'), res.status, 'workspace_move_remote_failed')
    const chunks = await readNdjson<RecordsChunk>(res.body)
    for (const chunk of chunks) yield chunk
  }

  async fileManifest(input: { workspaceId: string; projectId: string }) {
    return this.post<MoveFileManifest>('/api/workspace-moves/serve/files/manifest', input)
  }

  async readFile(input: { workspaceId: string; projectId: string; path: string }) {
    const query = new URLSearchParams({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      path: input.path,
    })
    const res = await this.fetchImpl(
      joinUrl(this.opts.apiUrl, `/api/workspace-moves/serve/files/raw?${query.toString()}`),
      { headers: this.headers(false) },
    )
    if (!res.ok) throw new WorkspaceMoveError(await describe(res, input.path), res.status, 'workspace_move_remote_failed')
    return new Uint8Array(await res.arrayBuffer())
  }

  async setEnabled(input: { workspaceId: string; kind: HandoverKind; ids: string[]; enabled: boolean }) {
    await this.post('/api/workspace-moves/serve/enabled', input)
  }

  async markMoved(input: { workspaceId: string; targetWorkspaceId: string | null }) {
    await this.post('/api/workspace-moves/serve/moved', input)
  }
}

/**
 * Models the wire never carries (SEC-18).
 *
 * `Member` is refused by `/receive/records` on purpose: membership of the
 * workspace a move lands in is decided by the receiving instance — `/receive/init`
 * makes the caller its owner — never by the side that sent the rows. Sending it
 * anyway would turn every move into a 400 on its first membership chunk, so the
 * HTTP target skips it. The in-process target (a desktop receiving a move) still
 * writes the members: there is no wire, and no untrusted caller.
 */
const NEVER_OVER_HTTP: ReadonlySet<string> = new Set(['Member'])

export class HttpMoveTarget implements MoveTarget {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly opts: RemoteOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  private headers(json = true): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.apiKey}`,
      ...(json ? { 'content-type': 'application/json' } : {}),
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(joinUrl(this.opts.apiUrl, path), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new WorkspaceMoveError(await describe(res, path), res.status, 'workspace_move_remote_failed')
    return (await res.json()) as T
  }

  init(input: { name: string; sourceWorkspaceId: string; ownerUserId: string; instanceSize?: string | null }) {
    return this.post<{ workspaceId: string }>('/api/workspace-moves/receive/init', input)
  }

  writeRecords(input: { workspaceId: string; model: string; rows: MoveRow[] }) {
    if (NEVER_OVER_HTTP.has(input.model)) return Promise.resolve({ inserted: 0 })
    return this.post<{ inserted: number }>('/api/workspace-moves/receive/records', input)
  }

  fileManifest(input: { workspaceId: string; projectId: string }) {
    return this.post<MoveFileManifest>('/api/workspace-moves/receive/files/manifest', input)
  }

  async writeFile(input: { workspaceId: string; projectId: string; path: string; bytes: Uint8Array }) {
    const query = new URLSearchParams({ workspaceId: input.workspaceId, projectId: input.projectId, path: input.path })
    const res = await this.fetchImpl(
      joinUrl(this.opts.apiUrl, `/api/workspace-moves/receive/files/raw?${query.toString()}`),
      { method: 'PUT', headers: this.headers(false), body: input.bytes as any },
    )
    if (!res.ok) throw new WorkspaceMoveError(await describe(res, input.path), res.status, 'workspace_move_remote_failed')
  }

  async flushFiles(input: { workspaceId: string; projectId: string }) {
    return this.post<{ notices?: string[] }>('/api/workspace-moves/receive/files/flush', input)
      .then((body) => ({ notices: body?.notices ?? [] }))
  }

  async setEnabled(input: { workspaceId: string; kind: HandoverKind; ids: string[]; enabled: boolean }) {
    await this.post('/api/workspace-moves/receive/enabled', input)
  }

  async relink(input: { workspaceId: string; projectId: string; name: string; remote: string; branch: string }) {
    await this.post('/api/workspace-moves/receive/relink', input)
  }
}

async function describe(res: Response, what: string): Promise<string> {
  let detail = ''
  try {
    const body = (await res.json()) as any
    detail = body?.error?.message ?? body?.error ?? ''
  } catch {
    detail = ''
  }
  return `The other side refused ${what}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`
}
