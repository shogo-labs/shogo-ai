// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Git Smart-HTTP backend
 *
 * Exposes each project's server-side git repo at
 *   GET  /projects/:projectId/git/info/refs?service=git-(upload|receive)-pack
 *   POST /projects/:projectId/git/(git-upload-pack|git-receive-pack)
 *
 * Implementation: bridge to the `git http-backend` CGI shipped with the
 * git core. It already speaks the wire protocol; we just need to set
 * the CGI env vars correctly, stream request body → stdin, and parse
 * the CGI response (text headers, blank line, binary body) back into
 * a Hono Response.
 *
 * Auth: handled by the parent `authMiddleware` + an explicit
 * `authorizeProject` check inside the handler. Unlike most routes,
 * git's HTTP client expects 401s to carry a `WWW-Authenticate: Basic`
 * challenge so `git`'s askpass flow can surface the error cleanly.
 *
 * Excluded: projects with `workingMode='external'` — Shogo doesn't
 * own that git repo. Treat them as 404 from this endpoint.
 *
 * Post-receive: after a successful `git-receive-pack` push, we resolve
 * the new HEAD via `git rev-parse` and insert a `ProjectCheckpoint`
 * row marked `isAutomatic`. This keeps the desktop checkpoint timeline
 * aligned with whatever the worker pushed without depending on a
 * filesystem-level git hook script (which would require shipping +
 * permissioning a separate file inside each project's `.git/hooks/`).
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { Hono, type Context } from 'hono'
import { prisma } from '../lib/prisma'
import { authorizeProject } from '../middleware/auth'
import * as gitService from '../services/git.service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHttpRoutesConfig {
  /** Directory containing per-project workspaces (each has its own .git/). */
  workspacesDir: string
}

/** Services that `git http-backend` accepts. Anything else → 400. */
const ALLOWED_SERVICES = new Set(['git-upload-pack', 'git-receive-pack'])

/**
 * CGI response parser. `git http-backend` writes:
 *   Status: 200 OK\r\n
 *   Content-Type: application/x-git-upload-pack-result\r\n
 *   \r\n
 *   <binary body>
 *
 * Some implementations use \n separators; we accept both.
 */
function parseCgiHeaders(buffer: Uint8Array): { headers: Record<string, string>; status: number; bodyStart: number } {
  // Find the header/body separator: \r\n\r\n or \n\n
  let bodyStart = -1
  let sepLen = 0
  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a && buffer[i + 2] === 0x0d && buffer[i + 3] === 0x0a) {
      bodyStart = i + 4
      sepLen = 4
      break
    }
    if (buffer[i] === 0x0a && buffer[i + 1] === 0x0a) {
      bodyStart = i + 2
      sepLen = 2
      break
    }
  }
  if (bodyStart === -1) {
    // No separator yet — treat the whole thing as headers, no body.
    return { headers: {}, status: 200, bodyStart: buffer.length }
  }
  const headerText = new TextDecoder().decode(buffer.slice(0, bodyStart - sepLen))
  const headers: Record<string, string> = {}
  let status = 200
  for (const line of headerText.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key.toLowerCase() === 'status') {
      const m = value.match(/^(\d{3})/)
      if (m) status = parseInt(m[1]!, 10)
    } else {
      headers[key] = value
    }
  }
  return { headers, status, bodyStart }
}

// ---------------------------------------------------------------------------
// Repo bootstrap
// ---------------------------------------------------------------------------

/**
 * Ensure `<workspacesDir>/<projectId>` has an initialized git repo
 * configured to accept pushes onto its current branch.
 *
 * The cloud-side repo is the source of truth for the project's git
 * history, BUT during pinned-mode operation the working tree there is
 * essentially read-only (all real work happens on the paired machine).
 * We set `receive.denyCurrentBranch=updateInstead` so pushes that
 * fast-forward and find a clean working tree will also update the
 * checkout — which is what we want when the project is later
 * unpinned and a cloud pod has to resume.
 *
 * Idempotent: safe to call on every smart-HTTP request.
 */
