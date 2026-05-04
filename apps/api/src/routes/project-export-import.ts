// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { AgentClient, type WorkspaceBundle } from '@shogo-ai/sdk/agent'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { prisma } from '../lib/prisma'
import type { AuthContext } from '../middleware/auth'

const PROJECT_ROOT = resolve(import.meta.dir, '../../../..')
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
const isKubernetes = () => !!process.env.KUBERNETES_SERVICE_HOST

// `dist/` and `build/` are intentionally NOT excluded here — we want the prebuilt
// app output in the bundle so an imported project can serve its preview
// immediately (preview-manager treats `project/dist/index.html` as "ready").
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.cache',
  '.next',
  '.turbo',
  '.expo',
])

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB per file
const MAX_TOTAL_SIZE = 200 * 1024 * 1024 // 200 MB total bundle

/**
 * Remove a broken .shogo symlink left by a previous VM 9p mount.
 * The VM creates .shogo -> /tmp/shogo-local/<id>/.shogo which becomes
 * dangling on the host after the VM exits, causing collectWorkspaceFiles
 * to silently skip the entire .shogo tree.
 */
function cleanBrokenShogoSymlink(workspaceDir: string): void {
  const shogoDir = join(workspaceDir, '.shogo')
  try {
    const st = lstatSync(shogoDir)
    if (st.isSymbolicLink()) {
      try { statSync(shogoDir) } catch { rmSync(shogoDir, { force: true }) }
    }
  } catch {}
}

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

// ─── Import internals ──────────────────────────────────────────
// Factored out so both the JSON and SSE endpoints share the exact same logic.

type ImportEvent =
  | { phase: 'parse' }
  | { phase: 'createProject' }
  | { phase: 'writeFiles'; done: number; total: number }
  | { phase: 'importChats'; done: number; total: number }
  | {
      phase: 'done'
      project: { id: string; name: string; description: string | null }
      stats: {
        filesWritten: number
        filesSkipped: number
        chatsImported: number
        chatsSkipped: number
      }
    }
  | { phase: 'error'; message: string; fatal: boolean }

interface ProjectBundle {
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

type ImportResult =
  | {
      ok: true
      project: { id: string; name: string; description: string | null }
      stats: {
        filesWritten: number
        filesSkipped: number
        chatsImported: number
        chatsSkipped: number
      }
    }
  | { ok: false; status: 400 | 401 | 403 | 413; error: string }

async function runImport(
  zipBuffer: Uint8Array,
  workspaceId: string,
  userId: string,
  options: { includeChats: boolean },
  emit: (ev: ImportEvent) => void | Promise<void>,
): Promise<ImportResult> {
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
      return { ok: false, status: 403, error: 'Access denied to this workspace' }
    }
  }

  let unzipped: Record<string, Uint8Array>
  try {
    unzipped = unzipSync(zipBuffer)
  } catch {
    return { ok: false, status: 400, error: 'Invalid or corrupt ZIP file' }
  }

  const projectJsonData = unzipped['project.json']
  if (!projectJsonData) {
    return { ok: false, status: 400, error: 'Invalid bundle: missing project.json' }
  }

  let bundle: ProjectBundle
  try {
    bundle = JSON.parse(strFromU8(projectJsonData))
  } catch {
    return { ok: false, status: 400, error: 'Invalid project.json in bundle' }
  }

  await emit({ phase: 'parse' })

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

  await emit({ phase: 'createProject' })

  // Extract workspace files
  const projectDir = join(WORKSPACES_DIR, project.id)
  mkdirSync(projectDir, { recursive: true })

  const workspaceEntries = Object.entries(unzipped).filter(([path]) =>
    path.startsWith('workspace/'),
  )
  const totalFiles = workspaceEntries.length
  let filesWritten = 0
  let filesSkipped = 0

  await emit({ phase: 'writeFiles', done: 0, total: totalFiles })

  for (let i = 0; i < workspaceEntries.length; i++) {
    const [path, data] = workspaceEntries[i]
    const relPath = path.slice('workspace/'.length).replace(/\\/g, '/')
    if (!relPath || relPath.includes('..') || relPath.startsWith('/')) {
      filesSkipped++
      await emit({
        phase: 'error',
        message: `Skipped unsafe path: ${path}`,
        fatal: false,
      })
      continue
    }

    try {
      const destPath = join(projectDir, relPath)
      const destDir = join(destPath, '..')
      mkdirSync(resolve(destDir), { recursive: true })
      writeFileSync(destPath, data)
      filesWritten++
    } catch (err: any) {
      filesSkipped++
      await emit({
        phase: 'error',
        message: `Failed to write ${relPath}: ${err?.message || 'unknown error'}`,
        fatal: false,
      })
    }

    // Emit incremental progress every 25 files and on the final file so the
    // client gets a smooth progress bar without flooding the SSE stream.
    if ((i + 1) % 25 === 0 || i === workspaceEntries.length - 1) {
      await emit({ phase: 'writeFiles', done: i + 1, total: totalFiles })
    }
  }

  // Import chat history (optional — client toggle)
  let chatsImported = 0
  let chatsSkipped = 0

  if (options.includeChats) {
    const chatEntries = Object.entries(unzipped).filter(
      ([path]) => path.startsWith('chat-history/') && path.endsWith('.json'),
    )
    const totalChats = chatEntries.length

    await emit({ phase: 'importChats', done: 0, total: totalChats })

    for (let i = 0; i < chatEntries.length; i++) {
      const [path, data] = chatEntries[i]
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
        chatsImported++
      } catch (err: any) {
        chatsSkipped++
        await emit({
          phase: 'error',
          message: `Failed to import chat ${path}: ${err?.message || 'malformed'}`,
          fatal: false,
        })
      }

      if ((i + 1) % 5 === 0 || i === chatEntries.length - 1) {
        await emit({ phase: 'importChats', done: i + 1, total: totalChats })
      }
    }
  } else {
    // Count what we skipped due to the toggle so the summary is honest.
    chatsSkipped = Object.keys(unzipped).filter(
      (p) => p.startsWith('chat-history/') && p.endsWith('.json'),
    ).length
  }

  const stats = { filesWritten, filesSkipped, chatsImported, chatsSkipped }
  const projectSummary = {
    id: project.id,
    name: project.name,
    description: project.description,
  }

  await emit({ phase: 'done', project: projectSummary, stats })

  return { ok: true, project: projectSummary, stats }
}

