// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Meeting note templates ("recipes"): instructions for how enhanced notes
 * are structured. Built-ins live here; users add their own as
 * `MeetingTemplate` rows in their personal workspace.
 */

export interface MeetingTemplateView {
  id: string
  name: string
  description: string | null
  instructions: string
  builtIn: boolean
}

export const BUILTIN_TEMPLATE_PREFIX = 'builtin:'
export const DEFAULT_TEMPLATE_ID = `${BUILTIN_TEMPLATE_PREFIX}general`

export const BUILTIN_MEETING_TEMPLATES: readonly MeetingTemplateView[] = [
  {
    id: DEFAULT_TEMPLATE_ID,
    name: 'General',
    description: 'Summary, key points, decisions, and action items.',
    instructions: [
      'Sections, in order:',
      '## Summary: two or three sentences on what the meeting was for and where it landed.',
      '## Key points: grouped bullets by topic, most important first.',
      '## Decisions: only decisions that were actually made. Omit the section if none.',
      '## Action items',
    ].join('\n'),
    builtIn: true,
  },
  {
    id: `${BUILTIN_TEMPLATE_PREFIX}one-on-one`,
    name: '1:1',
    description: 'Updates, feedback, blockers, and follow-ups for a recurring 1:1.',
    instructions: [
      'Sections, in order:',
      '## Updates: what each person shared since last time.',
      '## Feedback: feedback given in either direction, quoted closely when it matters.',
      '## Blockers and support needed',
      '## Topics for next time',
      '## Action items',
    ].join('\n'),
    builtIn: true,
  },
  {
    id: `${BUILTIN_TEMPLATE_PREFIX}standup`,
    name: 'Standup',
    description: 'Per-person progress, plans, and blockers.',
    instructions: [
      'Sections, in order:',
      '## By person: one subsection per speaker with Done, Next, and Blocked bullets.',
      '## Blockers needing follow-up',
      '## Action items',
      'Keep it terse. No summary paragraph.',
    ].join('\n'),
    builtIn: true,
  },
  {
    id: `${BUILTIN_TEMPLATE_PREFIX}customer-call`,
    name: 'Customer call',
    description: 'Context, pain points, requests, objections, and next steps.',
    instructions: [
      'Sections, in order:',
      '## Customer context: who they are, their role, team, and current setup.',
      '## Pain points: in their words where possible.',
      '## Feature requests',
      '## Objections and concerns',
      '## Buying signals and timeline: budget, decision makers, dates. Omit if none.',
      '## Next steps',
      '## Action items',
    ].join('\n'),
    builtIn: true,
  },
  {
    id: `${BUILTIN_TEMPLATE_PREFIX}interview`,
    name: 'Interview',
    description: 'Candidate background, answers, strengths, and concerns.',
    instructions: [
      'Sections, in order:',
      '## Candidate background',
      '## Questions and answers: each question asked, with a faithful summary of the answer.',
      '## Strengths: evidence-based, cite what was said.',
      '## Concerns: evidence-based, cite what was said.',
      '## Action items',
      'Do not give a hire/no-hire recommendation unless the user notes ask for one.',
    ].join('\n'),
    builtIn: true,
  },
  {
    id: `${BUILTIN_TEMPLATE_PREFIX}brainstorm`,
    name: 'Brainstorm',
    description: 'Problem, ideas grouped by theme, and what to try next.',
    instructions: [
      'Sections, in order:',
      '## Problem',
      '## Ideas: grouped by theme, with who proposed them when clear.',
      '## Favorites and why',
      '## Open questions',
      '## Action items',
    ].join('\n'),
    builtIn: true,
  },
]

export function isBuiltinTemplateId(id: string | null | undefined): boolean {
  return !!id && id.startsWith(BUILTIN_TEMPLATE_PREFIX)
}

export function findBuiltinTemplate(id: string | null | undefined): MeetingTemplateView | null {
  if (!id) return null
  return BUILTIN_MEETING_TEMPLATES.find((t) => t.id === id) ?? null
}
