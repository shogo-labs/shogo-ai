// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Personality & Identity Eval Test Cases
 *
 * Tests the agent's ability to self-update its workspace personality files
 * (SOUL.md, IDENTITY.md, AGENTS.md) via read_file + edit_file, following
 * the WORKSPACE_FILES_GUIDE pattern: read defaults first, then edit in place.
 */

import type { AgentEval } from './types'
import { usedTool, toolCallArgsContain } from './eval-helpers'

function readBeforeEdit(r: { toolCalls: { name: string; input: Record<string, unknown> }[] }): boolean {
  const readIdx = r.toolCalls.findIndex(t => t.name === 'read_file')
  const editIdx = r.toolCalls.findIndex(t => t.name === 'edit_file')
  return readIdx !== -1 && editIdx !== -1 && readIdx < editIdx
}

function editedFile(r: { toolCalls: { name: string; input: Record<string, unknown> }[] }, filename: string): boolean {
  return r.toolCalls
    .filter(t => t.name === 'edit_file')
    .some(t => {
      const path = String(t.input?.path ?? '')
      return path === filename || path.endsWith(`/${filename}`)
    })
}

export const PERSONALITY_EVALS: AgentEval[] = [
  {
    id: 'personality-tone-correction',
    name: 'Personality: Adjust tone via workspace edit',
    category: 'personality',
    level: 2,
    input: 'From now on, I need you to be more formal and professional. No casual language — this is for a client-facing project.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-edit-file',
        description: 'Used edit_file to modify a workspace personality file',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'edit_file'),
      },
      {
        id: 'read-before-edit',
        description: 'Read the file before editing (read_file then edit_file)',
        points: 20,
        phase: 'execution',
        validate: (r) => readBeforeEdit(r),
      },
      {
        id: 'targeted-soul-md',
        description: 'Edited SOUL.md (the tone/voice file)',
        points: 20,
        phase: 'execution',
        validate: (r) => editedFile(r, 'SOUL.md'),
      },
      {
        id: 'mentions-formal',
        description: 'Edit content references formal/professional tone',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('formal') || json.includes('professional')
        },
      },
      {
        id: 'confirms-update',
        description: 'Agent confirms the personality was updated',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('update') || text.includes('adjust') || text.includes('change')
        },
      },
    ],
    antiPatterns: ['personality_update'],
  },

  {
    id: 'personality-no-update-trivial',
    name: 'Personality: Don\'t edit workspace for one-off request',
    category: 'personality',
    level: 2,
    input: 'Can you explain this in simpler terms? What is quantum computing?',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'no-edit-file',
        description: 'Did NOT use edit_file for a one-off simplification request',
        points: 60,
        phase: 'intention',
        validate: (r) => !usedTool(r, 'edit_file'),
      },
      {
        id: 'answered-question',
        description: 'Actually explained quantum computing',
        points: 40,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('quantum') || text.includes('comput')
        },
      },
    ],
  },

  {
    id: 'personality-set-identity',
    name: 'Personality: Set agent name and role via workspace edit',
    category: 'personality',
    level: 2,
    input: 'I\'d like you to go by "Atlas" and focus on climate science research going forward.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-edit-file',
        description: 'Used edit_file to update identity',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'edit_file'),
      },
      {
        id: 'read-before-edit',
        description: 'Read the file before editing',
        points: 15,
        phase: 'execution',
        validate: (r) => readBeforeEdit(r),
      },
      {
        id: 'targeted-identity',
        description: 'Edited IDENTITY.md',
        points: 20,
        phase: 'execution',
        validate: (r) => editedFile(r, 'IDENTITY.md'),
      },
      {
        id: 'has-name',
        description: 'Edit content includes the name Atlas',
        points: 20,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'edit_file', 'Atlas'),
      },
      {
        id: 'has-role',
        description: 'Edit content references climate/research role',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls.filter(t => t.name === 'edit_file')).toLowerCase()
          return json.includes('research') || json.includes('climate')
        },
      },
    ],
    antiPatterns: ['personality_update'],
  },

  {
    id: 'personality-domain-expertise',
    name: 'Personality: Set domain expertise via workspace edit',
    category: 'personality',
    level: 2,
    input: 'You\'re my DevOps guy now. I need you thinking about infra costs, security, and deployment reliability in everything we do.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-edit-file',
        description: 'Used edit_file to set domain expertise',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'edit_file'),
      },
      {
        id: 'read-before-edit',
        description: 'Read the file before editing',
        points: 10,
        phase: 'execution',
        validate: (r) => readBeforeEdit(r),
      },
      {
        id: 'targeted-soul-or-agents',
        description: 'Edited SOUL.md or AGENTS.md',
        points: 15,
        phase: 'execution',
        validate: (r) => editedFile(r, 'SOUL.md') || editedFile(r, 'AGENTS.md'),
      },
      {
        id: 'has-devops-role',
        description: 'Edit content references DevOps or infrastructure',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls.filter(t => t.name === 'edit_file')).toLowerCase()
          return json.includes('devops') || json.includes('infrastructure')
        },
      },
      {
        id: 'has-security-concern',
        description: 'Edit content references security',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls.filter(t => t.name === 'edit_file')).toLowerCase()
          return json.includes('security')
        },
      },
      {
        id: 'confirms-update',
        description: 'Agent confirms the update',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('update') || text.includes('devops') || text.includes('change')
        },
      },
    ],
    antiPatterns: ['personality_update'],
  },

  {
    id: 'personality-set-boundaries',
    name: 'Personality: Set safety boundaries via workspace edit',
    category: 'personality',
    level: 2,
    input: 'Hey, new rules: never run shell commands without asking me, stay away from production databases, and always suggest a dry-run before anything destructive.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-edit-file',
        description: 'Used edit_file to set boundaries',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'edit_file'),
      },
      {
        id: 'read-before-edit',
        description: 'Read file before editing',
        points: 10,
        phase: 'execution',
        validate: (r) => readBeforeEdit(r),
      },
      {
        id: 'targeted-agents-md',
        description: 'Edited AGENTS.md (rules file)',
        points: 15,
        phase: 'execution',
        validate: (r) => editedFile(r, 'AGENTS.md'),
      },
      {
        id: 'has-shell-boundary',
        description: 'Edit content mentions shell command restriction',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls.filter(t => t.name === 'edit_file')).toLowerCase()
          return json.includes('shell') || json.includes('command')
        },
      },
      {
        id: 'has-production-boundary',
        description: 'Edit content mentions production database restriction',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls.filter(t => t.name === 'edit_file')).toLowerCase()
          return json.includes('production') && json.includes('database')
        },
      },
      {
        id: 'has-dryrun-boundary',
        description: 'Edit content mentions dry-run before destructive ops',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls.filter(t => t.name === 'edit_file')).toLowerCase()
          return json.includes('dry-run') || json.includes('dry run') || json.includes('destructive')
        },
      },
    ],
    antiPatterns: ['personality_update'],
  },

  {
    id: 'personality-no-update-style',
    name: 'Personality: Don\'t edit workspace for one-off style request',
    category: 'personality',
    level: 2,
    input: 'Can you rewrite this in bullet points instead? Here\'s the text: The quarterly results show growth in three areas: revenue increased 15%, customer base grew by 8,000 users, and average deal size rose to $2,400.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'no-edit-file',
        description: 'Did NOT use edit_file for a one-off formatting request',
        points: 55,
        phase: 'intention',
        validate: (r) => !usedTool(r, 'edit_file'),
      },
      {
        id: 'reformatted-text',
        description: 'Response contains reformatted bullet points',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText
          return text.includes('•') || text.includes('-') || text.includes('*') || text.includes('revenue')
        },
      },
      {
        id: 'preserved-data',
        description: 'Response preserves the key data points',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('15%') && (text.includes('8,000') || text.includes('8000'))
        },
      },
    ],
  },
]