export function projectExportImportRoutes() {
  const app = new Hono()

  // GET /:projectId/export
  // Auth is handled by the requireProjectAccess middleware applied to /api/projects/:projectId/*
  app.get('/:projectId/export', async (c) => {
    const projectId = c.req.param('projectId')
    // Default to including chats; only "false" disables.
    const includeChats = c.req.query('includeChats') !== 'false'

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { agentConfig: true },
    })
    if (!project) {
      return c.json({ error: 'Project not found' }, 404)
    }

    const chatSessions = includeChats
      ? await prisma.chatSession.findMany({
          where: { contextType: 'project', contextId: projectId },
          include: {
            messages: {
              where: { agent: 'technical' },
              orderBy: { createdAt: 'asc' },
            },
          },
        })
      : []

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
      includedChats: includeChats,
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

    let gotWorkspaceFiles = false
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
        gotWorkspaceFiles = true
      } catch (err: any) {
        console.warn(`[Export] Could not reach agent pod, falling back to local workspace: ${err.message}`)
      }
    }

    if (!gotWorkspaceFiles) {
      const workspaceDir = join(WORKSPACES_DIR, projectId)
      cleanBrokenShogoSymlink(workspaceDir)
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
  //
  // When the client sends `Accept: text/event-stream`, we stream progress as SSE:
  //   event: progress     data: { phase, ... }
  //   event: error        data: { message, fatal }       (non-fatal per-file/per-chat)
  //   event: done         data: { project, stats }
  //   event: fatal        data: { message }              (terminal failure)
  // Otherwise, we return the original JSON `{ project: {...} }` response so
  // existing non-streaming clients / tests keep working unchanged.
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
    const acceptsSSE = (c.req.header('accept') || '').includes('text/event-stream')

    let zipBuffer: Uint8Array
    let workspaceId: string
    let includeChats: boolean

    if (contentType.includes('multipart/form-data')) {
      const formData = await c.req.formData()
      const file = formData.get('file') as File | null
      workspaceId = (formData.get('workspaceId') as string) || ''
      const includeChatsRaw = (formData.get('includeChats') as string | null) ?? 'true'
      includeChats = includeChatsRaw !== 'false'

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

    if (acceptsSSE) {
      return streamSSE(c, async (stream) => {
        try {
          const result = await runImport(
            zipBuffer,
            workspaceId,
            userId,
            { includeChats },
            async (ev) => {
              if (ev.phase === 'error') {
                await stream.writeSSE({
                  event: ev.fatal ? 'fatal' : 'error',
                  data: JSON.stringify({ message: ev.message, fatal: ev.fatal }),
                })
              } else if (ev.phase === 'done') {
                await stream.writeSSE({
                  event: 'done',
                  data: JSON.stringify({ project: ev.project, stats: ev.stats }),
                })
              } else {
                await stream.writeSSE({
                  event: 'progress',
                  data: JSON.stringify(ev),
                })
              }
            },
          )

          if (!result.ok) {
            await stream.writeSSE({
              event: 'fatal',
              data: JSON.stringify({ message: result.error, status: result.status }),
            })
          }
        } catch (err: any) {
          await stream.writeSSE({
            event: 'fatal',
            data: JSON.stringify({
              message: err?.message || 'Import failed',
            }),
          })
        }
      })
    }

    // Non-streaming fallback — preserve existing JSON shape.
    try {
      const result = await runImport(
        zipBuffer,
        workspaceId,
        userId,
        { includeChats },
        () => {
          /* drop events */
        },
      )

      if (!result.ok) {
        if (result.status === 403) {
          return c.json(
            { error: { code: 'forbidden', message: result.error } },
            403,
          )
        }
        return c.json({ error: result.error }, result.status)
      }

      return c.json({ project: result.project })
    } catch (err: any) {
      return c.json({ error: err?.message || 'Import failed' }, 500)
    }
  })

  return app
}
