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

import { createHash } from 'crypto'
import { z } from 'zod'
import { parse as parseYaml } from 'yaml'
import { CAPABILITY_KEYS } from '@shogo/shared-runtime/capability-settings'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

const TIME_OF_DAY_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/

/**
 * A value a pack leaves for the install wizard to fill: `{{answers.<path>}}`.
 * Anything carrying one is validated after substitution, not at parse time —
 * the manifest is written before the answers exist.
 */
export function hasAnswerTemplate(value: string | undefined): boolean {
  return !!value && /\{\{\s*answers\./.test(value)
}

/** `HH:MM`, 24-hour. The shape a `review-time` answer and quiet hours take. */
export function isTimeOfDay(value: string): boolean {
  return TIME_OF_DAY_RE.test(value.trim())
}

export const AttachModeSchema = z.enum(['readwrite', 'readonly'])

const quietTime = z.string().refine((v) => isTimeOfDay(v) || hasAnswerTemplate(v), 'HH:MM')

export const QuietHoursSchema = z.object({
  start: quietTime,
  end: quietTime,
  timezone: z.string().optional(),
})

export type QuietHours = z.infer<typeof QuietHoursSchema>

export const HeartbeatSpecSchema = z.object({
  enabled: z.boolean().optional(),
  /** Seconds; minimum 60. */
  interval: z.number().int().min(60).optional(),
  quietHours: QuietHoursSchema.optional(),
})

export const AgentSpecSchema = z.object({
  /** Model id or alias. Use `auto` (recommended); other ids must be ones the workspace offers. */
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  heartbeat: HeartbeatSpecSchema.optional(),
  /** Capability toggles, e.g. { boardsEnabled: true, boardAdminEnabled: false }. Unlisted ones keep their current value. */
  capabilities: z.record(z.string(), z.boolean()).optional(),
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

export const BOARD_ITEM_TYPES = ['task', 'problem', 'ticket', 'deal', 'candidate', 'approval', 'content', 'custom'] as const
export const BOARD_COLUMN_CATEGORIES = ['backlog', 'active', 'waiting', 'review', 'done', 'dismissed'] as const

/** `workspace` for the workspace agent, or the key of a project in this manifest. */
const AgentRefSchema = z.string().min(1).max(80)

export const BoardColumnSpecSchema = z.object({
  name: z.string().min(1).max(60),
  category: z.enum(BOARD_COLUMN_CATEGORIES).optional(),
  wipLimit: z.number().int().positive().optional(),
  /** Cards moved here are handed to this agent. */
  agent: AgentRefSchema.optional(),
  slaHours: z.number().positive().optional(),
}).strict()

export const BoardFieldSpecSchema = z.object({
  key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/, 'camelCase or snake_case'),
  label: z.string().max(80).optional(),
  type: z.enum(['text', 'number', 'money', 'date', 'select', 'user', 'url', 'boolean']).optional(),
  options: z.array(z.string().min(1)).optional(),
  required: z.boolean().optional(),
}).strict()

/** A Kanban board in a team channel. Omit `columns` for the item type's defaults. */
export const BoardSpecSchema = z.object({
  name: z.string().min(1).max(80),
  itemType: z.enum(BOARD_ITEM_TYPES).default('task'),
  description: z.string().max(2000).optional(),
  keyPrefix: z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,5}$/, '2-6 letters or digits').transform((p) => p.toUpperCase()).optional(),
  columns: z.array(BoardColumnSpecSchema).min(1).optional(),
  fields: z.array(BoardFieldSpecSchema).default([]),
  postToChannel: z.enum(['all', 'done_only', 'none']).optional(),
  requiresHumanReview: z.boolean().optional(),
  /** New cards go to this agent unless assigned. */
  defaultAgent: AgentRefSchema.optional(),
}).strict()

export const TeamChannelSpecSchema = z.object({
  name: z.string().transform((n) => n.replace(/^#/, '')).pipe(z.string().regex(CHANNEL_NAME_RE, 'lowercase letters, digits, - and _')),
  topic: z.string().max(500).optional(),
  private: z.boolean().default(false),
  members: z.array(TeamChannelMemberSchema).default([]),
  boards: z.array(BoardSpecSchema).default([]),
})

/** How a `work_item` trigger turns an event into a card. Values are payload paths or `{{path}}` templates. */
export const TriggerCardSpecSchema = z.object({
  board: z.string().min(1),
  channel: z.string().transform((n) => n.replace(/^#/, '')).optional(),
  column: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.string().optional(),
  externalRef: z.string().optional(),
  dueAt: z.string().optional(),
  fields: z.record(z.string(), z.string()).optional(),
  stack: z.string().optional(),
  environment: z.string().optional(),
  release: z.string().optional(),
  url: z.string().optional(),
  /** Repeats with the same value update the open card instead of making a new one. */
  dedupeKey: z.string().optional(),
}).strict()

/** "When this event happens, do that." Webhook targets are left out: their secret is shown once. */
export const TriggerSpecSchema = z.object({
  key: z.string().regex(KEY_RE),
  name: z.string().min(1).max(200),
  /** Event type from trigger_types_list, e.g. `member.joined` or `composio.github.GITHUB_ISSUE_ADDED_EVENT`. */
  event: z.string().min(1),
  filter: z.record(z.string(), z.unknown()).optional(),
  /** Config the app event requires (e.g. owner/repo). */
  config: z.record(z.string(), z.unknown()).optional(),
  target: z.enum(['agent', 'project', 'work_item']).default('agent'),
  /** Manifest project key, for target `project`. */
  project: z.string().regex(KEY_RE).optional(),
  mode: z.enum(['agent', 'hook']).optional(),
  prompt: z.string().max(10_000).optional(),
  card: TriggerCardSpecSchema.optional(),
  /** Team channel that receives each result. */
  notify: z.string().transform((n) => n.replace(/^#/, '')).optional(),
  enabled: z.boolean().default(true),
}).strict()

/**
 * Five-field cron (`m h dom mon dow`). Names are allowed (`MON-FRI`), as are
 * the usual step/range/list operators. Anything else is rejected here so a
 * pack fails validation instead of creating a schedule that never fires; the
 * API validates cadence and timezone for real when the schedule is created.
 */
const CRON_TOKEN_RE = /^[A-Za-z0-9*?/,#LW-]+$/
export function isCronExpression(value: string): boolean {
  const parts = value.trim().split(/\s+/)
  if (parts.length !== 5) return false
  if (!parts.every((p) => p.length > 0 && CRON_TOKEN_RE.test(p))) return false
  return true
}

/** A recurring run the manifest creates, posts into a channel, and keeps in step on re-apply. */
export const ScheduleSpecSchema = z.object({
  key: z.string().regex(KEY_RE),
  name: z.string().min(1).max(200),
  /** Manifest project whose agent runs it; its tag replaces `{{agent.<key>}}` in the prompt. */
  project: z.string().regex(KEY_RE).optional(),
  /** Team channel the result is posted in (resolved to its conversation id at apply time). */
  channel: z.string().transform((n) => n.replace(/^#/, '')).optional(),
  /**
   * Five-field cron (`m h dom mon dow`), or a cron composed from answers
   * (`0 {{answers.profile.hour}} * * 1-5`). Use `hour` for a daily run.
   */
  cron: z.string().refine((v) => isCronExpression(v) || hasAnswerTemplate(v), 'a five-field cron expression (minute hour day month weekday)').optional(),
  /**
   * Time of day the run happens: `HH:MM` or an answer (`{{answers.profile.review-time}}`).
   * Composed into `<minute> <hour> * * <days>` so the run lands in the answered hour,
   * in the zone below — never in UTC by accident.
   */
  hour: z.string().optional(),
  /** Minute past the hour for an `hour` schedule. Defaults to the answer's minutes, else 0. */
  minute: z.number().int().min(0).max(59).optional(),
  /** Cron day-of-week field for an `hour` schedule, e.g. `1-5`. Defaults to every day. */
  days: z.string().regex(CRON_TOKEN_RE, 'a cron weekday field').optional(),
  timezone: z.string().min(1).optional(),
  prompt: z.string().min(1).max(10_000),
  enabled: z.boolean().default(true),
}).strict().superRefine((spec, ctx) => {
  if (spec.cron === undefined && spec.hour === undefined) {
    ctx.addIssue({ code: 'custom', path: ['cron'], message: 'a schedule needs `cron` or `hour`' })
  }
  if (spec.cron !== undefined && spec.hour !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['hour'], message: 'a schedule takes `cron` or `hour`, not both' })
  }
  if (spec.hour !== undefined && !isTimeOfDay(spec.hour) && !hasAnswerTemplate(spec.hour)) {
    ctx.addIssue({ code: 'custom', path: ['hour'], message: 'hour must be HH:MM or {{answers.<path>}}' })
  }
  if (spec.hour === undefined && (spec.minute !== undefined || spec.days !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['minute'], message: 'minute and days need `hour`' })
  }
})

export const SETUP_QUESTION_TYPES = ['text', 'choice', 'multi', 'confirm'] as const

/** One question the install wizard asks. Rendered from data — never hardcoded per pack. */
export const SetupQuestionSchema = z.object({
  id: z.string().regex(KEY_RE),
  header: z.string().min(1).max(80),
  question: z.string().min(1).max(500),
  type: z.enum(SETUP_QUESTION_TYPES).default('text'),
  options: z.array(z.string().min(1).max(120)).min(1).optional(),
  default: z.union([z.string(), z.array(z.string()), z.boolean()]).optional(),
  /** Profile path the answer fills, e.g. `profile.product`. */
  applies: z.string().optional(),
  required: z.boolean().optional(),
}).strict()

export const SetupSpecSchema = z.object({
  questions: z.array(SetupQuestionSchema).default([]),
  /** Where answers land in the anchor's files: a `## section` body. */
  profile: z.object({
    file: z.string().default('AGENTS.md'),
    section: z.string().min(1).max(120),
  }).strict().optional(),
}).strict()

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
  projects: z.array(ProjectSpecSchema).default([]),
  /**
   * Workspace team chat channels the system works in, with their members.
   * Distinct from a project's `channels` (Slack/Telegram/... connections).
   */
  teamChannels: z.array(TeamChannelSpecSchema).default([]),
  /** Event triggers, including ones that turn events into board cards. */
  triggers: z.array(TriggerSpecSchema).default([]),
  /** Recurring runs; tracked in the lock so re-apply updates instead of duplicating. */
  schedules: z.array(ScheduleSpecSchema).default([]),
  /**
   * Install-time questions and where their answers land. A `shogo-system.yaml`
   * written by an agent leaves this out; a marketplace pack uses it to ask
   * 2–4 questions before anything is created.
   */
  setup: SetupSpecSchema.optional(),
})

export type SystemManifest = z.infer<typeof SystemManifestSchema>
export type ProjectSpec = z.infer<typeof ProjectSpecSchema>
export type AttachMode = z.infer<typeof AttachModeSchema>
export type TeamChannelSpec = z.infer<typeof TeamChannelSpecSchema>
export type AgentTrigger = z.infer<typeof AgentTriggerSchema>
export type AgentContextMode = z.infer<typeof AgentContextModeSchema>
export type BoardSpec = z.infer<typeof BoardSpecSchema>
export type BoardColumnSpec = z.infer<typeof BoardColumnSpecSchema>
export type TriggerSpec = z.infer<typeof TriggerSpecSchema>
export type TriggerCardSpec = z.infer<typeof TriggerCardSpecSchema>
export type ScheduleSpec = z.infer<typeof ScheduleSpecSchema>
export type SetupSpec = z.infer<typeof SetupSpecSchema>
export type SetupQuestion = z.infer<typeof SetupQuestionSchema>

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

const SECTION_EXAMPLES: Record<string, string> = {
  triggers: [
    'triggers:',
    '  - key: onboarding-cards',
    '    name: New members get an onboarding card',
    '    event: member.joined',
    '    target: work_item',
    '    card:',
    '      board: Onboarding',
    '      channel: people',
    "      title: 'Onboard {{member.name}}'",
  ].join('\n'),
  teamChannels: [
    'teamChannels:',
    '  - name: support',
    '    members:',
    '      - project: support-agent',
    '    boards:',
    '      - name: Tickets',
    '        keyPrefix: SUP',
    '        columns:',
    '          - { name: New, category: backlog }',
    '          - { name: Working, category: active, slaHours: 24 }',
    '          - { name: Done, category: done }',
  ].join('\n'),
}

/** Examples for the manifest sections named in validation errors, so a caller can fix them without guessing. */
export function manifestHints(errors: string[]): string[] {
  const hints = ['system_apply reconciles the whole manifest, so edit shogo-system.yaml and keep the sections that are already there.']
  for (const [section, example] of Object.entries(SECTION_EXAMPLES)) {
    if (errors.some((e) => e.startsWith(`${section}.`) || e.startsWith(`${section}:`))) hints.push(`Valid ${section} entry:\n${example}`)
  }
  return hints
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
  const agentRefOk = (ref: string | undefined) => ref === undefined || ref === 'workspace' || keys.has(ref)
  const capabilityKeys = new Set<string>(CAPABILITY_KEYS)
  for (const p of manifest.projects) {
    for (const key of Object.keys(p.agent?.capabilities ?? {})) {
      if (!capabilityKeys.has(key)) errors.push(`${p.key}: unknown capability "${key}"`)
    }
  }
  const boardsByChannel = new Map<string, Set<string>>()
  for (const ch of manifest.teamChannels) {
    const names = new Set<string>()
    for (const b of ch.boards) {
      const where = `teamChannels.${ch.name}.boards.${b.name}`
      if (names.has(b.name.toLowerCase())) errors.push(`teamChannels.${ch.name}: board "${b.name}" is listed twice`)
      names.add(b.name.toLowerCase())
      if (!agentRefOk(b.defaultAgent)) errors.push(`${where}: defaultAgent "${b.defaultAgent}" is not "workspace" or a project key`)
      const columns = new Set<string>()
      for (const c of b.columns ?? []) {
        if (columns.has(c.name.toLowerCase())) errors.push(`${where}: column "${c.name}" is listed twice`)
        columns.add(c.name.toLowerCase())
        if (!agentRefOk(c.agent)) errors.push(`${where}.${c.name}: agent "${c.agent}" is not "workspace" or a project key`)
      }
      const fields = new Set<string>()
      for (const f of b.fields) {
        if (fields.has(f.key)) errors.push(`${where}: field "${f.key}" is listed twice`)
        fields.add(f.key)
        if (f.type === 'select' && !f.options?.length) errors.push(`${where}: select field "${f.key}" needs options`)
      }
    }
    boardsByChannel.set(ch.name, names)
  }
  const triggerKeys = new Set<string>()
  for (const t of manifest.triggers) {
    const where = `triggers.${t.key}`
    if (triggerKeys.has(t.key)) errors.push(`duplicate trigger key "${t.key}"`)
    triggerKeys.add(t.key)
    if (t.event.startsWith('composio.') && t.event.endsWith('*')) errors.push(`${where}: app events need an exact event type`)
    if ((t.target === 'agent' || (t.target === 'project' && (t.mode ?? 'agent') === 'agent')) && !t.prompt?.trim()) {
      errors.push(`${where}: a prompt is required to say what the agent should do`)
    }
    if (t.target === 'project' && (!t.project || !keys.has(t.project))) errors.push(`${where}: target project needs a project key from this manifest`)
    if (t.target !== 'project' && (t.project || t.mode)) errors.push(`${where}: project and mode only apply to target project`)
    if (t.target === 'work_item' && !t.card) errors.push(`${where}: target work_item needs a card mapping`)
    if (t.target !== 'work_item' && t.card) errors.push(`${where}: card only applies to target work_item`)
    if (t.card?.channel && boardsByChannel.has(t.card.channel) && !boardsByChannel.get(t.card.channel)!.has(t.card.board.toLowerCase())) {
      errors.push(`${where}: #${t.card.channel} declares no board "${t.card.board}"`)
    }
  }
  if (manifest.anchor && !keys.has(manifest.anchor)) {
    errors.push(`anchor "${manifest.anchor}" is not a project key`)
  }
  const scheduleKeys = new Set<string>()
  for (const s of manifest.schedules) {
    const where = `schedules.${s.key}`
    if (scheduleKeys.has(s.key)) errors.push(`duplicate schedule key "${s.key}"`)
    scheduleKeys.add(s.key)
    if (s.project && !keys.has(s.project)) errors.push(`${where}: project "${s.project}" is not a project key in this manifest`)
    if (s.channel && !channelNames.has(s.channel)) errors.push(`${where}: channel "${s.channel}" is not a teamChannel in this manifest`)
    if (s.timezone && !hasAnswerTemplate(s.timezone)) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: s.timezone }).format()
      } catch {
        errors.push(`${where}: unknown timezone "${s.timezone}"`)
      }
    }
  }
  const questionIds = new Set<string>()
  for (const q of manifest.setup?.questions ?? []) {
    const where = `setup.questions.${q.id}`
    if (questionIds.has(q.id)) errors.push(`duplicate setup question id "${q.id}"`)
    questionIds.add(q.id)
    if ((q.type === 'choice' || q.type === 'multi') && !q.options?.length) {
      errors.push(`${where}: a ${q.type} question needs options`)
    }
    if (q.applies !== undefined && !q.applies.startsWith('profile.')) {
      errors.push(`${where}: applies must be a "profile.<key>" path`)
    }
  }
  if (manifest.setup?.profile && !isSafeRelativePath(manifest.setup.profile.file)) {
    errors.push(`setup.profile.file: unsafe file path "${manifest.setup.profile.file}"`)
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
  /** `managed` (sandboxed workspace) or `external` (folder-linked). */
  workingMode?: string
  attachments: Array<{ attachedProjectId: string; attachMode: AttachMode }>
  agent: { heartbeatEnabled: boolean; heartbeatInterval: number; modelName: string; modelProvider: string } | null
  /** Capability toggles saved on the project (Project.settings). */
  capabilities?: Record<string, unknown>
}

/** `.shogo/system.lock.json` — manifest key → live project id. */
export interface SystemLock {
  version: 1
  name: string
  bindings: Record<string, string>
  /** Trigger key → live trigger id and the hash of the spec it was last applied from. */
  triggers?: Record<string, { id: string; hash: string }>
  /** Schedule key → live schedule id and the hash of the values it was last applied from. */
  schedules?: Record<string, { id: string; hash: string }>
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
    /**
     * Only ever `'external'` — the flip is one-way, so a manifest can make a
     * managed project folder-linked but never the reverse.
     */
    workingMode?: 'external'
    agent?: {
      heartbeatEnabled?: boolean
      heartbeatInterval?: number
      modelName?: string
      modelProvider?: string
      quietHoursStart?: string
      quietHoursEnd?: string
      quietHoursTimezone?: string
    }
    /** Capability toggles to save. */
    settings?: Record<string, boolean>
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
export interface FileOp {
  kind: 'file'
  key: string
  projectId: string | null
  path: string
  /**
   * `skip` means the project's folder is not on this runtime, so the file was
   * neither read nor written — never `create` for a file we cannot reach.
   */
  action: 'create' | 'update' | 'unchanged' | 'skip'
  reason?: 'project_not_mounted'
}

/** Live team chat channel, as returned by the agent-channels `team-channels` route. */
export interface LiveTeamChannel {
  id?: string
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

/** Live board, as returned by the agent-boards route. */
export interface LiveBoard {
  id: string
  name: string
  channelName: string | null
  itemType: string
  keyPrefix: string
  description: string | null
  fieldsSchema: unknown
  postToChannel: string
  requiresHumanReview: boolean
  defaultAssigneeAgentRef: string | null
  systemManagedBy?: string | null
  archivedAt: string | null
  columns: Array<{ id: string; name: string; position: number; category: string; wipLimit: number | null; agentRef: string | null; slaHours: number | null }>
}

/** Column values as the agent-boards API takes them; agent refs are resolved at apply time. */
export interface BoardColumnValues {
  name: string
  category?: string
  wip_limit?: number | null
  /** Manifest agent ref (`workspace` or a project key); null clears. */
  agent?: string | null
  sla_hours?: number | null
}

export interface BoardColumnOp {
  action: 'create' | 'update'
  column: string
  after?: string
  values: Partial<BoardColumnValues>
}

export interface BoardOp {
  kind: 'board'
  channel: string
  name: string
  action: 'create' | 'update' | 'restore'
  boardId: string | null
  /** Board values to send on create, or the changed ones on update. */
  values: {
    item_type?: string
    description?: string
    key_prefix?: string
    fields?: unknown[]
    post_to_channel?: string
    requires_human_review?: boolean
    /** Manifest agent ref; resolved at apply time. */
    default_agent?: string | null
    columns?: BoardColumnValues[]
  }
  columns: BoardColumnOp[]
  changes: string[]
}

/** Live trigger, as returned by the triggers route. */
export interface LiveTrigger {
  id: string
  name: string
  eventType: string
  target: string
  targetProjectId: string | null
}

export interface TriggerOp {
  kind: 'trigger'
  key: string
  action: 'create' | 'update' | 'replace' | 'delete'
  triggerId: string | null
  spec: TriggerSpec | null
  hash: string | null
}

/** Live schedule, as the internal schedules route returns it. */
export interface LiveSchedule {
  id: string
  name: string
  prompt: string
  cronExpression: string
  timezone: string
  enabled: boolean
  notifyConversationId: string | null
}

/** What a schedule is created (or updated) with, after template substitution. */
export interface ScheduleValues {
  name: string
  prompt: string
  cronExpression: string
  timezone: string
  enabled: boolean
  /** Team channel name to post into; resolved to a conversation id at apply time. */
  channel: string | null
  /** Set when the spec cannot become a schedule from the answers it has. */
  error?: string
}

/** The cron + zone a spec resolves to, or the reason it cannot. */
export interface ScheduleTiming {
  cronExpression: string
  timezone: string
  error: string | null
}

export interface ScheduleOp {
  kind: 'schedule'
  key: string
  action: 'create' | 'update' | 'delete'
  scheduleId: string | null
  spec: ScheduleSpec | null
  hash: string | null
  values: ScheduleValues | null
  /** The spec resolved to something the schedules API would reject; report it, write nothing. */
  error?: string | null
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
  boards: BoardOp[]
  triggers: TriggerOp[]
  schedules: ScheduleOp[]
  /** Things `system_apply` cannot do without credentials — surfaced for the user. */
  manual: string[]
  /**
   * Things the apply left undone for a reason that needs no error and will
   * clear on its own (a project not mounted in this runtime yet, the implicit
   * caller edge skipped for the workspace agent). `ok` stays true; the same
   * apply converges when re-run.
   */
  warnings: string[]
  /** True when nothing needs to change. */
  empty: boolean
}

export interface DiffOptions {
  /** Project id of the runtime running the apply. Binds to `manifest.anchor`. */
  callerProjectId: string
  /**
   * Reader for current file contents inside a bound project. `unmounted` when
   * the project's folder is not on this runtime — distinct from `missing`, so
   * an unreachable file is never reported as a create.
   */
  readFile?: (projectId: string, path: string) => FileProbe
  /**
   * Ids this workspace knows about, even when the caller cannot see them in
   * the live graph. A lock entry matching one of these resolves (configure /
   * update) instead of reporting `inaccessible`.
   */
  knownProjectIds?: Iterable<string>
  /**
   * True when the apply runs as the workspace agent. That runtime has no
   * project identity to attach *from*, so the implicit-anchor edges are
   * skipped instead of failing one `Unauthorized` per manifest project.
   */
  callerIsWorkspaceAgent?: boolean
  /** Current team chat channels; when omitted, `teamChannels` are reported as manual steps. */
  teamChannels?: LiveTeamChannels
  /** Current boards (archived included); when omitted, declared boards are reported as manual steps. */
  boards?: LiveBoard[]
  /** Why boards cannot be applied, for the manual step (e.g. board management is off). */
  boardsUnavailable?: string
  /** Current triggers; when omitted, declared triggers are reported as manual steps. */
  triggers?: LiveTrigger[]
  triggersUnavailable?: string
  /** Current schedules; when omitted, declared schedules are reported as manual steps. */
  schedules?: LiveSchedule[]
  schedulesUnavailable?: string
  /** Answers from an install wizard, substituted into files and prompts as `{{answers.*}}`. */
  answers?: Record<string, unknown>
}

/**
 * What a project file looks like right now. `unmounted` is deliberately not
 * `missing`: when the project's folder is not on this runtime, "absent" and
 * "unreachable" cannot be told apart, and a file we cannot reach must never
 * be reported — or attempted — as a create.
 */
export type FileProbe =
  | { status: 'ok'; content: string }
  | { status: 'missing' }
  | { status: 'unmounted' }

const IMPLICIT_ANCHOR_KEY = '__caller__'

/**
 * Resolve manifest key → live id using, in order: the anchor rule, the lock,
 * exact-name match against live projects. Keys left unbound are creates.
 *
 * A locked id that is not in `live` is still bound when the workspace knows
 * the id at all (`knownProjectIds`, e.g. the workspace project list): the
 * project exists and is simply not visible/mounted to this caller, which is a
 * `configure`/`update` — never a second copy of the project.
 */
export function resolveBindings(
  manifest: SystemManifest,
  live: LiveProject[],
  lock: SystemLock | null,
  callerProjectId: string,
  knownProjectIds: Iterable<string> = [],
): { bindings: Record<string, string>; adopt: AdoptOp[]; inaccessible: InaccessibleOp[] } {
  const bindings: Record<string, string> = {}
  const adopt: AdoptOp[] = []
  const inaccessible: InaccessibleOp[] = []
  const liveIds = new Set(live.map((p) => p.id))
  const knownIds = new Set(knownProjectIds)
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
    if (locked && (liveIds.has(locked) || knownIds.has(locked))) {
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
  sourceManifest: SystemManifest,
  live: LiveProject[],
  lock: SystemLock | null,
  opts: DiffOptions,
): SystemDiff {
  const manifest = applyAnswersToManifest(sourceManifest, opts.answers)
  const { bindings, adopt, inaccessible } = resolveBindings(manifest, live, lock, opts.callerProjectId, opts.knownProjectIds)
  const liveById = new Map(live.map((p) => [p.id, p]))
  const blocked = new Set(inaccessible.map((op) => op.key))

  const create: CreateOp[] = []
  const configure: ConfigureOp[] = []
  const attach: AttachOp[] = []
  const detach: DetachOp[] = []
  const files: FileOp[] = []
  const manual: string[] = []
  const warnings: string[] = []

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
    // Working mode can be pinned; the flip is one-way (managed → external) and
    // only applies to a project that already exists (a create carries it).
    if (spec.workingMode === 'external' && liveProject && (liveProject.workingMode ?? 'managed') !== 'external') {
      patch.workingMode = 'external'
    } else if (spec.workingMode === 'managed' && liveProject?.workingMode === 'external') {
      manual.push(
        `${spec.key}: project is folder-linked (external) and cannot go back to managed — export its folder or drop workingMode from the manifest`,
      )
    }
    const settings = capabilityPatch(spec, liveProject)
    if (settings) patch.settings = settings
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
      if (!id) {
        // No binding yet — created earlier in this same apply.
        files.push({ kind: 'file', key: spec.key, projectId: null, path, action: 'create' })
        continue
      }
      const probe: FileProbe = opts.readFile ? opts.readFile(id, path) : { status: 'missing' }
      if (probe.status === 'unmounted') {
        files.push({ kind: 'file', key: spec.key, projectId: id, path, action: 'skip', reason: 'project_not_mounted' })
        continue
      }
      const action: FileOp['action'] =
        probe.status === 'missing' ? 'create' : probe.content === content ? 'unchanged' : 'update'
      files.push({ kind: 'file', key: spec.key, projectId: id, path, action })
    }

    for (const ch of spec.channels) manual.push(`${spec.key}: connect channel "${ch}" (channel_connect needs credentials)`)
    for (const integ of spec.integrations) manual.push(`${spec.key}: connect integration "${integ}" (Composio / MCP auth)`)
  }

  // Implicit anchor: the caller manages every manifest project read-write.
  // The workspace agent has no project identity to attach *from* — its id is
  // the workspace anchor, which the attach authorizes as someone else — so
  // every edge would come back `Unauthorized`. Skip the block and say so once.
  if (!manifest.anchor) {
    if (opts.callerIsWorkspaceAgent) {
      warnings.push('attach: skipped for the workspace agent — no project identity to attach')
    } else {
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
  }

  const teamChannels = opts.teamChannels
    ? diffTeamChannels(manifest, bindings, opts.teamChannels, manual)
    : []
  if (!opts.teamChannels && manifest.teamChannels.length) {
    manual.push(`teamChannels: team chat is not reachable from this runtime; create ${manifest.teamChannels.map((c) => `#${c.name}`).join(', ')} by hand`)
  }

  const declaredBoards = manifest.teamChannels.some((c) => c.boards.length > 0)
  const boards = opts.boards ? diffBoards(manifest, opts.boards, manual, bindings) : []
  if (!opts.boards && declaredBoards) {
    const names = manifest.teamChannels.flatMap((c) => c.boards.map((b) => `#${c.name} ${b.name}`))
    manual.push(`boards: ${opts.boardsUnavailable ?? 'boards are not reachable from this runtime'}; set up ${names.join(', ')} by hand`)
  }
  const triggers = opts.triggers ? diffTriggers(manifest, opts.triggers, lock, bindings) : []
  if (!opts.triggers && manifest.triggers.length) {
    manual.push(`triggers: ${opts.triggersUnavailable ?? 'triggers are not reachable from this runtime'}; create ${manifest.triggers.map((t) => t.name).join(', ')} by hand`)
  }

  const schedules = opts.schedules
    ? diffSchedules(manifest, opts.schedules, lock, {
        bindings,
        answers: opts.answers,
        channelIds: Object.fromEntries((opts.teamChannels?.channels ?? []).filter((c) => c.id).map((c) => [c.name, c.id!])),
      })
    : []
  if (!opts.schedules && manifest.schedules.length) {
    manual.push(`schedules: ${opts.schedulesUnavailable ?? 'schedules are not reachable from this runtime'}; create ${manifest.schedules.map((s) => s.name).join(', ')} by hand`)
  }

  for (const f of files) {
    if (f.action === 'skip') warnings.push(fileSkipWarning(f.key, f.path))
  }

  const empty =
    teamChannels.length === 0 &&
    boards.length === 0 &&
    triggers.length === 0 &&
    schedules.length === 0 &&
    create.length === 0 &&
    configure.length === 0 &&
    attach.length === 0 &&
    detach.length === 0 &&
    files.every((f) => f.action === 'unchanged')

  return { adopt, inaccessible, create, configure, attach, detach, files, teamChannels, boards, triggers, schedules, manual, warnings, empty }
}

/**
 * Why a manifest file was left alone: its project's folder is not on this
 * runtime. Not an error — re-running the same apply after the project mounts
 * converges.
 */
export function fileSkipWarning(key: string, path: string): string {
  return `files ${key}/${path}: skipped — project not mounted in this runtime; re-run after it mounts`
}

function capabilityPatch(spec: ProjectSpec, live: LiveProject | null): Record<string, boolean> | undefined {
  const wanted = spec.agent?.capabilities
  if (!wanted) return undefined
  const patch: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(wanted)) {
    if (live?.capabilities?.[key] !== value) patch[key] = value
  }
  return Object.keys(patch).length ? patch : undefined
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

function normalizeFields(fields: unknown): string {
  const list = Array.isArray(fields) ? fields : []
  return JSON.stringify(list.map((f: any) => ({
    key: f?.key,
    label: f?.label ?? null,
    type: f?.type ?? 'text',
    options: Array.isArray(f?.options) && f.options.length ? f.options : null,
    required: !!f?.required,
  })))
}

/**
 * Board create/update ops. Boards are matched by name within their channel.
 * Declared columns are added or updated, never deleted: a column the manifest
 * no longer lists may still hold cards, so it is reported for a person to move.
 */
export function diffBoards(manifest: SystemManifest, live: LiveBoard[], manual: string[] = [], bindings: Record<string, string> = {}): BoardOp[] {
  const ops: BoardOp[] = []
  for (const ch of manifest.teamChannels) {
    for (const spec of ch.boards) {
      const current = live.find((b) => b.channelName === ch.name && b.name.toLowerCase() === spec.name.toLowerCase()) ?? null
      const columnValues = (spec.columns ?? []).map((c) => ({
        name: c.name,
        ...(c.category ? { category: c.category } : {}),
        ...(c.wipLimit !== undefined ? { wip_limit: c.wipLimit } : {}),
        ...(c.agent !== undefined ? { agent: c.agent } : {}),
        ...(c.slaHours !== undefined ? { sla_hours: c.slaHours } : {}),
      }))
      if (!current) {
        ops.push({
          kind: 'board',
          channel: ch.name,
          name: spec.name,
          action: 'create',
          boardId: null,
          values: {
            item_type: spec.itemType,
            ...(spec.description !== undefined ? { description: spec.description } : {}),
            ...(spec.keyPrefix ? { key_prefix: spec.keyPrefix } : {}),
            ...(spec.fields.length ? { fields: spec.fields } : {}),
            ...(spec.postToChannel ? { post_to_channel: spec.postToChannel } : {}),
            ...(spec.requiresHumanReview !== undefined ? { requires_human_review: spec.requiresHumanReview } : {}),
            ...(spec.defaultAgent ? { default_agent: spec.defaultAgent } : {}),
            ...(columnValues.length ? { columns: columnValues } : {}),
          },
          columns: [],
          changes: [`${spec.itemType} board${columnValues.length ? `, ${columnValues.length} columns` : ''}`],
        })
        continue
      }

      const values: BoardOp['values'] = {}
      const changes: string[] = []
      if (current.itemType !== spec.itemType) manual.push(`#${ch.name} ${spec.name}: is a ${current.itemType} board; the manifest says ${spec.itemType}. Item type is not changed in place.`)
      if (spec.description !== undefined && (current.description ?? '') !== spec.description) { values.description = spec.description; changes.push('description') }
      if (spec.keyPrefix && current.keyPrefix !== spec.keyPrefix) { values.key_prefix = spec.keyPrefix; changes.push(`key prefix ${spec.keyPrefix}`) }
      if (spec.fields.length && normalizeFields(current.fieldsSchema) !== normalizeFields(spec.fields)) { values.fields = spec.fields; changes.push('fields') }
      if (spec.postToChannel && current.postToChannel !== spec.postToChannel) { values.post_to_channel = spec.postToChannel; changes.push(`posts ${spec.postToChannel}`) }
      if (spec.requiresHumanReview !== undefined && current.requiresHumanReview !== spec.requiresHumanReview) {
        values.requires_human_review = spec.requiresHumanReview
        changes.push(spec.requiresHumanReview ? 'require human review' : 'no human review')
      }
      if (spec.defaultAgent !== undefined && !sameAgent(current.defaultAssigneeAgentRef, spec.defaultAgent, bindings)) {
        values.default_agent = spec.defaultAgent
        changes.push(`default agent ${spec.defaultAgent}`)
      }

      const columns: BoardColumnOp[] = []
      if (spec.columns) {
        const byName = new Map(current.columns.map((c) => [c.name.toLowerCase(), c]))
        const liveOrder = current.columns.slice().sort((a, b) => a.position - b.position).map((c) => c.name.toLowerCase())
        let prev: string | undefined
        for (const c of spec.columns) {
          const existing = byName.get(c.name.toLowerCase())
          if (!existing) {
            columns.push({ action: 'create', column: c.name, ...(prev ? { after: prev } : {}), values: columnValues.find((v) => v.name === c.name)! })
            changes.push(`add column ${c.name}`)
          } else {
            const patch: Partial<BoardColumnValues> = {}
            if (c.category && existing.category !== c.category) patch.category = c.category
            if (c.wipLimit !== undefined && existing.wipLimit !== c.wipLimit) patch.wip_limit = c.wipLimit
            if (c.slaHours !== undefined && existing.slaHours !== c.slaHours) patch.sla_hours = c.slaHours
            if (c.agent !== undefined && !sameAgent(existing.agentRef, c.agent, bindings)) patch.agent = c.agent
            if (Object.keys(patch).length) {
              columns.push({ action: 'update', column: existing.name, values: patch })
              changes.push(`update column ${existing.name}`)
            }
          }
          prev = c.name
        }
        const declared = spec.columns.map((c) => c.name.toLowerCase())
        const kept = liveOrder.filter((n) => declared.includes(n))
        const expected = declared.filter((n) => byName.has(n))
        if (kept.join('\u0000') !== expected.join('\u0000')) {
          for (let i = 1; i < spec.columns.length; i++) {
            const c = spec.columns[i]
            const existing = byName.get(c.name.toLowerCase())
            if (!existing) continue
            const op = columns.find((o) => o.action === 'update' && o.column === existing.name)
            if (op) op.after = spec.columns[i - 1].name
            else columns.push({ action: 'update', column: existing.name, after: spec.columns[i - 1].name, values: {} })
          }
          changes.push('reorder columns')
        }
        for (const c of current.columns) {
          if (!declared.includes(c.name.toLowerCase())) manual.push(`#${ch.name} ${spec.name}: column "${c.name}" is not in the manifest; it was left in place (move its cards and delete it with column_delete if it is no longer needed)`)
        }
      }

      const archived = !!current.archivedAt
      if (!archived && !changes.length && !columns.length) continue
      if (archived) changes.unshift('restore')
      ops.push({ kind: 'board', channel: ch.name, name: spec.name, action: archived ? 'restore' : 'update', boardId: current.id, values, columns, changes })
    }
  }
  return ops
}

/** Live refs are `workspace` / `project:<id>`; manifest refs are `workspace` / a project key. */
function sameAgent(live: string | null, wanted: string, bindings: Record<string, string>): boolean {
  if (wanted === 'workspace') return live === 'workspace'
  const id = bindings[wanted]
  return !!id && live === `project:${id}`
}

/** Manifest agent ref → the API's ref; null while the project does not exist yet. */
export function resolveAgentRef(ref: string, bindings: Record<string, string>): string | null {
  if (ref === 'workspace') return 'workspace'
  const id = bindings[ref]
  return id ? `project:${id}` : null
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, stable((value as any)[k])]))
  }
  return value
}

export function triggerHash(spec: TriggerSpec, bindings: Record<string, string> = {}): string {
  const resolved = { ...spec, project: spec.project ? bindings[spec.project] ?? spec.project : undefined }
  return createHash('sha256').update(JSON.stringify(stable(resolved))).digest('hex').slice(0, 16)
}

/**
 * Trigger ops. A trigger is bound to its key through the lock (or adopted by
 * exact name). It is updated when its spec changed since the last apply and
 * replaced when the event or target changed, which cannot be edited in place.
 * Triggers the lock records but the manifest no longer declares are deleted.
 */
export function diffTriggers(manifest: SystemManifest, live: LiveTrigger[], lock: SystemLock | null, bindings: Record<string, string> = {}): TriggerOp[] {
  const ops: TriggerOp[] = []
  const byId = new Map(live.map((t) => [t.id, t]))
  const locked = lock?.triggers ?? {}
  const claimed = new Set<string>()
  for (const spec of manifest.triggers) {
    const hash = triggerHash(spec, bindings)
    const entry = locked[spec.key]
    let current = entry ? byId.get(entry.id) ?? null : null
    if (!current) {
      current = live.find((t) => t.name === spec.name && !claimed.has(t.id)) ?? null
    }
    if (current) claimed.add(current.id)
    if (!current) { ops.push({ kind: 'trigger', key: spec.key, action: 'create', triggerId: null, spec, hash }); continue }
    if (entry?.id === current.id && entry.hash === hash) continue
    const wantedProject = spec.target === 'project' && spec.project ? bindings[spec.project] ?? null : null
    const structural = current.eventType !== spec.event || current.target !== spec.target ||
      (spec.target === 'project' && wantedProject !== null && current.targetProjectId !== wantedProject)
    ops.push({ kind: 'trigger', key: spec.key, action: structural ? 'replace' : 'update', triggerId: current.id, spec, hash })
  }
  const declared = new Set(manifest.triggers.map((t) => t.key))
  for (const [key, entry] of Object.entries(locked)) {
    if (declared.has(key) || !byId.has(entry.id)) continue
    ops.push({ kind: 'trigger', key, action: 'delete', triggerId: entry.id, spec: null, hash: null })
  }
  return ops
}

/**
 * Read one answer. Answers arrive either nested (`{ profile: { product } }`) or
 * flat (`{ 'profile.product': ... }`, which is what the install wizard posts),
 * and either keyed by the question id or by its `applies` path. All of those
 * mean the same thing here.
 */
function readAnswer(answers: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(answers, path)) return answers[path]
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), answers)
}

