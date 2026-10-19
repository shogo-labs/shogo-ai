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
 *   capabilities_configure  enable or disable this project's own capabilities
 *   project_call       run one agent turn in another project, threading a runId
 *   system_apply       reconcile a `shogo-system.yaml` manifest against the workspace
 *
 * All of them go through `/api/internal/...` routes (see internal-api.ts) with
 * the runtime's own token plus the signed requester ticket for the person who
 * started the turn. Lists, creates, attachments and calls are limited to what
 * that person is allowed to do. Nothing here can reach another workspace.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { randomBytes } from 'crypto'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { runChatSessionId } from '@shogo/shared-runtime/project-call-chat'
import {
  CAPABILITY_INFO,
  CAPABILITY_KEYS,
  mergeCapabilitySettingsIntoConfig,
  type CapabilityKey,
  type CapabilitySettings,
} from '@shogo/shared-runtime/capability-settings'
import type { ToolContext } from './gateway-tools'
import { BACKGROUND_TASK_HINT, textResult } from './gateway-tools'
import { trackRemoteTask } from './remote-tasks'
import { capabilityState, effectiveCapabilityValue, lockedCapabilityKeys, resolveRuntimeCapabilities } from './capability-status-prompt'
import { isMetalRuntime } from './remote-tools'
import {
  applyTechStackChange,
  planTechStackChange,
  seedEntries,
  stackChangeRefusalHint,
  type ApplyTechStackChangeResult,
} from './tech-stack-switch'
import { listTechStacks, loadTechStackMeta, resolveWorkspaceConfigFilePath } from './workspace-defaults'
import { isWorkspaceAgentRuntime } from './workspace-runtime-mode'
import { TECH_STACK_REGISTRY } from '@shogo/shared-runtime'
import { availableModelsHint, isAvailableModel } from './available-models'
import { channelIdentity } from './channel-tools'
import {
  agentBoardsRequest,
  createTrigger,
  deleteTrigger,
  listTriggers,
  updateTrigger,
  attachProject as apiAttachProject,
  callProjectAgent as apiCallProjectAgent,
  configureProject as apiConfigureProject,
  createProject as apiCreateProject,
  detachProject as apiDetachProject,
  getProjectConfig as apiGetProjectConfig,
  getWorkspaceProjectGraph as apiGetWorkspaceProjectGraph,
  hasInternalApiCredentials,
  listTeamChannels,
  listWorkspaceProjects as apiListWorkspaceProjects,
  projectScopedId,
  syncTeamChannelOwnership,
  upsertTeamChannel,
  type ProjectGraphNode,
} from './internal-api'
import {
  computeSystemDiff,
  fileSkipWarning,
  IMPLICIT_ANCHOR,
  isSafeRelativePath,
  parseSystemManifest,
  manifestHints,
  resolveAgentRef,
  summarizeDiff,
  type BoardOp,
  type FileProbe,
  type LiveBoard,
  type LiveProject,
  type LiveTrigger,
  type TriggerSpec,
  type LiveTeamChannels,
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

function apiFailure(res: { error?: string; code?: string; status?: number }) {
  const hint =
    res.code === 'requester_required'
      ? 'This turn has no signed requester, so project tools cannot act as a person.'
      : res.code === 'forbidden' || res.code === 'not_found'
        ? 'The requester is not allowed to do that.'
        : undefined
  return textResult({
    error: res.error ?? 'Request failed',
    code: res.code,
    status: res.status,
    ...(hint ? { hint } : {}),
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
export async function resolveProjectRef(
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

function settingsObject(settings: unknown): Record<string, unknown> {
  if (typeof settings === 'string') {
    try { return settingsObject(JSON.parse(settings)) } catch { return {} }
  }
  return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings as Record<string, unknown> : {}
}

function toLive(nodes: ProjectGraphNode[]): LiveProject[] {
  return nodes.map((n) => ({
    id: n.id,
    name: n.name,
    description: n.description,
    workingMode: n.workingMode,
    attachments: n.attachments,
    agent: n.agent,
    capabilities: settingsObject(n.settings),
  }))
}

/** Manifest trigger → the triggers API body. */
function triggerBody(spec: TriggerSpec, idOf: (key: string) => string | null) {
  const card = spec.card
  return {
    name: spec.name,
    filter: spec.filter ?? null,
    prompt: spec.prompt,
    notifyConversationId: spec.notify ?? null,
    enabled: spec.enabled,
    ...(spec.target === 'project' ? { targetProjectId: spec.project ? idOf(spec.project) ?? undefined : undefined, targetMode: spec.mode ?? 'agent' } : {}),
    ...(card ? {
      workItemTarget: {
        board: card.board,
        channel: card.channel,
        column: card.column,
        dedupeKey: card.dedupeKey,
        mapping: {
          title: card.title,
          description: card.description,
          message: card.description,
          priority: card.priority,
          externalRef: card.externalRef,
          dueAt: card.dueAt,
          fields: card.fields,
          stack: card.stack,
          environment: card.environment,
          release: card.release,
          url: card.url,
        },
      },
    } : {}),
  }
}

// ---------------------------------------------------------------------------
// tech-stack catalogue helpers
// ---------------------------------------------------------------------------

interface StackOption {
  id: string
  name: string
  description: string
}

/**
 * The project types an agent can pick. Read from the stack files on disk (the
 * same list `GET /api/tech-stacks` serves, so the tool can never invent an id
 * the runtime doesn't ship); a packaged runtime without the `tech-stacks/`
 * directory falls back to the registry ids.
 */
export function techStackOptions(): StackOption[] {
  const stacks = listTechStacks()
  if (stacks.length > 0) {
    return stacks
      .map((s) => ({ id: s.id, name: s.name, description: s.description ?? '' }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }
  return Object.values(TECH_STACK_REGISTRY)
    .map((s) => ({ id: s.id, name: s.id, description: '' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function techStackCatalogueText(): string {
  return techStackOptions()
    .map((s) => `- "${s.id}" — ${s.name}${s.description ? `: ${s.description}` : ''}`)
    .join('\n')
}

/** `techStackId` stored in `Project.settings`, if any. */
function readStackId(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null
  const id = (settings as Record<string, unknown>).techStackId
  return typeof id === 'string' && id.trim() ? id.trim() : null
}

function unknownStackResult(id: string) {
  return textResult({
    error: `Unknown tech stack "${id}". Pick one of the ids below (or omit techStackId for a chat/agent-only project).`,
    code: 'unknown_tech_stack',
    validTechStackIds: techStackOptions().map((s) => s.id),
    stacks: techStackCatalogueText(),
  })
}

// ---------------------------------------------------------------------------
// project_list
// ---------------------------------------------------------------------------

export function createProjectListTool(ctx: ToolContext): AgentTool {
  return {
    name: 'project_list',
    label: 'List Workspace Projects',
    description:
      'List the projects you can access in this workspace, with each one\'s tech stack (project type), attachments (which projects it can see/edit), agent config (heartbeat, model) and whether it is the current project. Use before project_attach / project_call to find ids.',
    parameters: Type.Object({}),
    execute: async () => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const res = await apiGetWorkspaceProjectGraph(workspaceId)
      if (!res.ok || !res.data) return apiFailure(res)
      const lock = readLock(ctx)
      const keyById = new Map(Object.entries(lock?.bindings ?? {}).map(([k, v]) => [v, k]))
      return textResult({
        workspaceId,
        currentProjectId: ctx.projectId,
        projects: res.data.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          techStackId: readStackId(p.settings),
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
      'Pass `techStackId` to choose the project type — it decides the starter files and the preview; omit it for a prompt-only agent project. The project types this runtime ships:\n' +
        techStackCatalogueText(),
      'In the AGENTS.md you write for it, do not tell it to tag you (or any agent) when it finishes: cards it moves and calls it answers already notify you, and agents that are told to tag back tend to loop.',
    ].join('\n\n'),
    parameters: Type.Object({
      name: Type.String({ description: 'Display name (unique within the workspace is strongly recommended).' }),
      description: Type.Optional(Type.String({ description: 'One or two sentences on what this project/agent is for.' })),
      techStackId: Type.Optional(Type.String({
        description: `Project type — one of: ${techStackOptions().map((s) => s.id).join(', ')}. Omit for a chat/agent-only project.`,
      })),
      templateId: Type.Optional(Type.String({ description: 'Agent template id to seed heartbeat/model from.' })),
      attach: Type.Optional(Type.Boolean({ description: 'Attach the new project to the current one (default true).' })),
      attachMode: Type.Optional(Type.Union([Type.Literal('readwrite'), Type.Literal('readonly')], { description: 'Attachment mode when attaching (default readwrite).' })),
    }),
    execute: async (_id, params) => {
      const p = params as { name: string; description?: string; techStackId?: string; templateId?: string; attach?: boolean; attachMode?: 'readwrite' | 'readonly' }
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()

      // An unknown id used to be accepted silently: `stackSeedsItself()` is
      // false for it, so apps/api copied the default Vite template and the
      // project came up as something nobody asked for.
      const techStackId = p.techStackId?.trim() || undefined
      if (techStackId && !techStackOptions().some((s) => s.id === techStackId)) {
        return unknownStackResult(techStackId)
      }

      const created = await apiCreateProject(workspaceId, {
        name: p.name,
        description: p.description,
        techStackId,
        templateId: p.templateId,
        hidden: ctx.config.capabilityProfile === 'personal',
        userId: ctx.userId,
      })
      if (!created.ok || !created.data) {
        return apiFailure(created)
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
        note: isMetalRuntime()
          ? `Write its files with write_file / edit_file and \`project: "${created.data.id}"\` (they run in that project's own runtime). Write its AGENTS.md next.`
          : mounted
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
    description: isMetalRuntime()
      ? 'Attach an existing workspace project to the current project (readwrite lets you edit it; readonly is for inspection). Its files are not mounted here: work in it with `connect_project` and the `project` parameter of the file and shell tools. Idempotent; re-running with a different mode changes the mode.'
      : 'Attach an existing workspace project to the current project so its files appear as a sibling folder (readwrite lets you edit its prompts; readonly is for inspection). Idempotent; re-running with a different mode changes the mode.',
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
      if (!res.ok || !res.data) return apiFailure(res)
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
      if (!res.ok) return apiFailure(res)
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
      `Read or change a project's agent configuration: heartbeat (enabled/interval/quiet hours), default model, name, description, working mode and project type (\`techStackId\`). Defaults to the current project. Call with no changes to read the current config. \`workingMode: "external"\` makes an existing managed project folder-linked (one-way: it gains a primary folder row pointing at the workspace it already uses, and Shogo stops managing its git). An external project cannot become managed again. Heartbeats require a paid plan: on a free plan the other changes are still applied and the result includes a \`heartbeatError\`.\n\n` +
      `\`techStackId\` switches the project type. A switch that collides with files the project already has is **refused**: nothing is written, and the result carries \`code: "stack_change_needs_reset"\` with the \`collisions\` list and a \`hint\`. Pass \`resetFiles: true\` to delete the current project code first (agent identity, memory, git history and canvas state survive) — that is the only thing that deletes files. A switch into an empty project seeds the new stack and reports what it \`leftInPlace\`. Project types this runtime ships:\n` +
      techStackCatalogueText(),
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: 'Project id, name, or manifest key. Default: current project.' })),
      name: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      workingMode: Type.Optional(Type.String({
        description: '\'external\' turns the project into a folder-linked one (one-way; managed → external only). \'managed\' is only valid for a project that is already managed.',
      })),
      model: Type.Optional(Type.String({ description: `Default model for the agent. Defaults to "auto" (recommended). ${availableModelsHint()}` })),
      provider: Type.Optional(Type.String({ description: 'Model provider (usually inferred).' })),
      heartbeatEnabled: Type.Optional(Type.Boolean()),
      heartbeatInterval: Type.Optional(Type.Number({ description: 'Seconds, minimum 60.' })),
      quietHoursStart: Type.Optional(Type.String({ description: 'HH:MM' })),
      quietHoursEnd: Type.Optional(Type.String({ description: 'HH:MM' })),
      quietHoursTimezone: Type.Optional(Type.String({ description: 'IANA timezone.' })),
      techStackId: Type.Optional(Type.String({
        description: `Project type — one of: ${techStackOptions().map((s) => s.id).join(', ')}. Switches the stack without deleting files unless resetFiles is true.`,
      })),
      resetFiles: Type.Optional(Type.Boolean({
        description: 'With techStackId (or alone, to reset the current stack): delete the project code before seeding. Keeps .shogo/, memory/, .git/ and canvas state. Default false.',
      })),
    }),
    execute: async (_id, params) => {
      const p = params as {
        project?: string; name?: string; description?: string; workingMode?: string; model?: string; provider?: string
        heartbeatEnabled?: boolean; heartbeatInterval?: number
        quietHoursStart?: string; quietHoursEnd?: string; quietHoursTimezone?: string
        techStackId?: string; resetFiles?: boolean
      }
      if (p.workingMode !== undefined && p.workingMode !== 'managed' && p.workingMode !== 'external') {
        return textResult({ error: 'workingMode must be "managed" or "external"' })
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
      if (p.model !== undefined && !isAvailableModel(p.model)) {
        return textResult({ error: `Model "${p.model}" is not available in this workspace. ${availableModelsHint()}` })
      }

      // ── tech stack ────────────────────────────────────────────────────
      // Resolved before the patch so "already on that stack" can be a no-op
      // instead of a pointless write, and so resetFiles alone (reset the
      // current stack) knows which stack that is.
      const wantsStack = p.techStackId !== undefined || p.resetFiles === true
      let stackFrom: string | null = null
      let stackTo: string | null = null
      let stackNoop = false
      if (wantsStack) {
        const requested = p.techStackId?.trim()
        if (requested && !techStackOptions().some((s) => s.id === requested)) {
          return unknownStackResult(requested)
        }
        const current = await apiGetProjectConfig(targetId)
        if (!current.ok || !current.data) return apiFailure(current)
        stackFrom = readStackId(current.data.settings)
        stackTo = requested || stackFrom
        if (!stackTo) {
          return textResult({
            error: 'This project has no project type yet — pass techStackId to pick one.',
            code: 'tech_stack_unknown',
            validTechStackIds: techStackOptions().map((s) => s.id),
          })
        }
        if (stackTo === stackFrom && p.resetFiles !== true) {
          // Already on that stack — nothing to seed. Fall through so any other
          // field in the same call (name, model, heartbeat) still applies.
          stackNoop = true
          stackTo = null
        }
      }

      // ── decide the stack change before writing anything ───────────────
      // A colliding switch is refused with nothing written, so this runs before
      // the settings PATCH: a refusal must not persist `techStackId` (or any
      // other field in the same call) for a project whose files did not change.
      const stackTarget = stackTo
      const stackProjectDir = stackTarget ? resolveProjectDir(ctx, targetId) : null
      let local: ApplyTechStackChangeResult | null = null
      let appliesOnNextStart: { appliesOnNextStart: true; note: string } | null = null
      if (stackTarget) {
        if (stackProjectDir) {
          const plan = planTechStackChange({
            projectDir: stackProjectDir,
            stackId: stackTarget,
            resetFiles: p.resetFiles === true,
          })
          if (plan.needsReset) {
            return textResult({
              ok: false,
              changed: false,
              code: 'stack_change_needs_reset',
              error:
                `Switching to "${stackTarget}" would overwrite ${plan.collisions.length} existing ` +
                `entr${plan.collisions.length === 1 ? 'y' : 'ies'}: ${plan.collisions.join(', ')}. ` +
                `Nothing was changed — settings included.`,
              from: plan.from,
              to: plan.to,
              collisions: plan.collisions,
              leftInPlace: plan.leftInPlace,
              hint: stackChangeRefusalHint(plan),
            })
          }
          local = applyTechStackChange({
            projectDir: stackProjectDir,
            projectId: targetId,
            stackId: stackTarget,
            resetFiles: p.resetFiles === true,
          })
          if (!local.ok) {
            return textResult({
              ok: false,
              changed: false,
              code: local.code,
              error: local.error ?? `Failed to apply project type "${stackTarget}"`,
              collisions: local.collisions,
              leftInPlace: local.leftInPlace,
              ...(local.hint ? { hint: local.hint } : {}),
            })
          }
        } else {
          appliesOnNextStart = {
            appliesOnNextStart: true,
            note:
              `The project's files are not mounted on this runtime, so only its settings changed. ` +
              `They apply when it next starts. If it is a cloud/delegated project, run project_configure again ` +
              `inside it (or ask its agent) to seed "${stackTarget}" into its folder.`,
          }
        }
      }

      const agent: Record<string, unknown> = {}
      if (p.model !== undefined) agent.modelName = p.model
      if (p.provider !== undefined) agent.modelProvider = p.provider
      if (p.heartbeatEnabled !== undefined) agent.heartbeatEnabled = p.heartbeatEnabled
      if (p.heartbeatInterval !== undefined) agent.heartbeatInterval = p.heartbeatInterval
      if (p.quietHoursStart !== undefined) agent.quietHoursStart = p.quietHoursStart
      if (p.quietHoursEnd !== undefined) agent.quietHoursEnd = p.quietHoursEnd
      if (p.quietHoursTimezone !== undefined) agent.quietHoursTimezone = p.quietHoursTimezone

      // The new stack's capability defaults ride along in the same PATCH: a
      // video project with the browser/shell turned off is not a video project.
      const settings: Record<string, unknown> = {}
      if (stackTo && stackTo !== stackFrom) {
        settings.techStackId = stackTo
        const caps = loadTechStackMeta(stackTo)?.capabilities ?? {}
        for (const [key, value] of Object.entries(caps)) {
          if (key in CAPABILITY_INFO && typeof value === 'boolean') settings[key] = value
        }
      }

      const hasChanges =
        p.name !== undefined ||
        p.description !== undefined ||
        p.workingMode !== undefined ||
        Object.keys(agent).length > 0 ||
        Object.keys(settings).length > 0
      const res = hasChanges
        ? await apiConfigureProject(targetId, {
            name: p.name,
            description: p.description,
            workingMode: p.workingMode as 'managed' | 'external' | undefined,
            agent: Object.keys(agent).length > 0 ? (agent as any) : undefined,
            ...(Object.keys(settings).length > 0 ? { settings } : {}),
          })
        : await apiGetProjectConfig(targetId)
      if (!res.ok || !res.data) return apiFailure(res)
      const heartbeatError = res.data.heartbeatError

      // The files were already changed before the PATCH; this only decides what
      // the caller is told about them.
      const stackResult = stackTarget
        ? { from: stackFrom, to: stackTarget, resetFiles: p.resetFiles === true }
        : null

      return textResult({
        ok: true,
        changed: hasChanges || !!stackResult,
        project: res.data,
        ...(stackNoop
          ? {
              techStackId: stackFrom,
              stackNote: `Already on "${stackFrom}" — nothing to re-seed. Pass resetFiles: true to replace the project code with the starter.`,
            }
          : {}),
        ...(stackResult
          ? {
              stack: {
                from: stackResult.from,
                to: stackResult.to,
                resetFiles: stackResult.resetFiles,
                applied: local ? 'local' : 'next-start',
                ...(local
                  ? {
                      seeded: local.seeded,
                      wiped: local.wiped,
                      collisions: local.collisions,
                      leftInPlace: local.leftInPlace,
                      stackDocUpdated: local.stackDocUpdated,
                      previewRestarted: local.previewRestarted,
                      ...(seedEntries(stackResult.to).length === 0
                        ? {
                            note:
                              `"${stackResult.to}" ships no files of its own, so nothing was added or overwritten — ` +
                              `the current project files are untouched and remain the project's code (see leftInPlace). ` +
                              `Pass resetFiles: true to delete them and start from an empty project.`,
                          }
                        : local.leftInPlace.length > 0
                          ? {
                              note:
                                `Left ${local.leftInPlace.length} entr${local.leftInPlace.length === 1 ? 'y' : 'ies'} in place that ` +
                                `"${stackResult.to}" does not write: ${local.leftInPlace.join(', ')}. Pass resetFiles: true to delete them first.`,
                            }
                          : {}),
                    }
                  : {}),
                ...(appliesOnNextStart ?? {}),
              },
            }
          : {}),
        // Partial success: everything but the heartbeat change was applied.
        ...(heartbeatError
          ? { heartbeatError, warning: `Heartbeat settings were not applied: ${heartbeatError.message}` }
          : {}),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// capabilities_configure
// ---------------------------------------------------------------------------

const CAPABILITY_KEY_SET = new Set<string>(CAPABILITY_KEYS)

function capabilityChangesSchema() {
  const properties: Record<string, ReturnType<typeof Type.Optional<ReturnType<typeof Type.Boolean>>>> = {}
  for (const key of CAPABILITY_KEYS) {
    properties[key] = Type.Optional(Type.Boolean({ description: CAPABILITY_INFO[key].label }))
  }
  return Type.Optional(Type.Object(properties, {
    description: 'Flags to set on this project. Omit to read the current state.',
  }))
}

function capabilityStatus(config: ToolContext['config'], changed: boolean) {
  const caps = resolveRuntimeCapabilities(config as unknown as Record<string, unknown>)
  const view = capabilityState(config)
  const resolved: CapabilitySettings = { ...caps }
  for (const key of view.locked) {
    resolved[key] = effectiveCapabilityValue(key, caps, config.capabilityProfile)
  }
  return {
    ok: true,
    changed,
    enabled: view.enabled,
    disabled: view.disabled,
    locked: view.locked,
    capabilities: resolved,
    ...(changed ? { applies: 'next turn' as const } : {}),
  }
}

/**
 * Persist a capability patch into config.json without clobbering flags the
 * patch does not mention. `activeMode` rides along with canvas so the prompt
 * guide matches the toggle.
 */
function writeLocalCapabilityCache(
  workspaceDir: string,
  patch: Partial<CapabilitySettings>,
  activeMode?: 'canvas' | 'none',
): void {
  const configPath = resolveWorkspaceConfigFilePath(workspaceDir, 'config.json')
    ?? join(workspaceDir, 'config.json')
  let fileConfig: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fileConfig = parsed
    } catch {
      fileConfig = {}
    }
  }
  const source = { ...fileConfig, ...patch }
  const { config } = mergeCapabilitySettingsIntoConfig(fileConfig, source)
  if (activeMode) config.activeMode = activeMode
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

export function createCapabilitiesConfigureTool(ctx: ToolContext): AgentTool {
  return {
    name: 'capabilities_configure',
    label: 'Configure Capabilities',
    description:
      'Read or change this project\'s capability toggles (web search, shell, browser, channels, and the rest). Call with no changes to read what is enabled, disabled, or locked. Changes are saved on this project only and apply from your next turn. Locked capabilities cannot be changed.',
    parameters: Type.Object({
      changes: capabilityChangesSchema(),
    }),
    execute: async (_id, params) => {
      const raw = (params as { changes?: unknown }).changes
      if (raw === undefined) return textResult(capabilityStatus(ctx.config, false))
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return textResult({ error: 'changes must be an object of capability flags', code: 'bad_request' })
      }

      const current = resolveRuntimeCapabilities(ctx.config as unknown as Record<string, unknown>)
      const locked = new Set(lockedCapabilityKeys(ctx.config.capabilityProfile))
      const patch: Partial<CapabilitySettings> = {}
      for (const [key, value] of Object.entries(raw)) {
        if (!CAPABILITY_KEY_SET.has(key)) {
          return textResult({ error: `Unknown capability "${key}"`, code: 'unknown_capability' })
        }
        if (typeof value !== 'boolean') {
          return textResult({ error: `${key} must be a boolean`, code: 'bad_request' })
        }
        if (locked.has(key as CapabilityKey)) {
          return textResult({
            error: `${key} is locked by the ${ctx.config.capabilityProfile} workspace profile`,
            code: 'capability_locked',
          })
        }
        patch[key as CapabilityKey] = value
      }
      if (Object.keys(patch).length === 0) return textResult(capabilityStatus(ctx.config, false))

      const currentMode = ctx.config.activeMode || 'canvas'
      let activeMode: 'canvas' | 'none' | undefined
      if (patch.canvasEnabled === false && currentMode !== 'none') activeMode = 'none'
      if (patch.canvasEnabled === true && currentMode !== 'canvas') activeMode = 'canvas'

      const differs = (Object.keys(patch) as CapabilityKey[]).some((key) => patch[key] !== current[key]) || activeMode !== undefined
      if (!differs) return textResult(capabilityStatus(ctx.config, false))

      const settings: Record<string, unknown> = { ...patch }
      if (activeMode) settings.activeMode = activeMode

      const projectId = projectScopedId(ctx.projectId)
      if (projectId && hasInternalApiCredentials()) {
        const res = await apiConfigureProject(projectId, { settings })
        if (!res.ok || !res.data) return apiFailure(res)
      }
      writeLocalCapabilityCache(ctx.workspaceDir, patch, activeMode)
      await ctx.onCapabilitiesChanged?.()

      const nextConfig = {
        ...ctx.config,
        ...patch,
        ...(activeMode ? { activeMode } : {}),
      }
      return textResult(capabilityStatus(nextConfig, true))
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
      'Use `wait: false` for long jobs: the call runs in the background as a task with no time limit (it can take hours) and its reply arrives like any other task result.',
    ].join(' '),
    parameters: Type.Object({
      project: Type.String({ description: 'Target project id, exact name, or manifest key.' }),
      message: Type.String({ description: 'The request. Be explicit about the expected output shape (e.g. JSON findings) — the callee has none of your context.' }),
      runId: Type.Optional(Type.String({ description: 'Pipeline correlation id shared across hops. Minted when omitted.' })),
      wait: Type.Optional(Type.Boolean({ description: 'Wait for the reply (default true).' })),
      timeoutMs: Type.Optional(Type.Number({ description: 'How long a `wait: true` call waits for the reply, in ms (default 300000, max 1200000). It does not limit the callee, and `wait: false` calls ignore it.' })),
    }),
    execute: async (toolCallId, params) => {
      const p = params as { project: string; message: string; runId?: string; wait?: boolean; timeoutMs?: number }
      const target = await resolveProjectRef(ctx, p.project)
      if ('error' in target) return textResult(target)
      if (target.id === ctx.projectId) {
        return textResult({ error: 'project_call targets another project; use agent_spawn to delegate within this one.', code: 'self_call' })
      }
      const runId = p.runId?.trim() || newRunId()
      ctx.uiWriter?.write({
        type: 'tool-output-available',
        toolCallId,
        output: {
          project: { id: target.id, name: target.name },
          runId,
          status: 'running',
          wait: p.wait !== false,
          chatSessionId: runChatSessionId(target.id, runId),
        },
        dynamic: true,
        preliminary: true,
      })
      const background = p.wait === false
      const res = await apiCallProjectAgent(target.id, {
        message: p.message,
        runId,
        wait: !background,
        timeoutMs: p.timeoutMs,
        callerProjectId: ctx.projectId,
        ...(background ? { track: true } : {}),
      })
      if (!res.ok || !res.data) {
        return textResult({
          error: res.error ?? 'Call failed',
          code: res.code,
          status: res.status,
          project: { id: target.id, name: target.name },
          runId,
          hint: res.code === 'agent_call_timeout' || res.code === 'timeout'
            ? 'The callee is still working. Re-issue with wait=false or a larger timeoutMs; the same runId keeps the trace intact.'
            : res.code === 'requester_required'
              ? 'This turn has no signed requester, so project tools cannot act as a person.'
              : res.code === 'forbidden' || res.code === 'not_found'
                ? 'The requester is not allowed to do that.'
                : undefined,
        })
      }
      if (background && res.data.tracked && ctx.commandRegistry && ctx.sessionId) {
        const task = await trackRemoteTask(ctx.commandRegistry, ctx.sessionId, {
          source: 'project_call',
          targetRef: `${target.id}:${runId}`,
          title: `${target.name}: ${p.message.replace(/\s+/g, ' ').slice(0, 80)}`,
          // The callee's own session: pressing the row opens that agent's chat.
          link: {
            kind: 'project_session',
            projectId: target.id,
            name: target.name,
            chatSessionId: res.data.chatSessionId ?? res.data.sessionId ?? undefined,
          },
        })
        if (task) {
          return textResult({
            ok: true,
            project: { id: target.id, name: target.name },
            runId,
            ...task,
            chatSessionId: res.data.chatSessionId ?? res.data.sessionId,
            hint: BACKGROUND_TASK_HINT,
          })
        }
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
        wait: p.wait !== false,
        sessionId: res.data.sessionId,
        chatSessionId: res.data.chatSessionId ?? res.data.sessionId,
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
  /** Left undone for a reason that clears on its own (a project not mounted here yet); `ok` stays true. */
  warnings: string[]
  manual: string[]
  bindings: Record<string, string>
  empty: boolean
}

export function createSystemApplyTool(ctx: ToolContext): AgentTool {
  return {
    name: 'system_apply',
    label: 'Apply System Manifest',
    description: [
      'Reconcile a `shogo-system.yaml` manifest against the workspace: create missing projects, attach them as declared, set heartbeat/model/capabilities, write each project\'s prompt files (AGENTS.md, HEARTBEAT.md, .shogo/agents/*.md), create the `teamChannels` the agents work in with their members and `boards`, and set up `triggers` (including ones that turn events into cards).',
      'Idempotent: a second run reports an empty diff. Bindings from manifest key to project id are recorded in .shogo/system.lock.json so renames do not create duplicates.',
      'This is also how you create a team channel or change one (privacy, topic, members): edit its `teamChannels` entry and apply.',
      'Run with `dryRun: true` first. If the plan does only what the person asked for, apply it; if it changes more, show the plan and ask before applying. Chat integrations and external channels are listed under `manual` because they need credentials.',
      'A project whose folder is not on this runtime yet is reported under `warnings` with `ok: true` (files are skipped, never claimed as created) — re-run after it mounts to finish the job. Real failures are in `errors` with `ok: false`.',
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
      if (!parsed.ok || !parsed.manifest) return textResult({ error: 'Manifest is invalid', issues: parsed.errors, hints: manifestHints(parsed.errors) })
      const manifest = parsed.manifest

      const unavailable = manifest.projects
        .filter((pr) => pr.agent?.model !== undefined && !isAvailableModel(pr.agent.model))
        .map((pr) => `${pr.key}: ${pr.agent?.model}`)
      if (unavailable.length > 0) {
        return textResult({
          error: `Manifest uses models not available in this workspace (${unavailable.join(', ')}). ${availableModelsHint()}`,
          code: 'model_unavailable',
        })
      }

      const graphRes = await apiGetWorkspaceProjectGraph(workspaceId)
      if (!graphRes.ok || !graphRes.data) return apiFailure(graphRes)
      const live = toLive(graphRes.data)
      const lock = readLock(ctx)

      // The graph only returns what this requester can see here. A locked id
      // that exists in the workspace but is not in the graph (not mounted, not
      // visible to this caller) is a configure — never a second copy — so ask
      // the workspace project list before calling anything inaccessible.
      const knownProjectIds = new Set(live.map((p) => p.id))
      const unbound = Object.values(lock?.bindings ?? {}).filter((id) => !knownProjectIds.has(id))
      if (unbound.length > 0) {
        const listRes = await apiListWorkspaceProjects(workspaceId, ctx.userId ? { userId: ctx.userId } : {})
        if (listRes.ok && listRes.data) for (const p of listRes.data) knownProjectIds.add(p.id)
      }

      const readFile = (projectId: string, path: string): FileProbe => {
        const dir = resolveProjectDir(ctx, projectId)
        if (!dir) return { status: 'unmounted' }
        const abs = resolve(dir, path)
        if (!abs.startsWith(resolve(dir))) return { status: 'missing' }
        try {
          return existsSync(abs) ? { status: 'ok', content: readFileSync(abs, 'utf-8') } : { status: 'missing' }
        } catch {
          return { status: 'missing' }
        }
      }

      let teamChannels: LiveTeamChannels | undefined
      if (manifest.teamChannels.length) {
        const res = await listTeamChannels(workspaceId)
        if (res.ok && res.data) teamChannels = res.data
      }

      const work = resolveRuntimeCapabilities(ctx.config as unknown as Record<string, unknown>)
      const boardIdentity = channelIdentity(ctx).projectId
      let boards: LiveBoard[] | undefined
      let boardsUnavailable: string | undefined
      if (manifest.teamChannels.some((c) => c.boards.length)) {
        if (!work.boardsEnabled || !work.boardAdminEnabled) {
          boardsUnavailable = 'board management is off for this agent (turn on Boards and Board Management)'
        } else {
          const res = await agentBoardsRequest<{ boards: LiveBoard[] }>(workspaceId, 'GET', '/agent-boards', { query: { includeArchived: true, projectId: boardIdentity } })
          if (res.ok && res.data) boards = res.data.boards ?? []
          else boardsUnavailable = `boards could not be read (${res.error ?? 'failed'})`
        }
      }
      let triggers: LiveTrigger[] | undefined
      let triggersUnavailable: string | undefined
      if (manifest.triggers.length || Object.keys(lock?.triggers ?? {}).length) {
        if (!work.workTriggersEnabled) triggersUnavailable = 'trigger changes are off for this agent (turn on Triggers)'
        else if (!ctx.userId) triggersUnavailable = 'triggers run as a person, and no one started this run'
        else {
          const res = await listTriggers(workspaceId)
          if (res.ok && res.data) triggers = res.data
          else triggersUnavailable = `triggers could not be read (${res.error ?? 'failed'})`
        }
      }

      const diff = computeSystemDiff(manifest, live, lock, {
        callerProjectId: ctx.projectId,
        readFile,
        knownProjectIds,
        callerIsWorkspaceAgent: isWorkspaceAgentRuntime(),
        teamChannels,
        boards,
        boardsUnavailable,
        triggers,
        triggersUnavailable,
      })
      const report: ApplyReport = {
        ok: true,
        dryRun: p.dryRun === true,
        manifest: { name: manifest.name, projects: manifest.projects.length, anchor: manifest.anchor ?? null },
        plan: summarizeDiff(diff),
        applied: [],
        skipped: [],
        errors: [],
        warnings: [...diff.warnings],
        manual: diff.manual,
        bindings: {},
        empty: diff.empty,
      }

      const bindings: Record<string, string> = { ...(lock?.bindings ?? {}) }
      for (const a of diff.adopt) bindings[a.key] = a.projectId
      if (manifest.anchor) bindings[manifest.anchor] = ctx.projectId
      for (const op of diff.inaccessible) {
        delete bindings[op.key]
        report.errors.push(`${op.key}: not_accessible (bound to ${op.projectId}; this requester cannot see it). Not creating a duplicate.`)
      }

      if (p.dryRun) {
        report.bindings = { ...bindings }
        for (const op of diff.inaccessible) report.bindings[op.key] = op.projectId
        report.ok = report.errors.length === 0
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
        else {
          report.applied.push(`configure ${op.key}`)
          configured.add(op.key)
          if (res.data?.heartbeatError) {
            report.errors.push(`configure ${op.key}: heartbeat not applied (${res.data.heartbeatError.message}); the other settings were applied`)
          }
        }
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
        else {
          report.applied.push(`configure ${op.key}`)
          if (res.data?.heartbeatError) {
            report.errors.push(`configure ${op.key}: heartbeat not applied (${res.data.heartbeatError.message}); the other settings were applied`)
          }
        }
      }

      // 4. Files. Only projects reachable on disk; the rest are skipped with a
      //    warning so the agent re-runs system_apply after the runtime mounts
      //    them — an unreachable file is never reported as a create.
      const warnedFile = new Set(diff.warnings)
      for (const spec of manifest.projects) {
        const id = idOf(spec.key)
        if (!id) continue
        const entries = Object.entries(spec.files)
        if (entries.length === 0) continue
        const dir = resolveProjectDir(ctx, id)
        if (!dir) {
          for (const rel of Object.keys(spec.files)) {
            const line = fileSkipWarning(spec.key, rel)
            if (!warnedFile.has(line)) {
              warnedFile.add(line)
              report.warnings.push(line)
            }
          }
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

      // 5. Team chat channels (after creates, so new projects can be members).
      for (const op of diff.teamChannels) {
        const agents: Array<{ projectId: string | null; agentTrigger: string; agentKeywords: string | null; agentContextMode: string }> = []
        for (const a of op.agents) {
          const id = a.projectId ?? idOf(a.key)
          if (!id) { report.skipped.push(`channel #${op.name}: agent ${a.key} unresolved`); continue }
          agents.push({ projectId: id, agentTrigger: a.agentTrigger, agentKeywords: a.agentKeywords, agentContextMode: a.agentContextMode })
        }
        const res = await upsertTeamChannel(workspaceId, op.name, {
          ...(op.topic !== undefined ? { topic: op.topic } : {}),
          private: op.private,
          agents,
          removeAgentProjectIds: op.removeAgents.map((r) => r.projectId),
          userEmails: op.userEmails,
          groupHandles: op.groupHandles,
          system: ctx.projectId,
          ...(ctx.userId ? { onBehalfOfUserId: ctx.userId } : {}),
        })
        if (!res.ok) report.errors.push(`channel #${op.name}: ${res.error ?? 'failed'}${res.code ? ` (${res.code})` : ''}`)
        else report.applied.push(`${res.data?.created ? 'create' : 'update'} channel #${op.name}`)
      }
      // Declared channels can't be deleted out from under the system; ones this
      // manifest no longer declares can be again. Protection is bookkeeping, so
      // only releases are reported. Not fatal: an older API lacks the endpoint.
      const ownership = await syncTeamChannelOwnership(workspaceId, ctx.projectId, manifest.teamChannels.map((ch) => ch.name))
      if (!ownership.ok) report.skipped.push(`channel ownership: ${ownership.error ?? 'failed'}`)
      else for (const name of ownership.data?.released ?? []) report.applied.push(`release channel #${name}`)

      // 6. Boards (after channels, so they have somewhere to live).
      const appliedBindings: Record<string, string> = {}
      for (const pr of manifest.projects) {
        const id = idOf(pr.key)
        if (id) appliedBindings[pr.key] = id
      }
      const agentRef = (ref: string | null | undefined) => (ref == null ? ref : resolveAgentRef(ref, appliedBindings))
      const columnBody = (v: Record<string, unknown>) => ({ ...v, ...(v.agent !== undefined ? { agent: agentRef(v.agent as string | null) } : {}) })
      for (const op of diff.boards) {
        const failed = await applyBoardOp(workspaceId, op, { system: ctx.projectId, projectId: boardIdentity, sessionId: ctx.sessionId }, agentRef, columnBody)
        if (failed) report.errors.push(`board #${op.channel} ${op.name}: ${failed}`)
        else report.applied.push(`${op.action} board #${op.channel} ${op.name}`)
      }

      // 7. Triggers. Each runs as the person who started this run.
      const triggerLock: Record<string, { id: string; hash: string }> = { ...(lock?.triggers ?? {}) }
      for (const op of diff.triggers) {
        if (!ctx.userId) break
        if (op.action === 'delete') {
          const res = await deleteTrigger(workspaceId, op.triggerId!, ctx.userId)
          if (!res.ok) report.errors.push(`trigger ${op.key}: ${res.error ?? 'delete failed'}`)
          else { delete triggerLock[op.key]; report.applied.push(`delete trigger ${op.key}`) }
          continue
        }
        const spec = op.spec!
        const body = triggerBody(spec, idOf)
        if (op.action === 'update') {
          const res = await updateTrigger(workspaceId, op.triggerId!, { userId: ctx.userId, ...body } as any)
          if (!res.ok) { report.errors.push(`trigger ${op.key}: ${res.error ?? 'update failed'}${res.code ? ` (${res.code})` : ''}`); continue }
          triggerLock[op.key] = { id: op.triggerId!, hash: op.hash! }
          report.applied.push(`update trigger ${op.key}`)
          continue
        }
        if (op.action === 'replace') {
          const res = await deleteTrigger(workspaceId, op.triggerId!, ctx.userId)
          if (!res.ok) { report.errors.push(`trigger ${op.key}: ${res.error ?? 'replace failed'}`); continue }
        }
        const res = await createTrigger(workspaceId, {
          userId: ctx.userId,
          eventType: spec.event,
          target: spec.target,
          triggerConfig: spec.config,
          ...body,
        } as any)
        if (!res.ok || !res.data) {
          report.errors.push(`trigger ${op.key}: ${res.error ?? 'create failed'}${res.code ? ` (${res.code})` : ''}`)
          if (op.action === 'replace') delete triggerLock[op.key]
          continue
        }
        triggerLock[op.key] = { id: res.data.trigger.id, hash: op.hash! }
        report.applied.push(`${op.action} trigger ${op.key}`)
      }

      // 8. Lock.
      const finalBindings: Record<string, string> = {}
      for (const spec of manifest.projects) {
        const id = idOf(spec.key)
        if (id) finalBindings[spec.key] = id
      }
      for (const op of diff.inaccessible) finalBindings[op.key] = op.projectId
      writeLock(ctx, {
        version: 1,
        name: manifest.name,
        bindings: finalBindings,
        ...(Object.keys(triggerLock).length ? { triggers: triggerLock } : {}),
      })
      report.bindings = finalBindings
      report.ok = report.errors.length === 0
      return textResult(report)
    },
  }
}

/** Apply one board op through the agent-boards API; returns an error message, or null. */
async function applyBoardOp(
  workspaceId: string,
  op: BoardOp,
  identity: { system: string; projectId: string | null; sessionId?: string },
  agentRef: (ref: string | null | undefined) => string | null | undefined,
  columnBody: (v: Record<string, unknown>) => Record<string, unknown>,
): Promise<string | null> {
  const who = { projectId: identity.projectId, sessionId: identity.sessionId }
  const values = {
    ...op.values,
    ...(op.values.default_agent !== undefined ? { default_agent: agentRef(op.values.default_agent) } : {}),
    ...(op.values.columns ? { columns: op.values.columns.map((c) => columnBody(c as unknown as Record<string, unknown>)) } : {}),
  }
  if (op.action === 'create') {
    const res = await agentBoardsRequest(workspaceId, 'POST', '/agent-boards', { body: { ...values, name: op.name, channel: op.channel, system: identity.system, ...who } })
    return res.ok ? null : `${res.error ?? 'create failed'}${res.code ? ` (${res.code})` : ''}`
  }
  const board = encodeURIComponent(op.boardId!)
  if (op.action === 'restore') {
    const res = await agentBoardsRequest(workspaceId, 'POST', `/agent-boards/${board}/archive`, { body: { archived: false, ...who } })
    if (!res.ok) return res.error ?? 'restore failed'
  }
  if (Object.keys(values).length) {
    const res = await agentBoardsRequest(workspaceId, 'PATCH', `/agent-boards/${board}`, { body: { ...values, ...who } })
    if (!res.ok) return res.error ?? 'update failed'
  }
  for (const col of op.columns) {
    const body = { ...columnBody(col.values as Record<string, unknown>), ...(col.after ? { after: col.after } : {}), ...who }
    const res = col.action === 'create'
      ? await agentBoardsRequest(workspaceId, 'POST', `/agent-boards/${board}/columns`, { body: { ...body, name: col.column } })
      : await agentBoardsRequest(workspaceId, 'PATCH', `/agent-boards/${board}/columns/${encodeURIComponent(col.column)}`, { body })
    if (!res.ok) return `column ${col.column}: ${res.error ?? 'failed'}`
  }
  return null
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
  'capabilities_configure',
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
      createCapabilitiesConfigureTool(ctx),
      createProjectCallTool(ctx),
      createSystemApplyTool(ctx),
    ],
  }
}

export type { SystemDiff }
