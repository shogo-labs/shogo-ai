// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The marketplace pack catalogue.
 *
 * A pack is the unit a listing installs: an agent project plus the team
 * channels, boards, schedules and triggers that turn it into a teammate, and
 * the 2–4 questions the install wizard asks so the prompts fit the workspace
 * that installs it.
 *
 * The manifest inside a pack is exactly a `shogo-system.yaml` (one parser,
 * `system-manifest.ts`). Department packs are derived from the department
 * bundles in `work-templates.ts` so the two catalogues cannot disagree about a
 * department's boards. `templates/packs/<id>/pack.yaml` is generated from this
 * file (`pack-templates-gen.ts`) and committed so a pack can be read and
 * diffed without running Bun.
 */

import { stringify as stringifyYaml } from 'yaml'
import { bundleManifest, DEPARTMENTS } from './work-templates'
import type { SystemManifest, SetupQuestion } from './system-manifest'

export interface PackTemplate {
  id: string
  name: string
  description: string
  /** Same shape as `shogo-system.yaml`. */
  manifest: Record<string, unknown>
  /** Questions the wizard asks before installing; also inside `manifest.setup`. */
  questions: SetupQuestion[]
}

const PROFILE_SECTION = '## Workspace profile'

/**
 * Timezones offered as a choice rather than free text: a schedule's zone is
 * validated, so a typo'd "Pacific" must not be able to sink an install.
 */
