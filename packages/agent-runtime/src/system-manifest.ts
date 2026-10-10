// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `shogo-system.yaml` — declarative composition of a multi-project agent
 * system inside one workspace.
 *
 * `.shogo-project` is the per-module archive; this manifest is the `go.mod`:
 * it names the projects (modules), how they attach to each other, what each
 * agent's heartbeat/model looks like, and which prompt files each project
 * carries. `system_apply` (project-tools.ts) reads it, diffs it against the
 * live workspace graph, and applies the difference idempotently.
 *
 * Binding between manifest keys and live project ids is recorded in
 * `.shogo/system.lock.json` next to the manifest (the `go.sum` analog). When
 * a key has no lock entry the live project with the exact same name is
 * adopted; otherwise the project is created.
 *
 * This module is pure: schema, validation and diff. No I/O.
 */

import { z } from 'zod'
import { parse as parseYaml } from 'yaml'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export const AttachModeSchema = z.enum(['readwrite', 'readonly'])

export const QuietHoursSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM'),
  end: z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM'),
  timezone: z.string().optional(),
})

export const HeartbeatSpecSchema = z.object({
  enabled: z.boolean().optional(),
  /** Seconds; minimum 60. */
  interval: z.number().int().min(60).optional(),
  quietHours: QuietHoursSchema.optional(),
})

export const AgentSpecSchema = z.object({
  /** Model id or alias (e.g. `claude-haiku-4-5`, `sonnet`). */
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  heartbeat: HeartbeatSpecSchema.optional(),
})

export const AttachmentSpecSchema = z.object({
  /** Key of another project in this manifest. */
  project: z.string().regex(KEY_RE),
  mode: AttachModeSchema.default('readwrite'),
})

export const ProjectSpecSchema = z.object({
  key: z.string().regex(KEY_RE, 'lowercase letters, digits and hyphens'),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  /** `TECH_STACK_REGISTRY` id from @shogo-ai/core (e.g. `react-app`). */
  techStackId: z.string().optional(),
  workingMode: z.enum(['managed', 'external']).optional(),
  agent: AgentSpecSchema.optional(),
  attachments: z.array(AttachmentSpecSchema).default([]),
  /**
   * Files written into the project's workspace, keyed by relative path
   * (`AGENTS.md`, `HEARTBEAT.md`, `.shogo/agents/reviewer.md`, ...).
   * Paths must stay inside the project.
   */
  files: z.record(z.string(), z.string()).default({}),
  /** Advisory: channels to connect by hand (need credentials). */
  channels: z.array(z.string()).default([]),
  /** Advisory: Composio / MCP integrations to connect by hand. */
  integrations: z.array(z.string()).default([]),
})

const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/

export const AgentTriggerSchema = z.enum(['mention', 'all', 'keyword', 'auto'])

/** `isolated` agents (e.g. a reviewer) see only the hand-off, the task's criteria and links, never the discussion. */
export const AgentContextModeSchema = z.enum(['shared', 'isolated'])

/** One member of a team channel: a manifest project's agent, a group (by handle) or a person (by email). */
export const TeamChannelMemberSchema = z.union([
  z.object({
    project: z.string().regex(KEY_RE),
    agentTrigger: AgentTriggerSchema.default('mention'),
    keywords: z.array(z.string().min(1)).optional(),
    contextMode: AgentContextModeSchema.default('shared'),
  }).strict(),
  z.object({ group: z.string().min(1).transform((h) => h.replace(/^@/, '')) }).strict(),
  z.object({ user: z.string().email().transform((e) => e.toLowerCase()) }).strict(),
])

export const TeamChannelSpecSchema = z.object({
  name: z.string().transform((n) => n.replace(/^#/, '')).pipe(z.string().regex(CHANNEL_NAME_RE, 'lowercase letters, digits, - and _')),
  topic: z.string().max(500).optional(),
  private: z.boolean().default(false),
  members: z.array(TeamChannelMemberSchema).default([]),
})

export const SystemManifestSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(120),
  description: z.string().max(4000).optional(),
  /**
   * Key of the project that owns this manifest (the one running
   * `system_apply`). When set, that key binds to the calling project and the
   * manifest may describe its files/config/attachments like any other. When
   * absent, the calling project is implicit and is attached read-write to
   * every project in the manifest so it can manage them.
   */
  anchor: z.string().regex(KEY_RE).optional(),
  projects: z.array(ProjectSpecSchema).min(1),
  /**
   * Workspace team chat channels the system works in, with their members.
   * Distinct from a project's `channels` (Slack/Telegram/... connections).
   */
  teamChannels: z.array(TeamChannelSpecSchema).default([]),
})

