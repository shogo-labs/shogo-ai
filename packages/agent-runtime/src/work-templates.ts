// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Work templates: board templates, department bundles and company bundles.
 *
 * This file is the source of truth. `templates/boards/*.yaml`,
 * `templates/departments/<id>/shogo-system.yaml` and
 * `templates/companies/<id>/shogo-system.yaml` are rendered from it by
 * `work-templates-gen.ts` (a test fails on drift).
 *
 * A department bundle is one team channel with its boards, a department agent
 * project (AGENTS.md, HEARTBEAT.md, capabilities, heartbeat) that is a member
 * of the channel, and any triggers that turn events into cards. A company
 * bundle is several department bundles in one manifest.
 *
 * Templates are merged into the workspace's one `shogo-system.yaml` rather
 * than applied as separate manifests: the lock records one manifest's
 * bindings and triggers, so applying bundles one after another as separate
 * files would delete the earlier bundle's triggers.
 *
 * Pure apart from YAML rendering. No I/O.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Category = 'backlog' | 'active' | 'waiting' | 'review' | 'done' | 'dismissed'

interface ColumnSpec { name: string; category: Category; wipLimit?: number; slaHours?: number; agent?: string }
interface FieldSpec { key: string; label?: string; type?: 'text' | 'number' | 'money' | 'date' | 'select' | 'user' | 'url' | 'boolean'; options?: string[]; required?: boolean }

export interface BoardSpecInput {
  name: string
  itemType: 'task' | 'problem' | 'ticket' | 'deal' | 'candidate' | 'approval' | 'content' | 'custom'
  description?: string
  keyPrefix?: string
  columns?: ColumnSpec[]
  fields?: FieldSpec[]
  postToChannel?: 'all' | 'done_only' | 'none'
  requiresHumanReview?: boolean
  defaultAgent?: string
  /**
   * Template the board came from, recorded on the board row. Server behaviour
   * keys off it where a board is more than a board — the Solo Founder course
   * board (`solo-founder-course`) refuses to close a lesson until its check
   * passes.
   */
  templateId?: string
}

export interface BoardTemplate {
  id: string
  name: string
  summary: string
  /** Channel the board goes in when none is given. */
  channel: string
  board: BoardSpecInput
}

interface TriggerSpecInput {
  key: string
  name: string
  event: string
  target: 'work_item'
  card: { board: string; channel: string; title: string; description?: string; priority?: string; dedupeKey?: string }
}

export interface DepartmentBundle {
  id: string
  name: string
  summary: string
  channel: { name: string; topic: string; private?: boolean }
  /** Board template ids, in tab order. The department agent becomes each board's default agent. */
  boards: string[]
  agent: {
    key: string
    name: string
    description: string
    /** What the agent does, one line per responsibility (AGENTS.md). */
    duties: string[]
    /** Things it must never do (AGENTS.md). */
    limits: string[]
    /** Heartbeat checklist (HEARTBEAT.md). */
    heartbeat: string[]
    capabilities: Record<string, boolean>
    heartbeatInterval: number
  }
  triggers?: TriggerSpecInput[]
  /** Advisory: integrations that feed this department; connected by hand. */
  integrations?: string[]
  /**
   * Not in the public catalogue: `work_template_list` and `work_template_add`
   * never offer it. Installed by code that knows what it is for — today the
   * Solo Founder course's #course department.
   */
  hidden?: boolean
}

/**
 * Per-company tweaks to a department it borrows, so a company can reuse a
 * department without a near-copy of it (the Solo Founder OS wants the
 * `operations` department in #ops, and every agent on one model).
 */
export interface DepartmentOverride {
  /** Channel name instead of the department's own. */
  channel?: string
  /** Channel topic, when a company's channel means something else. */
  channelTopic?: string
  /** Agent model id instead of `auto`. */
  model?: string
  /** Project key, display name and description instead of the department's agent. */
  agentKey?: string
  agentName?: string
  description?: string
  /** Replaces the agent's own copy: a company writes its duties in its own words. */
  duties?: string[]
  limits?: string[]
  heartbeat?: string[]
  /** Board template ids this company's channel installs, instead of all of them. */
  boards?: string[]
  /** Seconds between heartbeat sweeps instead of the department's default. */
  heartbeatInterval?: number
}

export interface CompanyBundle {
  id: string
  name: string
  summary: string
  departments: string[]
  /** Keyed by department id. */
  overrides?: Record<string, DepartmentOverride>
  /** Not in the public catalogue. See `DepartmentBundle.hidden`. */
  hidden?: boolean
}

export type WorkTemplateKind = 'board' | 'department' | 'company'

export interface WorkTemplateSummary {
  id: string
  kind: WorkTemplateKind
  name: string
  summary: string
  /** Boards (by `#channel Board`) the template adds. */
  adds: string[]
}

// ---------------------------------------------------------------------------
// Board templates
// ---------------------------------------------------------------------------

