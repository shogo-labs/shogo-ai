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
import { isMacOSJunkName } from '@shogo/shared-runtime'
import { cleanupStagingOutput } from './build-output-commit'
import { createPublishedArtifactFilter } from './publish-artifact-filter'
import { PUBLISH_STAGING_DIR } from './preview-manager'

/** What the handlers need from the runtime that owns them. */
export interface PublishEndpointDeps {
  /** The project's workspace dir, or null when it is not attached to this runtime. */
  projectDir(projectId?: string): string | null
  /** Where the publish build wrote `dist.publish.staging` (the bundler cwd). */
  outputRoot(projectId: string, projectDir: string): string
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
 * `GET /agent/publish-artifact?projectId=…`
 *
 * The build context a published image is built from (SHO-308 §2), as a gzipped
 * tar, base64-encoded. Publishing used to build on boot: the pod hydrated source
 * and then ran `bun install`, `prisma generate` and a Vite build before it could
 * answer. Now the image is built once per commit, in a BuildKit Job, from this
 * artifact — so a published pod only has to start. What goes in it:
 *
 *   - the project's source at its current commit, minus `node_modules`, `.git`
 *     and the caches a build regenerates anyway;
 *   - the root-based `dist/` that `buildForPublish()` just produced, since a
 *     published bundle must be served from `/` rather than `/p/<id>/`.
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

  const { cp, mkdtemp, readFile, rm } = await import('fs/promises')
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
    await tar.create({ gzip: true, file: archivePath, cwd: contextDir, portable: true }, ['.'])
    const buf = await readFile(archivePath)
    cleanupStagingOutput(outputRoot, PUBLISH_STAGING_DIR)
    return c.json({ archive: buf.toString('base64'), bytes: buf.length })
  } catch (err: any) {
    return c.json({ error: 'artifact_failed', message: err?.message ?? String(err) }, 500)
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}