export type SystemManifest = z.infer<typeof SystemManifestSchema>
export type ProjectSpec = z.infer<typeof ProjectSpecSchema>
export type AttachMode = z.infer<typeof AttachModeSchema>
export type TeamChannelSpec = z.infer<typeof TeamChannelSpecSchema>
export type AgentTrigger = z.infer<typeof AgentTriggerSchema>
export type AgentContextMode = z.infer<typeof AgentContextModeSchema>

export interface ManifestParseResult {
  ok: boolean
  manifest?: SystemManifest
  errors: string[]
}

/** Reject `..`, absolute paths and anything that would escape the project. */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) return false
  const parts = p.split(/[\\/]+/)
  return parts.every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

/** Parse + validate YAML (or an already-parsed object). Cross-references are checked too. */
export function parseSystemManifest(source: string | unknown): ManifestParseResult {
  let raw: unknown = source
  if (typeof source === 'string') {
    try {
      raw = parseYaml(source)
    } catch (err: any) {
      return { ok: false, errors: [`YAML parse error: ${err?.message ?? err}`] }
    }
  }
  const parsed = SystemManifestSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    }
  }
  const manifest = parsed.data
  const errors: string[] = []
  const keys = new Set<string>()
  for (const p of manifest.projects) {
    if (keys.has(p.key)) errors.push(`duplicate project key "${p.key}"`)
    keys.add(p.key)
  }
  for (const p of manifest.projects) {
    for (const a of p.attachments) {
      if (a.project === p.key) errors.push(`${p.key}: cannot attach to itself`)
      else if (!keys.has(a.project)) errors.push(`${p.key}: attachment references unknown key "${a.project}"`)
    }
    for (const path of Object.keys(p.files)) {
      if (!isSafeRelativePath(path)) errors.push(`${p.key}: unsafe file path "${path}"`)
    }
  }
  const channelNames = new Set<string>()
  for (const ch of manifest.teamChannels) {
    if (channelNames.has(ch.name)) errors.push(`duplicate team channel "${ch.name}"`)
    channelNames.add(ch.name)
    const agents = new Set<string>()
    for (const m of ch.members) {
      if (!('project' in m)) continue
      if (!keys.has(m.project)) errors.push(`teamChannels.${ch.name}: member references unknown key "${m.project}"`)
      if (agents.has(m.project)) errors.push(`teamChannels.${ch.name}: "${m.project}" is listed twice`)
      agents.add(m.project)
      if (m.agentTrigger === 'keyword' && !m.keywords?.length) errors.push(`teamChannels.${ch.name}: "${m.project}" uses agentTrigger keyword without keywords`)
    }
  }
  if (manifest.anchor && !keys.has(manifest.anchor)) {
    errors.push(`anchor "${manifest.anchor}" is not a project key`)
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, manifest, errors: [] }
}

// ---------------------------------------------------------------------------
// Live state + diff
// ---------------------------------------------------------------------------

export interface LiveProject {
  id: string
  name: string
  description: string | null
  attachments: Array<{ attachedProjectId: string; attachMode: AttachMode }>
  agent: { heartbeatEnabled: boolean; heartbeatInterval: number; modelName: string; modelProvider: string } | null
}

/** `.shogo/system.lock.json` — manifest key → live project id. */
export interface SystemLock {
  version: 1
  name: string
  bindings: Record<string, string>
}

