// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The two runtime-owned endpoints a publish reads its build output through.
 *
 * They are a pair, and they share one directory: `/agent/dist-files?publish=true`
 * hands the API the files it uploads to the published-apps bucket, and
 * `/agent/publish-artifact` hands it the build context for the per-commit image
 * (SHO-308 §2). Both read `dist.publish.staging`, and both used to delete it
 * after reading — which is fine when only one of them runs, and fatal when a
 * server-backed publish runs both: the first call removed the directory the
 * second one needed, so every server-backed publish failed with
 * `artifact_missing` (SHO-308, staging, 2026-11-08).
 *
 * The rule now: whoever reads last cleans up. `dist-files` takes `keep=true`
 * when an image build will follow, and `publish-artifact` always cleans up
 * after itself.
 *
 * They live here rather than inline in `server.ts` so a test can drive the real
 * handlers against a real directory. The bug above shipped because the tests
 * mocked the runtime and asserted the API's calls, not the runtime's behaviour.
 *
 * Both are mounted under `/agent/*`, NOT `/api/*`. The `/api/*` namespace is
 * owned by the user app's sidecar Hono server (see code-agent-prompt.ts) and the
 * runtime mounts `app.all('/api/*', ...)` higher up to proxy every `/api/*`
 * request to it. The original placement at `/api/dist-files` (commit 2f9b326d)
 * was registered after that proxy and shadowed from day one — every publish hit
 * either the proxy's `if (!port) return c.notFound()` branch (404) or got the
 * user app's SPA fallback (200 + index.html, which the publisher then failed to
 * JSON-parse). `/agent/*` is the runtime-owned namespace, is auth-gated by
 * `authPrefixes` so callers must send `x-runtime-token`, and is in the SPA
 * catch-all skip-list — so neither endpoint is reachable as a userland route.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'hono'
import { isMacOSJunkName, putFileToObjectStore } from '@shogo/shared-runtime'
import { publishArtifactInlineMaxBytes, publishArtifactMaxBytes } from '@shogo/shared-runtime/publish-timeouts'
import { cleanupStagingOutput } from './build-output-commit'
import {
  ArtifactMediaOffloadError,
  createPublishedArtifactFilter,
  measureDockerignoreExclusion,
  offloadArtifactMedia,
  type ArtifactMediaOffloadResult,
} from './publish-artifact-filter'
import { PUBLISH_STAGING_DIR } from './preview-manager'

/** What the handlers need from the runtime that owns them. */
export interface PublishEndpointDeps {
  /** The project's workspace dir, or null when it is not attached to this runtime. */
  projectDir(projectId?: string): string | null
  /** Where the publish build wrote `dist.publish.staging` (the bundler cwd). */
  outputRoot(projectId: string, projectDir: string): string
  /**
   * The object store this runtime can write to: LFS objects and, when the API
   * names a target, the artifact itself. Null when the runtime has none.
   */
  objectStore?(): { client: { send(command: any): Promise<any> }; bucket: string } | null
}

const PUBLISH_DIST_MAX_FILE_SIZE = 50 * 1024 * 1024

function collectPublishDistFiles(dir: string, baseDir: string): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (isMacOSJunkName(entry.name)) continue
    const fullPath = join(dir, entry.name)
    const relPath = fullPath.slice(baseDir.length + 1).replace(/\\/g, '/')
    if (entry.isDirectory()) {
      out.push(...collectPublishDistFiles(fullPath, baseDir))
    } else if (entry.isFile()) {
      try {
        const stat = statSync(fullPath)
        if (stat.size > PUBLISH_DIST_MAX_FILE_SIZE) continue
        out.push({
          path: relPath,
          content: readFileSync(fullPath).toString('base64'),
        })
      } catch {
        // skip unreadable files
      }
    }
  }
  return out
}

/**
 * `GET /agent/dist-files?projectId=…&publish=true[&keep=true]`
 *
 * `keep=true` leaves `dist.publish.staging` in place for the artifact call that
 * follows. Without it the directory is removed after the read, which is what a
 * static publish wants (nothing else will read it) and what a server-backed
 * publish must not do.
 */
export function handleDistFiles(c: Context, deps: PublishEndpointDeps): Response {
  const projectId = c.req.query('projectId')
  const publishBuild = c.req.query('publish') === 'true'
  const keep = c.req.query('keep') === 'true'
  const projectDir = deps.projectDir(projectId)
  if (!projectDir) {
    return c.json({ error: 'project_not_attached', message: 'Project is not attached to this runtime' }, 404)
  }
  // Publish builds are written under the PreviewManager's bundler cwd, which
  // is `<projectDir>/project` for legacy-layout workspaces.
  const outputRoot = publishBuild ? deps.outputRoot(projectId ?? '', projectDir) : projectDir
  const distDir = join(outputRoot, publishBuild ? PUBLISH_STAGING_DIR : 'dist')
  if (!existsSync(distDir)) {
    return c.json(
      { error: 'dist_not_found', message: 'No dist/ directory — run a build first' },
      404,
    )
  }
  const files = collectPublishDistFiles(distDir, distDir)
  if (publishBuild && !keep) {
    cleanupStagingOutput(outputRoot, PUBLISH_STAGING_DIR)
  }
  return c.json(files)
}

