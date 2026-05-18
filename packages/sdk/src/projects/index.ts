// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Projects API
 *
 * Typed helpers for syncing a project's workspace between Shogo Cloud and
 * a local directory using the cloud Files API (no AWS credentials needed).
 *
 * Pairs with the user-facing `shogo project pull/push` CLI in
 * `@shogo-ai/worker` and the `WorkerRuntimeManager` auto-pull hook.
 *
 * @example
 * ```ts
 * const stats = await client.projects.pull(projectId, { into: './myproj' })
 * console.log(`Pulled ${stats.downloaded} files (${stats.errors.length} errors)`)
 * ```
 */

import type { HttpClient } from '../http/client.js'
import {
  CloudFileTransport,
  type ManifestEntry,
  type SyncStats,
  type FsAdapter,
  type ProgressEvent,
} from './cloud-file-transport.js'

export type {
  ManifestEntry,
  SyncStats,
  FsAdapter,
  ProgressEvent,
  CloudFileTransport,
}

export { CloudFileTransport as CloudFileTransportClass } from './cloud-file-transport.js'

export interface PullOptions {
  /** Target directory. Defaults to `./<projectId>`. */
  into?: string
  /** Optional include glob filter, gitignore-style. */
  include?: string[]
  /** Override `fetch` (tests only). */
  fetchImpl?: typeof fetch
  /** Inject an alternate filesystem adapter (tests only). */
  fs?: FsAdapter
  /** Progress callback. */
  onProgress?: (event: ProgressEvent) => void
  /** Override the cloud API base URL. Defaults to the client's `apiUrl`. */
  apiUrl?: string
  /** Override the API key. Defaults to whatever auth the SDK is using. */
  apiKey?: string
}

export interface PushOptions extends PullOptions {
  /** Source directory. Defaults to `./<projectId>`. */
  from?: string
  /** If true, files in the remote manifest but missing locally get deleted. */
  deleteRemote?: boolean
}

export interface ProjectFilesEntry {
  path: string
  type: 'file' | 'directory'
  size?: number
  extension?: string
}

/**
 * Typed Files-API helpers + clone (pull) and sync (push) workflows.
 *
 * The cloud endpoints accept `shogo_sk_*` keys (workspace-scoped) in the
 * `Authorization: Bearer` header. Routes used:
 *   - GET    /api/projects/:id/workspace/manifest
 *   - GET    /api/projects/:id/s3/files
 *   - POST   /api/projects/:id/s3/presign
 *   - GET    /api/projects/:id/files/*
 *   - PUT    /api/projects/:id/files/*
 *   - DELETE /api/projects/:id/files/*
 */
export class ProjectsApi {
  /**
   * Note: the API key isn't accessible from {@link HttpClient} directly
   * (it uses a token getter). For the bulk transport routes we accept an
   * explicit `apiKey` on pull/push options, falling back to whatever the
   * HttpClient already has wired up.
   */
  constructor(
    private http: HttpClient,
    private resolveApiKey: () => string | null,
    private resolveApiUrl: () => string,
  ) {}

  /** Fetch the workspace manifest (full tree, server-filtered). */
  async manifest(projectId: string): Promise<ManifestEntry[]> {
    const res = await this.http.get<{ ok: boolean; files: ManifestEntry[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/manifest`,
    )
    return res.data?.files ?? []
  }

  /** List files via the Studio-style endpoint (filtered to source extensions). */
  async listFiles(projectId: string): Promise<ProjectFilesEntry[]> {
    const res = await this.http.get<{ ok: boolean; files: ProjectFilesEntry[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/s3/files`,
    )
    return res.data?.files ?? []
  }

  /**
   * Read a single file's contents as a string. Convenience wrapper over
   * `GET /api/projects/:id/files/<path>` for ad-hoc reads.
   */
  async readFile(projectId: string, path: string): Promise<string> {
    const res = await this.http.get<{ ok: boolean; content: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/files/${path}`,
    )
    return res.data?.content ?? ''
  }

  /** Write a file via `PUT /api/projects/:id/files/<path>`. */
  async writeFile(projectId: string, path: string, content: string): Promise<void> {
    await this.http.request(
      `/api/projects/${encodeURIComponent(projectId)}/files/${path}`,
      { method: 'PUT', body: { content } },
    )
  }

  /** Delete a remote file. */
  async deleteFile(projectId: string, path: string): Promise<void> {
    await this.http.delete(
      `/api/projects/${encodeURIComponent(projectId)}/files/${path}`,
    )
  }

  /**
   * Clone a project's workspace from cloud → local.
   *
   * Atomic: writes into `<into>.shogo-pull-tmp/` and renames over `<into>`
   * on success.
   */
  async pull(projectId: string, opts: PullOptions = {}): Promise<SyncStats> {
    const transport = this.makeTransport(projectId, opts.into ?? `./${projectId}`, opts)
    return transport.downloadAll()
  }

  /**
   * Push local edits back to staging. Mirrors deletes when
   * `opts.deleteRemote` is true.
   */
  async push(projectId: string, opts: PushOptions = {}): Promise<SyncStats> {
    const transport = this.makeTransport(projectId, opts.from ?? `./${projectId}`, opts)
    return transport.uploadAll({ deleteRemote: opts.deleteRemote })
  }

  /**
   * Build a {@link CloudFileTransport} for advanced workflows (e.g. the
   * worker's auto-pull hook or a long-running watcher). The transport
   * inherits the same API key + base URL resolution as `pull` / `push`.
   */
  transport(projectId: string, localDir: string, opts: Omit<PullOptions, 'into'> = {}): CloudFileTransport {
    return this.makeTransport(projectId, localDir, opts)
  }

  private makeTransport(projectId: string, localDir: string, opts: PullOptions): CloudFileTransport {
    const apiKey = opts.apiKey ?? this.resolveApiKey()
    const apiUrl = opts.apiUrl ?? this.resolveApiUrl()
    if (!apiKey) {
      throw new Error(
        'ProjectsApi: no API key configured. Pass `apiKey` to pull/push, or sign in with a `shogo_sk_*` key first.',
      )
    }
    if (!apiUrl) {
      throw new Error('ProjectsApi: no apiUrl configured on the client')
    }
    return new CloudFileTransport({
      apiUrl,
      apiKey,
      projectId,
      localDir,
      include: opts.include,
      fetchImpl: opts.fetchImpl,
      fs: opts.fs,
      onProgress: opts.onProgress,
    })
  }
}