const col = (name: string, category: Category, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({ name, category, ...extra })

export const BOARD_TEMPLATES: BoardTemplate[] = [
  {
    id: 'support-tickets',
    name: 'Support Tickets',
    summary: 'Customer tickets from new to solved, with a first-response SLA and a waiting-on-customer column.',
    channel: 'support',
    board: {
      name: 'Tickets',
      itemType: 'ticket',
      keyPrefix: 'SUP',
      description: 'Every customer request. Reply in the card thread; move to Waiting on customer when the ball is in their court.',
      columns: [
        col('New', 'backlog', { slaHours: 4 }),
        col('Open', 'active', { wipLimit: 15, slaHours: 24 }),
        col('Waiting on customer', 'waiting'),
        col('Solved', 'done'),
      ],
      fields: [
        { key: 'customer', label: 'Customer', type: 'text', required: true },
        { key: 'plan', label: 'Plan', type: 'select', options: ['free', 'pro', 'enterprise'] },
        { key: 'channel', label: 'Came in via', type: 'select', options: ['email', 'chat', 'phone', 'social'] },
      ],
      postToChannel: 'done_only',
    },
  },
  {
    id: 'bug-triage',
    name: 'Bug Triage',
    summary: 'Reported bugs triaged to a severity and owner, fixed, and verified.',
    channel: 'engineering',
    board: {
      name: 'Bugs',
      itemType: 'task',
      keyPrefix: 'BUG',
      description: 'Bugs reported by people or escalated from #support. Triage sets severity and an owner within a day.',
      columns: [
        col('Reported', 'backlog', { slaHours: 24 }),
        col('Triaged', 'backlog'),
        col('Fixing', 'active', { wipLimit: 6 }),
        col('In review', 'review'),
        col('Verified', 'done'),
        col("Won't fix", 'dismissed'),
      ],
      fields: [
        { key: 'severity', label: 'Severity', type: 'select', options: ['sev1', 'sev2', 'sev3', 'sev4'], required: true },
        { key: 'area', label: 'Area', type: 'text' },
        { key: 'pr', label: 'Pull request', type: 'url' },
      ],
      requiresHumanReview: true,
    },
  },
  {
    id: 'engineering-problems',
    name: 'Engineering Problems',
    summary: 'Production errors grouped by fingerprint, investigated, and resolved (Interfere-style Problems).',
    channel: 'engineering',
    board: {
      name: 'Problems',
      itemType: 'problem',
      keyPrefix: 'PRB',
      description: 'Errors and regressions reported by monitoring. Repeats of the same fingerprint update the open card.',
      postToChannel: 'all',
    },
  },
  {
    id: 'sales-pipeline',
    name: 'Sales Pipeline',
    summary: 'Deals from lead to won or lost, with amount, close date and next step.',
    channel: 'sales',
    board: {
      name: 'Pipeline',
      itemType: 'deal',
      keyPrefix: 'DEAL',
      description: 'Every open deal. A deal without a next step and a date is stale.',
      columns: [
        col('Lead', 'backlog', { slaHours: 48 }),
        col('Qualified', 'active'),
        col('Proposal', 'active'),
        col('Negotiation', 'review'),
        col('Won', 'done'),
        col('Lost', 'dismissed'),
      ],
      fields: [
        { key: 'company', label: 'Company', type: 'text', required: true },
        { key: 'amount', label: 'Amount', type: 'money' },
        { key: 'closeDate', label: 'Expected close', type: 'date' },
        { key: 'nextStep', label: 'Next step', type: 'text' },
        { key: 'lostReason', label: 'Lost reason', type: 'select', options: ['price', 'timing', 'competitor', 'no decision', 'fit'] },
      ],
      postToChannel: 'done_only',
    },
  },
  {
    id: 'renewals',
    name: 'Renewals',
    summary: 'Upcoming renewals worked 90 days out, with risk and expansion flagged.',
    channel: 'sales',
    board: {
      name: 'Renewals',
      itemType: 'deal',
      keyPrefix: 'REN',
      description: 'Contracts up for renewal. Open a card 90 days before the renewal date.',
      columns: [
        col('Upcoming', 'backlog'),
        col('In conversation', 'active'),
        col('At risk', 'waiting'),
        col('Renewed', 'done'),
        col('Churned', 'dismissed'),
      ],
      fields: [
        { key: 'company', label: 'Company', type: 'text', required: true },
        { key: 'arr', label: 'ARR', type: 'money' },
        { key: 'renewalDate', label: 'Renewal date', type: 'date', required: true },
        { key: 'risk', label: 'Risk', type: 'select', options: ['low', 'medium', 'high'] },
      ],
    },
  },
  {
    id: 'hiring-candidates',
    name: 'Hiring Candidates',
    summary: 'Candidates per role from applied to hired, with a screening SLA.',
    channel: 'people',
    board: {
      name: 'Candidates',
      itemType: 'candidate',
      keyPrefix: 'CAN',
      description: 'One card per candidate. Decisions are made by people; agents screen and schedule.',
      columns: [
        col('Applied', 'backlog', { slaHours: 72 }),
        col('Screen', 'active'),
        col('Interview', 'active'),
        col('Offer', 'review'),
        col('Hired', 'done'),
        col('Rejected', 'dismissed'),
      ],
      fields: [
        { key: 'role', label: 'Role', type: 'text', required: true },
        { key: 'source', label: 'Source', type: 'select', options: ['inbound', 'referral', 'sourced', 'agency'] },
        { key: 'resume', label: 'Resume', type: 'url' },
      ],
      postToChannel: 'none',
      requiresHumanReview: true,
    },
  },
  {
    id: 'onboarding-checklist',
    name: 'Onboarding Checklist',
    summary: 'A card per new teammate covering accounts, equipment and first-week goals.',
    channel: 'people',
    board: {
      name: 'Onboarding',
      itemType: 'task',
      keyPrefix: 'ONB',
      description: 'Opened when someone joins the workspace. Done when they have access, a buddy, and first-week goals.',
      columns: [
        col('Starting soon', 'backlog'),
        col('Setting up', 'active', { slaHours: 48 }),
        col('First week', 'active'),
        col('Onboarded', 'done'),
      ],
      fields: [
        { key: 'startDate', label: 'Start date', type: 'date' },
        { key: 'buddy', label: 'Buddy', type: 'user' },
        { key: 'team', label: 'Team', type: 'text' },
      ],
    },
  },
  {
    id: 'finance-approvals',
    name: 'Finance Approvals',
    summary: 'Spend and invoice approvals with an amount, a cost center and a human sign-off.',
    channel: 'finance',
    board: {
      name: 'Approvals',
      itemType: 'approval',
      keyPrefix: 'APR',
      description: 'Purchase requests and vendor invoices. A person approves; agents check the budget and paperwork first.',
      columns: [
        col('Requested', 'backlog', { slaHours: 24 }),
        col('Checking', 'active'),
        col('Needs approval', 'review', { slaHours: 48 }),
        col('Approved', 'done'),
        col('Rejected', 'dismissed'),
      ],
      fields: [
        { key: 'amount', label: 'Amount', type: 'money', required: true },
        { key: 'vendor', label: 'Vendor', type: 'text' },
        { key: 'costCenter', label: 'Cost center', type: 'select', options: ['engineering', 'sales', 'marketing', 'operations', 'people', 'g&a'] },
        { key: 'receipt', label: 'Receipt or invoice', type: 'url' },
      ],
      requiresHumanReview: true,
      postToChannel: 'done_only',
    },
  },
  {
    id: 'collections',
    name: 'Collections',
    summary: 'Overdue invoices chased on a schedule until paid or written off.',
    channel: 'finance',
    board: {
      name: 'Collections',
      itemType: 'task',
      keyPrefix: 'COL',
      description: 'One card per overdue invoice. Reminders at 7, 14 and 30 days; escalate to the account owner after 30.',
      columns: [
        col('Overdue', 'backlog', { slaHours: 24 }),
        col('Reminded', 'waiting', { slaHours: 168 }),
        col('Escalated', 'active'),
        col('Paid', 'done'),
        col('Written off', 'dismissed'),
      ],
      fields: [
        { key: 'customer', label: 'Customer', type: 'text', required: true },
        { key: 'invoice', label: 'Invoice', type: 'text', required: true },
        { key: 'amount', label: 'Amount due', type: 'money', required: true },
        { key: 'dueDate', label: 'Due date', type: 'date' },
      ],
    },
  },
  {
    id: 'content-calendar',
    name: 'Content Calendar',
    summary: 'Posts, articles and newsletters from idea to published, with a publish date.',
    channel: 'marketing',
    board: {
      name: 'Content',
      itemType: 'content',
      keyPrefix: 'CNT',
      description: 'Everything we publish. A card needs a publish date before it leaves Drafting.',
      columns: [
        col('Ideas', 'backlog'),
        col('Drafting', 'active', { wipLimit: 5 }),
        col('Review', 'review', { slaHours: 48 }),
        col('Scheduled', 'waiting'),
        col('Published', 'done'),
      ],
      fields: [
        { key: 'format', label: 'Format', type: 'select', options: ['blog', 'newsletter', 'social', 'video', 'case study'] },
        { key: 'publishDate', label: 'Publish date', type: 'date' },
        { key: 'link', label: 'Link', type: 'url' },
      ],
      requiresHumanReview: true,
    },
  },
  {
    id: 'campaigns',
    name: 'Campaigns',
    summary: 'Marketing campaigns from brief to launched and measured.',
    channel: 'marketing',
    board: {
      name: 'Campaigns',
      itemType: 'task',
      keyPrefix: 'CMP',
      description: 'Launches, promotions and events. Close a card only after its results are posted.',
      columns: [
        col('Brief', 'backlog'),
        col('Building', 'active'),
        col('Live', 'active'),
        col('Measuring', 'review'),
        col('Done', 'done'),
      ],
      fields: [
        { key: 'goal', label: 'Goal', type: 'text' },
        { key: 'budget', label: 'Budget', type: 'money' },
        { key: 'launchDate', label: 'Launch date', type: 'date' },
      ],
    },
  },
  {
    id: 'build-backlog',
    name: 'Build Backlog',
    summary: 'What to build next, from idea to shipped, one person or a small team.',
    channel: 'build',
    board: {
      name: 'Backlog',
      itemType: 'task',
      keyPrefix: 'BLD',
      description: 'Everything we intend to build. A card leaves Review only when the change is actually live.',
      columns: [
        col('Ideas', 'backlog'),
        col('Building', 'active', { wipLimit: 2 }),
        col('Review', 'review', { slaHours: 48 }),
        col('Shipped', 'done'),
        col('Dropped', 'dismissed'),
      ],
      fields: [
        { key: 'area', label: 'Area', type: 'text' },
        { key: 'size', label: 'Size', type: 'select', options: ['S', 'M', 'L'] },
        { key: 'link', label: 'Link', type: 'url' },
      ],
      requiresHumanReview: true,
    },
  },
  {
    id: 'solo-founder-course',
    name: 'Course',
    summary: 'One card per lesson, closed only when the workspace shows the lesson produced something.',
    channel: 'course',
    board: {
      name: 'Course',
      itemType: 'custom',
      keyPrefix: 'SF',
      description:
        'Your 30 days. Move a lesson to Checking when you think it is done: the server checks the card against your workspace before it can reach Done.',
      columns: [
        col('Up next', 'backlog'),
        col('This week', 'active'),
        col('Checking', 'waiting', { agent: 'coach' }),
        col('Done', 'done'),
        col('Skipped', 'dismissed'),
      ],
      fields: [
        { key: 'lessonId', label: 'Lesson', type: 'text' },
        { key: 'module', label: 'Module', type: 'number' },
        { key: 'videoUrl', label: 'Video', type: 'url' },
        { key: 'output', label: 'Output', type: 'text' },
        { key: 'check', label: 'Check', type: 'text' },
      ],
      templateId: 'solo-founder-course',
    },
  },
  {
    id: 'vendor-requests',
    name: 'Vendor Requests',
    summary: 'New vendors and tools requested, reviewed for security and cost, then set up.',
    channel: 'operations',
    board: {
      name: 'Vendor requests',
      itemType: 'approval',
      keyPrefix: 'VEN',
      description: 'Requests for new tools, suppliers and contractors.',
      columns: [
        col('Requested', 'backlog', { slaHours: 48 }),
        col('Reviewing', 'active'),
        col('Needs approval', 'review'),
        col('Set up', 'done'),
        col('Declined', 'dismissed'),
      ],
      fields: [
        { key: 'vendor', label: 'Vendor', type: 'text', required: true },
        { key: 'annualCost', label: 'Annual cost', type: 'money' },
        { key: 'dataAccess', label: 'Touches customer data', type: 'boolean' },
      ],
      requiresHumanReview: true,
    },
  },
  {
    id: 'legal-review',
    name: 'Legal Review',
    summary: 'Contracts and policies through review, redlines and signature.',
    channel: 'legal',
    board: {
      name: 'Contracts',
      itemType: 'approval',
      keyPrefix: 'LGL',
      description: 'NDAs, MSAs, DPAs and policy changes. Agents summarise and flag; a person approves.',
      columns: [
        col('Requested', 'backlog', { slaHours: 48 }),
        col('Reviewing', 'active'),
        col('Redlines out', 'waiting'),
        col('Ready to sign', 'review'),
        col('Signed', 'done'),
        col('Dropped', 'dismissed'),
      ],
      fields: [
        { key: 'counterparty', label: 'Counterparty', type: 'text', required: true },
        { key: 'contractType', label: 'Type', type: 'select', options: ['NDA', 'MSA', 'DPA', 'SOW', 'policy', 'other'] },
        { key: 'value', label: 'Contract value', type: 'money' },
        { key: 'document', label: 'Document', type: 'url' },
      ],
      requiresHumanReview: true,
      postToChannel: 'done_only',
    },
  },
  {
    id: 'okrs',
    name: 'OKRs',
    summary: "The quarter's key results, each with an owner and a status that is updated weekly.",
    channel: 'operations',
    board: {
      name: 'OKRs',
      itemType: 'custom',
      keyPrefix: 'OKR',
      description: 'One card per key result. Update the confidence field every week.',
      columns: [
        col('Not started', 'backlog'),
        col('On track', 'active'),
        col('At risk', 'waiting'),
        col('Achieved', 'done'),
        col('Missed', 'dismissed'),
      ],
      fields: [
        { key: 'objective', label: 'Objective', type: 'text', required: true },
        { key: 'target', label: 'Target', type: 'text' },
        { key: 'confidence', label: 'Confidence', type: 'select', options: ['high', 'medium', 'low'] },
      ],
    },
  },
]

// ---------------------------------------------------------------------------
// Department bundles
// ---------------------------------------------------------------------------

const WORKER = { boardsEnabled: true, boardAdminEnabled: false, teamChatEnabled: true, companyOpsEnabled: false }
// Cards wake their agents directly; the heartbeat only sweeps for what slipped through.
const SWEEP_INTERVAL = 4 * 3600

export const DEPARTMENTS: DepartmentBundle[] = [
  {
    id: 'support',
    name: 'Support',
    summary: 'A #support channel with a Tickets board and a support agent that triages, drafts replies and escalates bugs.',
    channel: { name: 'support', topic: 'Customer tickets. Every request is a card on Tickets.' },
    boards: ['support-tickets'],
    agent: {
      key: 'support-agent',
      name: 'Support Agent',
      description: 'Triages new tickets, drafts replies, and escalates bugs to engineering.',
      duties: [
        'Triage every card in New within its SLA: set priority, the customer and plan fields, and an owner.',
        'Draft the reply in the card thread. Answer directly only for how-to questions covered by the docs.',
        'When a ticket is a bug, move it to the Engineering Bugs board with work_item_move and say why in the thread.',
        'Move a card to Waiting on customer when you are waiting on them, and back to Open when they reply.',
      ],
      limits: [
        'Do not promise refunds, credits or dates; tag a person for those.',
        'Do not close a ticket the customer has not confirmed is solved.',
      ],
      heartbeat: [
        'board_health for #support. Triage anything in New past its SLA.',
        'For cards in Waiting on customer over 3 days, post a friendly follow-up draft in the thread.',
        'Post nothing if nothing needs attention.',
      ],
      capabilities: WORKER,
      heartbeatInterval: SWEEP_INTERVAL,
    },
    integrations: ['zendesk', 'intercom', 'gmail'],
  },
  {
    id: 'sales',
    name: 'Sales',
    summary: 'A #sales channel with Pipeline and Renewals boards and a sales agent that keeps every deal moving.',
    channel: { name: 'sales', topic: 'Deals and renewals. Every deal is a card on Pipeline.' },
    boards: ['sales-pipeline', 'renewals'],
    agent: {
      key: 'sales-agent',
      name: 'Sales Agent',
      description: 'Qualifies leads, keeps next steps current, and flags renewals at risk.',
      duties: [
        'Qualify new leads: fill company and amount, and move to Qualified or Lost with a reason.',
        'Every open deal needs a next step and an expected close date. Ask the owner in the thread when one is missing.',
        'Open a Renewals card 90 days before each renewal date and flag risk from recent support tickets.',
        'Draft follow-up emails in the card thread; a person sends them.',
      ],
      limits: [
        'Do not change amounts or close dates someone else set without saying so in the thread.',
        'Do not send email to customers yourself.',
      ],
      heartbeat: [
        'board_health for #sales. Ask the owner about any deal with no activity in 7 days.',
        'Move renewals with an open urgent support ticket to At risk and tag the owner.',
      ],
      capabilities: WORKER,
      heartbeatInterval: SWEEP_INTERVAL,
    },
    integrations: ['hubspot', 'salesforce', 'gmail'],
  },
  {
    id: 'marketing',
    name: 'Marketing',
    summary: 'A #marketing channel with Content and Campaigns boards and an agent that drafts and keeps the calendar honest.',
    channel: { name: 'marketing', topic: 'Content calendar and campaigns.' },
    boards: ['content-calendar', 'campaigns'],
    agent: {
      key: 'marketing-agent',
      name: 'Marketing Agent',
      description: 'Drafts content, keeps the calendar dated, and reports campaign results.',
      duties: [
        'Turn ideas into outlines and first drafts in the card thread when a card moves to Drafting.',
        'Make sure every card in Drafting or later has a publish date.',
        'When a campaign moves to Measuring, collect its results and post them in the thread.',
      ],
      limits: ['Never publish or schedule anything yourself; a person approves in Review.'],
      heartbeat: [
        'board_health for #marketing. Ask about cards in Review over 2 days.',
        'Flag Scheduled cards whose publish date has passed.',
      ],
      capabilities: WORKER,
      heartbeatInterval: SWEEP_INTERVAL,
    },
  },
  {
    id: 'engineering',
    name: 'Engineering',
    summary: 'An #engineering channel with Bugs and Problems boards and an engineering agent that triages and investigates.',
    channel: { name: 'engineering', topic: 'Bugs and production problems.' },
    boards: ['bug-triage', 'engineering-problems'],
    agent: {
      key: 'engineering-agent',
      name: 'Engineering Agent',
      description: 'Triages bugs, investigates production problems, and links fixes.',
      duties: [
        'Triage Reported bugs within a day: set severity and area, find duplicates, and suggest an owner.',
        'For a new Problem, read its occurrences, find the likely cause, and write it in the thread.',
        'Link the pull request to the card (work_item_link) and move it to In review when one is open.',
        'For the full reproduce, plan, implement, review pipeline, apply the issue-pipeline template.',
      ],
      limits: ['Do not mark a bug Verified; a person verifies the fix.', "Do not move a sev1 to Won't fix."],
      heartbeat: [
        'board_health for #engineering. Escalate any sev1 or Problem with no owner to #engineering with an alert.',
        'Check cards in In review for merged pull requests.',
      ],
      capabilities: { ...WORKER, problemsEnabled: true },
      heartbeatInterval: SWEEP_INTERVAL,
    },
    integrations: ['github', 'sentry', 'linear'],
  },
  {
    id: 'people',
    name: 'People',
    summary: 'A #people channel with Candidates and Onboarding boards; new members get an onboarding card automatically.',
    channel: { name: 'people', topic: 'Hiring and onboarding.', private: true },
    boards: ['hiring-candidates', 'onboarding-checklist'],
    agent: {
      key: 'people-agent',
      name: 'People Agent',
      description: 'Screens applicants against the role, schedules interviews, and runs onboarding.',
      duties: [
        'Screen new applicants against the role requirements and write a short summary with evidence from the resume.',
        "Recommend Screen or Rejected; a person decides. Never use age, gender, ethnicity or other protected attributes.",
        'For each onboarding card, list the accounts, equipment and first-week goals, and check them off in the thread.',
      ],
      limits: [
        'Do not move a candidate to Offer, Hired or Rejected yourself.',
        'Keep candidate details in #people; do not post them elsewhere.',
      ],
      heartbeat: [
        'board_health for #people. Summarise applicants waiting past the screening SLA.',
        'Nudge the buddy on onboarding cards with no activity in 2 days.',
      ],
      capabilities: WORKER,
      heartbeatInterval: SWEEP_INTERVAL,
    },
    triggers: [
      {
        key: 'onboard-new-members',
        name: 'Onboarding card for each new member',
        event: 'member.joined',
        target: 'work_item',
        card: {
          board: 'Onboarding',
          channel: 'people',
          title: 'Onboard {{member.name}}',
          description: '{{member.name}} joined the workspace as {{member.role}}.',
          dedupeKey: '{{member.userId}}',
        },
      },
    ],
    integrations: ['greenhouse', 'google-calendar'],
  },
  {
    id: 'finance',
    name: 'Finance',
    summary: 'A #finance channel with Approvals and Collections boards and an agent that checks requests and chases invoices.',
    channel: { name: 'finance', topic: 'Spend approvals and collections.', private: true },
    boards: ['finance-approvals', 'collections'],
    agent: {
      key: 'finance-agent',
      name: 'Finance Agent',
      description: 'Checks spend requests against budget and policy, and chases overdue invoices.',
      duties: [
        'For each request, check the amount, vendor and receipt, compare with the cost center budget, and move it to Needs approval with a one-line recommendation.',
        'Flag duplicates: same vendor and amount within 30 days.',
        'Draft collection reminders at 7, 14 and 30 days overdue; escalate after 30 by tagging the account owner.',
      ],
      limits: ['Never approve spend or mark an invoice Paid yourself.', 'Keep amounts and customers in #finance.'],
      heartbeat: [
        'board_health for #finance. Ask the approver about requests in Needs approval past 2 days.',
        'Move Reminded collections past 7 days back to Overdue for the next reminder.',
      ],
      capabilities: WORKER,
      heartbeatInterval: SWEEP_INTERVAL,
    },
    integrations: ['quickbooks', 'stripe'],
  },
  {
    id: 'operations',
    name: 'Operations',
    summary: 'An #operations channel with Vendor requests and OKRs boards and an agent that runs reviews and weekly check-ins.',
    channel: { name: 'operations', topic: 'Vendors, tools and the quarterly OKRs.' },
    boards: ['vendor-requests', 'okrs'],
    agent: {
      key: 'operations-agent',
      name: 'Operations Agent',
      description: 'Reviews vendor requests and runs the weekly OKR check-in.',
      duties: [
        'For a vendor request, check for an existing tool that does the same job, note the cost and whether it touches customer data, and move it to Needs approval.',
        'Every Monday, ask each OKR owner for their confidence in the card thread and move the card to match.',
      ],
      limits: ['Do not sign up for or pay vendors.', 'Do not change an OKR target.'],
      heartbeat: [
        'board_health for #operations.',
        'On Mondays, start the OKR check-in if it has not run this week.',
      ],
      capabilities: WORKER,
      heartbeatInterval: SWEEP_INTERVAL,
    },
  },
  {
    id: 'build',
    name: 'Build',
    summary: 'A #build channel with a Backlog board and a builder agent that takes an idea to shipped.',
    channel: { name: 'build', topic: 'What we are building. Every idea is a card on Backlog.' },
    boards: ['build-backlog'],
    agent: {
      key: 'build-agent',
      name: 'Builder',
      description: 'Turns an idea on the Backlog into something shipped, and keeps the card honest about it.',
      duties: [
        'For a card in Ideas, write the smallest version that is worth shipping and its acceptance criteria in the thread.',
        'When a card moves to Building, implement it, test it, and post what changed and where it runs.',
        'Move a card to Review only when it is live and you have said how to see it; never mark it Shipped yourself.',
        'When Review sends a card back, fix what was raised and say what you changed.',
      ],
      limits: [
        'Do not move a card to Shipped; a person decides that.',
        'Do not change the acceptance criteria after a card leaves Ideas without saying so in the thread.',
      ],
      heartbeat: [
        'board_health for #build. Move any card in Ideas past 3 days to a blocker or ask the owner in the thread.',
        'For cards in Review over 2 days, post one nudge with what a reviewer needs to check.',
      ],
      capabilities: WORKER,
      heartbeatInterval: SWEEP_INTERVAL,
    },
  },
  {
    id: 'course',
    name: 'Course',
    summary: 'A #course channel with the Course board and a Coach that runs one lesson at a time and checks the output.',
    channel: { name: 'course', topic: 'Your Solo Founder course. One lesson at a time.' },
    boards: ['solo-founder-course'],
    hidden: true,
    agent: {
      key: 'coach',
      name: 'Coach',
      description: 'Runs the Solo Founder course: posts each lesson, checks the learner\'s work, and helps when they\'re stuck.',
      duties: [
        'Post each lesson when it moves to This week: what to watch, the exact prompt to paste and where, and what "done" looks like.',
        'When the learner says they are done or moves a lesson to Checking, look at their setup with your tools (`project_list`, `schedule_list`, `work_item_list`, `team_chat_doc_read`) and then try to move it to Done. The server runs the check. If it refuses, explain what is missing in plain words, give the next step, and move it back to This week.',
        "For lessons the server does not check (M2, M3, M5, M10), ask for the evidence listed on the card (a link, a screenshot, a pasted reply) and judge honestly.",
        'When a lesson is Done, celebrate in one line, pull the next lesson into This week, and post it.',
        'In Lesson 0, explain models: cheap models for routine work, stronger ones for hard builds, and where the usage cap is set.',
      ],
      limits: [
        'Never mark a lesson Done any other way than by the server check (or, for unchecked lessons, real evidence).',
        'Never do the lesson for the learner. Help them do it.',
        'After 3 nudges with no reply, stop nudging until the learner writes.',
      ],
      heartbeat: [
        'Nothing on a timer: the daily 09:00 nudge is its own schedule, not this sweep. If the learner has not written and no lesson sits in Checking, say nothing.',
      ],
      capabilities: WORKER,
      heartbeatInterval: 24 * 3600,
    },
  },
  {
    id: 'legal',
    name: 'Legal',
    summary: 'A #legal channel with a Contracts board and an agent that summarises contracts and flags risky terms.',
    channel: { name: 'legal', topic: 'Contracts and policy reviews.', private: true },
    boards: ['legal-review'],
    agent: {
      key: 'legal-agent',
      name: 'Legal Agent',
      description: 'Summarises contracts, compares them with our standard terms, and flags risk.',
      duties: [
        'For each contract, post a summary: parties, term, value, renewal, liability cap, and anything that differs from our standard terms.',
        'Rate risk low, medium or high and say why.',
        'Move to Redlines out when we have sent changes, and to Ready to sign when both sides agree.',
      ],
      limits: ['You are not a lawyer: never tell anyone a contract is safe to sign.', 'Never move a card to Signed.'],
      heartbeat: ['board_health for #legal. Ask about contracts in Redlines out over 5 days.'],
      capabilities: WORKER,
      heartbeatInterval: SWEEP_INTERVAL,
    },
    integrations: ['docusign', 'google-drive'],
  },
]

// ---------------------------------------------------------------------------
// Company bundles
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Solo Founder OS
//
// The company that ships with the $99 course (SHO-428). Content comes from
// Russell's course work (2026-11-18): five agents, each with its own duties,
// every one on the economy model and a once-a-day heartbeat — six agents
// sweeping every four hours would spend a beginner's AI allowance on empty
// boards. The shared duties and limits are written into all five.
// ---------------------------------------------------------------------------

/** Prepended to every Solo Founder OS agent's duties. */
const SOLO_FOUNDER_SHARED_DUTIES = [
  'Before starting new work, read the company brief in the #ops channel doc (`team_chat_doc_read`). If it is missing, ask the founder to do Lesson 0 first.',
  'Write for a busy founder: short, plain, the decision you need first.',
  "End every task with a checklist of what you were asked to do, each marked done / not done / couldn't check, with one line of evidence. Never mark something done you didn't verify.",
]

/** Prepended to every Solo Founder OS agent's limits. */
const SOLO_FOUNDER_SHARED_LIMITS = [
  "Never publish, send, post, spend or delete anything outside Shogo without the founder's approval in the thread.",
  "Never invent facts, numbers, testimonials or customer names. If it isn't in the brief or a source, mark it [GUESS].",
]

/** One day: the Solo Founder OS sweep interval for every agent. */
const SOLO_FOUNDER_HEARTBEAT_SECONDS = 86_400

export const COMPANIES: CompanyBundle[] = [
  {
    id: 'saas-startup',
    name: 'SaaS startup',
    summary: 'Support, Sales, Marketing, Engineering, People and Finance.',
    departments: ['support', 'sales', 'marketing', 'engineering', 'people', 'finance'],
  },
  {
    id: 'agency',
    name: 'Agency',
    summary: 'Sales, Marketing, Operations, Finance and People for a client-services agency.',
    departments: ['sales', 'marketing', 'operations', 'finance', 'people'],
  },
  {
    id: 'ecommerce',
    name: 'E-commerce',
    summary: 'Support, Marketing, Operations and Finance for an online store.',
    departments: ['support', 'marketing', 'operations', 'finance'],
  },
  {
    id: 'nonprofit',
    name: 'Nonprofit',
    summary: 'Marketing, People, Finance and Operations for a nonprofit.',
    departments: ['marketing', 'people', 'finance', 'operations'],
  },
  {
    id: 'freelancer',
    name: 'Freelancer',
    summary: 'Sales, Finance and Marketing for one person running their own business.',
    departments: ['sales', 'finance', 'marketing'],
  },
  {
    id: 'local-services',
    name: 'Local services',
    summary: 'Support, Sales, Operations and Finance for a local service business.',
    departments: ['support', 'sales', 'operations', 'finance'],
  },
  {
    id: 'solo-founder-os',
    name: 'Solo Founder OS',
    summary: 'Build, Marketing, Sales, Support and Ops for one person running a company, with every agent on the economy model.',
    departments: ['build', 'marketing', 'sales', 'support', 'operations'],
    overrides: {
      build: {
        model: 'hoshi-2-0',
        channelTopic: 'Product: ideas, builds and what shipped.',
        agentKey: 'builder',
        agentName: 'Builder',
        description: 'Plans, builds and tests product changes, then hands them to the founder for review.',
        duties: [
          ...SOLO_FOUNDER_SHARED_DUTIES,
          "When a card lands in Ideas, write a short plan in its thread: what changes, and a checklist of how we'll know it works. Ask at most 3 questions if something important is unclear.",
          "Build it, then test every checklist item yourself the way a customer would, and post what passed and what didn't.",
          'Move the card to Review and tag the founder with the preview link. If the founder sends it back, fix exactly what they said and say what changed.',
        ],
        limits: [
          ...SOLO_FOUNDER_SHARED_LIMITS,
          'Never move a card to Shipped; that is the founder\'s call.',
          "Never publish, change payments to live mode or delete data without the founder's approval in the thread.",
        ],
        heartbeat: [
          'Cards in Building with no update for 2 days: post where it stands or what you need.',
          'Post nothing if nothing needs attention.',
        ],
        heartbeatInterval: SOLO_FOUNDER_HEARTBEAT_SECONDS,
      },
      marketing: {
        model: 'hoshi-2-0',
        channelTopic: 'Content, guides and ads.',
        agentKey: 'marketer',
        agentName: 'Marketer',
        description: 'Turns the brief into posts, guides and ad ideas, and keeps the calendar moving.',
        duties: [
          ...SOLO_FOUNDER_SHARED_DUTIES,
          'Propose post ideas as cards in Ideas, each one a customer problem in their words.',
          'Draft posts when a card moves to Drafting (hook under 10 words, the post, the channel) and move them to Review.',
          "For ads: write hooks as Campaigns cards in Brief; follow the ad rules in this channel's doc. When a campaign moves to Measuring, report spend, sign-ups and cost per sign-up.",
        ],
        limits: [
          ...SOLO_FOUNDER_SHARED_LIMITS,
          'Never publish or schedule a post, and never start, change or raise ad spend; propose and wait for approval.',
          "No fake urgency, no claims we can't prove.",
        ],
        heartbeat: [
          'Cards in Review over 2 days: one-line reminder to the founder.',
          'Scheduled cards whose date has passed: flag them.',
        ],
        heartbeatInterval: SOLO_FOUNDER_HEARTBEAT_SECONDS,
      },
      sales: {
        model: 'hoshi-2-0',
        // A brand-new one-person company has no renewals, so no Renewals board.
        boards: ['sales-pipeline'],
        channelTopic: 'Leads, follow-ups and demos.',
        agentKey: 'seller',
        agentName: 'Seller',
        description: "Finds and researches leads, keeps every deal's next step current, and drafts follow-ups.",
        duties: [
          ...SOLO_FOUNDER_SHARED_DUTIES,
          'Research leads from public sources only; add each to Lead with why it fits and the evidence.',
          'Every open deal has a next step and a date. Each morning list the overdue ones and draft the follow-up in each thread.',
          "When asked, build a demo for a lead using only their public details, and send the preview (don't publish it).",
        ],
        limits: [
          ...SOLO_FOUNDER_SHARED_LIMITS,
          'Never contact a lead or send an email yourself.',
          'Never scrape private data or guess personal contact details.',
        ],
        heartbeat: [
          'Deals past their next-step date: draft the follow-up and tag the founder once.',
        ],
        heartbeatInterval: SOLO_FOUNDER_HEARTBEAT_SECONDS,
      },
      support: {
        model: 'hoshi-2-0',
        channelTopic: 'Customer questions. Every email is a ticket.',
        agentKey: 'support',
        agentName: 'Support',
        description: "Turns customer emails into tickets and drafts every reply for the founder's approval.",
        duties: [
          ...SOLO_FOUNDER_SHARED_DUTIES,
          'Triage each ticket in New: the customer, their question in one line, and a drafted reply in the thread using the brief and docs.',
          'When the founder approves a draft, send it (once email is connected) and move the ticket to Waiting on customer or Solved.',
          'When a ticket is a product bug, add a card to Ideas on the Build board and link it in the thread.',
        ],
        limits: [
          ...SOLO_FOUNDER_SHARED_LIMITS,
          "Never send a reply the founder hasn't approved.",
          'Never promise refunds, credits or dates.',
        ],
        heartbeat: [
          'Tickets in New for more than 1 day: remind the founder.',
          'Waiting on customer for over 3 days: draft a friendly follow-up.',
        ],
        heartbeatInterval: SOLO_FOUNDER_HEARTBEAT_SECONDS,
      },
      // The Solo Founder reads #ops, not #operations, and has no vendors yet.
      operations: {
        model: 'hoshi-2-0',
        channel: 'ops',
        channelTopic: 'The company brief, goals and the morning digest.',
        boards: ['okrs'],
        agentKey: 'ops',
        agentName: 'Chief of Staff',
        description: 'Keeps the company brief current, tracks the 30-day goal, and writes the digests the founder asks for.',
        duties: [
          ...SOLO_FOUNDER_SHARED_DUTIES,
          "Keep the company brief in this channel's doc up to date when the founder asks; never change it on your own.",
          "Turn the brief's 30-day goal into the first OKR card, and check its confidence with the founder each Monday.",
          'Run the routines the founder sets up (morning digest, weekly numbers, weekly review) and keep each one short.',
        ],
        limits: [
          ...SOLO_FOUNDER_SHARED_LIMITS,
          'Never sign up for or pay for tools.',
          "Never change a goal's target.",
        ],
        heartbeat: [
          "On Mondays, start the goal check-in if it hasn't run this week.",
        ],
        heartbeatInterval: SOLO_FOUNDER_HEARTBEAT_SECONDS,
      },
    },
  },
]

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function boardTemplate(id: string): BoardTemplate {
  const t = BOARD_TEMPLATES.find((b) => b.id === id)
  if (!t) throw new Error(`Unknown board template "${id}"`)
  return t
}

function department(id: string): DepartmentBundle {
  const d = DEPARTMENTS.find((x) => x.id === id)
  if (!d) throw new Error(`Unknown department "${id}"`)
  return d
}

/** The agent as it will be written, after any company override. */
interface ResolvedAgent {
  key: string
  name: string
  description: string
  duties: string[]
  limits: string[]
  heartbeat: string[]
  heartbeatInterval: number
  capabilities: Record<string, boolean>
}

function agentsMd(a: ResolvedAgent, channelName: string, boards: BoardTemplate[]): string {
  const boardLines = boards.map((t) => `- **${t.board.name}** (${t.board.keyPrefix}-): ${t.board.description ?? t.summary}`)
  return [
    `# ${a.name}`,
    '',
    `You work in #${channelName}. ${a.description}`,
    '',
    '## Boards',
    ...boardLines,
    '',
    '## What you do',
    ...a.duties.map((x) => `- ${x}`),
    '',
    '## How you work a card',
    '- Start with `work_item_get` and read the thread before acting.',
    '- Work in the card thread, not the main channel.',
    '- Before you stop, move the card and set `history_summary`: where it stands, what you did, what is next.',
    '',
    '## Never',
    ...a.limits.map((x) => `- ${x}`),
    '',
  ].join('\n')
}

function heartbeatMd(a: ResolvedAgent): string {
  return ['# Heartbeat', '', ...a.heartbeat.map((x, i) => `${i + 1}. ${x}`), ''].join('\n')
}

function departmentParts(d: DepartmentBundle, override: DepartmentOverride = {}) {
  const boards = (override.boards ?? d.boards).map(boardTemplate)
  const agent: ResolvedAgent = {
    key: override.agentKey ?? d.agent.key,
    name: override.agentName ?? d.agent.name,
    description: override.description ?? d.agent.description,
    duties: override.duties ?? d.agent.duties,
    limits: override.limits ?? d.agent.limits,
    heartbeat: override.heartbeat ?? d.agent.heartbeat,
    heartbeatInterval: override.heartbeatInterval ?? d.agent.heartbeatInterval,
    capabilities: d.agent.capabilities,
  }
  const channelName = override.channel ?? d.channel.name
  const project = {
    key: agent.key,
    name: agent.name,
    description: agent.description,
    agent: {
      model: override.model ?? 'auto',
      heartbeat: { enabled: true, interval: agent.heartbeatInterval },
      capabilities: agent.capabilities,
    },
    files: { 'AGENTS.md': agentsMd(agent, channelName, boards), 'HEARTBEAT.md': heartbeatMd(agent) },
    ...(d.integrations?.length ? { integrations: d.integrations } : {}),
  }
  const channel = {
    name: channelName,
    topic: override.channelTopic ?? d.channel.topic,
    ...(d.channel.private ? { private: true } : {}),
    members: [{ project: agent.key, agentTrigger: 'mention' }],
    boards: boards.map((t) => ({ ...t.board, defaultAgent: agent.key })),
  }
  return { project, channel, triggers: d.triggers ?? [] }
}

/** The manifest for one department or company bundle, as a plain object. */
export function bundleManifest(
  kind: 'department' | 'company',
  id: string,
  overrides?: Record<string, DepartmentOverride>,
): Record<string, unknown> {
  if (kind === 'department') {
    const d = department(id)
    const parts = departmentParts(d, overrides?.[id])
    return {
      version: 1,
      name: `${d.name} department`,
      description: d.summary,
      projects: [parts.project],
      teamChannels: [parts.channel],
      ...(parts.triggers.length ? { triggers: parts.triggers } : {}),
    }
  }
  const c = COMPANIES.find((x) => x.id === id)
  if (!c) throw new Error(`Unknown company "${id}"`)
  const parts = c.departments.map((d) => departmentParts(department(d), c.overrides?.[d]))
  const triggers = parts.flatMap((p) => p.triggers)
  return {
    version: 1,
    name: c.name,
    description: c.summary,
    projects: parts.map((p) => p.project),
    teamChannels: parts.map((p) => p.channel),
    ...(triggers.length ? { triggers } : {}),
  }
}

/**
 * The install for a paid Solo Founder course (SHO-428): the Solo Founder OS
 * company plus the hidden #course department and the Coach's one daily nudge.
 *
 * Not a catalogue template: only `soloFounderService.enroll()` applies it. The
 * Coach schedule is declared here so the M9 schedule check can exclude the
 * schedules the pack created (they are in `bindings.schedules`).
 */
export function soloFounderCourseManifest(): Record<string, unknown> {
  const company = bundleManifest('company', 'solo-founder-os') as any
  // The Coach runs on the economy model too: a beginner should not spend the
  // week's window on a course nudge.
  const course = bundleManifest('department', 'course', { course: { model: 'hoshi-2-0' } }) as any
  return {
    version: 1,
    name: 'Solo Founder OS + course',
    description: 'The Solo Founder OS company and the Course board its Coach runs.',
    projects: [...company.projects, ...course.projects],
    teamChannels: [...company.teamChannels, ...course.teamChannels],
    ...(company.triggers?.length || course.triggers?.length
      ? { triggers: [...(company.triggers ?? []), ...(course.triggers ?? [])] }
      : {}),
    schedules: [
      {
        key: 'coach-lesson-nudge',
        name: 'Coach: current lesson nudge',
        project: 'coach',
        channel: 'course',
        hour: '09:00',
        prompt:
          'Post one short nudge on the current Solo Founder lesson in #course: what is left, and the prompt to do it. Check the workspace first (project_list, work_item_list, schedule_list); never claim a lesson is done unless its check passes and the card moved.',
        enabled: true,
      },
    ],
  }
}

const YAML_OPTS = { lineWidth: 0 } as const

export function renderBoardTemplateYaml(id: string): string {
  const t = boardTemplate(id)
  const header = [
    '# GENERATED FILE — do not hand-edit. Source: packages/agent-runtime/src/work-templates.ts',
    '# Regenerate with: bun run packages/agent-runtime/src/work-templates-gen.ts',
    '#',
    '# A board template: add `board` to a team channel in shogo-system.yaml',
    '# (or call work_template_add), then run system_apply.',
    '',
  ].join('\n')
  return header + stringifyYaml({ id: t.id, name: t.name, summary: t.summary, channel: t.channel, board: t.board }, YAML_OPTS)
}

export function renderBundleYaml(kind: 'department' | 'company', id: string): string {
  const header = [
    '# GENERATED FILE — do not hand-edit. Source: packages/agent-runtime/src/work-templates.ts',
    '# Regenerate with: bun run packages/agent-runtime/src/work-templates-gen.ts',
    '',
  ].join('\n')
  return header + stringifyYaml(bundleManifest(kind, id), YAML_OPTS)
}

/** Every generated file, keyed by path relative to `templates/`. */
export function renderAllTemplateFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  for (const b of BOARD_TEMPLATES) files[`boards/${b.id}.yaml`] = renderBoardTemplateYaml(b.id)
  for (const d of DEPARTMENTS) files[`departments/${d.id}/shogo-system.yaml`] = renderBundleYaml('department', d.id)
  for (const c of COMPANIES) files[`companies/${c.id}/shogo-system.yaml`] = renderBundleYaml('company', c.id)
  return files
}

