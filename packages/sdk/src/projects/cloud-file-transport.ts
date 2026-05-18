// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CloudFileTransport
 *
 * Cross-runtime (Node, Bun, edge) file sync that moves a project's
 * workspace between cloud and a local directory using ONLY the Shogo
 * Cloud Files API — no AWS credentials required.
 *
 * It is the engine behind:
 *   - `shogo project pull <projectId>` (CLI)
 *   - `shogo project push <projectId>` (CLI)
 *   - `client.projects.pull/push` (SDK)
 *   - `WorkerRuntimeManager` auto-pull (worker package)
 *
 * Why a separate module from `@shogo/shared-runtime`'s `S3Sync`?
 *   - S3Sync needs `AWS_*` env vars + a direct S3 endpoint and is AGPL.
 *     That makes it impossible for a third-party VPS worker to use
 *     without leaking cloud-operator credentials to every paired host.
 *   - CloudFileTransport speaks the public Files API instead:
 *       GET /api/projects/:id/workspace/manifest
 *       POST /api/projects/:id/s3/presign  (batched, action=read|write)
 *       PUT /api/projects/:id/files/*       (proxied write fallback)
 *       DELETE /api/projects/:id/files/*    (push --delete-remote)
 *   - This module is MIT-licensed so the worker (also MIT) can depend
 *     on it without becoming AGPL.
 *
 * Concurrency: at most {@link CloudFileTransportOptions.concurrency}
 * parallel uploads/downloads (default 8). The transport never spins
 * background workers on its own; the long-running watcher lives in the
 * worker package because file watching is inherently Node-only.
 */

const DEFAULT_CONCURRENCY = 8

export interface CloudFileTransportOptions {
  /** Base URL of the Shogo Cloud API (e.g. `https://api.shogo.ai`). */
  apiUrl: string
  /** `shogo_sk_*` API key — sent as `Authorization: Bearer <key>`. */
  apiKey: string
  /** Project UUID. */
  projectId: string
  /** Local destination directory. Must already exist on push. */
  localDir: string
  /**
   * Optional include filter (gitignore-style globs joined with commas).
   * If unset, every manifest entry that the server returns is synced.
   */
  include?: string[]
  /** Max parallel HTTP requests. Default 8. */
  concurrency?: number
  /**
   * Hook for progress reporting. Called once per file when an upload
   * or download finishes (success OR skip; not called on failure).
   */
  onProgress?: (event: ProgressEvent) => void
  /**
   * Override `fetch` for tests. Defaults to globalThis.fetch.
   */
  fetchImpl?: typeof fetch
  /**
   * Node-only filesystem adapter. Required at runtime when calling
   * `downloadAll` / `uploadAll`; left injectable so the SDK doesn't have
   * to statically `import 'node:fs'` (and break in edge/browser bundles).
   */
  fs?: FsAdapter
}

export interface ProgressEvent {
  kind: 'download' | 'upload' | 'delete' | 'skip'
  path: string
  bytes?: number
  /** Index of this file within the current batch (0-based). */
  index: number
  /** Total files in this batch. */
  total: number
}

export interface ManifestEntry {
  path: string
  size: number
  lastModified: string | null
  etag: string | null
}

export interface WorkspaceManifest {
  ok: true
  projectId: string
  files: ManifestEntry[]
  source: string
  generatedAt: string
}

export interface SyncStats {
  downloaded: number
  uploaded: number
  skipped: number
  deleted: number
  errors: Array<{ path: string; message: string }>
}

/**
 * Subset of `node:fs/promises` we actually need. Easy to fake for tests
 * and lets the SDK avoid a static `import 'node:fs'` at module load time.
 */
export interface FsAdapter {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  mkdir(path: string, opts: { recursive: true }): Promise<void>
  unlink(path: string): Promise<void>
  stat(path: string): Promise<{ size: number; mtimeMs: number; isDirectory(): boolean }>
  readdir(path: string, opts: { withFileTypes: true }): Promise<Array<{
    name: string
    isDirectory(): boolean
    isFile(): boolean
  }>>
  rename(src: string, dest: string): Promise<void>
  rm(path: string, opts: { recursive: true; force: true }): Promise<void>
}

