// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Hono } from 'hono'
import { existsSync, readdirSync, readFileSync, mkdirSync, cpSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { prisma } from '../lib/prisma'

const EVAL_OUTPUTS_DIR = resolve(import.meta.dir, '../../../../packages/agent-runtime/eval-outputs')

interface EvalOutputEntry {
  id: string
  name: string
  description: string
  icon: string
  passed: boolean
  score: { earned: number; max: number; percentage: number }
  tags: string[]
  path: string
}

interface EvalOutputRun {
  track: string
  timestamp: string
  dirName: string
  entries: EvalOutputEntry[]
}

export function evalOutputRoutes() {
  const app = new Hono()

  app.get('/eval-outputs', (c) => {
    if (!existsSync(EVAL_OUTPUTS_DIR)) {
      return c.json({ runs: [] })
    }

    const runs: EvalOutputRun[] = []

    const runDirs = readdirSync(EVAL_OUTPUTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name))

    for (const runDir of runDirs) {
      const parts = runDir.name.match(/^(.+?)-(\d{4}-\d{2}-\d{2}T.+)$/)
      const track = parts?.[1] ?? runDir.name
      const timestamp = parts?.[2]?.replace(/-/g, (m, offset: number) => {
        if (offset <= 9) return m
        return offset === 13 || offset === 16 ? ':' : m
      }) ?? runDir.name

      const runPath = join(EVAL_OUTPUTS_DIR, runDir.name)
      const entries: EvalOutputEntry[] = []

      function pushEntry(relPath: string, folderName: string, templatePath: string) {
        try {
          const meta = JSON.parse(readFileSync(templatePath, 'utf-8'))
          entries.push({
            id: meta.id ?? folderName,
            name: meta.name ?? folderName,
            description: meta.description ?? '',
            icon: meta.icon ?? '?',
            passed: meta.eval?.passed ?? false,
            score: {
              earned: meta.eval?.score ?? 0,
              max: meta.eval?.maxScore ?? 0,
              percentage: meta.eval?.percentage ?? 0,
            },
            tags: meta.tags ?? [],
            path: relPath,
          })
        } catch {
          // skip malformed entries
        }
      }

      // Legacy layout: <run>/<evalId>/template.json
      const topDirs = readdirSync(runPath, { withFileTypes: true }).filter(d => d.isDirectory())
      for (const evalDir of topDirs) {
        if (evalDir.name === 'workspaces' || evalDir.name === 'logs') continue
        const templatePath = join(runPath, evalDir.name, 'template.json')
        if (!existsSync(templatePath)) continue
        pushEntry(`${runDir.name}/${evalDir.name}`, evalDir.name, templatePath)
      }

      // Current run-eval layout: <run>/workspaces/<evalId>/template.json
      const workspacesRoot = join(runPath, 'workspaces')
      if (existsSync(workspacesRoot)) {
        for (const evalDir of readdirSync(workspacesRoot, { withFileTypes: true }).filter(
          d => d.isDirectory(),
        )) {
          const templatePath = join(workspacesRoot, evalDir.name, 'template.json')
          if (!existsSync(templatePath)) continue
          pushEntry(`${runDir.name}/workspaces/${evalDir.name}`, evalDir.name, templatePath)
        }
      }

      if (entries.length > 0) {
        runs.push({ track, timestamp, dirName: runDir.name, entries })
      }
    }

    return c.json({ runs })
  })

  app.post('/eval-outputs/import', async (c) => {
    const body = await c.req.json() as {
      evalOutputPath: string
      workspaceId: string
      userId: string
      name?: string
    }

    if (!body.evalOutputPath || !body.workspaceId || !body.userId) {
      return c.json({ error: 'Missing required fields: evalOutputPath, workspaceId, userId' }, 400)
    }

    const sanitized = body.evalOutputPath.replace(/\.\./g, '')
    const evalDir = join(EVAL_OUTPUTS_DIR, sanitized)

    if (!existsSync(evalDir)) {
      return c.json({ error: `Eval output not found: ${sanitized}` }, 404)
    }

    const templatePath = join(evalDir, 'template.json')
    let meta: Record<string, any> = {}
    if (existsSync(templatePath)) {
      try {
        meta = JSON.parse(readFileSync(templatePath, 'utf-8'))
      } catch {}
    }

    const projectName = body.name || meta.name || 'Imported Eval'
    const description = meta.description || `Imported from eval output: ${sanitized}`

    const project = await prisma.project.create({
      data: {
        name: projectName,
        description,
        workspaceId: body.workspaceId,
        createdBy: body.userId,
        tier: 'starter',
        status: 'draft',
        accessLevel: 'anyone',
        settings: JSON.stringify({ activeMode: 'canvas', canvasMode: 'code' }),
      },
    })

    const workspacesDir = process.env.WORKSPACES_DIR || process.cwd()
    const projectDir = join(workspacesDir, project.id)
    mkdirSync(projectDir, { recursive: true })

    cpSync(evalDir, projectDir, {
      recursive: true,
      filter: (src) => !src.endsWith('template.json'),
    })

    return c.json({
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
      },
    })
  })

  return app
}