// ---------------------------------------------------------------------------
// Catalog and merge (work_template_list / work_template_add)
// ---------------------------------------------------------------------------

export function listWorkTemplates(kind?: WorkTemplateKind): WorkTemplateSummary[] {
  const out: WorkTemplateSummary[] = []
  if (!kind || kind === 'company') {
    for (const c of COMPANIES) {
      if (c.hidden) continue
      out.push({
        id: c.id, kind: 'company', name: c.name, summary: c.summary,
        adds: c.departments.flatMap((d) => {
          const channel = c.overrides?.[d]?.channel ?? department(d).channel.name
          return department(d).boards.map((b) => `#${channel} ${boardTemplate(b).board.name}`)
        }),
      })
    }
  }
  if (!kind || kind === 'department') {
    for (const d of DEPARTMENTS) {
      if (d.hidden) continue
      out.push({ id: d.id, kind: 'department', name: d.name, summary: d.summary, adds: d.boards.map((b) => `#${d.channel.name} ${boardTemplate(b).board.name}`) })
    }
  }
  if (!kind || kind === 'board') {
    for (const b of BOARD_TEMPLATES) {
      if (DEPARTMENTS.some((d) => d.hidden && d.boards.includes(b.id))) continue
      out.push({ id: b.id, kind: 'board', name: b.name, summary: b.summary, adds: [`#${b.channel} ${b.board.name}`] })
    }
  }
  return out
}