function ensureRepoConfigured(workspacePath: string): boolean {
  if (!existsSync(workspacePath)) return false
  // initRepo is idempotent; it leaves an existing repo alone but
  // initializes a new one with the same Shogo-managed gitignore +
  // checkpoint-safe config (autocrlf=false, longpaths=true, …).
  try {
    void gitService.initRepo(workspacePath)
  } catch {
    return false
  }
  // Permit receive-pack onto the checked-out branch.
  try {
    spawnSync('git', ['config', 'receive.denyCurrentBranch', 'updateInstead'], workspacePath)
  } catch {
    /* non-fatal — push will just fail with a clearer error from git itself */
  }
  return true
}

/** Synchronous spawn helper that just runs a short git command for config. */
function spawnSync(cmd: string, args: string[], cwd: string): void {
  // We do this synchronously via child_process.execFileSync to avoid
  // polluting the streaming path. Imported lazily so the streaming
  // CGI handlers can use the async `spawn` cleanly.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execFileSync } = require('child_process') as typeof import('child_process')
  execFileSync(cmd, args, { cwd, stdio: 'pipe' })
}

// ---------------------------------------------------------------------------
// CGI invocation
// ---------------------------------------------------------------------------

/**
 * Run `git http-backend` for one HTTP request.
 *
 * Returns a Response built from the CGI output. The post-receive hook
 * (if applicable) fires AFTER the response body has fully streamed back
 * to the client — `git http-backend` exits when receive-pack completes,
 * so by the time we resolve, the new ref is already in place.
 */
async function runGitHttpBackend(c: Context, opts: {
  /** Root directory containing all per-project workspaces. */
  workspacesDir: string
  /** Resolved per-project workspace dir (`workspacesDir/projectId`). Used
   *  only for the post-receive hook; the CGI gets `workspacesDir` itself. */
  workspacePath: string
  /** CGI PATH_INFO already including the project id + repo path, e.g.
   *  `/p_abc/.git/info/refs`. Must start with `/`. */
  pathInfo: string
  service: string | null
  isReceivePack: boolean
  projectId: string
  userId: string | undefined
}): Promise<Response> {
  const { workspacesDir, workspacePath, pathInfo, projectId, userId, isReceivePack } = opts

  const url = new URL(c.req.url)
  // `git http-backend` resolves the repo path as `GIT_PROJECT_ROOT + PATH_INFO`
  // and walks up to find an info/refs (etc.). Our on-disk layout is
  //   <workspacesDir>/<projectId>/.git/...
  // so we feed it the workspaces root + a path-info that carries the
  // project id and the `.git/` suffix.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_PROJECT_ROOT: workspacesDir,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: pathInfo,
    REQUEST_METHOD: c.req.method,
    QUERY_STRING: url.search.startsWith('?') ? url.search.slice(1) : url.search,
    CONTENT_TYPE: c.req.header('content-type') || '',
    REMOTE_USER: userId ?? '',
    REMOTE_ADDR: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '',
    // git http-backend reads its body from stdin until EOF
  }
  // Some git versions check HTTP_* envs too (e.g. HTTP_CONTENT_TYPE).
  const contentEncoding = c.req.header('content-encoding')
  if (contentEncoding) env.HTTP_CONTENT_ENCODING = contentEncoding

  const child = spawn('git', ['http-backend'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Body → stdin (only POST requests carry one).
  if (c.req.method !== 'GET') {
    const reader = c.req.raw.body?.getReader()
    if (reader) {
      void (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (value) child.stdin.write(value)
          }
        } catch (err) {
          // If the client disconnects mid-upload, just terminate the child.
          console.warn('[git-http] body stream error:', err)
        } finally {
          child.stdin.end()
        }
      })()
    } else {
      child.stdin.end()
    }
  } else {
    child.stdin.end()
  }

  // Collect stdout. We buffer the header block and then start streaming
  // the body. For typical pack negotiation this is tens of KB; for a
  // first-time push of a populated workspace this may be tens of MB.
  // We buffer the small header prefix and stream the rest.
  const stderrChunks: Uint8Array[] = []
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(new Uint8Array(chunk)))

  // The streaming strategy: read until we find the CGI header separator,
  // then forward everything after to the client.
  const stdoutChunks: Uint8Array[] = []
  let headersResolved = false
  let parsedHeaders: { headers: Record<string, string>; status: number } | null = null

  const responseStream = new ReadableStream<Uint8Array>({
    start(controller) {
      child.stdout.on('data', (chunk: Buffer) => {
        const u8 = new Uint8Array(chunk)
        if (!headersResolved) {
          stdoutChunks.push(u8)
          const merged = concatChunks(stdoutChunks)
          const parsed = parseCgiHeaders(merged)
          if (parsed.bodyStart < merged.length || mergedEndsWithSeparator(merged)) {
            headersResolved = true
            parsedHeaders = { headers: parsed.headers, status: parsed.status }
            // Push the remainder of the body to the response stream.
            const tail = merged.slice(parsed.bodyStart)
            if (tail.length > 0) controller.enqueue(tail)
          }
        } else {
          controller.enqueue(u8)
        }
      })
      child.stdout.on('end', () => {
        if (!headersResolved) {
          // CGI returned nothing parseable — emit what we have.
          const merged = concatChunks(stdoutChunks)
          const parsed = parseCgiHeaders(merged)
          parsedHeaders = { headers: parsed.headers, status: parsed.status }
          headersResolved = true
        }
        controller.close()
      })
      child.stdout.on('error', (err) => controller.error(err))
    },
    cancel() {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
    },
  })

  // Wait for header block to be resolved before constructing the Response.
  // We do this by reading the first chunk; the Response itself can then
  // continue streaming the rest.
  // Trick: we use a small buffer to wait until headers are ready.
  const headerReady = new Promise<void>((resolve, reject) => {
    const interval = setInterval(() => {
      if (headersResolved) {
        clearInterval(interval)
        resolve()
      }
    }, 5)
    child.on('exit', (code) => {
      if (!headersResolved) {
        clearInterval(interval)
        // exited before producing headers — surface 502 with stderr.
        const errText = new TextDecoder().decode(concatChunks(stderrChunks)).slice(0, 500)
        console.warn('[git-http] backend exited code=%d before headers: %s', code, errText)
        reject(new Error(`git http-backend exited with no output (code ${code})`))
      }
    })
  })

  try {
    await headerReady
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: { code: 'git_backend_failed', message: err?.message ?? 'git-http-backend failed' } }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    )
  }

  const responseHeaders = new Headers(parsedHeaders!.headers)
  // Always set cache-control: no-cache for smart-HTTP responses.
  if (!responseHeaders.has('cache-control')) responseHeaders.set('cache-control', 'no-cache')

  // After the body fully drains, kick off the post-receive checkpoint
  // hook for receive-pack pushes. We do this outside the streaming
  // pipeline so it doesn't delay the response.
  if (isReceivePack) {
    child.on('exit', (code) => {
      if (code === 0) {
        runPostReceiveHook(projectId, workspacePath, userId).catch((err) => {
          console.warn(`[git-http] post-receive hook for ${projectId} failed:`, err?.message ?? err)
        })
      }
    })
  }

  return new Response(responseStream, {
    status: parsedHeaders!.status,
    headers: responseHeaders,
  })
}