/**
 * `GET /agent/publish-artifact?projectId=…[&bucket=…&key=…]`
 *
 * The build context a published image is built from (SHO-308 §2). Publishing
 * used to build on boot: the pod hydrated source and then ran `bun install`,
 * `prisma generate` and a Vite build before it could answer. Now the image is
 * built once per commit, in a BuildKit Job, from this artifact — so a published
 * pod only has to start. What goes in it:
 *
 *   - the project's source at its current commit, minus `node_modules`, `.git`
 *     and the caches a build regenerates anyway;
 *   - the root-based `dist/` that `buildForPublish()` just produced, since a
 *     published bundle must be served from `/` rather than `/p/<id>/`.
 *
 * **Large media is left out** (SHO-485): every LFS-tracked source file and
 * every `dist/` file over {@link PUBLISH_DIST_OFFLOAD_MIN_BYTES} becomes pointer
 * text, and its bytes are made durable in `<projectId>/lfs/objects` first. The
 * published pod streams them from there on request, so neither the artifact nor
 * the image nor the pod's 2 Gi volume grows with the project's media.
 *
 * **The archive never crosses the API** (SHO-485). Given `bucket` + `key`, the
 * runtime uploads the tar straight to object storage and answers
 * `{ bucket, key, bytes }`. With no object store of its own it streams the tar
 * to the `putUrl` the API presigned (SHO-536). Without either it falls back to
 * the old base64 body, which is what an API that has not been rolled out yet
 * still asks for — and above
 * {@link publishArtifactInlineMaxBytes} that body is refused with
 * `artifact_too_large_for_inline` instead of dying on V8's string limit.
 *
 * Always cleans up after itself: it is the last reader of the staging dir.
 */
