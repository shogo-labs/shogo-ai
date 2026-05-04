// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Terminal routes for the per-project agent runtime.
 *
 * The cloud API proxies /api/projects/:id/terminal/* to these runtime-local
 * /terminal/* endpoints. Local API mode has its own project-id wrapper, but in
 * a runtime pod the process is already scoped to exactly one workspace.
 */

import { execSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { isAbsolute, join, resolve } from 'path'
import { Hono } from 'hono'
import { makeKillChild, spawnPresetShell, spawnRunShell } from './terminal-shell'
import { completeTerminalPath } from './terminal-completion'
import { buildQuickCommands, groupQuickCommandsByCategory } from './quick-commands'

const META_SENTINEL_PREFIX = '\u001eSHOGO_TERM_META:'
const META_SENTINEL_SUFFIX = '\u001e\n'

export function runtimeTerminalRoutes(config: { workspaceDir: string }) {
  const { workspaceDir } = config
  const router = new Hono()

  router.get('/terminal/commands', (c) => {
    // Built per-request from the workspace's `package.json`, file probes
    // (Prisma/Playwright/Python), and the active stack's `quickCommands`.
    // See `quick-commands.ts` for the layering rules.
    const commands = groupQuickCommandsByCategory(buildQuickCommands(workspaceDir))
    return c.json({ commands })
  })

  router.post('/terminal/complete', async (c) => {
    if (!existsSync(workspaceDir)) {
      return c.json({ error: { code: 'workspace_not_found', message: 'Workspace not found' } }, 404)
    }

    let body: { cwd?: string; pathPrefix?: string; onlyDirectories?: boolean }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'invalid_body', message: 'Invalid request body' } }, 400)
    }

    return c.json(completeTerminalPath(workspaceDir, body))
  })

  router.post('/terminal/exec', async (c) => {
    if (!existsSync(workspaceDir)) {
      return c.json({ error: { code: 'workspace_not_found', message: 'Workspace not found' } }, 404)
    }

    let body: { commandId?: string; confirmDangerous?: boolean }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'invalid_body', message: 'Invalid request body' } }, 400)
    }

    // Re-resolve from the dynamic list so a freshly added `package.json`
    // script (or a stack switch) is honored without restarting the runtime.
    const preset = buildQuickCommands(workspaceDir).find(cmd => cmd.id === body.commandId)
    if (!preset) {
      return c.json({ error: { code: 'unknown_command', message: `Unknown command: ${body.commandId}` } }, 400)
    }
    if (preset.dangerous && !body.confirmDangerous) {
      return c.json({
        error: {
          code: 'confirmation_required',
          message: 'This command is destructive. Set confirmDangerous: true to proceed.',
        },
      }, 400)
    }

    if (preset.id === 'playwright-test' || preset.id === 'playwright-test-headed') {
      const nodeModulesDir = join(workspaceDir, 'node_modules')
      if (!existsSync(nodeModulesDir)) {
        try {
          execSync('bun install', { cwd: workspaceDir, stdio: 'pipe', timeout: 120000 })
        } catch (err: any) {
          return c.json({
            error: {
              code: 'install_failed',
              message: err?.message || 'bun install failed. Run "bun install" and try again.',
            },
          }, 500)
        }
      }
    }

    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()
    const clientSignal = c.req.raw.signal
    const timeout = preset.timeout || 60000

    ;(async () => {
      try {
        await writer.write(encoder.encode(`$ ${preset.command}\n\n`))
        // Platform-aware spawn: `sh -c` + detached process group on Unix
        // (so `makeKillChild` can signal the whole tree via negative pid)
        // and PowerShell + windowsHide on Windows so no console window
        // flashes and `taskkill /T` can walk the process tree.
        const child = spawnPresetShell({ command: preset.command, cwd: workspaceDir })
        const killChild = makeKillChild(child)
        const timeoutId = setTimeout(() => {
          writer.write(encoder.encode('\n\n[ERROR] Command timed out\n')).catch(() => {})
          killChild('SIGTERM')
        }, timeout)
        const onAbort = () => killChild('SIGTERM')
        clientSignal?.addEventListener('abort', onAbort)

        let settled = false
        const settle = async (trailer: string) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutId)
          clientSignal?.removeEventListener('abort', onAbort)
          try {
            await writer.write(encoder.encode(trailer))
            await writer.close()
          } catch {}
        }

        pipeWithBackpressure(child.stdout, writer)
        pipeWithBackpressure(child.stderr, writer)

        child.on('close', async (code) => {
          await settle(`\n\n[Process exited with code ${code}]\n`)
        })
        child.on('error', async (err) => {
          await settle(`\n\n[ERROR] ${err.message}\n`)
        })
      } catch (err: any) {
        try {
          await writer.write(encoder.encode(`[ERROR] ${err?.message ?? String(err)}\n`))
          await writer.close()
        } catch {}
      }
    })()

    return streamResponse(readable)
  })

  router.post('/terminal/run', async (c) => {
    if (!existsSync(workspaceDir)) {
      return c.json({ error: { code: 'workspace_not_found', message: 'Workspace not found' } }, 404)
    }

    let body: { command?: string; cwd?: string; prevCwd?: string; timeoutMs?: number }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'invalid_body', message: 'Invalid request body' } }, 400)
    }

    const command = typeof body.command === 'string' ? body.command : ''
    if (!command.trim()) {
      return c.json({ error: { code: 'empty_command', message: 'Command is required' } }, 400)
    }

    const rawTimeout = typeof body.timeoutMs === 'number' ? body.timeoutMs : 10 * 60_000
    const timeout = Math.min(Math.max(rawTimeout, 1_000), 30 * 60_000)
    const effectiveCwd = pickCwd(body.cwd, workspaceDir)
    const prevCwd = pickCwd(body.prevCwd, workspaceDir)

    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()
    const clientSignal = c.req.raw.signal

    const metaDir = mkdtempSync(join(tmpdir(), 'shogo-term-'))
    const pwdFile = join(metaDir, 'pwd')
    const cleanup = () => {
      try {
        rmSync(metaDir, { recursive: true, force: true })
      } catch {}
    }

    ;(async () => {
      // Platform-aware launcher: bash `cd → eval → write pwd → exit` on
      // Unix, PowerShell equivalent on Windows. See terminal-shell.ts.
      // HOME is scoped to the workspace on Unix (npm/git/etc. tilde
      // expansion) but left alone on Windows where USERPROFILE is what
      // PowerShell users expect.
      let child: ReturnType<typeof spawnRunShell>
      try {
        child = spawnRunShell({
          command,
          effectiveCwd,
          rootDir: workspaceDir,
          pwdFile,
          prevCwd,
          extraEnv: process.platform === 'win32' ? undefined : { HOME: workspaceDir },
        })
      } catch (err: any) {
        cleanup()
        try {
          await writer.write(encoder.encode(`\n[shogo] failed to spawn shell: ${err?.message ?? String(err)}\n`))
          await writeMetaSentinel(writer, encoder, { cwd: effectiveCwd, exitCode: null, signal: null })
          await writer.close()
        } catch {}
        return
      }

      const killChild = makeKillChild(child)
      const timeoutId = setTimeout(() => {
        writer.write(encoder.encode('\n[shogo] command timed out\n')).catch(() => {})
        killChild('SIGTERM')
      }, timeout)
      const onAbort = () => killChild('SIGTERM')
      clientSignal?.addEventListener('abort', onAbort)

      let settled = false
      const settle = async (meta: { cwd: string; exitCode: number | null; signal: string | null }) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        clientSignal?.removeEventListener('abort', onAbort)
        cleanup()
        try {
          await writeMetaSentinel(writer, encoder, meta)
          await writer.close()
        } catch {}
      }

      pipeWithBackpressure(child.stdout, writer)
      pipeWithBackpressure(child.stderr, writer)

      child.on('error', async (err) => {
        try {
          await writer.write(encoder.encode(`\n[shogo] ${err.message}\n`))
        } catch {}
        await settle({ cwd: effectiveCwd, exitCode: null, signal: null })
      })

      child.on('close', async (code, signal) => {
        let reported = ''
        try {
          if (existsSync(pwdFile)) reported = readFileSync(pwdFile, 'utf8').trim()
        } catch {}
        const finalCwd = reported && existsSync(reported) ? reported : effectiveCwd
        await settle({
          cwd: finalCwd,
          exitCode: typeof code === 'number' ? code : null,
          signal: signal ?? null,
        })
      })
    })()

    return streamResponse(readable)
  })

  return router
}

function pickCwd(candidate: string | undefined, workspaceDir: string): string {
  if (!candidate || typeof candidate !== 'string') return workspaceDir
  const abs = isAbsolute(candidate) ? candidate : resolve(workspaceDir, candidate)
  return existsSync(abs) ? abs : workspaceDir
}

function pipeWithBackpressure(
  src: NodeJS.ReadableStream | null,
  writer: WritableStreamDefaultWriter<Uint8Array>,
) {
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

async function writeMetaSentinel(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  meta: { cwd: string; exitCode: number | null; signal: string | null },
) {
  const payload = Buffer.from(JSON.stringify(meta), 'utf8').toString('base64')
  await writer.write(encoder.encode(META_SENTINEL_PREFIX + payload + META_SENTINEL_SUFFIX))
}

function streamResponse(readable: ReadableStream<Uint8Array>) {
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