/** A board template as `board_create` arguments (snake_case, as the agent-boards API takes them). */
export function boardTemplateArgs(id: string): Record<string, unknown> & { channel: string; name: string } {
  const t = boardTemplate(id)
  const b = t.board
  return {
    channel: t.channel,
    name: b.name,
    item_type: b.itemType,
    ...(b.description ? { description: b.description } : {}),
    ...(b.keyPrefix ? { key_prefix: b.keyPrefix } : {}),
    ...(b.columns ? { columns: b.columns.map((c) => ({ name: c.name, category: c.category, wip_limit: c.wipLimit, sla_hours: c.slaHours, agent: c.agent })) } : {}),
    ...(b.fields?.length ? { fields: b.fields } : {}),
    ...(b.postToChannel ? { post_to_channel: b.postToChannel } : {}),
    ...(b.requiresHumanReview !== undefined ? { requires_human_review: b.requiresHumanReview } : {}),
  }
}

export function findWorkTemplate(
  id: string,
  opts: { includeHidden?: boolean } = {},
): { kind: WorkTemplateKind; id: string } | null {
  if (COMPANIES.some((c) => c.id === id && (opts.includeHidden || !c.hidden))) return { kind: 'company', id }
  if (DEPARTMENTS.some((d) => d.id === id && (opts.includeHidden || !d.hidden))) return { kind: 'department', id }
  if (BOARD_TEMPLATES.some((b) => b.id === id)) {
    const hidden = DEPARTMENTS.some((d) => d.hidden && d.boards.includes(id))
    if (opts.includeHidden || !hidden) return { kind: 'board', id }
  }
  return null
}

