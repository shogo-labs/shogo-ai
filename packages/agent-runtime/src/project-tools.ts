// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Project lifecycle tools — let an agent compose a multi-project system.
 *
 *   project_list       live graph of the workspace (projects, attachments, agent config)
 *   project_create     create a sibling project (and attach it to this one)
 *   project_attach     attach an existing project to this one (readwrite / readonly)
 *   project_detach     remove an attachment
 *   project_configure  heartbeat / model / name / description of a project
 *   project_call       run one agent turn in another project, threading a runId
 *   system_apply       reconcile a `shogo-system.yaml` manifest against the workspace
 *
 * All of them go through `/api/internal/...` routes (see internal-api.ts) with
 * the runtime's own token, so authorization is "same workspace as the caller".
 * Nothing here can reach a project outside the workspace.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { randomBytes } from 'crypto'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { ToolContext } from './gateway-tools'
import { textResult } from './gateway-tools'
import {
  attachProject as apiAttachProject,
  callProjectAgent as apiCallProjectAgent,
  configureProject as apiConfigureProject,
  createProject as apiCreateProject,
  detachProject as apiDetachProject,
  getProjectConfig as apiGetProjectConfig,
  getWorkspaceProjectGraph as apiGetWorkspaceProjectGraph,
  type ProjectGraphNode,
} from './internal-api'
import {
  computeSystemDiff,
  IMPLICIT_ANCHOR,
  isSafeRelativePath,
  parseSystemManifest,
  summarizeDiff,
  type LiveProject,
  type SystemDiff,
  type SystemLock,
} from './system-manifest'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function workspaceIdOf(ctx: ToolContext): string | null {
  return ctx.workspaceId || process.env.WORKSPACE_ID || null
}

function noWorkspace() {
  return textResult({
    error: 'This runtime has no workspace context, so project lifecycle tools are unavailable.',
    code: 'no_workspace',
  })
}

export function newRunId(): string {
  return `run_${randomBytes(6).toString('hex')}`
}

/**
 * Where an attached project's files live from this runtime's point of view.
 * The current project is `ctx.workspaceDir`; in a merged-root runtime the
 * others are sibling folders `<parent>/<projectId>`. Returns null when the
 * project is not reachable on disk (not attached / not mounted yet).
 */
