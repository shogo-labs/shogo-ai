// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Terminal routes for the per-project agent runtime.
 *
 * The cloud API proxies /api/projects/:id/terminal/* to these runtime-local
 * /terminal/* endpoints. Local API mode has its own project-id wrapper, but in
 * a runtime pod the process is already scoped to exactly one workspace.
 */

import { spawn, execSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { isAbsolute, join, resolve } from 'path'
import { Hono } from 'hono'

const META_SENTINEL_PREFIX = '\u001eSHOGO_TERM_META:'
const META_SENTINEL_SUFFIX = '\u001e\n'

interface PresetCommand {
  id: string
  label: string
  description: string
  command: string
  category: 'package' | 'database' | 'server' | 'test' | 'build'
  dangerous?: boolean
  timeout?: number
}

const PRESET_COMMANDS: PresetCommand[] = [
  {
    id: 'bun-install',
    label: 'Install Dependencies',
    description: 'Install all project dependencies with bun',
    command: 'bun install',
    category: 'package',
    timeout: 120000,
  },
  {
    id: 'prisma-generate',
    label: 'Generate Prisma Client',
    description: 'Regenerate Prisma client after schema changes',
    // Use `bun x` instead of `bunx`: Shogo Desktop on Windows ships
    // bun.exe without a bunx.exe companion, so the bunx form fails
    // immediately with `'bunx' is not recognized`. `bun x` is bun's
    // built-in equivalent and only requires bun itself on PATH.
    command: 'bun x prisma generate',
    category: 'database',
  },
  {
    id: 'prisma-push',
    label: 'Push Schema',
    description: 'Push schema changes to the database',
    command: 'bun x prisma db push',
    category: 'database',
  },
  {
    id: 'prisma-reset',
    label: 'Reset Database',
    description: 'Wipe and recreate database from schema (destructive)',
    command: 'bun x prisma db push --force-reset',
    category: 'database',
    dangerous: true,
    timeout: 30000,
  },
  {
    id: 'prisma-migrate',
    label: 'Run Migrations',
    description: 'Create and apply database migrations',
    command: 'bun x prisma migrate dev --name auto',
    category: 'database',
    timeout: 60000,
  },
  {
    id: 'playwright-test',
    label: 'Run Tests',
    description: 'Run Playwright E2E tests',
    command: 'bun x playwright test',
    category: 'test',
    timeout: 180000,
  },
  {
    id: 'playwright-test-headed',
    label: 'Run Tests (Visible)',
    description: 'Run tests with browser visible',
    command: 'bun x playwright test --headed',
    category: 'test',
    timeout: 180000,
  },
  {
    id: 'typecheck',
    label: 'Type Check',
    description: 'Run TypeScript type checking',
    command: 'bun x tsc --noEmit',
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

export function runtimeTerminalRoutes(config: { workspaceDir: string }) {
  const { workspaceDir } = config
  const router = new Hono()

  router.get('/terminal/commands', (c) => {
    const commands = PRESET_COMMANDS.reduce((acc, cmd) => {
      acc[cmd.category] ??= []
      acc[cmd.category].push({
        id: cmd.id,
        label: cmd.label,
        description: cmd.description,
        category: cmd.category,
        dangerous: cmd.dangerous || false,
      })
      return acc
    }, {} as Record<string, Array<{ id: string; label: string; description: string; category: string; dangerous: boolean }>>)

    return c.json({ commands })
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

    const preset = PRESET_COMMANDS.find(cmd => cmd.id === body.commandId)
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
        const child = spawn('sh', ['-c', preset.command], {
          cwd: workspaceDir,
          env: {
            ...process.env,
            FORCE_COLOR: '1',
            CI: 'true',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        })
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
      const launcher =
        'cd -- "${SHOGO_CWD:-$SHOGO_ROOT}" 2>/dev/null || cd -- "$SHOGO_ROOT"; ' +
        'export OLDPWD="${SHOGO_OLDPWD:-$PWD}"; ' +
        'eval "$SHOGO_CMD"; ' +
        '__shogo_rc=$?; ' +
        '{ pwd > "$SHOGO_PWD_FILE"; } 2>/dev/null; ' +
        'exit $__shogo_rc'

      let child: ReturnType<typeof spawn>
      try {
        child = spawn('bash', ['-c', launcher], {
          cwd: effectiveCwd,
          env: {
            ...process.env,
            SHOGO_CMD: command,
            SHOGO_CWD: effectiveCwd,
            SHOGO_ROOT: workspaceDir,
            SHOGO_PWD_FILE: pwdFile,
            OLDPWD: prevCwd,
            SHOGO_OLDPWD: prevCwd,
            HOME: workspaceDir,
            PWD: effectiveCwd,
            FORCE_COLOR: '1',
            CLICOLOR: '1',
            CLICOLOR_FORCE: '1',
            TERM: process.env.TERM || 'xterm-256color',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
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

function makeKillChild(child: ReturnType<typeof spawn>) {
  let killed = false
  const killGroup = (sig: NodeJS.Signals) => {
    if (!child.pid) return
    try {
      process.kill(-child.pid, sig)
    } catch {
      try {
        child.kill(sig)
      } catch {}
    }
  }
  return function killChild(signal: NodeJS.Signals = 'SIGTERM') {
    if (killed) return
    killed = true
    killGroup(signal)
    setTimeout(() => {
      if (!child.killed && child.exitCode === null) killGroup('SIGKILL')
    }, 2_000).unref?.()
  }
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