const IANA_ZONES = ['UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Europe/Berlin', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney']

const PRODUCT_QUESTION = (): SetupQuestion => ({
  id: 'product',
  header: 'What this team builds',
  question: 'What does this team build or sell, in one sentence?',
  type: 'text',
  applies: 'profile.product',
})

const SIGN_OFF_QUESTION = (area: string): SetupQuestion => ({
  id: 'sign-off',
  header: 'Who signs off',
  question: `Who approves ${area} work?`,
  type: 'text',
  applies: 'profile.sign-off',
  default: 'the workspace owner',
})

const SLA_QUESTION = (): SetupQuestion => ({
  id: 'sla',
  header: 'Response target',
  question: 'How fast should this team respond to a new request?',
  type: 'choice',
  options: ['Same day', 'Within 2 business days', 'Within a week'],
  default: 'Within 2 business days',
  applies: 'profile.sla',
})

/**
 * Add the `## Workspace profile` section (filled from the answers) to every
 * project's AGENTS.md, and record the questions on the manifest. The section
 * is appended so the bundle's own instructions stay exactly as generated.
 */
function withProfile(
  manifest: Record<string, unknown>,
  questions: SetupQuestion[],
  extraSection?: string,
): Record<string, unknown> {
  const projects = (manifest.projects as Array<Record<string, unknown>>).map((p) => {
    const files = { ...((p.files as Record<string, string>) ?? {}) }
    if (files['AGENTS.md']) {
      const profile = questions
        .map((q) => `- **${q.header}**: {{answers.${q.applies ?? `profile.${q.id}`}}}`)
        .join('\n')
      files['AGENTS.md'] = `${files['AGENTS.md'].trimEnd()}\n\n${PROFILE_SECTION}\n\n${profile}\n${extraSection ? `\n${extraSection.trim()}\n` : ''}`
    }
    return { ...p, files }
  })
  return {
    ...manifest,
    projects,
    setup: {
      questions,
      profile: { file: 'AGENTS.md', section: PROFILE_SECTION },
    },
  }
}

function departmentPack(id: string): PackTemplate {
  const manifest = bundleManifest('department', id) as Record<string, unknown>
  const name = String(manifest.name)
  const questions: SetupQuestion[] = [PRODUCT_QUESTION(), SIGN_OFF_QUESTION(name.replace(/ department$/, '').toLowerCase()), SLA_QUESTION()]
  return {
    id: `department-${id}`,
    name,
    description: String(manifest.description ?? `An agent that runs your ${id} channel and board.`),
    manifest: withProfile(manifest, questions),
    questions,
  }
}

// ─── Specialist packs ────────────────────────────────────────────────────────

const BUG_TRIAGE: PackTemplate = (() => {
  const questions: SetupQuestion[] = [
    PRODUCT_QUESTION(),
    {
      id: 'severity',
      header: 'Severity scale',
      question: 'What counts as a sev1 for this product?',
      type: 'text',
      applies: 'profile.sev1',
      default: 'the product is unusable for everyone',
    },
    {
      id: 'triage-cadence',
      header: 'Triage cadence',
      question: 'How often should the agent sweep new bugs?',
      type: 'choice',
      options: ['Every weekday morning', 'Every morning', 'Twice a day'],
      default: 'Every weekday morning',
      applies: 'profile.triage-cadence',
    },
  ]
  const manifest = {
    version: 1,
    name: 'Bug Triage',
    description: 'A #bugs channel and Bugs board with an agent that triages reports, dedupes them and assigns an owner.',
    projects: [
      {
        key: 'bug-triage-agent',
        name: 'Bug Triage Agent',
        description: 'Triages bug reports, sets severity, finds duplicates and links fixes.',
        agent: {
          model: 'auto',
          capabilities: { boardsEnabled: true, boardAdminEnabled: false, teamChatEnabled: true },
        },
        files: {
          'AGENTS.md': `# Bug Triage Agent

You work in #bugs. Every report becomes a card on the **Bugs** board (BUG-) and is triaged within the response target in this file's workspace profile.

## What you do
- Read each new report, set severity and area, and look for a duplicate card before creating another.
- Ask the reporter one question only when the report cannot be reproduced without it.
- Write the likely cause in the card thread, then set an owner.
- Link a pull request to the card with \`work_item_link\` when one is opened.

## How you work a card
- Start with \`work_item_get\` and read the thread.
- Move the card to the next column yourself; never leave a triaged card in the new column.
- Before you stop, set \`history_summary\`: where it stands, what you did, what is next.

## Never
- Do not close a bug as fixed; a person verifies the fix.
- Do not downgrade a sev1 without a person saying so.

## Workspace profile
- **What this team builds**: {{answers.profile.product}}
- **Sev1 means**: {{answers.profile.sev1}}
- **Triage cadence**: {{answers.profile.triage-cadence}}`,
          'HEARTBEAT.md': `# Heartbeat

1. \`board_health\` for #bugs. Escalate any sev1 with no owner in #bugs.
2. Sweep the Bugs board for reports past the response target and comment on each.`,
        },
      },
    ],
    teamChannels: [
      {
        name: 'bugs',
        topic: 'Bug reports and triage.',
        members: [{ project: 'bug-triage-agent', agentTrigger: 'mention' }],
        boards: [
          {
            name: 'Bugs',
            itemType: 'task',
            keyPrefix: 'BUG',
            description: 'Reports triaged by the bug-triage agent.',
            defaultAgent: 'bug-triage-agent',
            fields: [
              { key: 'severity', label: 'Severity', type: 'select', options: ['sev1', 'sev2', 'sev3', 'sev4'] },
              { key: 'area', label: 'Area', type: 'text' },
            ],
            columns: [
              { name: 'New', category: 'backlog' },
              { name: 'Triaged', category: 'active' },
              { name: 'Fixing', category: 'active' },
              { name: 'Verify', category: 'review' },
              { name: 'Closed', category: 'done' },
            ],
          },
        ],
      },
    ],
    schedules: [
      {
        key: 'bug-sweep',
        name: 'Weekday bug sweep',
        project: 'bug-triage-agent',
        channel: 'bugs',
        cron: '0 8 * * 1-5',
        timezone: 'UTC',
        enabled: false,
        prompt: 'Sweep the Bugs board in {{channel.bugs}}: triage anything new for <@a:p:{{agent.bug-triage-agent}}>, flag sev1s, and post a short summary here.',
      },
    ],
    setup: {
      questions,
      profile: { file: 'AGENTS.md', section: PROFILE_SECTION },
    },
  }
  return {
    id: 'bug-triage',
    name: 'Bug Triage',
    description: String(manifest.description),
    manifest: manifest as unknown as Record<string, unknown>,
    questions,
  }
})()

const INCIDENT_COMMANDER: PackTemplate = (() => {
  const questions: SetupQuestion[] = [
    PRODUCT_QUESTION(),
    {
      id: 'oncall',
      header: 'Who is on call',
      question: 'Who runs incidents (a person, a rotation name, or a group handle)?',
      type: 'text',
      applies: 'profile.oncall',
      default: 'the workspace owner',
    },
    {
      id: 'sev1-channel',
      header: 'Escalation',
      question: 'Where should a sev1 be escalated?',
      type: 'text',
      applies: 'profile.escalation',
      default: 'the #incidents channel and a direct message to the owner',
    },
  ]
  const manifest = {
    version: 1,
    name: 'Incident Commander',
    description: 'A #incidents channel and Incidents board with an agent that runs the timeline, roles and follow-ups of an outage.',
    projects: [
      {
        key: 'incident-commander',
        name: 'Incident Commander',
        description: 'Runs an incident from declaration to a blameless review.',
        agent: { model: 'auto', capabilities: { boardsEnabled: true, boardAdminEnabled: false, teamChatEnabled: true, problemsEnabled: true } },
        files: {
          'AGENTS.md': `# Incident Commander

You run incidents in #incidents. One incident = one card on the **Incidents** board (INC-).

## While an incident is open
- Open the card with impact, start time and the person leading; set the severity field.
- Post a timestamped update every 15 minutes, even when nothing changed: what we know, what we are trying, what we need.
- Keep the timeline in the card thread so the review can be written from it.
- Only the incident lead closes the card.

## After it closes
- Write the review: timeline, contributing causes, and at most three follow-up cards.

## Workspace profile
- **What this team builds**: {{answers.profile.product}}
- **On call**: {{answers.profile.oncall}}
- **Escalation**: {{answers.profile.escalation}}`,
          'HEARTBEAT.md': `# Heartbeat

1. Check open incidents: any with no update in 20 minutes gets a nudge in #incidents.
2. Close the loop on incidents closed yesterday: review written, follow-up cards created.`,
        },
      },
    ],
    teamChannels: [
      {
        name: 'incidents',
        topic: 'Declare, run and review incidents.',
        members: [{ project: 'incident-commander', agentTrigger: 'mention' }],
        boards: [
          {
            name: 'Incidents',
            itemType: 'problem',
            keyPrefix: 'INC',
            description: 'One card per incident, with its timeline and review.',
            defaultAgent: 'incident-commander',
            requiresHumanReview: true,
            columns: [
              { name: 'Declared', category: 'backlog' },
              { name: 'Mitigating', category: 'active' },
              { name: 'Monitoring', category: 'waiting' },
              { name: 'Review', category: 'review' },
              { name: 'Closed', category: 'done' },
            ],
          },
        ],
      },
    ],
    schedules: [
      {
        key: 'incident-watch',
        name: 'Incident watch',
        project: 'incident-commander',
        channel: 'incidents',
        cron: '*/30 * * * *',
        timezone: 'UTC',
        enabled: false,
        prompt: 'Check open incidents in {{channel.incidents}} with <@a:p:{{agent.incident-commander}}>: nudge any thread with no update in 20 minutes and post the current state.',
      },
    ],
    setup: { questions, profile: { file: 'AGENTS.md', section: PROFILE_SECTION } },
  }
  return { id: 'incident-commander', name: 'Incident Commander', description: String(manifest.description), manifest: manifest as unknown as Record<string, unknown>, questions }
})()

const DAILY_STANDUP: PackTemplate = (() => {
  const questions: SetupQuestion[] = [
    PRODUCT_QUESTION(),
    {
      id: 'hour',
      header: 'Standup time',
      question: 'What time should the daily standup be posted?',
      type: 'choice',
      options: ['08:00', '09:00', '10:00', '17:00'],
      default: '09:00',
      applies: 'profile.standup-time',
    },
    {
      id: 'timezone',
      header: 'Timezone',
      question: 'Which timezone is that in?',
      type: 'choice',
      options: IANA_ZONES,
      default: 'UTC',
      applies: 'profile.timezone',
    },
  ]
  const manifest = {
    version: 1,
    name: 'Daily Standup',
    description: 'A #standup channel and an agent that posts what moved, what is stuck and what needs a decision, every weekday.',
    projects: [
      {
        key: 'standup-agent',
        name: 'Standup Agent',
        description: 'Writes the daily standup from boards, cards and yesterday’s threads.',
        agent: { model: 'auto', capabilities: { boardsEnabled: true, boardAdminEnabled: false, teamChatEnabled: true } },
        files: {
          'AGENTS.md': `# Standup Agent

You post the weekday standup in #standup.

## What goes in it
1. **Moved** — cards that changed column since yesterday, one line each.
2. **Stuck** — cards with no activity past their SLA, or blocked on someone outside the team.
3. **Decisions** — at most three things a person has to choose today.

Keep it under 15 lines. Link cards by key, never paste a whole thread.

## Workspace profile
- **What this team builds**: {{answers.profile.product}}
- **Standup time**: {{answers.profile.standup-time}} ({{answers.profile.timezone}})`,
        },
      },
    ],
    teamChannels: [{ name: 'standup', topic: 'The daily standup.', members: [{ project: 'standup-agent', agentTrigger: 'mention' }] }],
    schedules: [
      {
        key: 'daily-standup',
        name: 'Daily standup',
        project: 'standup-agent',
        channel: 'standup',
        // Weekdays, at the answered hour in the answered zone.
        hour: '{{answers.profile.standup-time}}',
        days: '1-5',
        timezone: '{{answers.profile.timezone}}',
        enabled: false,
        prompt: 'Write today’s standup in {{channel.standup}} with <@a:p:{{agent.standup-agent}}>: moved, stuck, decisions.',
      },
    ],
    setup: { questions, profile: { file: 'AGENTS.md', section: PROFILE_SECTION } },
  }
  return { id: 'daily-standup', name: 'Daily Standup', description: String(manifest.description), manifest: manifest as unknown as Record<string, unknown>, questions }
})()

const MEETING_TO_CARDS: PackTemplate = (() => {
  const questions: SetupQuestion[] = [
    PRODUCT_QUESTION(),
    {
      id: 'owner',
      header: 'Default owner',
      question: 'Who owns a follow-up nobody has claimed yet?',
      type: 'text',
      applies: 'profile.follow-up-owner',
      default: 'the workspace owner',
    },
    {
      id: 'due',
      header: 'Follow-up due date',
      question: 'When are meeting follow-ups due by default?',
      type: 'choice',
      options: ['Next day', 'End of the week', 'Next meeting'],
      default: 'End of the week',
      applies: 'profile.follow-up-due',
    },
  ]
  const manifest = {
    version: 1,
    name: 'Meeting → Cards',
    description: 'A #meetings channel with an agent that turns notes and transcripts into owned follow-up cards.',
    projects: [
      {
        key: 'meeting-agent',
        name: 'Meeting Agent',
        description: 'Turns a meeting into decisions and owned follow-up cards.',
        agent: { model: 'auto', capabilities: { boardsEnabled: true, boardAdminEnabled: false, teamChatEnabled: true } },
        files: {
          'AGENTS.md': `# Meeting Agent

You work in #meetings. When someone posts notes, a transcript or a recording summary, you turn it into cards.

## What you do
- Extract decisions and follow-ups; drop discussion that produced neither.
- One card per follow-up on the **Follow-ups** board: title in the imperative, owner from the meeting, due date per the workspace profile.
- If nobody was named, assign the default owner and say so in the card thread.
- Post a one-line summary in #meetings linking the cards you created.

## Workspace profile
- **What this team builds**: {{answers.profile.product}}
- **Default owner**: {{answers.profile.follow-up-owner}}
- **Due by**: {{answers.profile.follow-up-due}}`,
        },
      },
    ],
    teamChannels: [
      {
        name: 'meetings',
        topic: 'Notes in, owned follow-ups out.',
        members: [{ project: 'meeting-agent', agentTrigger: 'mention' }],
        boards: [
          {
            name: 'Follow-ups',
            itemType: 'task',
            keyPrefix: 'MTG',
            description: 'Follow-ups extracted from meetings.',
            defaultAgent: 'meeting-agent',
            columns: [
              { name: 'New', category: 'backlog' },
              { name: 'Doing', category: 'active' },
              { name: 'Waiting', category: 'waiting' },
              { name: 'Done', category: 'done' },
            ],
          },
        ],
      },
    ],
    schedules: [
      {
        key: 'follow-up-sweep',
        name: 'Open follow-up sweep',
        project: 'meeting-agent',
        channel: 'meetings',
        cron: '0 16 * * 5',
        timezone: 'UTC',
        enabled: false,
        prompt: 'Sweep open follow-ups with <@a:p:{{agent.meeting-agent}}>: nudge owners on cards due this week and post the list in {{channel.meetings}}.',
      },
    ],
    setup: { questions, profile: { file: 'AGENTS.md', section: PROFILE_SECTION } },
  }
  return { id: 'meeting-to-cards', name: 'Meeting → Cards', description: String(manifest.description), manifest: manifest as unknown as Record<string, unknown>, questions }
})()

const CHIEF_OF_STAFF: PackTemplate = (() => {
  const questions: SetupQuestion[] = [
    PRODUCT_QUESTION(),
    {
      id: 'focus',
      header: 'Weekly focus',
      question: 'What are you trying to move this quarter?',
      type: 'text',
      applies: 'profile.focus',
      default: 'ship what is already in flight',
    },
    {
      id: 'hours',
      header: 'Quiet hours',
      question: 'When should the agent never ping you?',
      type: 'choice',
      options: ['20:00–08:00', '18:00–09:00', 'No quiet hours'],
      default: '20:00–08:00',
      applies: 'profile.quiet-hours',
    },
  ]
  const manifest = {
    version: 1,
    name: 'Personal Chief of Staff',
    description: 'A personal channel with an agent that keeps your commitments, decisions and follow-ups from slipping.',
    projects: [
      {
        key: 'chief-of-staff',
        name: 'Chief of Staff',
        description: 'Tracks commitments and follow-ups across the workspace and reports what needs you.',
        agent: { model: 'auto', capabilities: { boardsEnabled: true, boardAdminEnabled: false, teamChatEnabled: true } },
        files: {
          'AGENTS.md': `# Chief of Staff

You work in the chief-of-staff channel, one-to-one with the person who installed you.

## Each morning
- Read the boards, the cards assigned to the person and the threads they are mentioned in.
- Post at most five things that need them today, each with a link and the reason it matters.
- Nothing else. No status recital.

## On request
- Turn "remind me" into a card with an owner and a due date, not a chat message.
- Draft the reply or the decision note; the person sends it.

## Workspace profile
- **What this team builds**: {{answers.profile.product}}
- **This quarter’s focus**: {{answers.profile.focus}}
- **Quiet hours**: {{answers.profile.quiet-hours}}`,
          'HEARTBEAT.md': `# Heartbeat

1. Post the morning brief once per quiet-hours-adjusted day.
2. Flag commitments that went past their due date, in the channel, once.`,
        },
      },
    ],
    teamChannels: [{ name: 'chief-of-staff', topic: 'Your commitments, decisions and follow-ups.', private: true, members: [{ project: 'chief-of-staff', agentTrigger: 'mention' }] }],
    schedules: [
      {
        key: 'morning-brief',
        name: 'Morning brief',
        project: 'chief-of-staff',
        channel: 'chief-of-staff',
        cron: '0 8 * * 1-5',
        timezone: 'UTC',
        enabled: false,
        prompt: 'Write the morning brief in {{channel.chief-of-staff}} with <@a:p:{{agent.chief-of-staff}}>: at most five things that need me today.',
      },
    ],
    setup: { questions, profile: { file: 'AGENTS.md', section: PROFILE_SECTION } },
  }
  return { id: 'personal-chief-of-staff', name: 'Personal Chief of Staff', description: String(manifest.description), manifest: manifest as unknown as Record<string, unknown>, questions }
})()

const SELF_EVOLVING: PackTemplate = (() => {
  const questions: SetupQuestion[] = [
    PRODUCT_QUESTION(),
    {
      id: 'roster',
      header: 'Agents to coach',
      question: 'Which agents should the daily review coach?',
      type: 'text',
      default: 'every agent project in this workspace',
      applies: 'profile.roster',
    },
    {
      id: 'hour',
      header: 'Review time',
      question: 'What time should the daily review run?',
      type: 'choice',
      options: ['06:00', '07:00', '08:00', '12:00', '18:00', '21:00'],
      default: '07:00',
      applies: 'profile.review-time',
    },
    {
      id: 'timezone',
      header: 'Timezone',
      question: 'Which timezone is that in?',
      type: 'choice',
      options: IANA_ZONES,
      default: 'UTC',
      applies: 'profile.timezone',
    },
    {
      id: 'quiet-hours-start',
      header: 'Quiet hours start',
      question: 'From what time should the agent not ping you?',
      type: 'choice',
      options: ['20:00', '21:00', '22:00', '23:00'],
      default: '22:00',
      applies: 'profile.quiet-hours-start',
    },
    {
      id: 'quiet-hours-end',
      header: 'Quiet hours end',
      question: 'When may it start pinging you again?',
      type: 'choice',
      options: ['06:00', '07:00', '08:00', '09:00'],
      default: '07:00',
      applies: 'profile.quiet-hours-end',
    },
  ]
  const manifest = {
    version: 1,
    name: 'Self Evolving',
    description: 'A daily retrospective that coaches every agent in this workspace, plus an #ideas channel for the platform gaps the work reveals.',
    projects: [
      {
        key: 'self-evolving',
        name: 'Self Evolver',
        description: 'Reviews the last 24 hours of agent work, writes lessons into each agent’s MEMORY.md, and files platform ideas.',
        agent: {
          model: 'auto',
          capabilities: { boardsEnabled: true, boardAdminEnabled: false, teamChatEnabled: true },
          // Quiet hours are the agent's own (AgentConfig), not a schedule column:
          // they are the window the heartbeat may not ping anyone in.
          heartbeat: {
            enabled: true,
            interval: 3600,
            quietHours: {
              start: '{{answers.profile.quiet-hours-start}}',
              end: '{{answers.profile.quiet-hours-end}}',
              timezone: '{{answers.profile.timezone}}',
            },
          },
        },
        files: {
          'AGENTS.md': `# Self Evolver

You are the workspace's retrospective coach. Once a day you read what the agents and people did, write down what should change, and file the platform gaps you find.

## Roster
Coach {{answers.profile.roster}}. Read it from \`team_directory\` on each run; a project added later is coached from then on.

## Each daily review
1. Read the last 24 hours: cards that moved, their threads, and any pull requests or links on them. Boards come from \`board_list\` (default: every board in the review channel).
2. Consolidate each coached agent's \`MEMORY.md\` — rewrite it to fit ~1,500 tokens, do not append to it. The always-on part of that file is loaded into the agent's prompt on every turn and is budgeted, so a file that only grows costs money every request and eventually stops being fully visible.
   - Merge duplicate lessons: the same rule stated twice becomes one line, in the sharper wording.
   - Delete lessons that are superseded, resolved, or already encoded in that agent's \`AGENTS.md\` or a guide it is given — those are in the prompt already, so repeating them is pure cost.
   - Keep only the lessons that pass the five-point test: specific, observable, about a decision, actionable next time, and not a restatement of the task. Drop per-card status notes and task restatements; those belong on the card.
   - Structure the file as \`## <topic>\` sections deduped by topic, not an append-only log.
   - Move long-form detail — worked examples, stack traces, code excerpts — into a **flat** \`memory/<slug>.md\` file. Not \`memory/topics/\`: the index does not recurse, so a nested file is invisible to \`memory_search\`.
   - Put anything that must always be in context inside \`<!-- memory:core:start -->\` … \`<!-- memory:core:end -->\`, kept under ~1,500 tokens. Everything outside that block is searchable archive, not injected.
   - Rewriting is the one time \`overwrite: true\` is correct on a memory file: the previous version is kept under \`.shogo/memory-history/\`.
   - Never edit \`AGENTS.md\` — it is regenerated from the workspace's configuration, so a lesson written there is lost.
3. File at most three **new** platform ideas into #ideas. Each idea: what happened, why the product made it harder than it should be, and the smallest change that would fix it.
   - Deduplicate against the #ideas channel doc: update an existing idea instead of writing a near-copy.
   - Never tag a person or an agent in #ideas.
4. Post the review in #evolution: what went well, what to change, and the count of ideas filed (\`#ideas: N new, M updated\`). Update the #ideas doc with the same count.
   - Include one memory line per coached agent — \`<agent>: 4,730 → 1,277 tokens\` — so a file that grows back is visible the next day.

## Monday rollup
On Mondays add a section: which lessons repeated, which one the workspace should fix this week, and whether last week's ideas moved.

## Workspace profile
- **What this team builds**: {{answers.profile.product}}
- **Agents to coach**: {{answers.profile.roster}}
- **Review time**: {{answers.profile.review-time}} ({{answers.profile.timezone}})
- **Quiet hours**: {{answers.profile.quiet-hours-start}}–{{answers.profile.quiet-hours-end}} ({{answers.profile.timezone}})`,
          'HEARTBEAT.md': `# Heartbeat

1. If today's review has not been posted in #evolution yet, write it.
2. Check #ideas: any idea with no owner and no reply after a week gets one line in the review, then leave it alone.`,
        },
      },
    ],
    teamChannels: [
      {
        name: 'evolution',
        topic: 'Daily retrospective — what the agents did well, what to change, and why.',
        members: [{ project: 'self-evolving', agentTrigger: 'mention' }],
      },
      {
        name: 'ideas',
        topic: 'Platform shortcomings and improvement ideas found while doing the work.',
        members: [{ project: 'self-evolving', agentTrigger: 'mention' }],
      },
    ],
    schedules: [
      {
        key: 'daily-evolution',
        name: 'Daily self review',
        project: 'self-evolving',
        channel: 'evolution',
        // The run happens at the answered hour, in the answered zone — not 07:00 UTC.
        hour: '{{answers.profile.review-time}}',
        timezone: '{{answers.profile.timezone}}',
        enabled: true,
        prompt: 'Start today’s review with <@a:p:{{agent.self-evolving}}>: read the last 24 hours of work, coach the roster, file ideas in {{channel.ideas}}, and post the review in {{channel.evolution}}.',
      },
      {
        key: 'weekly-rollup',
        name: 'Monday rollup',
        project: 'self-evolving',
        channel: 'evolution',
        hour: '{{answers.profile.review-time}}',
        days: '1',
        timezone: '{{answers.profile.timezone}}',
        enabled: true,
        prompt: 'Write the Monday rollup in {{channel.evolution}} with <@a:p:{{agent.self-evolving}}>: repeated lessons, the one to fix this week, and movement on last week’s ideas.',
      },
    ],
    setup: { questions, profile: { file: 'AGENTS.md', section: PROFILE_SECTION } },
  }
  return { id: 'self-evolving', name: 'Self Evolving', description: String(manifest.description), manifest: manifest as unknown as Record<string, unknown>, questions }
})()

/**
 * Bug triage and incident response ship together: the same agent watching
 * reports is the one who declares the incident when a report turns out to be
 * one. One pack, two projects, two boards.
 */
const OPS_TRIAGE: PackTemplate = (() => {
  const questions: SetupQuestion[] = dedupeQuestions([...(BUG_TRIAGE.questions ?? []), ...(INCIDENT_COMMANDER.questions ?? [])])
  const a = BUG_TRIAGE.manifest as any
  const b = INCIDENT_COMMANDER.manifest as any
  const manifest = {
    version: 1,
    name: 'Bug Triage & Incidents',
    description: 'A #bugs channel with a Bugs board and an #incidents channel with an Incidents board: reports are triaged, and the ones that turn into outages are run as incidents.',
    projects: [...a.projects, ...b.projects],
    teamChannels: [...a.teamChannels, ...b.teamChannels],
    schedules: [...(a.schedules ?? []), ...(b.schedules ?? [])],
    setup: { questions, profile: { file: 'AGENTS.md', section: PROFILE_SECTION } },
  }
  return {
    id: 'ops-triage',
    name: 'Bug Triage & Incidents',
    description: String(manifest.description),
    manifest: manifest as Record<string, unknown>,
    questions,
  }
})()

function dedupeQuestions(questions: SetupQuestion[]): SetupQuestion[] {
  const seen = new Set<string>()
  return questions.filter((q) => (seen.has(q.id) ? false : (seen.add(q.id), true)))
}

export const SPECIALIST_PACKS: PackTemplate[] = [OPS_TRIAGE, DAILY_STANDUP, MEETING_TO_CARDS, CHIEF_OF_STAFF, SELF_EVOLVING]

export const DEPARTMENT_PACK_IDS = DEPARTMENTS.map((d) => d.id)

/** Every installable pack, departments first, in catalogue order. */
export function listPackTemplates(): PackTemplate[] {
  return [...DEPARTMENT_PACK_IDS.map(departmentPack), ...SPECIALIST_PACKS]
}

export function getPackTemplate(id: string): PackTemplate | null {
  return listPackTemplates().find((p) => p.id === id) ?? null
}

const YAML_OPTS = { lineWidth: 0 } as const

export function renderPackYaml(id: string): string {
  const pack = getPackTemplate(id)
  if (!pack) throw new Error(`Unknown pack "${id}"`)
  const header = [
    '# GENERATED FILE — do not hand-edit. Source: packages/agent-runtime/src/pack-templates.ts',
    '# Regenerate with: bun run packages/agent-runtime/src/pack-templates-gen.ts',
    '',
  ].join('\n')
  return header + stringifyYaml({ version: 1, name: pack.name, description: pack.description, ...pack.manifest }, YAML_OPTS)
}

/** Generated files, keyed by path relative to `templates/`. */
export function renderAllPackFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  for (const pack of listPackTemplates()) files[`packs/${pack.id}/pack.yaml`] = renderPackYaml(pack.id)
  return files
}

/** Type guard used by the API: a parsed object is a pack manifest, not a bundle. */
export function packManifestOf(pack: PackTemplate): SystemManifest {
  return pack.manifest as unknown as SystemManifest
}