export interface CreateOp { kind: 'create'; key: string; spec: ProjectSpec }
export interface AdoptOp { kind: 'adopt'; key: string; projectId: string; reason: 'lock' | 'name' | 'anchor' }
/** Lock points at a project the caller cannot see. Do not create a second one. */
export interface InaccessibleOp { kind: 'inaccessible'; key: string; projectId: string }
export interface ConfigureOp {
  kind: 'configure'
  key: string
  projectId: string | null
  patch: {
    description?: string
    agent?: {
      heartbeatEnabled?: boolean
      heartbeatInterval?: number
      modelName?: string
      modelProvider?: string
      quietHoursStart?: string
      quietHoursEnd?: string
      quietHoursTimezone?: string
    }
  }
}
export interface AttachOp {
  kind: 'attach'
  anchorKey: string
  anchorId: string | null
  targetKey: string
  targetId: string | null
  mode: AttachMode
  /** true when the edge exists with a different mode. */
  changeMode: boolean
}
export interface DetachOp { kind: 'detach'; anchorKey: string; anchorId: string; targetKey: string; targetId: string }
export interface FileOp { kind: 'file'; key: string; projectId: string | null; path: string; action: 'create' | 'update' | 'unchanged' }

/** Live team chat channel, as returned by the agent-channels `team-channels` route. */
export interface LiveTeamChannel {
  name: string
  topic: string | null
  private: boolean
  agents: Array<{ projectId: string | null; agentTrigger: string; agentKeywords: string | null; agentContextMode?: string }>
  userEmails: string[]
}

export interface LiveTeamChannels {
  channels: LiveTeamChannel[]
  /** Group handle → member emails. */
  groups: Record<string, string[]>
}

export interface TeamChannelAgentOp {
  key: string
  /** null until the project is created earlier in the same apply. */
  projectId: string | null
  agentTrigger: AgentTrigger
  agentKeywords: string | null
  agentContextMode: AgentContextMode
}

export interface TeamChannelOp {
  kind: 'team_channel'
  name: string
  action: 'create' | 'update'
  topic?: string
  private: boolean
  /** Agent members to add or re-trigger. */
  agents: TeamChannelAgentOp[]
  /** Manifest-managed agents that are members but no longer declared. */
  removeAgents: Array<{ key: string; projectId: string }>
  userEmails: string[]
  groupHandles: string[]
  /** One-line descriptions of each change, for summaries. */
  changes: string[]
}

export interface SystemDiff {
  adopt: AdoptOp[]
  inaccessible: InaccessibleOp[]
  create: CreateOp[]
  configure: ConfigureOp[]
  attach: AttachOp[]
  detach: DetachOp[]
  files: FileOp[]
  teamChannels: TeamChannelOp[]
  /** Things `system_apply` cannot do without credentials — surfaced for the user. */
  manual: string[]
  /** True when nothing needs to change. */
  empty: boolean
}

export interface DiffOptions {
  /** Project id of the runtime running the apply. Binds to `manifest.anchor`. */
  callerProjectId: string
  /** Reader for current file contents inside a bound project; `null` = missing / unreadable. */
  readFile?: (projectId: string, path: string) => string | null
  /** Current team chat channels; when omitted, `teamChannels` are reported as manual steps. */
  teamChannels?: LiveTeamChannels
}

const IMPLICIT_ANCHOR_KEY = '__caller__'

/**
 * Resolve manifest key → live id using, in order: the anchor rule, the lock,
 * exact-name match against live projects. Keys left unbound are creates.
 */