function writeAnswer(answers: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let node = answers
  for (const key of keys.slice(0, -1)) {
    const next = node[key]
    if (!next || typeof next !== 'object' || Array.isArray(next)) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[keys[keys.length - 1]] = value
}

/** No answer: missing, blank, or an empty multi-select. A skipped question is not answered `''`. */
export function isBlankAnswer(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * One canonical answer set. Every question resolves under its `applies` path
 * *and* under its id, and a skipped question takes its default — so an answer
 * the wizard collected reaches the file, the prompt and the schedule that read
 * it, wherever the pack keys it.
 */
export function normalizeAnswers(setup: SetupSpec | undefined, answers?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(answers ?? {})) {
    if (!isBlankAnswer(value)) writeAnswer(out, key, value)
  }
  for (const q of setup?.questions ?? []) {
    const path = q.applies ?? `profile.${q.id}`
    const given = readAnswer(out, path) ?? readAnswer(out, q.id)
    const value = isBlankAnswer(given) ? q.default : given
    if (isBlankAnswer(value)) continue
    writeAnswer(out, path, value)
    if (readAnswer(out, q.id) === undefined) writeAnswer(out, q.id, value)
  }
  return out
}

/**
 * `{{answers.<path>}}` substitution. The dotted `applies` path wins, then the
 * bare question id, so both a normalized answer set and a hand-written
 * `{ product: '…' }` resolve.
 */
export function answerLookup(answers: Record<string, unknown> | undefined, path: string): string | null {
  if (!answers) return null
  let value = readAnswer(answers, path)
  if (value === undefined && path.startsWith('profile.')) value = readAnswer(answers, path.slice('profile.'.length))
  if (value === undefined) value = readAnswer(answers, path.split('.').slice(-1)[0])
  if (value === undefined) return null
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ')
  if (value === true) return 'yes'
  if (value === false) return 'no'
  return value == null ? null : String(value)
}

/** Replace `{{answers.*}}`; an unanswered path is left visible so the gap is obvious. */
export function substituteAnswers(text: string, answers?: Record<string, unknown>): string {
  if (!answers) return text
  return text.replace(/\{\{\s*answers\.([a-zA-Z0-9_.-]+)\s*\}\}/g, (whole, path: string) => answerLookup(answers, path) ?? whole)
}

/** `{{agent.<key>}}` → the agent's mention, `{{channel.<name>}}` → its id (or `#name`), `{{answers.*}}` → the answer. */
export function substituteTemplates(
  text: string,
  ctx: {
    bindings?: Record<string, string>
    answers?: Record<string, unknown>
    /** Team channel name → conversation id, resolved once the channel exists. */
    channelIds?: Record<string, string>
    /** `id` for prompts (a schedule posts by id); `mention` for prose files. */
    channelStyle?: 'mention' | 'id'
  },
): string {
  const withAnswers = substituteAnswers(text, ctx.answers)
  // A pack may write either `{{agent.x}}` or the mention form `<@a:p:{{agent.x}}>`
  // (the form the plan's examples use). The wrapped one is replaced whole, so a
  // prompt never ends up as the unusable `<@a:p:<@a:p:id>>`.
  return withAnswers.replace(
    /<@a:p:\{\{\s*agent\.([a-zA-Z0-9_-]+)\s*\}\}>|\{\{\s*(agent|channel)\.([a-zA-Z0-9_-]+)\s*\}\}/g,
    (whole, wrappedAgent: string | undefined, kind: string | undefined, key: string | undefined) => {
      if (wrappedAgent !== undefined) {
        return ctx.bindings?.[wrappedAgent] ? `<@a:p:${ctx.bindings[wrappedAgent]}>` : whole
      }
      if (kind === 'agent') return ctx.bindings?.[key!] ? `<@a:p:${ctx.bindings[key!]}>` : whole
      const id = ctx.channelIds?.[key!]
      if (ctx.channelStyle === 'id' && id) return id
      return `#${key}`
    },
  )
}

/**
 * The same manifest with `{{answers.*}}` filled into files, topics,
 * descriptions, prompts and the agent's quiet hours, and skipped questions
 * filled from their defaults. Everything else is untouched, so keys and
 * bindings still line up.
 */
export function applyAnswersToManifest(manifest: SystemManifest, answers?: Record<string, unknown>): SystemManifest {
  const normalized = normalizeAnswers(manifest.setup, answers)
  if (Object.keys(normalized).length === 0) return manifest
  const sub = (s: string | undefined) => (s === undefined ? undefined : substituteAnswers(s, normalized))
  const quiet = (q: QuietHours | undefined): QuietHours | undefined =>
    q === undefined ? undefined : {
      ...q,
      start: substituteAnswers(q.start, normalized),
      end: substituteAnswers(q.end, normalized),
      ...(q.timezone ? { timezone: substituteAnswers(q.timezone, normalized) } : {}),
    }
  const projects = manifest.projects.map((p) => ({
    ...p,
    description: sub(p.description),
    files: Object.fromEntries(Object.entries(p.files).map(([path, body]) => [path, substituteAnswers(body, normalized)])),
    ...(p.agent ? { agent: { ...p.agent, ...(p.agent.heartbeat ? { heartbeat: { ...p.agent.heartbeat, ...(p.agent.heartbeat.quietHours ? { quietHours: quiet(p.agent.heartbeat.quietHours) } : {}) } } : {}) } } : {}),
  }))
  const teamChannels = manifest.teamChannels.map((c) => ({
    ...c,
    topic: sub(c.topic),
    boards: c.boards.map((b) => ({ ...b, description: sub(b.description) })),
  }))
  const triggers = manifest.triggers.map((t) => ({ ...t, prompt: sub(t.prompt) }))
  const schedules = manifest.schedules.map((s) => ({
    ...s,
    prompt: substituteAnswers(s.prompt, normalized),
    ...(s.hour !== undefined ? { hour: substituteAnswers(s.hour, normalized) } : {}),
    ...(s.cron !== undefined ? { cron: substituteAnswers(s.cron, normalized) } : {}),
    ...(s.timezone !== undefined ? { timezone: substituteAnswers(s.timezone, normalized) } : {}),
  }))
  return { ...manifest, projects, teamChannels, triggers, schedules }
}

/**
 * Render the `setup.profile` section body from answers. Used by the install
 * wizard to fill the anchor's `## Workspace profile`; the apply engine writes
 * it, so both the runtime and the marketplace path produce the same text. An
 * answered question always wins; only a skipped one takes its default.
 */
export function renderProfileSection(setup: SetupSpec | undefined, answers: Record<string, unknown> = {}): string | null {
  const profile = setup?.profile
  if (!profile) return null
  const normalized = normalizeAnswers(setup, answers)
  const lines: string[] = []
  for (const q of setup.questions) {
    const value = answerLookup(normalized, q.applies ?? `profile.${q.id}`)
      ?? answerLookup(normalized, q.id)
      ?? (q.default !== undefined ? answerLookup({ v: q.default }, 'v') : null)
    if (!value) continue
    lines.push(`- **${q.header}**: ${value}`)
  }
  return lines.length ? lines.join('\n') : null
}

/**
 * Write the profile answers into a file body: the `## <section>` heading is
 * replaced (or appended when absent), leaving every other section alone.
 */
export function mergeProfileSection(body: string, section: string, rendered: string): string {
  const heading = section.trim().startsWith('#') ? section.trim() : `## ${section.trim()}`
  const lines = body.split('\n')
  const start = lines.findIndex((l) => l.trim() === heading)
  if (start === -1) {
    const sep = body.endsWith('\n') ? '' : '\n'
    return `${body}${sep}\n${heading}\n\n${rendered}\n`
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break }
  }
  const before = lines.slice(0, start + 1)
  const after = lines.slice(end)
  return [...before, '', rendered, '', ...after].join('\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * Turn a schedule spec into the cron + zone the schedules API takes. Answers
 * are substituted first and the result is validated, so a pack that asks for a
 * review time runs at that time in that zone instead of quietly at 07:00 UTC.
 * The only place a spec becomes a schedule: `system_apply` and the marketplace
 * apply engine both go through it.
 */
export function resolveScheduleTiming(spec: ScheduleSpec, answers?: Record<string, unknown>): ScheduleTiming {
  const timezone = (spec.timezone ? substituteAnswers(spec.timezone, answers).trim() : '') || 'UTC'
  let cronExpression: string
  if (spec.hour !== undefined) {
    const answered = substituteAnswers(spec.hour, answers).trim()
    if (hasAnswerTemplate(answered)) {
      return { cronExpression: answered, timezone, error: `hour "${answered}" was not filled in — the install is missing that answer` }
    }
    if (!isTimeOfDay(answered)) {
      return { cronExpression: answered, timezone, error: `hour "${answered}" is not a time of day (HH:MM)` }
    }
    const [hours, minutes] = answered.split(':').map((part) => Number(part))
    cronExpression = `${spec.minute ?? minutes} ${hours} * * ${spec.days ?? '*'}`
  } else {
    cronExpression = substituteAnswers(spec.cron ?? '', answers).trim()
    if (hasAnswerTemplate(cronExpression)) {
      return { cronExpression, timezone, error: `cron "${cronExpression}" was not filled in — the install is missing that answer` }
    }
    if (!isCronExpression(cronExpression)) {
      return { cronExpression, timezone, error: `"${cronExpression}" is not a five-field cron expression` }
    }
  }
  if (hasAnswerTemplate(timezone)) {
    return { cronExpression, timezone, error: `timezone "${timezone}" was not filled in — the install is missing that answer` }
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
  } catch {
    return { cronExpression, timezone, error: `unknown timezone "${timezone}"` }
  }
  return { cronExpression, timezone, error: null }
}

/** Manifest `schedules` render into the same shape the schedules API takes. */
export function resolveScheduleValues(
  spec: ScheduleSpec,
  ctx: {
    bindings?: Record<string, string>
    answers?: Record<string, unknown>
    channelIds?: Record<string, string>
  },
): ScheduleValues {
  const timing = resolveScheduleTiming(spec, ctx.answers)
  return {
    name: spec.name,
    prompt: substituteTemplates(spec.prompt, {
      bindings: ctx.bindings,
      answers: ctx.answers,
      channelIds: ctx.channelIds,
      channelStyle: 'id',
    }),
    cronExpression: timing.cronExpression,
    timezone: timing.timezone,
    enabled: spec.enabled,
    channel: spec.channel ?? null,
    ...(timing.error ? { error: timing.error } : {}),
  }
}

/**
 * A card spec → the `workItemTarget` the triggers API validates: the card's
 * placements at the top, its templates under `mapping`. Both `system_apply` and
 * the marketplace apply engine build it here, so a `work_item` trigger installs
 * the same way whichever path ran it.
 */
export function cardToWorkItemTarget(card: TriggerCardSpec): Record<string, unknown> {
  const mapping: Record<string, unknown> = { title: card.title }
  if (card.description !== undefined) {
    mapping.description = card.description
    mapping.message = card.description
  }
  for (const key of ['priority', 'externalRef', 'dueAt', 'fields', 'stack', 'environment', 'release', 'url'] as const) {
    if (card[key] !== undefined) mapping[key] = card[key]
  }
  return {
    board: card.board,
    ...(card.channel ? { channel: card.channel } : {}),
    ...(card.column ? { column: card.column } : {}),
    ...(card.dedupeKey ? { dedupeKey: card.dedupeKey } : {}),
    mapping,
  }
}

/**
 * Hash of the *declared* schedule — templates left intact, answers filled.
 * Deliberately independent of live ids, so creating a project or channel in
 * the same apply does not make the next apply look like a change.
 */
function scheduleHash(spec: ScheduleSpec, answers?: Record<string, unknown>): string {
  const timing = resolveScheduleTiming(spec, answers)
  return createHash('sha256')
    .update(JSON.stringify(stable({
      name: spec.name,
      prompt: substituteAnswers(spec.prompt, answers),
      cron: timing.cronExpression,
      timezone: timing.timezone,
      enabled: spec.enabled,
      channel: spec.channel ?? null,
    })))
    .digest('hex')
    .slice(0, 16)
}

/**
 * Schedule ops, keyed strictly by lock ownership: a schedule the pack did not
 * create is never adopted, updated or removed. A declared key that is gone
 * from the workspace is re-created; a key the lock records but the manifest no
 * longer declares is deleted.
 */
export function diffSchedules(
  manifest: SystemManifest,
  live: LiveSchedule[],
  lock: SystemLock | null,
  ctx: { bindings?: Record<string, string>; answers?: Record<string, unknown>; channelIds?: Record<string, string> } = {},
): ScheduleOp[] {
  const ops: ScheduleOp[] = []
  const byId = new Map(live.map((s) => [s.id, s]))
  const locked = lock?.schedules ?? {}
  for (const spec of manifest.schedules) {
    const values = resolveScheduleValues(spec, ctx)
    const hash = scheduleHash(spec, ctx.answers)
    const entry = locked[spec.key]
    const current = entry ? byId.get(entry.id) ?? null : null
    if (values.error) {
      // A spec that cannot become a schedule (an unanswered hour, a bad zone)
      // is reported by the caller and nothing is written for it.
      ops.push({ kind: 'schedule', key: spec.key, action: current ? 'update' : 'create', scheduleId: current?.id ?? null, spec, hash, values, error: values.error })
      continue
    }
    if (!current) {
      ops.push({ kind: 'schedule', key: spec.key, action: 'create', scheduleId: null, spec, hash, values })
      continue
    }
    if (entry!.hash === hash && !scheduleDrifted(current, values, ctx.channelIds?.[values.channel ?? ''])) continue
    ops.push({ kind: 'schedule', key: spec.key, action: 'update', scheduleId: current.id, spec, hash, values })
  }
  const declared = new Set(manifest.schedules.map((s) => s.key))
  for (const [key, entry] of Object.entries(locked)) {
    if (declared.has(key) || !byId.has(entry.id)) continue
    ops.push({ kind: 'schedule', key, action: 'delete', scheduleId: entry.id, spec: null, hash: null, values: null })
  }
  return ops
}

/**
 * A schedule edited outside the manifest (or created before a channel moved)
 * is repaired on the next apply. Fields whose template could not be resolved
 * yet — a project created earlier in this same apply, a channel not reached —
 * are not compared, so a dry run never reports a spurious update.
 */
function scheduleDrifted(current: LiveSchedule, values: ScheduleValues, channelId: string | undefined): boolean {
  if (current.name !== values.name) return true
  if (current.cronExpression !== values.cronExpression) return true
  if (current.timezone !== values.timezone) return true
  if (current.enabled !== values.enabled) return true
  if (!values.prompt.includes('{{') && current.prompt !== values.prompt) return true
  if (values.channel && channelId && (current.notifyConversationId ?? null) !== channelId) return true
  return false
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
  for (const c of diff.configure) {
    const keys = Object.keys({ ...c.patch, ...(c.patch.agent ?? {}), ...(c.patch.settings ?? {}) }).filter((k) => k !== 'agent' && k !== 'settings')
    lines.push(`configure ${c.key}: ${keys.join(', ')}`)
  }
  for (const a of diff.attach) lines.push(`${a.changeMode ? 'remode' : 'attach'} ${a.anchorKey === IMPLICIT_ANCHOR_KEY ? '(caller)' : a.anchorKey} → ${a.targetKey} [${a.mode}]`)
  for (const d of diff.detach) lines.push(`detach ${d.anchorKey} → ${d.targetKey}`)
  for (const f of diff.files) {
    if (f.action === 'unchanged') continue
    if (f.action === 'skip') lines.push(fileSkipWarning(f.key, f.path))
    else lines.push(`${f.action} ${f.key}/${f.path}`)
  }
  for (const ch of diff.teamChannels ?? []) {
    lines.push(ch.action === 'create'
      ? `create channel #${ch.name}${ch.changes.length ? `: ${ch.changes.join(', ')}` : ''}`
      : `update channel #${ch.name}: ${ch.changes.join(', ')}`)
  }
  for (const b of diff.boards ?? []) {
    lines.push(`${b.action} board #${b.channel} ${b.name}${b.changes.length ? `: ${b.changes.join(', ')}` : ''}`)
  }
  for (const t of diff.triggers ?? []) lines.push(`${t.action} trigger ${t.key}${t.spec ? ` "${t.spec.name}"` : ''}`)
  for (const s of diff.schedules ?? []) {
    lines.push(s.error
      ? `skip schedule ${s.key} — ${s.error}`
      : s.action === 'delete'
        ? `delete schedule ${s.key}`
        : `${s.action} schedule ${s.key} "${s.values?.name ?? ''}"${s.values ? ` (${s.values.cronExpression} ${s.values.timezone}${s.values.channel ? ` → #${s.values.channel}` : ''}${s.values.enabled ? '' : ', disabled'})` : ''}`)
  }
  return lines
}
