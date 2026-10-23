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

import { join, resolve } from 'node:path'
import { prisma } from '../lib/prisma'
import { getMinimumInstanceSize } from '@shogo/shared-runtime'
import { projectHooks, type HookContext } from '../generated/project.hooks'
import { encodeProjectSettingsForWrite, normalizeProjectSettings } from '../lib/project-settings'
import { canRunTechStackOnInstanceSize } from './billing-runtime'
import { HeartbeatConfigError, buildAgentConfigCreateData, updateHeartbeatConfig } from './heartbeat-config.service'
import { readProjectToolUsage } from './tool-usage.service'
import { dockerClassBlockedMessage } from '../lib/runtime-class-setting'

export type ProjectLifecycleErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'bad_request'
  | 'not_found'
  | 'invalid_working_mode'
  | 'working_mode_flip_not_supported'
  | 'durable_repo_external_flip'
  | 'instance_too_small'
  | 'docker_class_disabled'
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
  /**
   * One-way flip to `external` (folder-linked). `external → managed` is
   * refused: turning a folder-linked project back into a sandboxed one has no
   * defined folder semantics, so it stays out of the API until it does.
   */
  workingMode?: 'managed' | 'external'
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
  workingMode: string
  settings: unknown
  slackEnabled: boolean
  /**
   * The project's most-called tools over the last 30 days (SHO-97). The agent
   * runtime keeps these tool definitions advertised on every API call and
   * defers the rest, so this is what makes the advertised set learned rather
   * than a fixed list.
   */
  toolUsage: {
    totalCalls: number
    tools: Array<{ name: string; calls: number }>
  }
  agent: {
    heartbeatEnabled: boolean
    heartbeatInterval: number
    modelProvider: string
    modelName: string
    quietHoursStart: string | null
    quietHoursEnd: string | null
    quietHoursTimezone: string | null
    nextHeartbeatAt: Date | null
    lastHeartbeatAt: Date | null
  } | null
  /**
   * Set when the patch asked for heartbeat changes the workspace's plan does
   * not allow. The rest of the patch was still applied.
   */
  heartbeatError?: { code: 'paywall'; message: string }
}

/**
 * Patch the agent-facing configuration of a project: display fields, the
 * `settings` blob (merged), Slack routing, the `AgentConfig` row (heartbeat +
 * default model) and the one-way `managed → external` working-mode flip
 * (see `flipToExternal`). Publish state, trust level and billing stay behind
 * their own routes.
 */