/**
 * Lazy default `FsAdapter` backed by `node:fs/promises`. Only loaded
 * inside Node-like environments (when `globalThis.process` exists).
 * Throws a friendly error if called in a browser bundle.
 *
 * IMPORTANT — why `new Function(...)` instead of a plain `await import(...)`:
 *
 * Metro (React Native), webpack, esbuild and rollup all perform STATIC
 * module-graph analysis on `import()` calls whose argument is a string
 * literal. A literal `await import('node:fs/promises')` here is treated
 * as a hard dependency of the bundle even though it's only reachable in
 * Node at runtime. RN's bundler then fails the iOS / Android bundle with
 *   `Unable to resolve module fs/promises from packages/sdk/dist/index.js`
 * because Metro doesn't understand the `node:` scheme and tsup strips
 * the prefix in `dist/index.js`. (See android-build run #26016279560.)
 *
 * Wrapping the dynamic import in `new Function(...)` makes the argument
 * an opaque string literal inside a function body — bundlers do not look
 * inside `Function` constructors, so the spec is invisible to static
 * analysis. At runtime, the host's native `import()` still resolves it
 * exactly as before in Node/Bun, and the surrounding `isNode` guard
 * guarantees we never reach this line in a browser/RN runtime.
 */
async function getDefaultFs(): Promise<FsAdapter> {
  const isNode = typeof globalThis !== 'undefined' && typeof (globalThis as any).process?.versions?.node === 'string'
  if (!isNode) {
    throw new Error(
      'CloudFileTransport: no FsAdapter passed and `node:fs/promises` is not available. ' +
        'Provide `fs` in CloudFileTransportOptions when running outside Node/Bun.',
    )
  }
  const bundlerOpaqueImport = new Function('s', 'return import(s)') as (
    spec: string,
  ) => Promise<typeof import('node:fs/promises')>
  const mod = await bundlerOpaqueImport('node:fs/promises')
  return {
    readFile: (p) => mod.readFile(p),
    writeFile: (p, d) => mod.writeFile(p, d),
    mkdir: (p, o) => mod.mkdir(p, o).then(() => undefined),
    unlink: (p) => mod.unlink(p),
    stat: async (p) => {
      const s = await mod.stat(p)
      return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: () => s.isDirectory() }
    },
    readdir: async (p, o) => {
      const entries = await mod.readdir(p, o)
      return entries.map((e: any) => ({
        name: e.name,
        isDirectory: () => e.isDirectory(),
        isFile: () => e.isFile(),
      }))
    },
    rename: (s, d) => mod.rename(s, d),
    rm: (p, o) => mod.rm(p, o),
  }
}

/**
 * Joins URL segments with a single slash, tolerating trailing/leading
 * slashes on either side. Avoids the awkward `URL` constructor for
 * relative path composition.
 */
function joinUrl(base: string, ...parts: string[]): string {
  const trimmed = base.replace(/\/+$/, '')
  const rest = parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')
  return `${trimmed}/${rest}`
}

/** Cross-platform path.join that always produces forward-slash relative segments. */
function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .join('/')
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}

/** Default include matcher: very small subset of gitignore globs. */
function makeMatcher(patterns?: string[]): (path: string) => boolean {
  if (!patterns?.length) return () => true
  const regexes = patterns.map((p) => {
    const escaped = p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*')
      .replace(/\?/g, '[^/]')
    return new RegExp(`^${escaped}$`)
  })
  return (path) => regexes.some((re) => re.test(path))
}

/** Run `worker(item, idx, total)` over items with at most `limit` parallel. */
async function pool<T>(
  items: T[],
  limit: number,
  worker: (item: T, idx: number, total: number) => Promise<void>,
): Promise<void> {
  const total = items.length
  let next = 0
  const runners: Promise<void>[] = []
  const N = Math.min(limit, Math.max(1, total))
  for (let i = 0; i < N; i++) {
    runners.push(
      (async () => {
        while (true) {
          const idx = next++
          if (idx >= total) return
          await worker(items[idx]!, idx, total)
        }
      })(),
    )
  }
  await Promise.all(runners)
}