export function resolveProjectDir(ctx: ToolContext, projectId: string): string | null {
  if (projectId === ctx.projectId) return ctx.workspaceDir
  const candidates = [
    join(ctx.workspaceDir, projectId),
    join(dirname(ctx.workspaceDir), projectId),
    join(process.env.WORKSPACE_DIR || process.env.AGENT_DIR || '/app/workspace', projectId),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/** Resolve a project reference (id, exact name, or manifest key via lock) to an id. */
async function resolveProjectRef(
  ctx: ToolContext,
  ref: string,
): Promise<{ id: string; name: string } | { error: string; code: string }> {
  const workspaceId = workspaceIdOf(ctx)
  if (!workspaceId) return { error: 'No workspace context', code: 'no_workspace' }
  const graph = await apiGetWorkspaceProjectGraph(workspaceId)
  if (!graph.ok || !graph.data) return { error: graph.error ?? 'Could not list workspace projects', code: graph.code ?? 'api_error' }
  const byId = graph.data.find((p) => p.id === ref)
  if (byId) return { id: byId.id, name: byId.name }
  const lock = readLock(ctx)
  const locked = lock?.bindings[ref]
  if (locked) {
    const p = graph.data.find((x) => x.id === locked)
    if (p) return { id: p.id, name: p.name }
  }
  const byName = graph.data.filter((p) => p.name === ref)
  if (byName.length === 1) return { id: byName[0].id, name: byName[0].name }
  if (byName.length > 1) return { error: `Project name "${ref}" is ambiguous (${byName.length} matches); use the id.`, code: 'ambiguous' }
  return { error: `No project matches "${ref}" (by id, name, or manifest key).`, code: 'not_found' }
}

const LOCK_PATH = '.shogo/system.lock.json'
const DEFAULT_MANIFEST_PATH = 'shogo-system.yaml'

function readLock(ctx: ToolContext): SystemLock | null {
  try {
    const p = join(ctx.workspaceDir, LOCK_PATH)
    if (!existsSync(p)) return null
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    if (parsed?.version === 1 && parsed.bindings && typeof parsed.bindings === 'object') return parsed as SystemLock
    return null
  } catch {
    return null
  }
}

function writeLock(ctx: ToolContext, lock: SystemLock): void {
  const p = join(ctx.workspaceDir, LOCK_PATH)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(lock, null, 2) + '\n', 'utf-8')
}

function toLive(nodes: ProjectGraphNode[]): LiveProject[] {
  return nodes.map((n) => ({
    id: n.id,
    name: n.name,
    description: n.description,
    attachments: n.attachments,
    agent: n.agent,
  }))
}

// ---------------------------------------------------------------------------
// project_list
// ---------------------------------------------------------------------------

export function createProjectListTool(ctx: ToolContext): AgentTool {
  return {
    name: 'project_list',
    label: 'List Workspace Projects',
    description:
      'List every project in this workspace with its attachments (which projects it can see/edit), agent config (heartbeat, model) and whether it is the current project. Use before project_attach / project_call to find ids.',
    parameters: Type.Object({}),
    execute: async () => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const res = await apiGetWorkspaceProjectGraph(workspaceId)
      if (!res.ok || !res.data) return textResult({ error: res.error ?? 'Failed to list projects', code: res.code })
      const lock = readLock(ctx)
      const keyById = new Map(Object.entries(lock?.bindings ?? {}).map(([k, v]) => [v, k]))
      return textResult({
        workspaceId,
        currentProjectId: ctx.projectId,
        projects: res.data.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          manifestKey: keyById.get(p.id) ?? null,
          isCurrent: p.id === ctx.projectId,
          onDisk: resolveProjectDir(ctx, p.id) !== null,
          attachments: p.attachments,
          agent: p.agent,
        })),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// project_create
// ---------------------------------------------------------------------------

export function createProjectCreateTool(ctx: ToolContext): AgentTool {
  return {
    name: 'project_create',
    label: 'Create Project',
    description: [
      'Create a new Shogo project in this workspace. Each project is a module: its own AGENTS.md, .shogo/agents/*.md, skills, database, canvas UI, heartbeat and history.',
      'By default the new project is attached read-write to the current one so you can write its prompt files and call its agent with project_call.',
      'Pass `techStackId` (e.g. "react-app") for a project that needs a UI/dashboard; omit it for a prompt-only agent project.',
    ].join(' '),
    parameters: Type.Object({
      name: Type.String({ description: 'Display name (unique within the workspace is strongly recommended).' }),
      description: Type.Optional(Type.String({ description: 'One or two sentences on what this project/agent is for.' })),
      techStackId: Type.Optional(Type.String({ description: 'Tech stack id from the registry (e.g. "react-app"). Omit for a chat/agent-only project.' })),
      templateId: Type.Optional(Type.String({ description: 'Agent template id to seed heartbeat/model from.' })),
      attach: Type.Optional(Type.Boolean({ description: 'Attach the new project to the current one (default true).' })),
      attachMode: Type.Optional(Type.Union([Type.Literal('readwrite'), Type.Literal('readonly')], { description: 'Attachment mode when attaching (default readwrite).' })),
    }),
    execute: async (_id, params) => {
      const p = params as { name: string; description?: string; techStackId?: string; templateId?: string; attach?: boolean; attachMode?: 'readwrite' | 'readonly' }
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()

      const created = await apiCreateProject(workspaceId, {
        name: p.name,
        description: p.description,
        techStackId: p.techStackId,
        templateId: p.templateId,
        hidden: ctx.config.capabilityProfile === 'personal',
        userId: ctx.userId,
      })
      if (!created.ok || !created.data) {
        return textResult({ error: created.error ?? 'Project creation failed', code: created.code, status: created.status })
      }

      let attachment: unknown = null
      let mounted = false
      if (p.attach !== false) {
        const att = await apiAttachProject(ctx.projectId, created.data.id, p.attachMode ?? 'readwrite')
        if (att.ok && att.data) {
          attachment = att.data.attachment
          mounted = att.data.mounted
        } else {
          attachment = { error: att.error, code: att.code }
        }
      }

      return textResult({
        ok: true,
        project: created.data,
        attachment,
        mounted,
        projectDir: resolveProjectDir(ctx, created.data.id),
        note: mounted
          ? `Project files are reachable at ${resolveProjectDir(ctx, created.data.id) ?? '<sibling folder>'}. Write its AGENTS.md next.`
          : 'Attachment recorded. Files become reachable on the next runtime start; use project_call to talk to it meanwhile, or system_apply to write its files.',
      })
    },
  }
}

// ---------------------------------------------------------------------------
// project_attach / project_detach
// ---------------------------------------------------------------------------

export function createProjectAttachTool(ctx: ToolContext): AgentTool {
  return {
    name: 'project_attach',
    label: 'Attach Project',
    description:
      'Attach an existing workspace project to the current project so its files appear as a sibling folder (readwrite lets you edit its prompts; readonly is for inspection). Idempotent; re-running with a different mode changes the mode.',
    parameters: Type.Object({
      project: Type.String({ description: 'Project id, exact name, or manifest key.' }),
      mode: Type.Optional(Type.Union([Type.Literal('readwrite'), Type.Literal('readonly')], { description: 'Default readwrite.' })),
    }),
    execute: async (_id, params) => {
      const p = params as { project: string; mode?: 'readwrite' | 'readonly' }
      const target = await resolveProjectRef(ctx, p.project)
      if ('error' in target) return textResult(target)
      if (target.id === ctx.projectId) return textResult({ error: 'A project cannot attach to itself.', code: 'self_attach' })
      const res = await apiAttachProject(ctx.projectId, target.id, p.mode ?? 'readwrite')
      if (!res.ok || !res.data) return textResult({ error: res.error ?? 'Attach failed', code: res.code, status: res.status })
      return textResult({
        ok: true,
        attachment: res.data.attachment,
        mounted: res.data.mounted,
        projectDir: resolveProjectDir(ctx, target.id),
      })
    },
  }
}

export function createProjectDetachTool(ctx: ToolContext): AgentTool {
  return {
    name: 'project_detach',
    label: 'Detach Project',
    description: 'Remove an attachment from the current project. The other project is not deleted.',
    parameters: Type.Object({
      project: Type.String({ description: 'Project id, exact name, or manifest key.' }),
    }),
    execute: async (_id, params) => {
      const p = params as { project: string }
      const target = await resolveProjectRef(ctx, p.project)
      if ('error' in target) return textResult(target)
      const res = await apiDetachProject(ctx.projectId, target.id)
      if (!res.ok) return textResult({ error: res.error ?? 'Detach failed', code: res.code, status: res.status })
      return textResult({ ok: true, removed: res.data?.removed ?? false })
    },
  }
}

// ---------------------------------------------------------------------------
// project_configure
// ---------------------------------------------------------------------------

export function createProjectConfigureTool(ctx: ToolContext): AgentTool {
  return {
    name: 'project_configure',
    label: 'Configure Project',
    description:
      'Read or change a project\'s agent configuration: heartbeat (enabled/interval/quiet hours), default model, name and description. Defaults to the current project. Call with no changes to read the current config. For the current project\'s heartbeat prefer heartbeat_configure (it also updates config.json).',
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: 'Project id, name, or manifest key. Default: current project.' })),
      name: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      model: Type.Optional(Type.String({ description: 'Default model id/alias for the agent (e.g. "claude-haiku-4-5").' })),
      provider: Type.Optional(Type.String({ description: 'Model provider (usually inferred).' })),
      heartbeatEnabled: Type.Optional(Type.Boolean()),
      heartbeatInterval: Type.Optional(Type.Number({ description: 'Seconds, minimum 60.' })),
      quietHoursStart: Type.Optional(Type.String({ description: 'HH:MM' })),
      quietHoursEnd: Type.Optional(Type.String({ description: 'HH:MM' })),
      quietHoursTimezone: Type.Optional(Type.String({ description: 'IANA timezone.' })),
    }),
    execute: async (_id, params) => {
      const p = params as {
        project?: string; name?: string; description?: string; model?: string; provider?: string
        heartbeatEnabled?: boolean; heartbeatInterval?: number
        quietHoursStart?: string; quietHoursEnd?: string; quietHoursTimezone?: string
      }
      let targetId = ctx.projectId
      if (p.project) {
        const target = await resolveProjectRef(ctx, p.project)
        if ('error' in target) return textResult(target)
        targetId = target.id
      }
      if (p.heartbeatInterval !== undefined && p.heartbeatInterval < 60) {
        return textResult({ error: 'heartbeatInterval must be at least 60 seconds' })
      }

      const agent: Record<string, unknown> = {}
      if (p.model !== undefined) agent.modelName = p.model
      if (p.provider !== undefined) agent.modelProvider = p.provider
      if (p.heartbeatEnabled !== undefined) agent.heartbeatEnabled = p.heartbeatEnabled
      if (p.heartbeatInterval !== undefined) agent.heartbeatInterval = p.heartbeatInterval
      if (p.quietHoursStart !== undefined) agent.quietHoursStart = p.quietHoursStart
      if (p.quietHoursEnd !== undefined) agent.quietHoursEnd = p.quietHoursEnd
      if (p.quietHoursTimezone !== undefined) agent.quietHoursTimezone = p.quietHoursTimezone

      const hasChanges = p.name !== undefined || p.description !== undefined || Object.keys(agent).length > 0
      const res = hasChanges
        ? await apiConfigureProject(targetId, {
            name: p.name,
            description: p.description,
            agent: Object.keys(agent).length > 0 ? (agent as any) : undefined,
          })
        : await apiGetProjectConfig(targetId)
      if (!res.ok || !res.data) return textResult({ error: res.error ?? 'Configure failed', code: res.code, status: res.status })
      return textResult({ ok: true, changed: hasChanges, project: res.data })
    },
  }
}