/** Merge a list of Uint8Array chunks into one. */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

function mergedEndsWithSeparator(buf: Uint8Array): boolean {
  const n = buf.length
  if (n >= 4 && buf[n - 4] === 0x0d && buf[n - 3] === 0x0a && buf[n - 2] === 0x0d && buf[n - 1] === 0x0a) return true
  if (n >= 2 && buf[n - 2] === 0x0a && buf[n - 1] === 0x0a) return true
  return false
}

// ---------------------------------------------------------------------------
// Post-receive checkpoint hook
// ---------------------------------------------------------------------------

/**
 * After a successful `git push` from the worker, write a
 * `ProjectCheckpoint` row for the new HEAD so the desktop checkpoint
 * timeline reflects the push immediately.
 *
 * Idempotent: if a row with the same `commitSha` already exists (e.g.
 * because the agent-runtime on the worker also called the createCheckpoint
 * service path in a pre-`SHOGO_CLOUD_SYNC` build), we skip insertion.
 */
export async function runPostReceiveHook(
  projectId: string,
  workspacePath: string,
  createdBy: string | undefined,
): Promise<void> {
  // Resolve the new HEAD commit + stats.
  const commit = await gitService.getCommit(workspacePath, 'HEAD').catch(() => null)
  if (!commit) return

  const existing = await prisma.projectCheckpoint.findFirst({
    where: { projectId, commitSha: commit.sha },
    select: { id: true },
  })
  if (existing) return

  // Read the current branch name. Fall back to "main" if HEAD is detached.
  const branch = await gitService.getCurrentBranch(workspacePath).catch(() => 'main')

  await prisma.projectCheckpoint.create({
    data: {
      projectId,
      commitSha: commit.sha,
      commitMessage: commit.message || '(no message)',
      branch: branch || 'main',
      includesDb: false,
      filesChanged: commit.filesChanged,
      additions: commit.additions,
      deletions: commit.deletions,
      isAutomatic: true,
      createdBy,
    },
  })
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function gitHttpRoutes(config: GitHttpRoutesConfig) {
  const { workspacesDir } = config
  const router = new Hono()

  /**
   * Shared auth + project resolution for both info/refs and the
   * per-service POST handlers.
   *
   * Returns `null` on success (callers can proceed), or a Response on
   * any failure path (401 with WWW-Authenticate, 403, 404, or 409 for
   * workingMode=external).
   */
  async function authorize(c: Context, projectId: string): Promise<Response | null> {
    const auth = c.get('auth')
    if (!auth?.isAuthenticated || !auth.userId) {
      // git's HTTP client expects a Basic challenge to invoke its askpass flow.
      return new Response('Authentication required', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="shogo"' },
      })
    }
    const access = await authorizeProject(c, projectId)
    if (!access.ok) {
      return new Response(access.message, {
        status: access.status,
        headers: access.status === 401
          ? { 'WWW-Authenticate': 'Basic realm="shogo"' }
          : {},
      })
    }
    // workingMode=external projects don't have a Shogo-managed repo.
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { workingMode: true } as any,
    }) as { workingMode?: string } | null
    if (project?.workingMode === 'external') {
      return new Response('Not found', { status: 404 })
    }
    return null
  }

  /**
   * GET /projects/:projectId/git/info/refs
   *
   * Initial handshake: the client sends `?service=git-upload-pack` (for
   * clone/fetch) or `?service=git-receive-pack` (for push). We respond
   * with the advertised refs.
   */
  router.get('/projects/:projectId/git/info/refs', async (c) => {
    const projectId = c.req.param('projectId')
    if (!projectId) {
      return c.json({ error: { code: 'missing_project_id', message: 'projectId is required' } }, 400)
    }
    const denied = await authorize(c, projectId)
    if (denied) return denied

    const service = c.req.query('service')
    if (!service || !ALLOWED_SERVICES.has(service)) {
      return c.json(
        { error: { code: 'invalid_service', message: 'service query must be git-upload-pack or git-receive-pack' } },
        400,
      )
    }

    const workspacePath = join(workspacesDir, projectId)
    if (!ensureRepoConfigured(workspacePath)) {
      return c.json(
        { error: { code: 'workspace_not_found', message: 'Workspace not found for project' } },
        404,
      )
    }

    return runGitHttpBackend(c, {
      workspacesDir,
      workspacePath,
      pathInfo: `/${projectId}/.git/info/refs`,
      service,
      isReceivePack: service === 'git-receive-pack',
      projectId,
      userId: c.get('auth')?.userId,
    })
  })

  /**
   * POST /projects/:projectId/git/git-upload-pack
   * POST /projects/:projectId/git/git-receive-pack
   */
  function makePostHandler(service: 'git-upload-pack' | 'git-receive-pack') {
    return async (c: Context) => {
      const projectId = c.req.param('projectId')
      if (!projectId) {
        return c.json({ error: { code: 'missing_project_id', message: 'projectId is required' } }, 400)
      }
      const denied = await authorize(c, projectId)
      if (denied) return denied

      const workspacePath = join(workspacesDir, projectId)
      if (!ensureRepoConfigured(workspacePath)) {
        return c.json(
          { error: { code: 'workspace_not_found', message: 'Workspace not found for project' } },
          404,
        )
      }

      return runGitHttpBackend(c, {
        workspacesDir,
        workspacePath,
        pathInfo: `/${projectId}/.git/${service}`,
        service,
        isReceivePack: service === 'git-receive-pack',
        projectId,
        userId: c.get('auth')?.userId,
      })
    }
  }

  router.post('/projects/:projectId/git/git-upload-pack', makePostHandler('git-upload-pack'))
  router.post('/projects/:projectId/git/git-receive-pack', makePostHandler('git-receive-pack'))

  return router
}

export default gitHttpRoutes