export class CloudFileTransport {
  private readonly apiUrl: string
  private readonly apiKey: string
  private readonly projectId: string
  private readonly localDir: string
  private readonly include: (path: string) => boolean
  private readonly concurrency: number
  private readonly onProgress?: (event: ProgressEvent) => void
  private readonly fetchImpl: typeof fetch
  private readonly fsOverride?: FsAdapter
  private fsCached: FsAdapter | null = null

  constructor(opts: CloudFileTransportOptions) {
    if (!opts.apiUrl) throw new Error('CloudFileTransport: apiUrl is required')
    if (!opts.apiKey) throw new Error('CloudFileTransport: apiKey is required')
    if (!opts.projectId) throw new Error('CloudFileTransport: projectId is required')
    if (!opts.localDir) throw new Error('CloudFileTransport: localDir is required')

    this.apiUrl = opts.apiUrl.replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.projectId = opts.projectId
    this.localDir = opts.localDir
    this.include = makeMatcher(opts.include)
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
    this.onProgress = opts.onProgress
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.fsOverride = opts.fs
  }

  // ─── Manifest ────────────────────────────────────────────────────

  /**
   * Fetch the full workspace manifest from the cloud. Returns every
   * file the server is willing to expose (excluded dirs + sensitive
   * patterns already filtered server-side).
   */
  async listManifest(): Promise<ManifestEntry[]> {
    const url = joinUrl(this.apiUrl, '/api/projects', encodeURIComponent(this.projectId), '/workspace/manifest')
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: this.authHeaders(),
    })
    if (!res.ok) {
      throw new Error(`manifest_failed: HTTP ${res.status} ${await safeText(res)}`)
    }
    const body = (await res.json()) as WorkspaceManifest
    return body.files.filter((f) => this.include(f.path))
  }

  // ─── Pull (cloud → local) ────────────────────────────────────────

  /**
   * Pull every manifest entry that's missing or stale locally.
   *
   * Atomicity: the pull writes into `<localDir>.shogo-pull-tmp/` and
   * then renames over `<localDir>` on success, so a Ctrl-C mid-pull
   * never leaves a half-populated workspace dir. The previous content
   * is wiped on commit — callers that want incremental updates should
   * use {@link downloadFiles} directly instead.
   */
  async downloadAll(): Promise<SyncStats> {
    const stats: SyncStats = { downloaded: 0, uploaded: 0, skipped: 0, deleted: 0, errors: [] }
    const fs = await this.fs()

    const manifest = await this.listManifest()
    const stagingDir = `${this.localDir}.shogo-pull-tmp`
    try {
      await fs.rm(stagingDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    await fs.mkdir(stagingDir, { recursive: true })

    await this.downloadFilesInto(manifest, stagingDir, stats)
    if (stats.errors.length === 0) {
      // Atomic-ish swap. Best effort on platforms (Windows) where rename
      // over a non-empty target is not allowed: fall back to rm+rename.
      try {
        await fs.rm(this.localDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      await fs.rename(stagingDir, this.localDir)
    } else {
      // Leave the staging dir for debugging but don't clobber the live dir.
      throw new Error(
        `Pull aborted with ${stats.errors.length} errors (first: ${stats.errors[0]?.message}). ` +
          `Staging dir left at ${stagingDir}.`,
      )
    }
    return stats
  }

  /**
   * Lower-level pull that downloads `files` into an arbitrary directory.
   * Used by `downloadAll` for staging and by the worker auto-pull for
   * "merge into existing workspace" semantics.
   */
  async downloadFiles(files: ManifestEntry[]): Promise<SyncStats> {
    const stats: SyncStats = { downloaded: 0, uploaded: 0, skipped: 0, deleted: 0, errors: [] }
    await this.downloadFilesInto(files, this.localDir, stats)
    return stats
  }

  private async downloadFilesInto(files: ManifestEntry[], destDir: string, stats: SyncStats): Promise<void> {
    if (files.length === 0) return
    const fs = await this.fs()
    const urls = await this.presignBatch(
      files.map((f) => ({ path: f.path, action: 'read' as const })),
    )

    const urlByPath = new Map(urls.map((u) => [u.path, u.url]))
    await pool(files, this.concurrency, async (entry, idx, total) => {
      const url = urlByPath.get(entry.path)
      if (!url) {
        stats.errors.push({ path: entry.path, message: 'No presigned URL returned' })
        return
      }
      try {
        const resp = await this.fetchImpl(url)
        if (!resp.ok) {
          stats.errors.push({ path: entry.path, message: `HTTP ${resp.status} fetching ${entry.path}` })
          return
        }
        const buf = new Uint8Array(await resp.arrayBuffer())
        const localPath = joinPath(destDir, entry.path)
        const parent = dirOf(localPath)
        if (parent) await fs.mkdir(parent, { recursive: true })
        await fs.writeFile(localPath, buf)
        stats.downloaded += 1
        this.onProgress?.({ kind: 'download', path: entry.path, bytes: buf.byteLength, index: idx, total })
      } catch (err: any) {
        stats.errors.push({ path: entry.path, message: err?.message ?? String(err) })
      }
    })
  }

  // ─── Push (local → cloud) ────────────────────────────────────────

  /**
   * Walk `localDir`, build a list of files matching the include filter,
   * and upload each via a presigned PUT. If `opts.deleteRemote` is set,
   * any file present in the remote manifest but missing locally is
   * deleted via `DELETE /api/projects/:id/files/<path>`.
   */
  async uploadAll(opts: { deleteRemote?: boolean } = {}): Promise<SyncStats> {
    const stats: SyncStats = { downloaded: 0, uploaded: 0, skipped: 0, deleted: 0, errors: [] }
    const fs = await this.fs()

    const localFiles = await walkLocal(fs, this.localDir, this.include)
    const urls = await this.presignBatch(
      localFiles.map((f) => ({ path: f.path, action: 'write' as const, contentType: f.contentType })),
    )
    const urlByPath = new Map(urls.map((u) => [u.path, u.url]))

    await pool(localFiles, this.concurrency, async (file, idx, total) => {
      const url = urlByPath.get(file.path)
      if (!url) {
        stats.errors.push({ path: file.path, message: 'No presigned URL returned' })
        return
      }
      try {
        const buf = await fs.readFile(joinPath(this.localDir, file.path))
        const resp = await this.fetchImpl(url, {
          method: 'PUT',
          body: buf as any,
          headers: file.contentType ? { 'content-type': file.contentType } : undefined,
        })
        if (!resp.ok) {
          stats.errors.push({ path: file.path, message: `HTTP ${resp.status} uploading ${file.path}` })
          return
        }
        stats.uploaded += 1
        this.onProgress?.({ kind: 'upload', path: file.path, bytes: buf.byteLength, index: idx, total })
      } catch (err: any) {
        stats.errors.push({ path: file.path, message: err?.message ?? String(err) })
      }
    })

    if (opts.deleteRemote) {
      const remote = await this.listManifest()
      const localPaths = new Set(localFiles.map((f) => f.path))
      const toDelete = remote.filter((r) => !localPaths.has(r.path))
      await pool(toDelete, this.concurrency, async (entry, idx, total) => {
        try {
          const url = joinUrl(
            this.apiUrl,
            '/api/projects',
            encodeURIComponent(this.projectId),
            '/files',
            entry.path,
          )
          const resp = await this.fetchImpl(url, { method: 'DELETE', headers: this.authHeaders() })
          if (!resp.ok && resp.status !== 404) {
            stats.errors.push({ path: entry.path, message: `HTTP ${resp.status} deleting ${entry.path}` })
            return
          }
          stats.deleted += 1
          this.onProgress?.({ kind: 'delete', path: entry.path, index: idx, total })
        } catch (err: any) {
          stats.errors.push({ path: entry.path, message: err?.message ?? String(err) })
        }
      })
    }

    return stats
  }

  /**
   * Upload only the given relative paths (a subset of localDir). Used
   * by the worker watcher to push individual file events without
   * re-walking the entire tree.
   */
  async uploadFiles(relativePaths: string[]): Promise<SyncStats> {
    const stats: SyncStats = { downloaded: 0, uploaded: 0, skipped: 0, deleted: 0, errors: [] }
    if (relativePaths.length === 0) return stats
    const fs = await this.fs()
    const fileSpecs = relativePaths
      .filter((p) => this.include(p))
      .map((p) => ({ path: p, contentType: guessContentType(p) }))
    if (fileSpecs.length === 0) return stats

    const urls = await this.presignBatch(
      fileSpecs.map((f) => ({ path: f.path, action: 'write' as const, contentType: f.contentType })),
    )
    const urlByPath = new Map(urls.map((u) => [u.path, u.url]))
    await pool(fileSpecs, this.concurrency, async (file, idx, total) => {
      const url = urlByPath.get(file.path)
      if (!url) {
        stats.errors.push({ path: file.path, message: 'No presigned URL returned' })
        return
      }
      try {
        const buf = await fs.readFile(joinPath(this.localDir, file.path))
        const resp = await this.fetchImpl(url, {
          method: 'PUT',
          body: buf as any,
          headers: file.contentType ? { 'content-type': file.contentType } : undefined,
        })
        if (!resp.ok) {
          stats.errors.push({ path: file.path, message: `HTTP ${resp.status} uploading ${file.path}` })
          return
        }
        stats.uploaded += 1
        this.onProgress?.({ kind: 'upload', path: file.path, bytes: buf.byteLength, index: idx, total })
      } catch (err: any) {
        stats.errors.push({ path: file.path, message: err?.message ?? String(err) })
      }
    })
    return stats
  }

  /** Delete a single remote file. Convenience wrapper around the cloud API. */
  async deleteRemote(path: string): Promise<void> {
    const url = joinUrl(this.apiUrl, '/api/projects', encodeURIComponent(this.projectId), '/files', path)
    const resp = await this.fetchImpl(url, { method: 'DELETE', headers: this.authHeaders() })
    if (!resp.ok && resp.status !== 404) {
      throw new Error(`HTTP ${resp.status} deleting ${path}`)
    }
  }

  // ─── Internals ──────────────────────────────────────────────────

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      ...(extra ?? {}),
    }
  }

  private async presignBatch(
    files: Array<{ path: string; action: 'read' | 'write'; contentType?: string }>,
  ): Promise<Array<{ path: string; action: 'read' | 'write'; url: string }>> {
    if (files.length === 0) return []
    const url = joinUrl(this.apiUrl, '/api/projects', encodeURIComponent(this.projectId), '/s3/presign')
    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers: this.authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ files }),
    })
    if (!resp.ok) {
      throw new Error(`presign_failed: HTTP ${resp.status} ${await safeText(resp)}`)
    }
    const body = (await resp.json()) as {
      ok: boolean
      urls: Array<{ path: string; action: 'read' | 'write'; url: string }>
    }
    return body.urls ?? []
  }

  private async fs(): Promise<FsAdapter> {
    if (this.fsOverride) return this.fsOverride
    if (!this.fsCached) this.fsCached = await getDefaultFs()
    return this.fsCached
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

async function walkLocal(
  fs: FsAdapter,
  root: string,
  include: (path: string) => boolean,
): Promise<Array<{ path: string; contentType: string }>> {
  const out: Array<{ path: string; contentType: string }> = []
  const EXCLUDED = new Set(['node_modules', '.git', 'dist', 'build', '.vite', '.cache'])
  async function visit(dir: string, rel: string): Promise<void> {
    let entries: Awaited<ReturnType<FsAdapter['readdir']>>
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (EXCLUDED.has(entry.name)) continue
      const next = rel ? `${rel}/${entry.name}` : entry.name
      const full = joinPath(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(full, next)
      } else if (entry.isFile()) {
        if (include(next)) {
          out.push({ path: next, contentType: guessContentType(next) })
        }
      }
    }
  }
  await visit(root, '')
  return out
}

function guessContentType(path: string): string {
  const i = path.lastIndexOf('.')
  if (i === -1) return 'application/octet-stream'
  const ext = path.slice(i + 1).toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'application/typescript'
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'application/javascript'
    case 'json':
      return 'application/json'
    case 'md':
      return 'text/markdown'
    case 'html':
    case 'htm':
      return 'text/html'
    case 'css':
      return 'text/css'
    case 'svg':
      return 'image/svg+xml'
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'txt':
      return 'text/plain'
    case 'yaml':
    case 'yml':
      return 'application/yaml'
    default:
      return 'application/octet-stream'
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 500)
  } catch {
    return ''
  }
}
