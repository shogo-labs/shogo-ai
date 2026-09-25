// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Project Lifecycle Service
 *
 * Programmatic project create / configure for callers that are not a browser
 * session — today that is the agent runtime, acting on behalf of the user
 * who is chatting with it (see `POST /api/internal/workspaces/:id/projects`).
 *
 * Creation deliberately routes through the same `projectHooks.beforeCreate` /
 * `afterCreate` that the generated `POST /api/projects` route uses, so an
 * agent-created project is indistinguishable from a UI-created one: same
 * membership check, same settings normalization, same `AgentConfig` seeding,
 * same economy-model downgrade for workspaces without advanced model access.
 */

import { prisma } from '../lib/prisma'
import { getMinimumInstanceSize } from '@shogo/shared-runtime'
import { projectHooks, type HookContext } from '../generated/project.hooks'
import { encodeProjectSettingsForWrite, normalizeProjectSettings } from '../lib/project-settings'
import { canRunTechStackOnInstanceSize, hasPaidSubscription } from './billing-runtime'

export type ProjectLifecycleErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'bad_request'
  | 'not_found'
  | 'invalid_working_mode'
  | 'instance_too_small'
  | 'paywall'

export class ProjectLifecycleError extends Error {
  constructor(public code: ProjectLifecycleErrorCode, message: string) {
    super(message)
    this.name = 'ProjectLifecycleError'
  }
}

export interface CreateProjectInput {
  workspaceId: string
  /** User the project is created on behalf of. Must be a workspace member. */
  actingUserId: string
  name: string
  description?: string
  /** Tech stack id from `@shogo-ai/core` TECH_STACK_REGISTRY (e.g. `react-app`). */
  techStackId?: string
  /** `managed` (default, sandboxed workspace) or `external` (folder-linked). */
  workingMode?: 'managed' | 'external'
  /** Agent template id — seeds AgentConfig from the template's settings. */
  templateId?: string
  /** Hidden delegated-builder project. Visible user projects leave this unset. */
  hidden?: boolean
  /** Extra `Project.settings` keys, merged over the defaults derived from `techStackId`. */
  settings?: Record<string, unknown>
}

export interface CreatedProject {
  id: string
  name: string
  description: string | null
  workspaceId: string
  workingMode: string
  settings: unknown
  createdAt: Date
}

function hookCtx(userId: string, body: unknown): HookContext {
  return { body, params: {}, query: {}, userId, prisma }
}

/**
 * Create a project in `workspaceId` on behalf of `actingUserId`.
 *
 * When `techStackId` is given the project is created in canvas code mode for
 * that stack (the same shape the Studio "new project" flow writes); otherwise
 * the hook's chat-only defaults apply.
 */
export async function createProjectInWorkspace(input: CreateProjectInput): Promise<CreatedProject> {
  const name = input.name?.trim()
  if (!name) throw new ProjectLifecycleError('bad_request', 'name is required')
  if (input.workingMode && input.workingMode !== 'managed' && input.workingMode !== 'external') {
    throw new ProjectLifecycleError('invalid_working_mode', `Unknown workingMode "${input.workingMode}"`)
  }

  const settings: Record<string, unknown> | undefined = input.techStackId
    ? {
        activeMode: 'canvas',
        canvasMode: 'code',
        canvasEnabled: true,
        techStackId: input.techStackId,
        ...(input.settings ?? {}),
      }
    : input.settings

  // Delegate-builder projects created inside a `personal` workspace (the
  // companion agent building something on the user's behalf) are always
  // hidden from user-facing lists, regardless of what the caller passed —
  // see the module doc on the `hidden` flag and
  // e2e/personal-shell-hidden-project.test.ts. `team` workspaces only hide a
  // project when explicitly asked (input.hidden).
  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { kind: true },
  })
  const hidden = input.hidden === true || workspace?.kind === 'personal'

  const draft: Record<string, unknown> = {
    workspaceId: input.workspaceId,
    name,
    description: input.description ?? null,
    ...(input.templateId ? { templateId: input.templateId } : {}),
    ...(input.workingMode ? { workingMode: input.workingMode } : {}),
    hidden,
    ...(settings ? { settings } : {}),
  }

  const ctx = hookCtx(input.actingUserId, draft)
  // Routes through the same `beforeCreate` the generated `POST /api/projects`
  // route uses (see module doc), so the Docker-class minimum-instance-size
  // gate applies here too without duplicating the check.
  const before = await projectHooks.beforeCreate!(draft, ctx)
  if (before && !before.ok) {
    const code = (before.error?.code ?? 'bad_request') as ProjectLifecycleErrorCode
    const knownCodes: ProjectLifecycleErrorCode[] = [
      'unauthorized',
      'forbidden',
      'bad_request',
      'instance_too_small',
    ]
    throw new ProjectLifecycleError(
      knownCodes.includes(code) ? code : 'bad_request',
      before.error?.message ?? 'Project creation rejected',
    )
  }
  const data = (before && before.ok && before.data) || draft
  if (data.settings && typeof data.settings === 'object') {
    data.settings = encodeProjectSettingsForWrite(data.settings as Record<string, unknown>)
  }

  const record = (await prisma.project.create({ data: data as any })) as any
  await projectHooks.afterCreate!(record, ctx)

  return {
    id: record.id,
    name: record.name,
    description: record.description ?? null,
    workspaceId: record.workspaceId,
    workingMode: record.workingMode ?? 'managed',
    settings: normalizeProjectSettings(record.settings),
    createdAt: record.createdAt,
  }
}