export async function handlePublishArtifact(c: Context, deps: PublishEndpointDeps): Promise<Response> {
  const projectId = c.req.query('projectId')
  const projectDir = deps.projectDir(projectId)
  if (!projectDir) {
    return c.json({ error: 'project_not_attached', message: 'Project is not attached to this runtime' }, 404)
  }
  const outputRoot = deps.outputRoot(projectId ?? '', projectDir)
  const stagingDir = join(outputRoot, PUBLISH_STAGING_DIR)
  if (!existsSync(stagingDir)) {
    return c.json(
      { error: 'dist_not_found', message: 'No publish build output — run /agent/publish-build first' },
      404,
    )
  }

  // What may enter the image is decided in one place, and it is exercised by
  // `publish-artifact-filter.test.ts`: matching only the first path segment let
  // a nested `apps/*/node_modules` (and `.env` files) into the context, which
  // `COPY . /app` lays down *before* `bun install`.
  const filter = createPublishedArtifactFilter({
    projectDir,
    stagingDirName: PUBLISH_STAGING_DIR,
  })
  // The project's own `.dockerignore` can only remove paths (SHO-514). Say how
  // much it removed in the publish output: a 2 GiB image is usually one rule
  // nobody remembered writing, and a silent filter is a silent 2 GiB upload.
  const ignoredByDockerignore = measureDockerignoreExclusion({
    projectDir,
    stagingDirName: PUBLISH_STAGING_DIR,
  })
  if (ignoredByDockerignore.paths > 0) {
    console.log(
      `[agent-runtime] publish-artifact: .dockerignore left out ${ignoredByDockerignore.paths} paths / ` +
        `${(ignoredByDockerignore.bytes / (1024 * 1024)).toFixed(1)} MB`,
    )
  }

  const targetBucket = (c.req.query('bucket') || '').trim()
  const targetKey = (c.req.query('key') || '').trim()
  // A presigned PUT for the same bucket+key (SHO-536). The API mints it with
  // its own credentials, so a runtime that has no object store of its own can
  // still stream the tar out instead of handing it back base64.
  const targetPutUrl = (c.req.query('putUrl') || '').trim()
  const store = deps.objectStore?.() ?? null
  if (!store && (targetBucket || targetPutUrl)) {
    // Why a named target has no store to write it with: the env is the answer,
    // so say which one was missing rather than only failing later (SHO-536 §A).
    console.warn(
      '[agent-runtime] publish-artifact: no object store on this runtime ' +
        '(S3_LFS_BUCKET/S3_WORKSPACES_BUCKET unset) — media stays in the archive' +
        (targetPutUrl ? ', tar streamed to the API\'s presigned PUT' : ''),
    )
  }

  const { cp, mkdtemp, readFile, rm, stat } = await import('fs/promises')
  const os = await import('os')
  const tar = await import('tar')
  const tmpDir = await mkdtemp(join(os.tmpdir(), 'shogo-publish-artifact-'))
  const contextDir = join(tmpDir, 'context')
  const archivePath = join(tmpDir, 'artifact.tar.gz')
  try {
    // Fold the WAL back into the DB before copying it. Otherwise the tarball
    // would skip `-wal` (see publish-artifact-filter) and lose the writes it
    // still holds — a published app booting with a DB that is behind its own
    // last write.
    for (const rel of ['prisma/dev.db', 'dev.db']) {
      const dbPath = join(projectDir, rel)
      if (!existsSync(dbPath)) continue
      try {
        const { Database } = await import('bun:sqlite')
        const db = new Database(dbPath, { readonly: false })
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        db.close()
      } catch (err: any) {
        console.warn(`[agent-runtime] publish-artifact: checkpoint of ${rel} failed: ${err?.message ?? err}`)
      }
    }
    await cp(projectDir, contextDir, { recursive: true, filter })
    await cp(stagingDir, join(contextDir, 'dist'), { recursive: true })
    // Media out before the tar, so neither the tar nor the upload carries it.
    let offloaded: ArtifactMediaOffloadResult | null = null
    if (store) {
      try {
        offloaded = await offloadArtifactMedia({
          contextDir,
          sourceDir: projectDir,
          projectId: projectId ?? '',
          store: { bucket: store.bucket, client: store.client },
        })
      } catch (err: any) {
        if (err instanceof ArtifactMediaOffloadError) {
          return c.json({ error: 'lfs_object_missing', message: err.message }, 500)
        }
        throw err
      }
    }
    await tar.create({ gzip: true, file: archivePath, cwd: contextDir, portable: true }, ['.'])
    const { size: bytes } = await stat(archivePath)
    cleanupStagingOutput(outputRoot, PUBLISH_STAGING_DIR)

    // With no store the media stays in the tar, and a size refusal that follows
    // is caused by that rather than by the project (SHO-536).
    const offload = store ? null : { skipped: 'no_object_store' as const }
    const mediaStayed = offload
      ? ' Media could not be moved out because this runtime has no object store, so the context carries the project\'s media.'
      : ''

    // The Job's src volume is a 2 Gi `emptyDir`: an artifact over the limit is
    // an eviction with no explanation, so refuse it here with a name, before
    // spending the upload (SHO-485 §2c).
    const maxBytes = publishArtifactMaxBytes()
    if (bytes > maxBytes) {
      return c.json(
        {
          error: 'artifact_too_large',
          message:
            `The publish build context is ${(bytes / (1024 * 1024)).toFixed(0)} MB, over the ` +
            `${(maxBytes / (1024 * 1024)).toFixed(0)} MB limit for an image build.${mediaStayed}`,
        },
        413,
      )
    }

    if (targetBucket && targetKey && store) {
      await putFileToObjectStore(
        { bucket: targetBucket, client: store.client },
        targetKey,
        archivePath,
        { bytes, contentType: 'application/gzip' },
      )
      return c.json({ bucket: targetBucket, key: targetKey, bytes, offloaded, ...(offload ? { offload } : {}) })
    }

    if (targetBucket && targetKey && targetPutUrl) {
      try {
        await putArtifactToPresignedUrl(targetPutUrl, archivePath, bytes)
      } catch (err: any) {
        return c.json(
          { error: 'artifact_upload_failed', message: err?.message ?? String(err) },
          502,
        )
      }
      return c.json({ bucket: targetBucket, key: targetKey, bytes, offloaded, ...(offload ? { offload } : {}) })
    }

    // Last resort: the old base64 body, for an API that named no target and
    // minted no PUT. Above this cap the answer is a name, never a V8 string
    // crash — base64 of 1.5 GiB is one character past V8's 2^31−1 limit.
    const inlineMaxBytes = publishArtifactInlineMaxBytes()
    if (bytes > inlineMaxBytes) {
      return c.json(
        {
          error: 'artifact_too_large_for_inline',
          message:
            `The publish build context is ${(bytes / (1024 * 1024)).toFixed(0)} MB, over the ` +
            `${(inlineMaxBytes / (1024 * 1024)).toFixed(0)} MB this runtime can send inline: the ` +
            `artifact must go through object storage.${mediaStayed}`,
        },
        413,
      )
    }
    const buf = await readFile(archivePath)
    return c.json({ archive: buf.toString('base64'), bytes: buf.length, offloaded, ...(offload ? { offload } : {}) })
  } catch (err: any) {
    return c.json({ error: 'artifact_failed', message: err?.message ?? String(err) }, 500)
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * PUT the archive to a presigned URL the API minted (SHO-536).
 *
 * Streams from disk: a runtime without S3 credentials of its own can still
 * upload a multi-gigabyte build context, and the tar never becomes a string or
 * a single `Buffer` in this process. The explicit `content-length` keeps an S3
 * endpoint from treating the body as a chunked upload it cannot size.
 */
async function putArtifactToPresignedUrl(url: string, filePath: string, bytes: number): Promise<void> {
  const res = await fetch(url, {
    method: 'PUT',
    body: Bun.file(filePath),
    headers: { 'content-length': String(bytes), 'content-type': 'application/gzip' },
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`object storage refused the artifact (HTTP ${res.status}): ${detail.slice(0, 200)}`)
  }
}
