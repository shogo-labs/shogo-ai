// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent messages modeled on what staging team channels showed (names and
 * values changed), each with the design a good model returns for it. The
 * integration tests feed `design` through the designer seam to check the
 * pipeline around the model; `scripts/eval-question-designer.ts` runs the
 * real model on the same texts and compares against `expect`.
 */

import type { QuestionInteraction } from '../../services/conversation-message-kind'

export interface FixtureQuestion {
  header: string
  prompt: string
  interaction: QuestionInteraction
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
  hint?: 'number' | 'url'
  secretName?: string
}

export interface AskFixture {
  name: string
  /** `{me}` is replaced by the tagged person's mention token. */
  text: string
  /** Whether the free text check should pass it on to the model. */
  gate: boolean
  /** What the model returns; `sameAs` and `moot` refer to other fixtures' questions by header. */
  design: { questions: FixtureQuestion[]; sameAs?: Array<string | null>; moot?: string[] }
  /** What the live eval checks: interactions in order, or none. */
  expect: QuestionInteraction[]
}

const LONG_STATUS = [
  '## Weekly reliability report',
  '',
  '| Service | p95 | Errors | Trend |',
  '|---|---|---|---|',
  '| api | 212ms | 0.08% | flat |',
  '| worker | 1.4s | 0.31% | up |',
  '| ingest | 640ms | 0.02% | down |',
  '',
  'Worker latency rose after Tuesday’s deploy; the queue backlog peaked at 41k and drained by 03:10 UTC. ',
  'Ingest improved after the batching change. No customer-facing incidents this week. ',
  'I rotated the staging certificates and confirmed the renewal job runs nightly.',
].join('\n')

export const ONCALL_PROMPT = 'Where should platform-oncall alerts be delivered?'

export const STAGING_FIXTURES: AskFixture[] = [
  {
    name: 'choice buried in a long status report',
    text: `${LONG_STATUS}\n\n**Blocked:** {me} where should \`platform-oncall\` deliver: a Slack webhook URL, a distribution email, or a PagerDuty routing key? Once I have it I’ll wire the alert rules.\n\nNext week I’ll look at the worker regression.`,
    gate: true,
    design: {
      questions: [{
        header: 'Alert destination',
        prompt: ONCALL_PROMPT,
        interaction: 'choice',
        options: [
          { label: 'Slack webhook', description: 'Post alerts to a Slack channel' },
          { label: 'Email list', description: 'Send to a distribution email' },
          { label: 'PagerDuty', description: 'Page through a routing key' },
        ],
      }],
    },
    expect: ['choice'],
  },
  {
    name: 'the same ask again from another agent',
    text: 'Still need {me} to pick the platform-oncall destination (Slack webhook, email list or PagerDuty) before the alert rules can go live.',
    gate: true,
    design: {
      questions: [{
        header: 'Alert destination',
        prompt: 'Which destination should platform-oncall use?',
        interaction: 'choice',
        options: [{ label: 'Slack webhook' }, { label: 'Email list' }, { label: 'PagerDuty' }],
      }],
      sameAs: ['Alert destination'],
    },
    expect: ['choice'],
  },
  {
    name: 'a later message says the ask is moot',
    text: 'Update: platform-oncall is no longer needed — alerts now route through the shared incident channel the infra team set up. Nothing else needed from {me} on this.',
    gate: false,
    design: { questions: [], moot: ['Alert destination'] },
    expect: [],
  },
  {
    name: 'go/no-go',
    text: 'I reviewed the three proposals (cache warmer, retry budget, queue sharding). {me} do you approve proceeding to implementation on these three?',
    gate: true,
    design: {
      questions: [{ header: 'Proceed', prompt: 'Approve implementing the cache warmer, retry budget and queue sharding?', interaction: 'confirm' }],
    },
    expect: ['confirm'],
  },
  {
    name: 'a secret and a budget in one ask',
    text: 'To start pulling creator stats I need two things from {me}: drop the EnsembleData API key in, and give a rough monthly ceiling for the API spend.',
    gate: true,
    design: {
      questions: [
        { header: 'EnsembleData key', prompt: 'Paste the EnsembleData API key?', interaction: 'secret', secretName: 'ENSEMBLEDATA_API_TOKEN' },
        { header: 'Monthly ceiling', prompt: 'What is the monthly spend ceiling for the EnsembleData API (USD)?', interaction: 'text', hint: 'number' },
      ],
    },
    expect: ['secret', 'text'],
  },
  {
    name: 'who has access',
    text: '{me} who has SigNoz admin access? I need someone to create the ingestion key.',
    gate: true,
    design: {
      questions: [{ header: 'SigNoz admin', prompt: 'Who has SigNoz admin access?', interaction: 'person' }],
    },
    expect: ['person'],
  },
  {
    name: 'three numbered questions, nobody tagged',
    text: 'The migration plan needs three answers before I start:\n1. Should we keep the legacy endpoints for 30 or 90 days?\n2. What URL should the status page link to?\n3. Is a Saturday maintenance window acceptable?',
    gate: true,
    design: {
      questions: [
        { header: 'Legacy endpoints', prompt: 'How long should the legacy endpoints stay up?', interaction: 'choice', options: [{ label: '30 days' }, { label: '90 days' }] },
        { header: 'Status page link', prompt: 'What URL should the status page link to?', interaction: 'text', hint: 'url' },
        { header: 'Maintenance window', prompt: 'Is a Saturday maintenance window acceptable?', interaction: 'confirm' },
      ],
    },
    expect: ['choice', 'text', 'confirm'],
  },
  {
    name: 'agent-to-agent ask',
    text: 'Ask for <@a:p:devops>: please confirm (a) the staging cluster has spare capacity, (b) the node pool autoscaler is on, (c) the backup job ran last night.',
    gate: true,
    design: { questions: [] },
    expect: [],
  },
  {
    name: 'DM greeting',
    text: 'Hi! What are we building today?',
    gate: true,
    design: { questions: [] },
    expect: [],
  },
  {
    name: 'offer, not a question',
    text: 'Deployed v2.14 to production. All checks green. Let me know if you need anything else.',
    gate: true,
    design: { questions: [] },
    expect: [],
  },
  {
    name: 'plain status, no ask',
    text: 'Nightly backup finished in 14m (2.1 GB). Next run 02:00 UTC.',
    gate: false,
    design: { questions: [] },
    expect: [],
  },
  {
    name: 'question marks only in code and links',
    text: 'Fixed the query builder: `SELECT * FROM jobs WHERE id = ?` now binds correctly. Details: https://example.com/runs?id=42&view=full',
    gate: false,
    design: { questions: [] },
    expect: [],
  },
]
