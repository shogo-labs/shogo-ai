// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Terminal API Routes
 *
 * Endpoints:
 * - GET  /projects/:projectId/terminal/commands - List curated preset commands
 * - POST /projects/:projectId/terminal/exec     - Run a curated preset command
 * - POST /projects/:projectId/terminal/run      - Run an arbitrary shell command
 *                                                 inside the project workspace
 *
 * The `run` endpoint is what gives the IDE a real terminal: `ls`, `cat`,
 * pipes, redirects, `git status`, `bun run foo`, … all work. It's the
 * free-form counterpart to `exec` (which only knows curated commands).
 *
 * Shell semantics:
 *   - Each call runs in an ephemeral shell process: `bash -c` on Unix
 *     and `powershell.exe -Command` on Windows (see ../../packages/agent-
 *     runtime/src/terminal-shell.ts). `cd`, `export`/`$env:`, shell-local
 *     aliases, background jobs etc. do not persist on their own.
 *   - To give users the illusion of a persistent shell we track the CWD on
 *     the client: the client sends the session's current `cwd` (and
 *     previous `prevCwd` for `cd -`), we `cd` into it before running the
 *     command, then report back the post-command `pwd` through a per-request
 *     tempfile which we read once the child exits. The client uses that to
 *     update its state so the *next* command starts from the right place.
 *     (We initially used an fd-3 pipe, but Bun's `child_process` silently
 *     merges extra fds into stdout, which would leak the pwd bytes into the
 *     user-visible stream. A tempfile is boring and 100% portable.)
 *   - Output (stdout+stderr) is streamed as a chunked text response. A
 *     trailing, base64-encoded JSON sentinel carries the new cwd + exit
 *     code. The sentinel is wrapped in ASCII Record-Separator (0x1E) bytes
 *     so it cannot be confused with command output; the client strips it
 *     before rendering.
 *   - If the client disconnects mid-stream (Stop button / navigation /
 *     tab close), we SIGTERM the child and SIGKILL it 2s later. This is
 *     what makes Ctrl+C / Stop actually *stop* the command on the server.
 */

import { Hono } from "hono"
import { execSync } from "child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { isAbsolute, join, resolve } from "path"
import { makeKillChild, spawnPresetShell, spawnRunShell } from "@shogo/agent-runtime/src/terminal-shell"

/**
 * ASCII Record-Separator framed sentinel used to carry post-command metadata
 * (new cwd, exit code) out-of-band on the same HTTP stream. Keep in sync with
 * the client-side regex in apps/mobile/components/project/panels/ide/Terminal.tsx.
 */
const META_SENTINEL_PREFIX = "\u001eSHOGO_TERM_META:"
const META_SENTINEL_SUFFIX = "\u001e\n"

/**
 * Preset command definition
 */
export interface PresetCommand {
  /** Unique identifier for the command */
  id: string
  /** Display label */
  label: string
  /** Description of what the command does */
  description: string
  /** The actual shell command to execute */
  command: string
  /** Category for grouping in UI */
  category: 'package' | 'database' | 'server' | 'test' | 'build'
  /** Whether this command is potentially destructive */
  dangerous?: boolean
  /** Timeout in milliseconds (default: 60000) */
  timeout?: number
}

/**
 * Available preset commands that users can execute
 */
export const PRESET_COMMANDS: PresetCommand[] = [
  // Package Management
  {
    id: 'bun-install',
    label: 'Install Dependencies',
    description: 'Install all project dependencies with bun',
    command: 'bun install',
    category: 'package',
    timeout: 120000, // 2 minutes
  },
  
  // Database (Prisma)
  {
    id: 'prisma-generate',
    label: 'Generate Prisma Client',
    description: 'Regenerate Prisma client after schema changes',
    command: 'bunx prisma generate',
    category: 'database',
  },
  {
    id: 'prisma-push',
    label: 'Push Schema',
    description: 'Push schema changes to the database',
    command: 'bunx prisma db push',
    category: 'database',
  },
  {
    id: 'prisma-reset',
    label: 'Reset Database',
    description: 'Wipe and recreate database from schema (destructive)',
    command: 'bunx prisma db push --force-reset',
    category: 'database',
    dangerous: true,
    timeout: 30000,
  },
  {
    id: 'prisma-migrate',
    label: 'Run Migrations',
    description: 'Create and apply database migrations',
    command: 'bunx prisma migrate dev --name auto',
    category: 'database',
    timeout: 60000,
  },
  
  // Testing
  {
    id: 'playwright-test',
    label: 'Run Tests',
    description: 'Run Playwright E2E tests',
    command: 'bunx playwright test',
    category: 'test',
    timeout: 180000, // 3 minutes
  },
  {
    id: 'playwright-test-headed',
    label: 'Run Tests (Visible)',
    description: 'Run tests with browser visible',
    command: 'bunx playwright test --headed',
    category: 'test',
    timeout: 180000,
  },
  
  // Build
  {
    id: 'typecheck',
    label: 'Type Check',
    description: 'Run TypeScript type checking',
    command: 'bunx tsc --noEmit',
    category: 'build',
    timeout: 60000,
  },
  {
    id: 'build',
    label: 'Build for Production',
    description: 'Create production build',
    command: 'bun run build',
    category: 'build',
    timeout: 120000,
  },
]

