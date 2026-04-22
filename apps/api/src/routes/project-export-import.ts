// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { AgentClient, type WorkspaceBundle } from '@shogo-ai/sdk/agent'
import { Hono } from 'hono'
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { prisma } from '../lib/prisma'
import type { AuthContext } from '../middleware/auth'

const PROJECT_ROOT = resolve(import.meta.dir, '../../../..')
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
const isKubernetes = () => !!process.env.KUBERNETES_SERVICE_HOST

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.cache',
  '.next',
  'build',
  '.turbo',
  '.expo',
])

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB per file
const MAX_TOTAL_SIZE = 200 * 1024 * 1024 // 200 MB total bundle

function collectWorkspaceFiles(
  dir: string,
  baseDir: string,
): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {}
  if (!existsSync(dir)) return files

  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue
    if (entry.name.startsWith('.install-ok')) continue

    const fullPath = join(dir, entry.name)
    const relPath = relative(baseDir, fullPath).replace(/\\/g, '/')

    if (entry.isDirectory()) {
      Object.assign(files, collectWorkspaceFiles(fullPath, baseDir))
    } else if (entry.isFile()) {
      try {
        const stat = statSync(fullPath)
        if (stat.size > MAX_FILE_SIZE) continue
        files[relPath] = new Uint8Array(readFileSync(fullPath))
      } catch {
        // skip unreadable files
      }
    }
  }
  return files
}