export async function configureProject(
  projectId: string,
  patch: ConfigureProjectInput,
): Promise<ConfiguredProject> {
  const existing = (await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, settings: true, workspaceId: true, workingMode: true } as any,
  })) as { id: string; settings: unknown; workspaceId: string; workingMode?: string } | null
  if (!existing) throw new ProjectLifecycleError('not_found', `Project ${projectId} not found`)

  if (patch.agent?.heartbeatInterval !== undefined && patch.agent.heartbeatInterval < 60) {
    throw new ProjectLifecycleError('bad_request', 'heartbeatInterval must be at least 60 seconds')
  }
  if (patch.workingMode !== undefined && patch.workingMode !== 'managed' && patch.workingMode !== 'external') {
    throw new ProjectLifecycleError(
      'invalid_working_mode',
      `Unknown workingMode "${patch.workingMode}" (expected "managed" or "external")`,
    )
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
    if (incomingTechStackId) {
      const currentTechStackId = current.techStackId as string | undefined
      if (currentTechStackId !== incomingTechStackId) {
        const dockerBlocked = dockerClassBlockedMessage(incomingTechStackId)
        if (dockerBlocked) {
          throw new ProjectLifecycleError('docker_class_disabled', dockerBlocked)
        }
        if (getMinimumInstanceSize(incomingTechStackId)) {
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
    }
    projectData.settings = encodeProjectSettingsForWrite({ ...current, ...patch.settings })
  }

  if (patch.workingMode !== undefined && patch.workingMode !== (existing.workingMode ?? 'managed')) {
    if (patch.workingMode === 'managed') {
      throw new ProjectLifecycleError(
        'working_mode_flip_not_supported',
        // One-way on purpose: an external project's files are the user's own
        // folders, so there is nothing to move back into a sandboxed
        // workspace and no rule for what would happen to the folder rows.
        "A folder-linked (external) project cannot become managed — its files live in the user's own folders, not in a Shogo workspace.",
      )
    }
    await flipToExternal(projectId)
    projectData.workingMode = 'external'
  }

  if (Object.keys(projectData).length > 0) {
    await prisma.project.update({ where: { id: projectId }, data: projectData as any })
  }

  let heartbeatError: ConfiguredProject['heartbeatError']
  if (patch.agent) {
    const a = patch.agent

    // Row + model columns. Heartbeat columns are owned by the heartbeat config
    // service below (it is the only writer of schedule fields).
    const modelData: Record<string, unknown> = {}
    if (a.modelProvider !== undefined) modelData.modelProvider = a.modelProvider
    if (a.modelName !== undefined) modelData.modelName = a.modelName
    await prisma.agentConfig.upsert({
      where: { projectId },
      create: buildAgentConfigCreateData(projectId, {
        modelProvider: a.modelProvider ?? 'anthropic',
        modelName: a.modelName ?? 'auto',
        channels: [],
      }) as any,
      update: modelData,
    })

    const touchesHeartbeat =
      a.heartbeatEnabled !== undefined ||
      a.heartbeatInterval !== undefined ||
      a.quietHoursStart !== undefined ||
      a.quietHoursEnd !== undefined ||
      a.quietHoursTimezone !== undefined
    if (touchesHeartbeat) {
      try {
        await updateHeartbeatConfig(projectId, {
          heartbeatEnabled: a.heartbeatEnabled,
          heartbeatInterval: a.heartbeatInterval,
          quietHoursStart: a.quietHoursStart,
          quietHoursEnd: a.quietHoursEnd,
          quietHoursTimezone: a.quietHoursTimezone,
        })
      } catch (err) {
        // A free workspace can't schedule heartbeats, but that must not discard
        // the rest of the patch (name, model, ...). Report it back instead.
        if (err instanceof HeartbeatConfigError && err.code === 'paywall') {
          heartbeatError = { code: 'paywall', message: err.message }
        } else if (err instanceof HeartbeatConfigError && err.code === 'invalid_interval') {
          throw new ProjectLifecycleError('bad_request', err.message)
        } else {
          throw err
        }
      }
    }
  }

  const configured = await readProjectConfig(projectId)
  return heartbeatError ? { ...configured, heartbeatError } : configured
}

const PROJECT_ROOT = resolve(import.meta.dir, '../../../..')

/**
 * Where a managed project's files live. Mirrors `getWorkspacesDir()` in
 * `marketplace-install.service` (the pair every files / checkpoint / terminal
 * route builds as `<workspaces>/<projectId>`).
 */
function managedWorkspacePath(projectId: string): string {
  return join(process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces'), projectId)
}

/**
 * Make an existing managed project external.
 *
 * External projects resolve their workspace from `ProjectFolder` rows rather
 * than `workspaces/<projectId>`, so the flip adds a primary row pointing at
 * the folder the project already renders from. Nothing is created, moved or
 * cloned on disk: the files stay exactly where they are and the project opens
 * on them with external semantics (no Shogo-managed git, no checkpoints).
 *
 * Refused when the project has a durable git repo in object storage: that repo
 * is its source of truth and the durable backend does not serve external
 * projects (see `git-http.ts`), so flipping would silently detach it.
 */
async function flipToExternal(projectId: string): Promise<void> {
  const { durableRepoExists } = await import('./git-repo-store')
  if (await durableRepoExists(projectId)) {
    throw new ProjectLifecycleError(
      'durable_repo_external_flip',
      'This project keeps its git history in Shogo-managed durable storage, which folder-linked projects do not use. Export the repo before making the project external.',
    )
  }

  const folders = (await prisma.projectFolder.findMany({
    where: { projectId },
    select: { id: true, isPrimary: true },
  })) as Array<{ id: string; isPrimary: boolean }>
  if (folders.some((folder) => folder.isPrimary)) return
  await prisma.projectFolder.create({
    data: { projectId, path: managedWorkspacePath(projectId), isPrimary: true },
  })
}

export async function readProjectConfig(projectId: string): Promise<ConfiguredProject> {
  const project = (await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, description: true, settings: true, slackEnabled: true, workingMode: true } as any,
  })) as
    | { id: string; name: string; description: string | null; settings: unknown; slackEnabled: boolean; workingMode?: string }
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
      lastHeartbeatAt: true,
    },
  })) as ConfiguredProject['agent']
  const toolUsage = await readProjectToolUsage(projectId)
  return {
    id: project.id,
    name: project.name,
    description: project.description ?? null,
    workingMode: project.workingMode ?? 'managed',
    settings: normalizeProjectSettings(project.settings),
    slackEnabled: project.slackEnabled,
    toolUsage,
    agent,
  }
}

/**
 * Projects in a workspace with their attachment edges — the manifest's live state.
 * `where` further restricts the set (the caller's readable projects).
 */
export async function listWorkspaceProjectsWithAttachments(
  workspaceId: string,
  where?: Record<string, unknown>,
) {
  const projects = (await prisma.project.findMany({
    where: where ? { AND: [{ workspaceId }, where] } : { workspaceId },
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