export interface ConfigureProjectInput {
  name?: string
  description?: string | null
  /** Shallow-merged over the existing `Project.settings`. */
  settings?: Record<string, unknown>
  slackEnabled?: boolean
  agent?: {
    heartbeatEnabled?: boolean
    heartbeatInterval?: number
    modelProvider?: string
    modelName?: string
    quietHoursStart?: string | null
    quietHoursEnd?: string | null
    quietHoursTimezone?: string | null
  }
}

export interface ConfiguredProject {
  id: string
  name: string
  description: string | null
  settings: unknown
  slackEnabled: boolean
  agent: {
    heartbeatEnabled: boolean
    heartbeatInterval: number
    modelProvider: string
    modelName: string
    quietHoursStart: string | null
    quietHoursEnd: string | null
    quietHoursTimezone: string | null
    nextHeartbeatAt: Date | null
  } | null
}

/**
 * Patch the agent-facing configuration of a project: display fields, the
 * `settings` blob (merged), Slack routing, and the `AgentConfig` row
 * (heartbeat + default model). Deliberately excludes publish state, trust
 * level, working mode and billing, which stay behind their own routes.
 */
export async function configureProject(
  projectId: string,
  patch: ConfigureProjectInput,
): Promise<ConfiguredProject> {
  const existing = (await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, settings: true, workspaceId: true },
  })) as { id: string; settings: unknown; workspaceId: string } | null
  if (!existing) throw new ProjectLifecycleError('not_found', `Project ${projectId} not found`)

  if (patch.agent?.heartbeatInterval !== undefined && patch.agent.heartbeatInterval < 60) {
    throw new ProjectLifecycleError('bad_request', 'heartbeatInterval must be at least 60 seconds')
  }

  const projectData: Record<string, unknown> = {}
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new ProjectLifecycleError('bad_request', 'name cannot be empty')
    projectData.name = name
  }
  if (patch.description !== undefined) projectData.description = patch.description
  if (patch.slackEnabled !== undefined) projectData.slackEnabled = patch.slackEnabled
  if (patch.settings) {
    const current = (normalizeProjectSettings(existing.settings) as Record<string, unknown> | null) ?? {}
    // Mirror the generated PATCH /api/projects/:id hook's tier gate: a
    // `configureProject` caller (agent runtime) can flip `techStackId` to a
    // Docker-class stack the same way the UI's settings PATCH can, so it
    // needs the same "does this workspace's instance size afford it?" check.
    const incomingTechStackId = patch.settings.techStackId as string | undefined
    if (incomingTechStackId && getMinimumInstanceSize(incomingTechStackId)) {
      const currentTechStackId = current.techStackId as string | undefined
      if (currentTechStackId !== incomingTechStackId) {
        const { allowed, currentSize, requiredSize } = await canRunTechStackOnInstanceSize(
          existing.workspaceId,
          incomingTechStackId,
        )
        if (!allowed) {
          throw new ProjectLifecycleError(
            'instance_too_small',
            `Switching to this stack requires the ${requiredSize} compute tier or higher ` +
              `(workspace is currently on ${currentSize}). Upgrade compute in Settings > Billing to continue.`,
          )
        }
      }
    }
    projectData.settings = encodeProjectSettingsForWrite({ ...current, ...patch.settings })
  }

  if (Object.keys(projectData).length > 0) {
    await prisma.project.update({ where: { id: projectId }, data: projectData as any })
  }

  if (patch.agent) {
    const a = patch.agent
    const agentData: Record<string, unknown> = {}
    if (a.heartbeatEnabled !== undefined) agentData.heartbeatEnabled = a.heartbeatEnabled
    if (a.heartbeatInterval !== undefined) agentData.heartbeatInterval = a.heartbeatInterval
    if (a.modelProvider !== undefined) agentData.modelProvider = a.modelProvider
    if (a.modelName !== undefined) agentData.modelName = a.modelName
    if (a.quietHoursStart !== undefined) agentData.quietHoursStart = a.quietHoursStart
    if (a.quietHoursEnd !== undefined) agentData.quietHoursEnd = a.quietHoursEnd
    if (a.quietHoursTimezone !== undefined) agentData.quietHoursTimezone = a.quietHoursTimezone

    // Keep the scheduler consistent: enabling schedules the next tick,
    // disabling clears it, and an interval change on an enabled agent
    // reschedules from now.
    const currentAgent = (await prisma.agentConfig.findUnique({
      where: { projectId },
      select: { heartbeatEnabled: true, heartbeatInterval: true },
    })) as { heartbeatEnabled: boolean; heartbeatInterval: number } | null
    const enabledAfter = a.heartbeatEnabled ?? currentAgent?.heartbeatEnabled ?? false
    const intervalAfter = a.heartbeatInterval ?? currentAgent?.heartbeatInterval ?? 1800

    // Mirror the public PATCH /api/projects/:id/heartbeat paywall: enabling
    // (or leaving enabled while patching other fields) requires a paid
    // workspace. Only gate on a rising or steady-enabled edge — disabling
    // must always be allowed regardless of plan.
    if (enabledAfter && !(await hasPaidSubscription(existing.workspaceId))) {
      throw new ProjectLifecycleError(
        'paywall',
        'Heartbeats require a paid plan. Please upgrade to enable scheduled heartbeats.',
      )
    }
    if (a.heartbeatEnabled !== undefined || a.heartbeatInterval !== undefined) {
      agentData.nextHeartbeatAt = enabledAfter ? new Date(Date.now() + intervalAfter * 1000) : null
    }

    await prisma.agentConfig.upsert({
      where: { projectId },
      create: {
        projectId,
        heartbeatEnabled: enabledAfter,
        heartbeatInterval: intervalAfter,
        modelProvider: a.modelProvider ?? 'anthropic',
        modelName: a.modelName ?? 'claude-sonnet-4-6',
        quietHoursStart: a.quietHoursStart ?? null,
        quietHoursEnd: a.quietHoursEnd ?? null,
        quietHoursTimezone: a.quietHoursTimezone ?? null,
        channels: [],
        nextHeartbeatAt: enabledAfter ? new Date(Date.now() + intervalAfter * 1000) : null,
      },
      update: agentData,
    })
  }

  return readProjectConfig(projectId)
}

