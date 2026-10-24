// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One reconcile engine for an agent *pack*.
 *
 * A pack is a `shogo-system.yaml`-shaped manifest: an agent project plus the
 * team channels, boards, schedules and triggers that make it a teammate.
 * Two callers use this service and nothing else writes those resources:
 *
 *   - the marketplace install path (`marketplace-install.service`), where a
 *     listing version carries the parsed pack and there is no agent runtime to
 *     ask;
 *   - the built-in pack catalogue (`routes/marketplace` `/packs`).
 *
 * `system_apply` keeps its runtime-side loop for a manifest an agent is
 * editing in place (it needs the project's own files on disk and the caller's
 * identity); both paths run the same parser, the same lock semantics and the
 * same schedule/trigger resolution, so they cannot drift in what they create.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  answerLookup,
  applyAnswersToManifest,
  cardToWorkItemTarget,
  diffSchedules,
  mergeProfileSection,
  normalizeAnswers,
  renderProfileSection,
  resolveScheduleValues,
  substituteTemplates,
  type LiveSchedule,
  type ScheduleOp,
  type ScheduleSpec,
  type SystemLock,
  type SystemManifest,
} from '@shogo/agent-runtime/src/system-manifest'
import { prisma } from '../lib/prisma'
import { getWorkspacesDir } from '../lib/workspaces-dir'
import { configureProject, createProjectInWorkspace } from './project-lifecycle.service'
import { archiveBoard, createBoard, listBoards } from './work-boards.service'
import { listTeamChannels, syncTeamChannelOwnership, upsertTeamChannel } from './conversation-team-channels'
import { createSchedule, deleteSchedule, listSchedules, updateSchedule } from './agent-schedule.service'
import { createSubscription, deleteSubscription, listSubscriptions } from './event-subscription.service'
import { deleteConversation } from './conversation.service'
import { slugify } from './conversation.service'

export interface PackBindings {
  projects: Record<string, string>
  channels: Record<string, string>
  boards: Record<string, string>
  schedules: Record<string, string>
  triggers: Record<string, string>
}

export const emptyBindings = (): PackBindings => ({ projects: {}, channels: {}, boards: {}, schedules: {}, triggers: {} })

export interface PackQuestion {
  id: string
  header: string
  question: string
  type: 'text' | 'choice' | 'multi' | 'confirm'
  options?: string[]
  default?: string | string[] | boolean
  applies?: string
  required?: boolean
}

export interface PackPreview {
  questions: PackQuestion[]
  /** One line per resource the install will create, in apply order. */
  plan: string[]
  /** Things that would be suffixed or refuse, shown before anything is written. */
  conflicts: string[]
  /** Declared channel name → the name it will actually get. */
  channelNames: Record<string, string>
}

export interface ApplyPackResult {
  ok: boolean
  dryRun: boolean
  plan: string[]
  applied: string[]
  skipped: string[]
  errors: string[]
  bindings: PackBindings
  anchorProjectId: string | null
}

export interface ApplyPackArgs {
  workspaceId: string
  manifest: SystemManifest
  answers?: Record<string, unknown>
  actorUserId: string
  /** The listing's project when the install already created one (the pack anchor). */
  anchorProjectId?: string
  /** From a preview, so the name the person saw is the name that is created. */
  channelNames?: Record<string, string>
  /** Bindings from a previous install of the same pack; makes apply update instead of duplicate. */
  bindings?: PackBindings
  dryRun?: boolean
  /** Prefix for board keys the pack declares without one. */
  defaultKeyPrefix?: string
}

function projectDir(projectId: string): string {
  return join(getWorkspacesDir(), projectId)
}

function safeJoin(root: string, rel: string): string | null {
  const abs = resolve(root, rel)
  return abs.startsWith(resolve(root) + '/') ? abs : null
}

function writeProjectFiles(projectId: string, files: Record<string, string>): { written: string[]; errors: string[] } {
  const root = projectDir(projectId)
  const written: string[] = []
  const errors: string[] = []
  for (const [rel, content] of Object.entries(files)) {
    const abs = safeJoin(root, rel)
    if (!abs) {
      errors.push(`${rel}: path escapes the project`)
      continue
    }
    try {
      const before = existsSync(abs) ? readFileSync(abs, 'utf-8') : null
      if (before === content) continue
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content, 'utf-8')
      written.push(`${before === null ? 'create' : 'update'} ${rel}`)
    } catch (err: any) {
      errors.push(`${rel}: ${err?.message ?? err}`)
    }
  }
  return { written, errors }
}

