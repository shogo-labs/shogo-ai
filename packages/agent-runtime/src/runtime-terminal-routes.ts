// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Terminal routes for the per-project agent runtime.
 *
 * The cloud API proxies /api/projects/:id/terminal/* to these runtime-local
 * /terminal/* endpoints. Local API mode has its own project-id wrapper, but in
 * a runtime pod the process is already scoped to exactly one workspace.
 *
 * Endpoints:
 *   GET    /terminal/commands          → preset list (bun install / typecheck / …)
 *   POST   /terminal/sessions          → spin up a new PTY shell for this workspace
 *   GET    /terminal/sessions          → list active PTY shells
 *   DELETE /terminal/sessions/:id      → kill an active PTY shell
 *
 * The actual byte stream (keystrokes ↔ shell output) lives on a WebSocket
 * upgrade at /terminal/sessions/:id/ws, decided in `apps/api/src/server.ts`
 * because Bun.serve owns upgrades.
 */

import { existsSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { Hono } from 'hono'
import { buildQuickCommands, groupQuickCommandsByCategory } from './quick-commands'
import { PtySessionManager } from './pty-session-manager'

export interface RuntimeTerminalRoutes {
  router: Hono
  manager: PtySessionManager
}

export function runtimeTerminalRoutes(config: {
  workspaceDir: string
  manager?: PtySessionManager
}): RuntimeTerminalRoutes {
  const { workspaceDir } = config
  const manager = config.manager ?? new PtySessionManager({ workspaceDir })
  const router = new Hono()

  router.post('/terminal/sessions', async (c) => {
    if (!existsSync(workspaceDir)) {
      return c.json({ error: { code: 'workspace_not_found', message: 'Workspace not found' } }, 404)
    }
    let body: { cwd?: string; cols?: number; rows?: number } = {}
    try { body = await c.req.json() } catch {}
    const cols = clampDim(body.cols, 1, 1000, 80)
    const rows = clampDim(body.rows, 1, 1000, 24)
    const cwd = pickCwd(body.cwd, workspaceDir)
    try {
      const rec = manager.create({ cwd, cols, rows })
      return c.json({
        id: rec.id,
        cwd: rec.session.cwd,
        cols: rec.session.cols,
        rows: rec.session.rows,
        createdAt: rec.createdAt,
      })
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      const code = msg.startsWith('max-sessions-reached') ? 'max_sessions_reached' : 'spawn_failed'
      return c.json({ error: { code, message: msg } }, 400)
    }
  })

  router.get('/terminal/sessions', (c) => {
    return c.json({ sessions: manager.list() })
  })

  router.delete('/terminal/sessions/:id', (c) => {
    const id = c.req.param('id')
    if (!manager.get(id)) {
      return c.json({ error: { code: 'unknown_session', message: 'Session not found' } }, 404)
    }
    manager.kill(id)
    return c.json({ ok: true })
  })

  router.get('/terminal/commands', (c) => {
    // Built per-request from the workspace's `package.json`, file probes
    // (Prisma/Playwright/Python), and the active stack's `quickCommands`.
    // See `quick-commands.ts` for the layering rules.
    const commands = groupQuickCommandsByCategory(buildQuickCommands(workspaceDir))
    return c.json({ commands })
  })

  return { router, manager }
}

function pickCwd(candidate: string | undefined, workspaceDir: string): string {
  if (!candidate || typeof candidate !== 'string') return workspaceDir
  const abs = isAbsolute(candidate) ? candidate : resolve(workspaceDir, candidate)
  return existsSync(abs) ? abs : workspaceDir
}

function clampDim(n: number | undefined, min: number, max: number, fallback: number): number {
  if (n == null || !Number.isFinite(n) || !Number.isInteger(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return n
}