export async function readProjectConfig(projectId: string): Promise<ConfiguredProject> {
  const project = (await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, description: true, settings: true, slackEnabled: true },
  })) as
    | { id: string; name: string; description: string | null; settings: unknown; slackEnabled: boolean }
    | null
  if (!project) throw new ProjectLifecycleError('not_found', `Project ${projectId} not found`)
  const agent = (await prisma.agentConfig.findUnique({
    where: { projectId },
    select: {
      heartbeatEnabled: true,
      heartbeatInterval: true,
      modelProvider: true,
      modelName: true,
      quietHoursStart: true,
      quietHoursEnd: true,
      quietHoursTimezone: true,
      nextHeartbeatAt: true,
    },
  })) as ConfiguredProject['agent']
  return {
    id: project.id,
    name: project.name,
    description: project.description ?? null,
    settings: normalizeProjectSettings(project.settings),
    slackEnabled: project.slackEnabled,
    agent,
  }
}

/** Projects in a workspace with their attachment edges — the manifest's live state. */
export async function listWorkspaceProjectsWithAttachments(workspaceId: string) {
  const projects = (await prisma.project.findMany({
    where: { workspaceId },
    select: {
      id: true,
      name: true,
      description: true,
      workingMode: true,
      settings: true,
      attachments: { select: { attachedProjectId: true, attachMode: true } },
      agentConfig: { select: { heartbeatEnabled: true, heartbeatInterval: true, modelName: true, modelProvider: true } },
    },
    orderBy: { name: 'asc' },
  })) as any[]
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description ?? null,
    workingMode: p.workingMode ?? 'managed',
    settings: normalizeProjectSettings(p.settings),
    attachments: (p.attachments ?? []).map((a: any) => ({
      attachedProjectId: a.attachedProjectId,
      attachMode: a.attachMode === 'readonly' ? 'readonly' : 'readwrite',
    })),
    agent: p.agentConfig ?? null,
  }))
}