export function projectExportImportRoutes() {
  const app = new Hono()

  // GET /:projectId/export
  // Auth is handled by the requireProjectAccess middleware applied to /api/projects/:projectId/*
  app.get('/:projectId/export', async (c) => {
    const projectId = c.req.param('projectId')

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { agentConfig: true },
    })
    if (!project) {
      return c.json({ error: 'Project not found' }, 404)
    }

    const chatSessions = await prisma.chatSession.findMany({
      where: { contextType: 'project', contextId: projectId },
      include: {
        messages: {
          where: { agent: 'technical' },
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    let settings: any = null
    if (project.settings) {
      try {
        settings =
          typeof project.settings === 'string'
            ? JSON.parse(project.settings)
            : project.settings
      } catch {
        settings = project.settings
      }
    }

    const agentConfigExport: Record<string, any> | null = project.agentConfig
      ? {
          heartbeatInterval: project.agentConfig.heartbeatInterval,
          heartbeatEnabled: project.agentConfig.heartbeatEnabled,
          modelProvider: project.agentConfig.modelProvider,
          modelName: project.agentConfig.modelName,
          channels: project.agentConfig.channels,
        }
      : null

    // Include optional PG-only fields when present
    if (agentConfigExport && project.agentConfig) {
      const ac = project.agentConfig as Record<string, any>
      for (const key of ['quietHoursStart', 'quietHoursEnd', 'quietHoursTimezone']) {
        if (ac[key] !== undefined) agentConfigExport[key] = ac[key]
      }
    }

    const projectJson = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      project: {
        name: project.name,
        description: project.description,
        tier: project.tier,
        status: project.status,
        settings,
        category: project.category,
        schemas: project.schemas,
        accessLevel: project.accessLevel,
        siteTitle: project.siteTitle,
        siteDescription: project.siteDescription,
      },
      agentConfig: agentConfigExport,
    }

    const zipContents: Record<string, Uint8Array> = {}

    zipContents['project.json'] = strToU8(JSON.stringify(projectJson, null, 2))

    if (isKubernetes()) {
      try {
        const { getProjectPodUrl } = await import('../lib/knative-project-manager')
        const podUrl = await getProjectPodUrl(projectId)
        const agent = new AgentClient({ baseUrl: podUrl })
        const bundle: WorkspaceBundle = await agent.getWorkspaceBundle()
        for (const [relPath, base64Data] of Object.entries(bundle.files)) {
          zipContents[`workspace/${relPath}`] = new Uint8Array(
            Buffer.from(base64Data, 'base64'),
          )
        }
      } catch (err: any) {
        console.warn(`[Export] Could not reach agent pod for workspace files: ${err.message}`)
      }
    } else {
      const workspaceDir = join(WORKSPACES_DIR, projectId)
      const workspaceFiles = collectWorkspaceFiles(workspaceDir, workspaceDir)
      for (const [relPath, data] of Object.entries(workspaceFiles)) {
        zipContents[`workspace/${relPath}`] = data
      }
    }

    for (const session of chatSessions) {
      const sessionData = {
        session: {
          name: session.name,
          inferredName: session.inferredName,
          contextType: session.contextType,
          phase: session.phase,
          createdAt: session.createdAt.toISOString(),
          updatedAt: session.updatedAt.toISOString(),
          lastActiveAt: session.lastActiveAt.toISOString(),
        },
        messages: session.messages.map((m) => ({
          role: m.role,
          content: m.content,
          parts: m.parts,
          createdAt: m.createdAt.toISOString(),
        })),
      }
      zipContents[`chat-history/${session.id}.json`] = strToU8(
        JSON.stringify(sessionData, null, 2),
      )
    }

    const zipped = zipSync(zipContents, { level: 6 })

    const safeName = project.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)
    const filename = `${safeName}.shogo-project`

    const body = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer
    return new Response(body, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(zipped.byteLength),
      },
    })
  })

  // POST /import
  // No requireProjectAccess middleware here (no projectId). Auth checked manually.
  app.post('/import', async (c) => {
    const authCtx = (c as any).get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json(
        { error: { code: 'unauthorized', message: 'Authentication required' } },
        401,
      )
    }
    const userId = authCtx.userId

    const contentType = c.req.header('content-type') || ''

    let zipBuffer: Uint8Array
    let workspaceId: string

    if (contentType.includes('multipart/form-data')) {
      const formData = await c.req.formData()
      const file = formData.get('file') as File | null
      workspaceId = (formData.get('workspaceId') as string) || ''

      if (!file) {
        return c.json({ error: 'Missing file in form data' }, 400)
      }
      if (!workspaceId) {
        return c.json({ error: 'Missing workspaceId in form data' }, 400)
      }

      const arrayBuf = await file.arrayBuffer()
      if (arrayBuf.byteLength > MAX_TOTAL_SIZE) {
        return c.json({ error: 'File too large' }, 413)
      }
      zipBuffer = new Uint8Array(arrayBuf)
    } else {
      return c.json(
        { error: 'Expected multipart/form-data with file upload' },
        400,
      )
    }

    // Verify user has access to the target workspace
    const member = await prisma.member.findFirst({
      where: { userId, workspaceId },
    })
    if (!member) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      })
      if (user?.role !== 'super_admin') {
        return c.json(
          {
            error: {
              code: 'forbidden',
              message: 'Access denied to this workspace',
            },
          },
          403,
        )
      }
    }

    let unzipped: Record<string, Uint8Array>
    try {
      unzipped = unzipSync(zipBuffer)
    } catch {
      return c.json({ error: 'Invalid or corrupt ZIP file' }, 400)
    }

    const projectJsonData = unzipped['project.json']
    if (!projectJsonData) {
      return c.json(
        { error: 'Invalid bundle: missing project.json' },
        400,
      )
    }

    let bundle: {
      version: string
      project: {
        name: string
        description?: string | null
        tier?: string
        status?: string
        settings?: any
        category?: string | null
        schemas?: string[]
        accessLevel?: string
        siteTitle?: string | null
        siteDescription?: string | null
      }
      agentConfig?: {
        heartbeatInterval?: number
        heartbeatEnabled?: boolean
        modelProvider?: string
        modelName?: string
        channels?: any
        quietHoursStart?: string | null
        quietHoursEnd?: string | null
        quietHoursTimezone?: string | null
      } | null
    }

    try {
      bundle = JSON.parse(strFromU8(projectJsonData))
    } catch {
      return c.json({ error: 'Invalid project.json in bundle' }, 400)
    }

    const bp = bundle.project
    const project = await prisma.project.create({
      data: {
        name: bp.name || 'Imported Project',
        description: bp.description ?? null,
        workspaceId,
        createdBy: userId,
        tier: (bp.tier as any) || 'starter',
        status: (bp.status as any) || 'draft',
        accessLevel: (bp.accessLevel as any) || 'anyone',
        schemas: bp.schemas ?? [],
        category: (bp.category as any) ?? null,
        siteTitle: bp.siteTitle ?? null,
        siteDescription: bp.siteDescription ?? null,
        settings: bp.settings
          ? typeof bp.settings === 'string'
            ? bp.settings
            : JSON.stringify(bp.settings)
          : JSON.stringify({
              activeMode: 'none',
              canvasMode: 'code',
              canvasEnabled: false,
            }),
      },
    })

    {
      const ac = bundle.agentConfig
      const agentData: Record<string, any> = {
        projectId: project.id,
        heartbeatInterval: ac?.heartbeatInterval ?? 1800,
        heartbeatEnabled: ac?.heartbeatEnabled ?? false,
        modelProvider: ac?.modelProvider ?? 'anthropic',
        modelName: ac?.modelName ?? 'claude-haiku-4-5',
        channels: ac?.channels ?? [],
      }
      // PG-only fields — include only when present in the bundle
      if (ac) {
        for (const key of ['quietHoursStart', 'quietHoursEnd', 'quietHoursTimezone']) {
          if ((ac as any)[key] !== undefined) agentData[key] = (ac as any)[key]
        }
      }
      await prisma.agentConfig.create({ data: agentData as any })
    }

    // Extract workspace files
    const projectDir = join(WORKSPACES_DIR, project.id)
    mkdirSync(projectDir, { recursive: true })

    for (const [path, data] of Object.entries(unzipped)) {
      if (!path.startsWith('workspace/')) continue
      const relPath = path.slice('workspace/'.length).replace(/\\/g, '/')
      if (!relPath || relPath.includes('..') || relPath.startsWith('/')) continue

      const destPath = join(projectDir, relPath)
      const destDir = join(destPath, '..')
      mkdirSync(resolve(destDir), { recursive: true })
      writeFileSync(destPath, data)
    }

    // Import chat history
    for (const [path, data] of Object.entries(unzipped)) {
      if (!path.startsWith('chat-history/') || !path.endsWith('.json'))
        continue

      try {
        const sessionBundle = JSON.parse(strFromU8(data)) as {
          session: {
            name?: string | null
            inferredName: string
            contextType: string
            phase?: string | null
            createdAt: string
            updatedAt: string
            lastActiveAt: string
          }
          messages: Array<{
            role: string
            content: string
            parts?: string | null
            createdAt: string
          }>
        }

        const s = sessionBundle.session
        const chatSession = await prisma.chatSession.create({
          data: {
            name: s.name ?? null,
            inferredName: s.inferredName || 'Imported session',
            contextType: 'project',
            contextId: project.id,
            phase: s.phase ?? null,
            createdAt: new Date(s.createdAt),
            updatedAt: new Date(s.updatedAt),
            lastActiveAt: new Date(s.lastActiveAt),
          },
        })

        if (sessionBundle.messages.length > 0) {
          await prisma.chatMessage.createMany({
            data: sessionBundle.messages.map((m) => ({
              sessionId: chatSession.id,
              role: m.role as any,
              content: m.content,
              parts: m.parts ?? null,
              createdAt: new Date(m.createdAt),
              agent: 'technical',
            })),
          })
        }
      } catch {
        // skip malformed chat session files
      }
    }

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