export function resolveBindings(
  manifest: SystemManifest,
  live: LiveProject[],
  lock: SystemLock | null,
  callerProjectId: string,
): { bindings: Record<string, string>; adopt: AdoptOp[]; inaccessible: InaccessibleOp[] } {
  const bindings: Record<string, string> = {}
  const adopt: AdoptOp[] = []
  const inaccessible: InaccessibleOp[] = []
  const liveIds = new Set(live.map((p) => p.id))
  const byName = new Map<string, LiveProject[]>()
  for (const p of live) {
    const arr = byName.get(p.name) ?? []
    arr.push(p)
    byName.set(p.name, arr)
  }

  for (const spec of manifest.projects) {
    if (manifest.anchor === spec.key) {
      bindings[spec.key] = callerProjectId
      if (lock?.bindings[spec.key] !== callerProjectId) adopt.push({ kind: 'adopt', key: spec.key, projectId: callerProjectId, reason: 'anchor' })
      continue
    }
    const locked = lock?.bindings[spec.key]
    if (locked && liveIds.has(locked)) {
      bindings[spec.key] = locked
      continue
    }
    if (locked) {
      inaccessible.push({ kind: 'inaccessible', key: spec.key, projectId: locked })
      continue
    }
    const candidates = byName.get(spec.name) ?? []
    // Only adopt by name when it is unambiguous and not already claimed.
    const taken = new Set(Object.values(bindings))
    const free = candidates.filter((c) => !taken.has(c.id) && c.id !== callerProjectId)
    if (free.length === 1) {
      bindings[spec.key] = free[0].id
      adopt.push({ kind: 'adopt', key: spec.key, projectId: free[0].id, reason: 'name' })
    }
  }
  return { bindings, adopt, inaccessible }
}

function agentPatch(spec: ProjectSpec, live: LiveProject | null): ConfigureOp['patch']['agent'] | undefined {
  const a = spec.agent
  if (!a) return undefined
  const patch: NonNullable<ConfigureOp['patch']['agent']> = {}
  if (a.model !== undefined && a.model !== live?.agent?.modelName) patch.modelName = a.model
  if (a.provider !== undefined && a.provider !== live?.agent?.modelProvider) patch.modelProvider = a.provider
  if (a.heartbeat) {
    if (a.heartbeat.enabled !== undefined && a.heartbeat.enabled !== live?.agent?.heartbeatEnabled) {
      patch.heartbeatEnabled = a.heartbeat.enabled
    }
    if (a.heartbeat.interval !== undefined && a.heartbeat.interval !== live?.agent?.heartbeatInterval) {
      patch.heartbeatInterval = a.heartbeat.interval
    }
    if (a.heartbeat.quietHours) {
      // Quiet hours are not in the live graph snapshot; always send them
      // (the API upsert is idempotent).
      patch.quietHoursStart = a.heartbeat.quietHours.start
      patch.quietHoursEnd = a.heartbeat.quietHours.end
      if (a.heartbeat.quietHours.timezone) patch.quietHoursTimezone = a.heartbeat.quietHours.timezone
    }
  }
  return Object.keys(patch).length > 0 ? patch : undefined
}

/**
 * Compute what `system_apply` must do. Pure. Creates are always followed by
 * a configure (so a fresh project gets its agent settings) and by file
 * writes; attachments to not-yet-created projects carry `targetId: null`
 * and are resolved after creation.
 */