// ---------------------------------------------------------------------------
// project_call
// ---------------------------------------------------------------------------

export function createProjectCallTool(ctx: ToolContext): AgentTool {
  return {
    name: 'project_call',
    label: 'Call Project Agent',
    description: [
      'Send a message to another project\'s agent and (by default) wait for its reply. This is how one module of a multi-project system invokes the next: intake calls analyst, planner calls implementer, and so on.',
      'Always pass the same `runId` for every hop of one piece of work; a new one is minted and returned when omitted. The callee runs in its own session `run:<runId>` and every cost metric it emits is stamped with that runId, so the run can be traced across projects.',
      'Use `wait: false` for long jobs and let the callee report back via project_call to you, or poll its outputs.',
    ].join(' '),
    parameters: Type.Object({
      project: Type.String({ description: 'Target project id, exact name, or manifest key.' }),
      message: Type.String({ description: 'The request. Be explicit about the expected output shape (e.g. JSON findings) — the callee has none of your context.' }),
      runId: Type.Optional(Type.String({ description: 'Pipeline correlation id shared across hops. Minted when omitted.' })),
      wait: Type.Optional(Type.Boolean({ description: 'Wait for the reply (default true).' })),
      timeoutMs: Type.Optional(Type.Number({ description: 'Wait budget in ms (default 300000, max 1200000).' })),
    }),
    execute: async (_id, params) => {
      const p = params as { project: string; message: string; runId?: string; wait?: boolean; timeoutMs?: number }
      const target = await resolveProjectRef(ctx, p.project)
      if ('error' in target) return textResult(target)
      if (target.id === ctx.projectId) {
        return textResult({ error: 'project_call targets another project; use agent_spawn to delegate within this one.', code: 'self_call' })
      }
      const runId = p.runId?.trim() || newRunId()
      const res = await apiCallProjectAgent(target.id, {
        message: p.message,
        runId,
        wait: p.wait !== false,
        timeoutMs: p.timeoutMs,
        callerProjectId: ctx.projectId,
      })
      if (!res.ok || !res.data) {
        return textResult({
          error: res.error ?? 'Call failed',
          code: res.code,
          status: res.status,
          runId,
          hint: res.code === 'agent_call_timeout' || res.code === 'timeout'
            ? 'The callee is still working. Re-issue with wait=false or a larger timeoutMs; the same runId keeps the trace intact.'
            : undefined,
        })
      }
      const reply = res.data.reply ?? null
      const urls = reply
        ? [...reply.matchAll(/https?:\/\/[^\s<>"')\]]+/g)]
            .map((match) => match[0].replace(/[.,;!?]+$/, ''))
            .filter((url) => url.length > 0)
        : []
      return textResult({
        ok: true,
        project: { id: target.id, name: target.name },
        runId,
        status: res.data.status,
        sessionId: res.data.sessionId,
        reply,
        ...(urls.length > 0
          ? {
              deliverables: urls.map((href) => ({
                type: 'url',
                label: target.name,
                href,
                projectId: target.id,
              })),
            }
          : {}),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// system_apply
// ---------------------------------------------------------------------------

interface ApplyReport {
  ok: boolean
  dryRun: boolean
  manifest: { name: string; projects: number; anchor: string | null }
  plan: string[]
  applied: string[]
  skipped: string[]
  errors: string[]
  manual: string[]
  bindings: Record<string, string>
  empty: boolean
}

export function createSystemApplyTool(ctx: ToolContext): AgentTool {
  return {
    name: 'system_apply',
    label: 'Apply System Manifest',
    description: [
      'Reconcile a `shogo-system.yaml` manifest against the workspace: create missing projects, attach them as declared, set heartbeat/model, and write each project\'s prompt files (AGENTS.md, HEARTBEAT.md, .shogo/agents/*.md).',
      'Idempotent: a second run reports an empty diff. Bindings from manifest key to project id are recorded in .shogo/system.lock.json so renames do not create duplicates.',
      'Run with `dryRun: true` first and show the plan to the user before applying. Channels and integrations are listed under `manual` because they need credentials.',
    ].join(' '),
    parameters: Type.Object({
      manifestPath: Type.Optional(Type.String({ description: `Path relative to the project root (default "${DEFAULT_MANIFEST_PATH}").` })),
      manifest: Type.Optional(Type.String({ description: 'Inline YAML. When given it is used instead of the file and also written to manifestPath.' })),
      dryRun: Type.Optional(Type.Boolean({ description: 'Compute and return the plan without changing anything.' })),
    }),
    execute: async (_id, params) => {
      const p = params as { manifestPath?: string; manifest?: string; dryRun?: boolean }
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()

      const manifestRel = p.manifestPath ?? DEFAULT_MANIFEST_PATH
      if (!isSafeRelativePath(manifestRel)) return textResult({ error: `Unsafe manifestPath "${manifestRel}"` })
      const manifestAbs = resolve(ctx.workspaceDir, manifestRel)

      let source: string
      if (typeof p.manifest === 'string' && p.manifest.trim()) {
        source = p.manifest
      } else if (existsSync(manifestAbs)) {
        source = readFileSync(manifestAbs, 'utf-8')
      } else {
        return textResult({ error: `No manifest at ${manifestRel} and none given inline.`, code: 'manifest_missing' })
      }

      const parsed = parseSystemManifest(source)
      if (!parsed.ok || !parsed.manifest) return textResult({ error: 'Manifest is invalid', issues: parsed.errors })
      const manifest = parsed.manifest

      const graphRes = await apiGetWorkspaceProjectGraph(workspaceId)
      if (!graphRes.ok || !graphRes.data) return textResult({ error: graphRes.error ?? 'Could not read workspace graph', code: graphRes.code })
      const live = toLive(graphRes.data)
      const lock = readLock(ctx)

      const readFile = (projectId: string, path: string): string | null => {
        const dir = resolveProjectDir(ctx, projectId)
        if (!dir) return null
        const abs = resolve(dir, path)
        if (!abs.startsWith(resolve(dir))) return null
        try {
          return existsSync(abs) ? readFileSync(abs, 'utf-8') : null
        } catch {
          return null
        }
      }

      const diff = computeSystemDiff(manifest, live, lock, { callerProjectId: ctx.projectId, readFile })
      const report: ApplyReport = {
        ok: true,
        dryRun: p.dryRun === true,
        manifest: { name: manifest.name, projects: manifest.projects.length, anchor: manifest.anchor ?? null },
        plan: summarizeDiff(diff),
        applied: [],
        skipped: [],
        errors: [],
        manual: diff.manual,
        bindings: {},
        empty: diff.empty,
      }

      const bindings: Record<string, string> = { ...(lock?.bindings ?? {}) }
      for (const a of diff.adopt) bindings[a.key] = a.projectId
      if (manifest.anchor) bindings[manifest.anchor] = ctx.projectId

      if (p.dryRun) {
        report.bindings = bindings
        return textResult(report)
      }

      // Persist the manifest when it came inline so the project carries it.
      if (typeof p.manifest === 'string' && p.manifest.trim()) {
        mkdirSync(dirname(manifestAbs), { recursive: true })
        writeFileSync(manifestAbs, p.manifest, 'utf-8')
      }

      // 1. Creates (no attach yet — edges come from the manifest).
      for (const op of diff.create) {
        const res = await apiCreateProject(workspaceId, {
          name: op.spec.name,
          description: op.spec.description,
          techStackId: op.spec.techStackId,
          workingMode: op.spec.workingMode,
          userId: ctx.userId,
        })
        if (!res.ok || !res.data) {
          report.errors.push(`create ${op.key}: ${res.error ?? 'failed'}${res.code ? ` (${res.code})` : ''}`)
          continue
        }
        bindings[op.key] = res.data.id
        report.applied.push(`create ${op.key} → ${res.data.id}`)
      }

      const idOf = (key: string): string | null => (key === IMPLICIT_ANCHOR ? ctx.projectId : bindings[key] ?? null)

      // 2. Attachments (ordering: caller edges first so files become reachable).
      const attachOps = [...diff.attach].sort((a, b) => Number(b.anchorKey === IMPLICIT_ANCHOR) - Number(a.anchorKey === IMPLICIT_ANCHOR))
      for (const op of attachOps) {
        const anchorId = idOf(op.anchorKey)
        const targetId = idOf(op.targetKey)
        if (!anchorId || !targetId) {
          report.skipped.push(`attach ${op.anchorKey} → ${op.targetKey}: unresolved binding`)
          continue
        }
        const res = await apiAttachProject(anchorId, targetId, op.mode)
        if (!res.ok) report.errors.push(`attach ${op.anchorKey} → ${op.targetKey}: ${res.error ?? 'failed'}`)
        else report.applied.push(`attach ${op.anchorKey} → ${op.targetKey} [${op.mode}]${res.data?.mounted ? ' (mounted)' : ''}`)
      }
      for (const op of diff.detach) {
        const res = await apiDetachProject(op.anchorId, op.targetId)
        if (!res.ok) report.errors.push(`detach ${op.anchorKey} → ${op.targetKey}: ${res.error ?? 'failed'}`)
        else report.applied.push(`detach ${op.anchorKey} → ${op.targetKey}`)
      }

      // 3. Configure (includes freshly created projects, which had no live row).
      const configured = new Set<string>()
      for (const op of diff.configure) {
        const id = idOf(op.key)
        if (!id) { report.skipped.push(`configure ${op.key}: unresolved binding`); continue }
        const res = await apiConfigureProject(id, op.patch)
        if (!res.ok) report.errors.push(`configure ${op.key}: ${res.error ?? 'failed'}`)
        else { report.applied.push(`configure ${op.key}`); configured.add(op.key) }
      }
      for (const op of diff.create) {
        if (configured.has(op.key) || !op.spec.agent) continue
        const id = idOf(op.key)
        if (!id) continue
        const a = op.spec.agent
        const res = await apiConfigureProject(id, {
          agent: {
            modelName: a.model,
            modelProvider: a.provider,
            heartbeatEnabled: a.heartbeat?.enabled,
            heartbeatInterval: a.heartbeat?.interval,
            quietHoursStart: a.heartbeat?.quietHours?.start,
            quietHoursEnd: a.heartbeat?.quietHours?.end,
            quietHoursTimezone: a.heartbeat?.quietHours?.timezone,
          },
        })
        if (!res.ok) report.errors.push(`configure ${op.key}: ${res.error ?? 'failed'}`)
        else report.applied.push(`configure ${op.key}`)
      }

      // 4. Files. Only projects reachable on disk; the rest are reported so
      //    the agent can re-run system_apply after the runtime remounts.
      for (const spec of manifest.projects) {
        const id = idOf(spec.key)
        if (!id) continue
        const entries = Object.entries(spec.files)
        if (entries.length === 0) continue
        const dir = resolveProjectDir(ctx, id)
        if (!dir) {
          report.skipped.push(`files ${spec.key}: project not reachable on disk yet (${entries.length} file(s)); re-run system_apply after the runtime remounts`)
          continue
        }
        for (const [rel, content] of entries) {
          const abs = resolve(dir, rel)
          if (!abs.startsWith(resolve(dir))) { report.errors.push(`files ${spec.key}/${rel}: path escapes project`); continue }
          try {
            const before = existsSync(abs) ? readFileSync(abs, 'utf-8') : null
            if (before === content) continue
            mkdirSync(dirname(abs), { recursive: true })
            writeFileSync(abs, content, 'utf-8')
            report.applied.push(`${before === null ? 'create' : 'update'} ${spec.key}/${rel}`)
          } catch (err: any) {
            report.errors.push(`files ${spec.key}/${rel}: ${err?.message ?? err}`)
          }
        }
      }

      // 5. Lock.
      const finalBindings: Record<string, string> = {}
      for (const spec of manifest.projects) {
        const id = idOf(spec.key)
        if (id) finalBindings[spec.key] = id
      }
      writeLock(ctx, { version: 1, name: manifest.name, bindings: finalBindings })
      report.bindings = finalBindings
      report.ok = report.errors.length === 0
      return textResult(report)
    },
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const PROJECT_TOOL_NAMES = [
  'project_list',
  'project_create',
  'project_attach',
  'project_detach',
  'project_configure',
  'project_call',
  'system_apply',
] as const

/** Read-only tools need no permission gate; the rest are `system` category. */
export function createProjectTools(ctx: ToolContext): { readonly: AgentTool[]; mutating: AgentTool[] } {
  return {
    readonly: [createProjectListTool(ctx)],
    mutating: [
      createProjectCreateTool(ctx),
      createProjectAttachTool(ctx),
      createProjectDetachTool(ctx),
      createProjectConfigureTool(ctx),
      createProjectCallTool(ctx),
      createSystemApplyTool(ctx),
    ],
  }
}

export type { SystemDiff }