export interface MergeResult {
  yaml: string
  added: string[]
  skipped: string[]
}

/**
 * Merge a template into an existing manifest (or none). Nothing already in
 * the manifest is changed: projects and triggers match by key, channels and
 * boards by name, so adding the same template twice is a no-op.
 */
export function mergeWorkTemplate(existingYaml: string | null, id: string, opts: { channel?: string; workspaceName?: string } = {}): MergeResult {
  const found = findWorkTemplate(id)
  if (!found) throw new Error(`Unknown template "${id}". Call work_template_list to see the ids.`)

  const base: Record<string, any> = existingYaml?.trim()
    ? (parseYaml(existingYaml) as Record<string, any>) ?? {}
    : { version: 1, name: opts.workspaceName ?? 'Company', projects: [] }
  if (!base || typeof base !== 'object' || Array.isArray(base)) throw new Error('The existing manifest is not a YAML object')
  base.version ??= 1
  base.name ??= opts.workspaceName ?? 'Company'
  base.projects = Array.isArray(base.projects) ? base.projects : []
  base.teamChannels = Array.isArray(base.teamChannels) ? base.teamChannels : []
  base.triggers = Array.isArray(base.triggers) ? base.triggers : []

  let incoming: { projects: any[]; teamChannels: any[]; triggers: any[] }
  if (found.kind === 'board') {
    const t = boardTemplate(id)
    const channel = (opts.channel ?? t.channel).replace(/^#/, '')
    // A channel the manifest does not declare would be created (or made public) by system_apply.
    if (!base.teamChannels.some((x: any) => String(x?.name ?? '').replace(/^#/, '') === channel)) {
      const dept = DEPARTMENTS.find((d) => d.boards.includes(id) && d.channel.name === channel)
      throw new Error([
        `#${channel} is not in shogo-system.yaml.`,
        `If the channel already exists, use board_create with template "${id}".`,
        dept
          ? `To create it, add the "${dept.id}" department template (its channel, boards and agent), or add #${channel} to teamChannels and run this again.`
          : `To create it, add #${channel} to teamChannels (set private: true if it should be private) and run this again.`,
      ].join(' '))
    }
    incoming = { projects: [], teamChannels: [{ name: channel, boards: [t.board] }], triggers: [] }
  } else {
    const m = bundleManifest(found.kind, id) as any
    incoming = { projects: m.projects, teamChannels: m.teamChannels, triggers: m.triggers ?? [] }
  }

  const added: string[] = []
  const skipped: string[] = []
  for (const p of incoming.projects) {
    if (base.projects.some((x: any) => x?.key === p.key)) { skipped.push(`project ${p.key}`); continue }
    base.projects.push(p)
    added.push(`project ${p.key}`)
  }
  for (const ch of incoming.teamChannels) {
    const name = String(ch.name)
    let current = base.teamChannels.find((x: any) => String(x?.name ?? '').replace(/^#/, '') === name)
    if (!current) {
      current = { name, ...(ch.topic ? { topic: ch.topic } : {}), ...(ch.private ? { private: true } : {}), members: [], boards: [] }
      base.teamChannels.push(current)
      added.push(`channel #${name}`)
    }
    current.members = Array.isArray(current.members) ? current.members : []
    current.boards = Array.isArray(current.boards) ? current.boards : []
    for (const m of ch.members ?? []) {
      if (current.members.some((x: any) => x?.project && x.project === m.project)) continue
      current.members.push(m)
    }
    for (const b of ch.boards ?? []) {
      if (current.boards.some((x: any) => String(x?.name ?? '').toLowerCase() === String(b.name).toLowerCase())) { skipped.push(`board #${name} ${b.name}`); continue }
      current.boards.push(b)
      added.push(`board #${name} ${b.name}`)
    }
  }
  for (const t of incoming.triggers) {
    if (base.triggers.some((x: any) => x?.key === t.key)) { skipped.push(`trigger ${t.key}`); continue }
    base.triggers.push(t)
    added.push(`trigger ${t.key}`)
  }
  if (!base.triggers.length) delete base.triggers
  if (!base.projects.length) {
    throw new Error('A manifest needs at least one project. Add a department or company template first, or add the board to an existing shogo-system.yaml.')
  }

  return { yaml: stringifyYaml(base, YAML_OPTS), added, skipped }
}