/**
 * Answers rendered into the anchor's `## section`. Returns the file it wrote
 * (if any) so the caller can report it.
 */
function writeProfile(manifest: SystemManifest, anchorId: string, answers?: Record<string, unknown>): string | null {
  const profile = manifest.setup?.profile
  if (!profile || !answers || Object.keys(answers).length === 0) return null
  const rendered = renderProfileSection(manifest.setup, answers)
  if (!rendered) return null
  const abs = safeJoin(projectDir(anchorId), profile.file)
  if (!abs) return null
  try {
    const before = existsSync(abs) ? readFileSync(abs, 'utf-8') : ''
    const after = mergeProfileSection(before, profile.section, rendered)
    if (after === before) return null
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, after, 'utf-8')
    return `update ${profile.file} (workspace profile)`
  } catch {
    return null
  }
}

/** A channel name that is free, or the next `-2`, `-3` … beside a taken one. */
function freeChannelName(wanted: string, taken: Set<string>): string {
  if (!taken.has(wanted)) return wanted
  for (let i = 2; i < 100; i++) {
    const candidate = `${wanted}-${i}`
    if (!taken.has(candidate)) return candidate
  }
  return `${wanted}-${Date.now()}`
}

/** Every name a pack would create that is already used, plus the channels it will rename. */
export async function previewSystemPack(params: {
  workspaceId: string
  manifest: SystemManifest
  answers?: Record<string, unknown>
  anchorProjectId?: string
}): Promise<PackPreview> {
  const { workspaceId } = params
  // One canonical answer set: keyed by `applies` path and by question id, with
  // a skipped question taking its default. Everything below reads this, so the
  // preview shows what the install will actually write.
  const answers = normalizeAnswers(params.manifest.setup, params.answers)
  const manifest = applyAnswersToManifest(params.manifest, answers)
  const conflicts: string[] = []
  const plan: string[] = []

  const liveChannels = await listTeamChannels(workspaceId)
  const takenChannels = new Set(liveChannels.channels.map((c) => c.name))
  const channelNames: Record<string, string> = {}
  for (const ch of manifest.teamChannels) {
    const name = freeChannelName(slugify(ch.name), takenChannels)
    if (name !== slugify(ch.name)) conflicts.push(`#${slugify(ch.name)} is taken → this install will use #${name}`)
    channelNames[ch.name] = name
    takenChannels.add(name)
  }

  const existingProjects = await prisma.project.findMany({
    where: { workspaceId, status: { not: 'archived' } },
    select: { name: true },
  })
  const projectNames = new Set(existingProjects.map((p) => p.name))
  const anchorKey = manifest.anchor ?? manifest.projects[0]?.key
  let creates = 0
  for (const spec of manifest.projects) {
    if (anchorKey === spec.key && params.anchorProjectId) continue
    if (projectNames.has(spec.name)) conflicts.push(`A project named "${spec.name}" already exists`)
    else creates++
    projectNames.add(spec.name)
  }

  const usedPrefixes = new Set(
    (await prisma.board.findMany({ where: { workspaceId }, select: { keyPrefix: true } })).map((b) => b.keyPrefix?.toUpperCase()).filter(Boolean) as string[],
  )
  for (const ch of manifest.teamChannels) {
    for (const b of ch.boards ?? []) {
      if (b.keyPrefix && usedPrefixes.has(b.keyPrefix)) conflicts.push(`Board key prefix ${b.keyPrefix} is taken → this install will be issued a free prefix`)
      if (b.keyPrefix) usedPrefixes.add(b.keyPrefix)
    }
  }

  if (creates) plan.push(`create ${creates} agent project${creates === 1 ? '' : 's'}: ${manifest.projects.filter((p) => manifest.anchor !== p.key).map((p) => p.name).join(', ') || '—'}`)
  const fileCount = manifest.projects.reduce((n, p) => n + Object.keys(p.files).length, 0)
  if (fileCount) plan.push(`write ${fileCount} prompt file${fileCount === 1 ? '' : 's'} (AGENTS.md, HEARTBEAT.md, .shogo/agents/*)`)
  for (const ch of manifest.teamChannels) {
    plan.push(`create channel #${channelNames[ch.name]}${ch.topic ? ` — ${ch.topic}` : ''}`)
    for (const b of ch.boards ?? []) plan.push(`create board #${channelNames[ch.name]} ${b.name}${b.keyPrefix ? ` (${b.keyPrefix})` : ''}`)
  }
  for (const s of manifest.schedules) {
    const values = resolveScheduleValues(s, { answers })
    if (values.error) {
      plan.push(`cannot create schedule "${values.name}" — ${values.error}`)
      continue
    }
    plan.push(`create schedule "${values.name}" (${values.cronExpression} ${values.timezone}${values.channel ? ` → #${values.channel}` : ''}${values.enabled ? '' : ', disabled until you enable it'})`)
  }
  for (const t of manifest.triggers) plan.push(`create trigger "${t.name}" (${t.event})`)
  // Every question is skippable: say which default is standing in for an
  // answer the person has not given, rather than showing an unanswered blank.
  for (const q of manifest.setup?.questions ?? []) {
    const path = q.applies ?? `profile.${q.id}`
    const given = answerLookup(params.answers, path) ?? answerLookup(params.answers, q.id)
    if (given) continue
    if (q.default === undefined) {
      plan.push(`"${q.header}" is skipped — nothing is written for it`)
      continue
    }
    const shown = Array.isArray(q.default) ? q.default.join(', ') : String(q.default)
    plan.push(`"${q.header}" is skipped — the default "${shown}" is used`)
  }
  if (!plan.length) plan.push('nothing to create — everything this pack declares already exists')

  return {
    questions: (manifest.setup?.questions ?? []) as PackQuestion[],
    plan,
    conflicts,
    channelNames,
  }
}

/**
 * The schedule half of an apply, as ops. This is `diffSchedules` — the same
 * function the runtime's `system_apply` runs — fed with the bindings a pack
 * install already has, so the two paths cannot disagree about what a schedule
 * spec becomes. Shared by `applySystemPack` and its parity test.
 */
export function planScheduleOps(args: {
  manifest: SystemManifest
  answers?: Record<string, unknown>
  bindings: PackBindings
  live: LiveSchedule[]
}): ScheduleOp[] {
  const lock: SystemLock = {
    version: 1,
    name: args.manifest.name,
    bindings: { ...args.bindings.projects },
    schedules: Object.fromEntries(
      Object.entries(args.bindings.schedules ?? {})
        .filter(([, id]) => !!id)
        .map(([key, id]) => [key, { id, hash: '' }]),
    ),
  }
  return diffSchedules(args.manifest, args.live, lock, {
    bindings: args.bindings.projects,
    answers: args.answers,
    channelIds: args.bindings.channels,
  })
}

/**
 * Create (or update, when bindings are supplied) everything a pack declares.
 * Dry run returns the same report with nothing written, so the preview shown
 * before an install is produced by the code that performs it.
 */
export async function applySystemPack(args: ApplyPackArgs): Promise<ApplyPackResult> {
  const { workspaceId, actorUserId, dryRun = false } = args
  const answers = normalizeAnswers(args.manifest.setup, args.answers)
  const manifest = applyAnswersToManifest(args.manifest, answers)
  const bindings: PackBindings = {
    projects: { ...(args.bindings?.projects ?? {}) },
    channels: { ...(args.bindings?.channels ?? {}) },
    boards: { ...(args.bindings?.boards ?? {}) },
    schedules: { ...(args.bindings?.schedules ?? {}) },
    triggers: { ...(args.bindings?.triggers ?? {}) },
  }
  const preview = await previewSystemPack({
    workspaceId,
    manifest,
    answers,
    anchorProjectId: args.anchorProjectId,
  })
  const channelNames = { ...preview.channelNames, ...(args.channelNames ?? {}) }
  const result: ApplyPackResult = {
    ok: true,
    dryRun,
    plan: preview.plan,
    applied: [],
    skipped: [],
    errors: [],
    bindings,
    anchorProjectId: args.anchorProjectId ?? null,
  }
  if (dryRun) return result

  // 1. Projects. The anchor may already exist (the listing's project); every
  //    other project is created and configured like a UI-created one.
  const actor = { userId: actorUserId }
  const anchorKey = manifest.anchor ?? manifest.projects[0]?.key
  for (const spec of manifest.projects) {
    const isAnchor = anchorKey === spec.key
    if (isAnchor && args.anchorProjectId) {
      bindings.projects[spec.key] = args.anchorProjectId
      result.anchorProjectId = args.anchorProjectId
      // The listing already created the anchor, but the pack still owns its
      // agent settings — model, capabilities and the quiet hours it asked for.
      if (spec.agent) {
        try {
          await configureProject(args.anchorProjectId, {
            agent: {
              modelName: spec.agent.model,
              modelProvider: spec.agent.provider,
              heartbeatEnabled: spec.agent.heartbeat?.enabled,
              heartbeatInterval: spec.agent.heartbeat?.interval,
              quietHoursStart: spec.agent.heartbeat?.quietHours?.start,
              quietHoursEnd: spec.agent.heartbeat?.quietHours?.end,
              quietHoursTimezone: spec.agent.heartbeat?.quietHours?.timezone,
            },
            ...(spec.agent.capabilities ? { settings: spec.agent.capabilities } : {}),
          })
          result.applied.push(`configure ${spec.key} (agent settings)`)
        } catch (err: any) {
          result.errors.push(`project ${spec.key}: ${err?.message ?? err}`)
        }
      }
      continue
    }
    if (bindings.projects[spec.key]) {
      result.skipped.push(`${spec.key}: already bound to ${bindings.projects[spec.key]}`)
      continue
    }
    try {
      const created = await createProjectInWorkspace({
        workspaceId,
        actingUserId: actorUserId,
        name: spec.name,
        description: spec.description,
        techStackId: spec.techStackId,
        workingMode: spec.workingMode,
        ...(spec.agent?.capabilities ? { settings: spec.agent.capabilities } : {}),
      })
      bindings.projects[spec.key] = created.id
      if (!result.anchorProjectId) result.anchorProjectId = created.id
      result.applied.push(`create ${spec.key} "${spec.name}" → ${created.id}`)
      if (spec.agent) {
        await configureProject(created.id, {
          agent: {
            modelName: spec.agent.model,
            modelProvider: spec.agent.provider,
            heartbeatEnabled: spec.agent.heartbeat?.enabled,
            heartbeatInterval: spec.agent.heartbeat?.interval,
            quietHoursStart: spec.agent.heartbeat?.quietHours?.start,
            quietHoursEnd: spec.agent.heartbeat?.quietHours?.end,
            quietHoursTimezone: spec.agent.heartbeat?.quietHours?.timezone,
          },
          ...(spec.agent.capabilities ? { settings: spec.agent.capabilities } : {}),
        })
      }
    } catch (err: any) {
      result.errors.push(`project ${spec.key}: ${err?.message ?? err}`)
    }
  }

  // 2. Prompt files (answers already substituted by applyAnswersToManifest).
  for (const spec of manifest.projects) {
    const id = bindings.projects[spec.key]
    if (!id) continue
    if (Object.keys(spec.files).length === 0) continue
    const { written, errors } = writeProjectFiles(id, spec.files)
    for (const line of written) result.applied.push(`${spec.key}: ${line}`)
    for (const line of errors) result.errors.push(`${spec.key}: ${line}`)
  }

  // 3. Attachments between pack projects.
  for (const spec of manifest.projects) {
    const anchorId = bindings.projects[spec.key]
    if (!anchorId) continue
    for (const a of spec.attachments ?? []) {
      const targetId = bindings.projects[a.project]
      if (!targetId) continue
      try {
        await prisma.projectAttachment.upsert({
          where: { projectId_attachedProjectId: { projectId: anchorId, attachedProjectId: targetId } },
          create: { projectId: anchorId, attachedProjectId: targetId, attachMode: a.mode },
          update: { attachMode: a.mode },
        })
        result.applied.push(`attach ${spec.key} → ${a.project}`)
      } catch (err: any) {
        result.errors.push(`attach ${spec.key} → ${a.project}: ${err?.message ?? err}`)
      }
    }
  }

  // 4. Channels, then boards inside them.
  const systemProjectId = result.anchorProjectId ?? actorUserId
  for (const ch of manifest.teamChannels) {
    const name = channelNames[ch.name] ?? slugify(ch.name)
    const members = ch.members ?? []
    const agents = members
      .filter((m): m is Extract<typeof m, { project: string }> => 'project' in m)
      .map((m) => ({
        projectId: bindings.projects[m.project] ?? null,
        agentTrigger: m.agentTrigger,
        agentKeywords: m.agentTrigger === 'keyword' ? (m.keywords ?? []).join(', ') || null : null,
        agentContextMode: m.contextMode,
      }))
    const userEmails = members.filter((m): m is Extract<typeof m, { user: string }> => 'user' in m).map((m) => m.user)
    const groupHandles = members.filter((m): m is Extract<typeof m, { group: string }> => 'group' in m).map((m) => m.group)
    try {
      const res = await upsertTeamChannel(
        workspaceId,
        {
          name,
          topic: ch.topic ?? null,
          private: ch.private,
          agents,
          userEmails,
          groupHandles,
          onBehalfOfUserId: actorUserId,
        },
        systemProjectId,
      )
      bindings.channels[ch.name] = res.channel.id
      result.applied.push(`${res.created ? 'create' : 'update'} channel #${name}`)
    } catch (err: any) {
      result.errors.push(`channel #${name}: ${err?.message ?? err}`)
      continue
    }
    for (const board of ch.boards ?? []) {
      const boardKey = `${ch.name}/${board.name}`
      if (bindings.boards[boardKey]) {
        result.skipped.push(`board ${board.name}: already created`)
        continue
      }
      try {
        const created = await createBoard(
          workspaceId,
          {
            name: board.name,
            conversationId: bindings.channels[ch.name],
            itemType: board.itemType,
            description: board.description,
            keyPrefix: board.keyPrefix ?? args.defaultKeyPrefix,
            columns: board.columns?.map((c) => ({
              name: c.name,
              category: c.category,
              wipLimit: c.wipLimit,
              slaHours: c.slaHours,
              agentRef: c.agent === 'workspace' ? 'workspace' : c.agent ? `project:${bindings.projects[c.agent] ?? ''}` : null,
            })),
            fieldsSchema: board.fields,
            postToChannel: board.postToChannel,
            requiresHumanReview: board.requiresHumanReview,
            defaultAssigneeAgentRef: board.defaultAgent === 'workspace' ? 'workspace' : board.defaultAgent ? `project:${bindings.projects[board.defaultAgent] ?? ''}` : null,
            systemManagedBy: systemProjectId,
            managedBy: 'manifest',
          },
          actor,
        )
        bindings.boards[boardKey] = created.id
        result.applied.push(`create board #${name} ${board.name}`)
      } catch (err: any) {
        result.errors.push(`board #${name} ${board.name}: ${err?.message ?? err}`)
      }
    }
  }
  if (manifest.teamChannels.length) {
    try {
      await syncTeamChannelOwnership(workspaceId, systemProjectId, manifest.teamChannels.map((c) => channelNames[c.name] ?? slugify(c.name)))
    } catch {
      // Bookkeeping only; the channels exist either way.
    }
  }

  // 5. Schedules, through the same diff `system_apply` runs. `{{agent.*}}`
  //    resolves to the created project, `channel:` to the conversation id, and
  //    the cron/zone come from the answers, so a run lands where it belongs.
  let liveSchedules: LiveSchedule[] = []
  try {
    liveSchedules = (await listSchedules(workspaceId)) ?? []
  } catch (err: any) {
    result.errors.push(`schedules could not be read: ${err?.message ?? err}`)
  }
  const scheduleOps = planScheduleOps({ manifest, answers, bindings, live: liveSchedules })
  for (const op of scheduleOps) {
    if (op.action === 'delete') {
      if (!op.scheduleId) continue
      try {
        await deleteSchedule(workspaceId, op.scheduleId)
        delete bindings.schedules[op.key]
        result.applied.push(`delete schedule ${op.key}`)
      } catch (err: any) {
        result.errors.push(`schedule ${op.key}: ${err?.message ?? err}`)
      }
      continue
    }
    if (op.error || !op.values) {
      result.errors.push(`schedule ${op.key}: ${op.error ?? 'the spec could not be resolved'}`)
      continue
    }
    const values = op.values
    const notifyConversationId = values.channel ? bindings.channels[values.channel] ?? null : null
    try {
      if (op.action === 'update' && op.scheduleId) {
        await updateSchedule(workspaceId, op.scheduleId, {
          name: values.name,
          prompt: values.prompt,
          cronExpression: values.cronExpression,
          timezone: values.timezone,
          enabled: values.enabled,
          notifyConversationId,
        })
        bindings.schedules[op.key] = op.scheduleId
        result.applied.push(`update schedule ${op.key}`)
      } else {
        const created = await createSchedule({
          workspaceId,
          userId: actorUserId,
          name: values.name,
          prompt: values.prompt,
          cronExpression: values.cronExpression,
          timezone: values.timezone,
          enabled: values.enabled,
          notifyConversationId,
        })
        bindings.schedules[op.key] = created.id
        result.applied.push(`create schedule ${op.key}${notifyConversationId ? '' : ' (no channel — results stay in the agent chat)'}`)
      }
    } catch (err: any) {
      result.errors.push(`schedule ${op.key}: ${err?.message ?? err}`)
    }
  }

  // 6. Triggers.
  for (const spec of manifest.triggers) {
    try {
      const resolvedPrompt = spec.prompt ? substituteTemplates(spec.prompt, { bindings: bindings.projects, answers }) : null
      const targetProjectId = spec.target === 'project' && spec.project ? bindings.projects[spec.project] ?? null : null
      const created = await createSubscription({
        workspaceId,
        ownerUserId: actorUserId,
        name: spec.name,
        eventType: spec.event,
        filter: spec.filter,
        target: spec.target,
        targetProjectId,
        targetMode: spec.mode,
        prompt: resolvedPrompt,
        notifyConversationId: spec.notify ? bindings.channels[spec.notify] ?? null : null,
        triggerConfig: spec.config,
        enabled: spec.enabled,
        policyEditor: actorUserId,
        ...(spec.target === 'work_item' && spec.card ? { workItemTarget: cardToWorkItemTarget(spec.card) } : {}),
      })
      bindings.triggers[spec.key] = created.subscription.id
      result.applied.push(`create trigger ${spec.key}`)
    } catch (err: any) {
      result.errors.push(`trigger ${spec.key}: ${err?.message ?? err}`)
    }
  }

  // 7. Workspace profile from the answers.
  if (result.anchorProjectId) {
    const line = writeProfile(manifest, result.anchorProjectId, args.answers)
    if (line) result.applied.push(line)
  }

  result.ok = result.errors.length === 0
  return result
}

/**
 * Remove exactly what a previous install created. Order matters: the schedule
 * points at a channel, the channels hold the boards, and the projects are
 * referenced by everything else. Anything not in `bindings` is left alone —
 * including a channel the install adopted rather than created.
 */
export async function uninstallSystemPack(params: {
  workspaceId: string
  actorUserId: string
  bindings: Partial<PackBindings> | null | undefined
}): Promise<{ removed: string[]; errors: string[] }> {
  const { workspaceId, actorUserId } = params
  const bindings = params.bindings ?? {}
  const removed: string[] = []
  const errors: string[] = []

  for (const [key, id] of Object.entries(bindings.schedules ?? {})) {
    if (!id) continue
    try {
      const gone = await deleteSchedule(workspaceId, id)
      if (gone) removed.push(`schedule ${key}`)
    } catch (err: any) {
      errors.push(`schedule ${key}: ${err?.message ?? err}`)
    }
  }

  for (const [key, id] of Object.entries(bindings.triggers ?? {})) {
    if (!id) continue
    try {
      await deleteSubscription(workspaceId, id, { allowAppManaged: true })
      removed.push(`trigger ${key}`)
    } catch (err: any) {
      errors.push(`trigger ${key}: ${err?.message ?? err}`)
    }
  }

  for (const [key, id] of Object.entries(bindings.boards ?? {})) {
    if (!id) continue
    const board = await prisma.board.findFirst({ where: { id, workspaceId } })
    if (!board) continue
    try {
      await archiveBoard(board, true)
      removed.push(`board ${key}`)
    } catch (err: any) {
      errors.push(`board ${key}: ${err?.message ?? err}`)
    }
  }

  for (const [name, id] of Object.entries(bindings.channels ?? {})) {
    if (!id) continue
    try {
      // A pack channel is system-managed, which refuses deletion; releasing it
      // first is what a person would do with the same intent.
      await prisma.conversation.update({ where: { id }, data: { systemManagedBy: null } })
      await deleteConversation(id, actorUserId)
      removed.push(`channel #${name}`)
    } catch (err: any) {
      errors.push(`channel #${name}: ${err?.message ?? err}`)
    }
  }

  for (const [key, id] of Object.entries(bindings.projects ?? {})) {
    if (!id) continue
    try {
      await prisma.project.update({ where: { id }, data: { status: 'archived' } })
      removed.push(`project ${key}`)
    } catch (err: any) {
      errors.push(`project ${key}: ${err?.message ?? err}`)
    }
  }

  return { removed, errors }
}

/** Schedules a pack declares, in a shape the preview/UI can show. */
export function packScheduleLines(manifest: SystemManifest): Array<{ key: string; name: string; cron: string; channel: string | null; enabled: boolean }> {
  return manifest.schedules.map((s: ScheduleSpec) => ({
    key: s.key,
    name: s.name,
    cron: s.cron ?? `${s.minute ?? 0} ${s.hour ?? ''} * * ${s.days ?? '*'}`.replace(/\s+/g, ' ').trim(),
    channel: s.channel ?? null,
    enabled: s.enabled,
  }))
}

export { listSchedules }