/**
 * Configuration for terminal routes
 */
export interface TerminalRoutesConfig {
  /**
   * Workspaces directory where projects are stored
   */
  workspacesDir: string
}

/**
 * Create terminal routes
 */
export function terminalRoutes(config: TerminalRoutesConfig) {
  const { workspacesDir } = config
  const router = new Hono()

  /**
   * GET /projects/:projectId/terminal/commands - List available commands
   */
  router.get("/projects/:projectId/terminal/commands", async (c) => {
    const projectId = c.req.param("projectId")
    const projectDir = join(workspacesDir, projectId)

    // If project directory doesn't exist yet, still return available commands
    // (the commands are generic, not project-specific)

    // Return available commands grouped by category
    const commandsByCategory = PRESET_COMMANDS.reduce((acc, cmd) => {
      if (!acc[cmd.category]) {
        acc[cmd.category] = []
      }
      acc[cmd.category].push({
        id: cmd.id,
        label: cmd.label,
        description: cmd.description,
        category: cmd.category,
        dangerous: cmd.dangerous || false,
      })
      return acc
    }, {} as Record<string, Array<{ id: string; label: string; description: string; category: string; dangerous: boolean }>>)

    return c.json({ commands: commandsByCategory }, 200)
  })

  /**
   * POST /projects/:projectId/terminal/exec - Execute a preset command
   *
   * Request body:
   * - commandId: string - ID of the preset command to execute
   * - confirmDangerous?: boolean - Must be true for dangerous commands
   *
   * Response: Streaming text output of the command
   */
  router.post("/projects/:projectId/terminal/exec", async (c) => {
    const projectId = c.req.param("projectId")
    const projectDir = join(workspacesDir, projectId)

    // Verify project exists
    if (!existsSync(projectDir)) {
      return c.json(
        { error: { code: "project_not_found", message: "Project not found" } },
        404
      )
    }

    // Parse request body
    let body: { commandId: string; confirmDangerous?: boolean }
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        { error: { code: "invalid_body", message: "Invalid request body" } },
        400
      )
    }

    const { commandId, confirmDangerous } = body

    // Find the preset command
    const preset = PRESET_COMMANDS.find(cmd => cmd.id === commandId)
    if (!preset) {
      return c.json(
        { error: { code: "unknown_command", message: `Unknown command: ${commandId}` } },
        400
      )
    }

    // Require confirmation for dangerous commands
    if (preset.dangerous && !confirmDangerous) {
      return c.json(
        { 
          error: { 
            code: "confirmation_required", 
            message: "This command is destructive. Set confirmDangerous: true to proceed." 
          } 
        },
        400
      )
    }

    const timeout = preset.timeout || 60000

    // For Playwright tests, ensure dependencies are installed (workspaces from template may have no node_modules)
    if (commandId === 'playwright-test' || commandId === 'playwright-test-headed') {
      const nodeModulesDir = join(projectDir, 'node_modules')
      if (!existsSync(nodeModulesDir)) {
        console.log(`[Terminal] Running bun install in ${projectDir} before playwright`)
        try {
          execSync('bun install', { cwd: projectDir, stdio: 'pipe', timeout: 120000 })
        } catch (err: any) {
          return c.json(
            { error: { code: 'install_failed', message: err.message || 'bun install failed. Run "bun install" in the project and try again.' } },
            500
          )
        }
      }
    }

    console.log(`[Terminal] Executing command: ${preset.command} in ${projectDir}`)

    // Create a streaming response
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()
    const clientSignal = c.req.raw.signal

    // Execute command asynchronously
    ;(async () => {
      try {
        // Write header
        await writer.write(encoder.encode(`$ ${preset.command}\n\n`))

        // Spawn via the platform-aware helper so that on Unix we get the
        // original `sh -c` + detached process group (used by `makeKillChild`'s
        // negative-pid group-signal mechanics) and on Windows we get
        // PowerShell + windowsHide so no console window flashes and
        // taskkill /T can walk the process tree.
        const child = spawnPresetShell({ command: preset.command, cwd: projectDir })

        const killChild = makeKillChild(child)

        // Set up timeout
        const timeoutId = setTimeout(() => {
          writer.write(encoder.encode('\n\n[ERROR] Command timed out\n')).catch(() => {})
          killChild('SIGTERM')
        }, timeout)

        // Kill child if the client goes away (Stop button / tab close / nav)
        const onAbort = () => killChild('SIGTERM')
        clientSignal?.addEventListener('abort', onAbort)

        // Guard against both 'error' and 'close' firing (Node allows this).
        let settled = false
        const settle = async (trailer: string) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutId)
          clientSignal?.removeEventListener('abort', onAbort)
          try {
            await writer.write(encoder.encode(trailer))
            await writer.close()
          } catch {
            // Writer already closed, ignore
          }
        }

        // Pipe with backpressure so a verbose preset (e.g. `bun install`
        // resolving 1k deps) can't balloon server memory when the HTTP
        // client reads slowly.
        const pipe = (src: NodeJS.ReadableStream | null) => {
          if (!src) return
          src.on('data', (data: Buffer) => {
            const p = writer.write(data).catch(() => {})
            if (writer.desiredSize !== null && writer.desiredSize <= 0) {
              src.pause()
              void Promise.resolve(p)
                .then(() => writer.ready)
                .then(() => src.resume())
                .catch(() => src.resume())
            }
          })
        }
        pipe(child.stdout)
        pipe(child.stderr)

        child.on('close', async (code) => {
          await settle(`\n\n[Process exited with code ${code}]\n`)
        })

        child.on('error', async (err) => {
          await settle(`\n\n[ERROR] ${err.message}\n`)
        })

      } catch (err: any) {
        try {
          await writer.write(encoder.encode(`[ERROR] ${err.message}\n`))
          await writer.close()
        } catch {
          // Writer already closed, ignore
        }
      }
    })()

    // Return streaming response
    return new Response(readable, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  })

  /**
   * POST /projects/:projectId/terminal/run - Execute a free-form shell command
   *
   * Body:
   *   command:   string              // required, the shell line to run
   *   cwd?:      string              // absolute path; must exist. Defaults to projectDir.
   *   prevCwd?:  string              // absolute path for OLDPWD (so `cd -` works)
   *   timeoutMs?: number             // 1s … 30min, default 10min
   *
   * Response: `text/plain; charset=utf-8` streaming stdout+stderr, followed by
   * a single Record-Separator framed JSON sentinel carrying { cwd, exitCode,
   * signal } so the client can keep its synthetic shell state in sync.
   */
  router.post("/projects/:projectId/terminal/run", async (c) => {
    const projectId = c.req.param("projectId")
    const projectDir = join(workspacesDir, projectId)

    if (!existsSync(projectDir)) {
      return c.json(
        { error: { code: "project_not_found", message: "Project not found" } },
        404,
      )
    }

    let body: { command?: string; cwd?: string; prevCwd?: string; timeoutMs?: number }
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        { error: { code: "invalid_body", message: "Invalid request body" } },
        400,
      )
    }

    const command = typeof body.command === "string" ? body.command : ""
    if (!command.trim()) {
      return c.json(
        { error: { code: "empty_command", message: "Command is required" } },
        400,
      )
    }

    // Clamp timeout to a sane window. Mirrors VS Code's "long running tasks
    // are fine" stance without letting a stuck curl keep a worker busy forever.
    const rawTimeout = typeof body.timeoutMs === "number" ? body.timeoutMs : 10 * 60_000
    const timeout = Math.min(Math.max(rawTimeout, 1_000), 30 * 60_000)

    const effectiveCwd = pickCwd(body.cwd, projectDir)
    const prevCwd = pickCwd(body.prevCwd, projectDir)

    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()
    const clientSignal = c.req.raw.signal

    // Allocate a per-request temp dir that the launcher can drop its
    // post-command pwd into. We initially tried a stdio[3] pipe (fd 3), but
    // Bun's child_process implementation silently glues extra fds onto
    // stdout, which both broke cwd reporting and leaked path bytes into the
    // user-visible stream. A tempfile is boring and 100% portable.
    const metaDir = mkdtempSync(join(tmpdir(), "shogo-term-"))
    const pwdFile = join(metaDir, "pwd")
    const cleanup = () => {
      try {
        rmSync(metaDir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }

    ;(async () => {
      // The platform-aware launcher in `spawnRunShell` handles the
      // `cd → eval → write pwd → exit` dance for both bash (Unix) and
      // PowerShell (Windows). HOME defaults to the project dir on Unix
      // so tilde-expansion and programs that look at $HOME (npm, git,
      // etc.) stay scoped to the workspace; on Windows we leave the
      // user's USERPROFILE alone since PowerShell users expect that.
      let child: ReturnType<typeof spawnRunShell>
      try {
        child = spawnRunShell({
          command,
          effectiveCwd,
          rootDir: projectDir,
          pwdFile,
          prevCwd,
          extraEnv: process.platform === "win32" ? undefined : { HOME: projectDir },
        })
      } catch (err: any) {
        cleanup()
        try {
          await writer.write(
            encoder.encode(`\n[shogo] failed to spawn shell: ${err?.message ?? String(err)}\n`),
          )
          await writeMetaSentinel(writer, encoder, {
            cwd: effectiveCwd,
            exitCode: null,
            signal: null,
          })
          await writer.close()
        } catch {
          /* writer already closed */
        }
        return
      }

      const killChild = makeKillChild(child)

      const timeoutId = setTimeout(() => {
        writer
          .write(encoder.encode("\n[shogo] command timed out\n"))
          .catch(() => {})
        killChild("SIGTERM")
      }, timeout)

      const onAbort = () => killChild("SIGTERM")
      clientSignal?.addEventListener("abort", onAbort)

      // Single-shot teardown. Node's ChildProcess can emit both 'error' and
      // 'close', and we also tear down from timeout/abort. Without this
      // flag we'd write the metadata sentinel twice and hit "writer already
      // closed" on the second path.
      let settled = false
      const settle = async (meta: {
        cwd: string
        exitCode: number | null
        signal: string | null
      }) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        clientSignal?.removeEventListener("abort", onAbort)
        cleanup()
        try {
          await writeMetaSentinel(writer, encoder, meta)
          await writer.close()
        } catch {
          /* writer already closed */
        }
      }

      // Pipe stdout/stderr with backpressure: if the HTTP sink slows down
      // we pause the child's stream so memory doesn't balloon under chatty
      // commands like `yes` or `find /`. Resuming once the writer is ready
      // keeps throughput high for normal output.
      const pipeWithBackpressure = (src: NodeJS.ReadableStream | null) => {
        if (!src) return
        src.on("data", (data: Buffer) => {
          const p = writer.write(data).catch(() => {})
          if (writer.desiredSize !== null && writer.desiredSize <= 0) {
            src.pause()
            void Promise.resolve(p)
              .then(() => writer.ready)
              .then(() => src.resume())
              .catch(() => src.resume())
          }
        })
      }
      pipeWithBackpressure(child.stdout)
      pipeWithBackpressure(child.stderr)

      child.on("error", async (err) => {
        try {
          await writer.write(encoder.encode(`\n[shogo] ${err.message}\n`))
        } catch {
          /* writer already closed */
        }
        await settle({ cwd: effectiveCwd, exitCode: null, signal: null })
      })

      child.on("close", async (code, signal) => {
        let reported = ""
        try {
          if (existsSync(pwdFile)) {
            reported = readFileSync(pwdFile, "utf8").trim()
          }
        } catch {
          /* fall through — we'll use effectiveCwd as fallback */
        }
        // If the child was killed before it could write pwd (abort, timeout,
        // SIGKILL from a panicking command) fall back to the starting cwd so
        // the client doesn't get stuck at some half-updated state.
        const finalCwd = reported && existsSync(reported) ? reported : effectiveCwd
        await settle({
          cwd: finalCwd,
          exitCode: typeof code === "number" ? code : null,
          signal: signal ?? null,
        })
      })
    })()

    return new Response(readable, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    })
  })

  return router
}

/**
 * Resolve a caller-supplied cwd to an absolute path, falling back to the
 * project root if the candidate is missing, relative, or no longer exists.
 * We intentionally *allow* absolute paths outside the project dir: users
 * frequently `cd /tmp` etc. during debugging and we don't want to surprise
 * them. The project dir is only a default.
 */
function pickCwd(candidate: string | undefined, projectDir: string): string {
  if (!candidate || typeof candidate !== "string") return projectDir
  const abs = isAbsolute(candidate) ? candidate : resolve(projectDir, candidate)
  return existsSync(abs) ? abs : projectDir
}

/**
 * Serialize the out-of-band metadata trailer. Base64-wrapping the JSON means
 * the payload itself cannot contain our Record-Separator framing bytes, so
 * there's no way for a weird cwd string to break the parser on the client.
 */
async function writeMetaSentinel(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  meta: { cwd: string; exitCode: number | null; signal: string | null },
) {
  const payload = Buffer.from(JSON.stringify(meta), "utf8").toString("base64")
  await writer.write(
    encoder.encode(META_SENTINEL_PREFIX + payload + META_SENTINEL_SUFFIX),
  )
}

export default terminalRoutes