export function computeSystemDiff(
  manifest: SystemManifest,
  live: LiveProject[],
  lock: SystemLock | null,
  opts: DiffOptions,
): SystemDiff {
  const { bindings, adopt, inaccessible } = resolveBindings(manifest, live, lock, opts.callerProjectId)
  const liveById = new Map(live.map((p) => [p.id, p]))
  const blocked = new Set(inaccessible.map((op) => op.key))

  const create: CreateOp[] = []
  const configure: ConfigureOp[] = []
  const attach: AttachOp[] = []
  const detach: DetachOp[] = []
  const files: FileOp[] = []
  const manual: string[] = []

  for (const spec of manifest.projects) {
    if (blocked.has(spec.key)) continue
    const id = bindings[spec.key] ?? null
    const liveProject = id ? liveById.get(id) ?? null : null
    if (!id) create.push({ kind: 'create', key: spec.key, spec })

    const patch: ConfigureOp['patch'] = {}
    if (spec.description !== undefined && (!liveProject || liveProject.description !== spec.description) && id) {
      // Description is passed at create time; only patch existing projects.
      patch.description = spec.description
    }
    const agent = agentPatch(spec, liveProject)
    if (agent) patch.agent = agent
    if (Object.keys(patch).length > 0) configure.push({ kind: 'configure', key: spec.key, projectId: id, patch })

    for (const a of spec.attachments) {
      const targetId = bindings[a.project] ?? null
      const existing = liveProject?.attachments.find((e) => e.attachedProjectId === targetId)
      if (existing && existing.attachMode === a.mode) continue
      attach.push({
        kind: 'attach',
        anchorKey: spec.key,
        anchorId: id,
        targetKey: a.project,
        targetId,
        mode: a.mode,
        changeMode: Boolean(existing),
      })
    }

    // Edges between two manifest-managed projects that the manifest no
    // longer declares are removed. Edges to projects outside the manifest
    // are left alone — they belong to the user.
    if (liveProject) {
      const declared = new Set(spec.attachments.map((a) => bindings[a.project]).filter(Boolean))
      const managedIds = new Map(Object.entries(bindings).map(([k, v]) => [v, k]))
      for (const e of liveProject.attachments) {
        if (managedIds.has(e.attachedProjectId) && !declared.has(e.attachedProjectId)) {
          detach.push({
            kind: 'detach',
            anchorKey: spec.key,
            anchorId: liveProject.id,
            targetKey: managedIds.get(e.attachedProjectId)!,
            targetId: e.attachedProjectId,
          })
        }
      }
    }

    for (const [path, content] of Object.entries(spec.files)) {
      const current = id && opts.readFile ? opts.readFile(id, path) : null
      const action: FileOp['action'] = current === null ? 'create' : current === content ? 'unchanged' : 'update'
      files.push({ kind: 'file', key: spec.key, projectId: id, path, action })
    }

    for (const ch of spec.channels) manual.push(`${spec.key}: connect channel "${ch}" (channel_connect needs credentials)`)
    for (const integ of spec.integrations) manual.push(`${spec.key}: connect integration "${integ}" (Composio / MCP auth)`)
  }

  // Implicit anchor: the caller manages every manifest project read-write.
  if (!manifest.anchor) {
    const caller = liveById.get(opts.callerProjectId) ?? null
    for (const spec of manifest.projects) {
      if (blocked.has(spec.key)) continue
      const targetId = bindings[spec.key] ?? null
      const existing = caller?.attachments.find((e) => e.attachedProjectId === targetId)
      if (existing && existing.attachMode === 'readwrite') continue
      attach.push({
        kind: 'attach',
        anchorKey: IMPLICIT_ANCHOR_KEY,
        anchorId: opts.callerProjectId,
        targetKey: spec.key,
        targetId,
        mode: 'readwrite',
        changeMode: Boolean(existing),
      })
    }
  }

  const teamChannels = opts.teamChannels
    ? diffTeamChannels(manifest, bindings, opts.teamChannels, manual)
    : []
  if (!opts.teamChannels && manifest.teamChannels.length) {
    manual.push(`teamChannels: team chat is not reachable from this runtime; create ${manifest.teamChannels.map((c) => `#${c.name}`).join(', ')} by hand`)
  }

  const empty =
    teamChannels.length === 0 &&
    create.length === 0 &&
    configure.length === 0 &&
    attach.length === 0 &&
    detach.length === 0 &&
    files.every((f) => f.action === 'unchanged')

  return { adopt, inaccessible, create, configure, attach, detach, files, teamChannels, manual, empty }
}

function keywordsOf(member: { keywords?: string[] }): string | null {
  return member.keywords?.length ? member.keywords.map((k) => k.trim()).filter(Boolean).join(', ') : null
}

function sameKeywords(a: string | null, b: string | null): boolean {
  const norm = (v: string | null) => (v ?? '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean).sort().join(',')
  return norm(a) === norm(b)
}

/** Channel create/update ops. People are only added; agent members of manifest projects are fully managed. */
export function diffTeamChannels(
  manifest: SystemManifest,
  bindings: Record<string, string>,
  live: LiveTeamChannels,
  manual: string[] = [],
): TeamChannelOp[] {
  const ops: TeamChannelOp[] = []
  const byName = new Map(live.channels.map((c) => [c.name, c]))
  const managedKeys = new Map(Object.entries(bindings).map(([k, v]) => [v, k]))
  for (const spec of manifest.teamChannels) {
    const current = byName.get(spec.name) ?? null
    const changes: string[] = []
    const agents: TeamChannelAgentOp[] = []
    const userEmails: string[] = []
    const groupHandles: string[] = []
    const members = new Set((current?.userEmails ?? []).map((e) => e.toLowerCase()))
    const declared = new Set<string>()

    for (const m of spec.members) {
      if ('project' in m) {
        const projectId = bindings[m.project] ?? null
        if (projectId) declared.add(projectId)
        const agentKeywords = m.agentTrigger === 'keyword' ? keywordsOf(m) : null
        const existing = projectId ? current?.agents.find((a) => a.projectId === projectId) : undefined
        if (
          existing &&
          existing.agentTrigger === m.agentTrigger &&
          sameKeywords(existing.agentKeywords, agentKeywords) &&
          (existing.agentContextMode ?? 'shared') === m.contextMode
        ) continue
        agents.push({ key: m.project, projectId, agentTrigger: m.agentTrigger, agentKeywords, agentContextMode: m.contextMode })
        changes.push(`${existing ? 'retrigger' : 'add'} agent ${m.project} (${m.agentTrigger}${m.contextMode === 'isolated' ? ', isolated' : ''})`)
      } else if ('group' in m) {
        const emails = live.groups[m.group]
        if (!emails) {
          manual.push(`teamChannels.${spec.name}: group @${m.group} does not exist yet; create it, then re-run system_apply`)
          continue
        }
        if (emails.some((e) => !members.has(e.toLowerCase()))) {
          groupHandles.push(m.group)
          changes.push(`add group @${m.group}`)
        }
      } else if (!members.has(m.user)) {
        userEmails.push(m.user)
        changes.push(`add ${m.user}`)
      }
    }

    const removeAgents: TeamChannelOp['removeAgents'] = []
    for (const a of current?.agents ?? []) {
      const key = a.projectId ? managedKeys.get(a.projectId) : undefined
      if (key && !declared.has(a.projectId!)) {
        removeAgents.push({ key, projectId: a.projectId! })
        changes.push(`remove agent ${key}`)
      }
    }

    const topicChanged = spec.topic !== undefined && (current?.topic ?? null) !== spec.topic
    if (current && topicChanged) changes.push('topic')
    const privacyChanged = !!current && current.private !== spec.private
    if (privacyChanged) changes.push(spec.private ? 'make private' : 'make public')
    if (current && !changes.length) continue
    ops.push({
      kind: 'team_channel',
      name: spec.name,
      action: current ? 'update' : 'create',
      ...(spec.topic !== undefined ? { topic: spec.topic } : {}),
      private: spec.private,
      agents,
      removeAgents,
      userEmails,
      groupHandles,
      changes,
    })
  }
  return ops
}

export const IMPLICIT_ANCHOR = IMPLICIT_ANCHOR_KEY

/** Human-readable one-line-per-op summary for tool output and commit messages. */
export function summarizeDiff(diff: SystemDiff): string[] {
  const lines: string[] = []
  for (const a of diff.adopt) lines.push(`adopt ${a.key} → ${a.projectId} (${a.reason})`)
  for (const op of diff.inaccessible ?? []) lines.push(`not_accessible ${op.key} (bound to ${op.projectId})`)
  for (const c of diff.create) lines.push(`create ${c.key} "${c.spec.name}"`)
  for (const c of diff.configure) lines.push(`configure ${c.key}: ${Object.keys({ ...c.patch, ...(c.patch.agent ?? {}) }).filter((k) => k !== 'agent').join(', ')}`)
  for (const a of diff.attach) lines.push(`${a.changeMode ? 'remode' : 'attach'} ${a.anchorKey === IMPLICIT_ANCHOR_KEY ? '(caller)' : a.anchorKey} → ${a.targetKey} [${a.mode}]`)
  for (const d of diff.detach) lines.push(`detach ${d.anchorKey} → ${d.targetKey}`)
  for (const f of diff.files) if (f.action !== 'unchanged') lines.push(`${f.action} ${f.key}/${f.path}`)
  for (const ch of diff.teamChannels ?? []) {
    lines.push(ch.action === 'create'
      ? `create channel #${ch.name}${ch.changes.length ? `: ${ch.changes.join(', ')}` : ''}`
      : `update channel #${ch.name}: ${ch.changes.join(', ')}`)
  }
  return lines
}
