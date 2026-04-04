// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { AgentEval, EvalResult } from './types'
import {
  usedTool,
  toolCallCount,
  toolCallArgsContain,
  toolCallsJson,
} from './eval-helpers'

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function taskCreateCount(r: EvalResult): number {
  return r.toolCalls.filter(tc => tc.name === 'task_create').length
}

function hasBlockedByDep(r: EvalResult): boolean {
  return r.toolCalls
    .filter(tc => tc.name === 'task_create')
    .some(tc => {
      const input = JSON.stringify(tc.input).toLowerCase()
      return input.includes('blocked_by') || input.includes('blockedby')
    })
}

function agentSpawnCount(r: EvalResult): number {
  return r.toolCalls.filter(tc => tc.name === 'agent_spawn').length
}

function agentSpawnPromptsDistinct(r: EvalResult): boolean {
  const spawns = r.toolCalls.filter(tc => tc.name === 'agent_spawn')
  if (spawns.length < 2) return false
  const prompts = spawns.map(tc => JSON.stringify(tc.input).toLowerCase())
  const hasDesigner = prompts.some(p => p.includes('design') || p.includes('ui') || p.includes('ux'))
  const hasDeveloper = prompts.some(p => p.includes('develop') || p.includes('implement') || p.includes('engineer'))
  return hasDesigner && hasDeveloper
}

function sendTeamMessageCount(r: EvalResult): number {
  return r.toolCalls.filter(tc => tc.name === 'send_team_message').length
}

function hasBroadcastMessage(r: EvalResult): boolean {
  return r.toolCalls
    .filter(tc => tc.name === 'send_team_message')
    .some(tc => {
      const input = tc.input as Record<string, any>
      return input.to === '*' || input.recipient === '*'
    })
}

function hasTargetedMessage(r: EvalResult): boolean {
  return r.toolCalls
    .filter(tc => tc.name === 'send_team_message')
    .some(tc => {
      const input = tc.input as Record<string, any>
      const to = input.to || input.recipient || ''
      return to !== '' && to !== '*'
    })
}

function messagesHaveContent(r: EvalResult): boolean {
  return r.toolCalls
    .filter(tc => tc.name === 'send_team_message')
    .every(tc => {
      const input = tc.input as Record<string, any>
      const msg = input.message || input.content || input.body || ''
      return typeof msg === 'string' && msg.trim().length > 10
    })
}

function taskUpdateCount(r: EvalResult): number {
  return r.toolCalls.filter(tc => tc.name === 'task_update').length
}

function hasShutdownRequest(r: EvalResult): boolean {
  return r.toolCalls
    .filter(tc => tc.name === 'send_team_message')
    .some(tc => {
      const input = JSON.stringify(tc.input).toLowerCase()
      return input.includes('shutdown') || input.includes('shut_down')
    })
}

// ---------------------------------------------------------------------------
// Phase 1: Team Assembly — 20 points
// ---------------------------------------------------------------------------

const PHASE_1_PROMPT =
  "You're managing a website redesign project. Create a team called 'web-redesign', " +
  "then create 3 tasks: 'Audit current site' (no deps), 'Design new layout' (blocked " +
  "by audit), 'Implement design' (blocked by layout design). List the tasks to verify " +
  'the dependency chain.'

const PHASE_1: AgentEval = {
  id: 'teammate-assembly',
  name: 'Teammate Coordination: Team Assembly — create team and tasks',
  category: 'teammate-coordination' as any,
  level: 2,
  pipeline: 'teammate-coordination',
  pipelinePhase: 1,
  input: PHASE_1_PROMPT,
  conversationHistory: [],
  maxScore: 20,
  validationCriteria: [
    {
      id: 'team-created',
      description: 'team_create called with team name',
      points: 5,
      phase: 'intention',
      validate: (r) => usedTool(r, 'team_create') && toolCallArgsContain(r, 'team_create', 'web-redesign'),
    },
    {
      id: 'tasks-created',
      description: 'task_create called 3 times for the three tasks',
      points: 5,
      phase: 'intention',
      validate: (r) => taskCreateCount(r) >= 3,
    },
    {
      id: 'has-dependency',
      description: 'At least one task has blocked_by dependency',
      points: 5,
      phase: 'intention',
      validate: (r) => hasBlockedByDep(r),
    },
    {
      id: 'tasks-listed',
      description: 'task_list called to verify dependency chain',
      points: 5,
      phase: 'execution',
      validate: (r) => usedTool(r, 'task_list'),
    },
  ],
  tags: ['teammate-coordination'],
}

// ---------------------------------------------------------------------------
// Phase 2: Task Distribution — 20 points
// ---------------------------------------------------------------------------

const PHASE_2_PROMPT =
  "Spawn two teammate agents using agent_spawn: a 'designer' and a 'developer'. " +
  'The designer should focus on UI/UX tasks, the developer on implementation. ' +
  'Then check the task list to see what\'s available.'

const PHASE_2: AgentEval = {
  id: 'teammate-distribution',
  name: 'Teammate Coordination: Task Distribution — spawn teammates',
  category: 'teammate-coordination' as any,
  level: 2,
  pipeline: 'teammate-coordination',
  pipelinePhase: 2,
  input: PHASE_2_PROMPT,
  conversationHistory: [{ role: 'user', content: PHASE_2_PROMPT }],
  pipelineFiles: {},
  maxScore: 20,
  validationCriteria: [
    {
      id: 'agents-spawned',
      description: 'agent_spawn called 2+ times',
      points: 8,
      phase: 'intention',
      validate: (r) => agentSpawnCount(r) >= 2,
    },
    {
      id: 'task-list-checked',
      description: 'task_list called to check available tasks',
      points: 4,
      phase: 'intention',
      validate: (r) => usedTool(r, 'task_list'),
    },
    {
      id: 'distinct-roles',
      description: 'Agents have distinct prompts/roles (designer vs developer)',
      points: 8,
      phase: 'intention',
      validate: (r) => agentSpawnPromptsDistinct(r),
    },
  ],
  tags: ['teammate-coordination'],
}

// ---------------------------------------------------------------------------
// Phase 3: Team Communication — 20 points
// ---------------------------------------------------------------------------

const PHASE_3_PROMPT =
  'Send a message to the designer asking for a status update. Then broadcast ' +
  'a message to all team members about the project timeline.'

const PHASE_3: AgentEval = {
  id: 'teammate-communication',
  name: 'Teammate Coordination: Team Communication — messaging',
  category: 'teammate-coordination' as any,
  level: 3,
  pipeline: 'teammate-coordination',
  pipelinePhase: 3,
  input: PHASE_3_PROMPT,
  conversationHistory: [{ role: 'user', content: PHASE_3_PROMPT }],
  pipelineFiles: {},
  maxScore: 20,
  validationCriteria: [
    {
      id: 'targeted-message',
      description: 'send_team_message called with specific recipient',
      points: 7,
      phase: 'intention',
      validate: (r) => hasTargetedMessage(r),
    },
    {
      id: 'broadcast-message',
      description: "send_team_message called with to: '*' for broadcast",
      points: 7,
      phase: 'intention',
      validate: (r) => hasBroadcastMessage(r),
    },
    {
      id: 'meaningful-content',
      description: 'Messages have meaningful content (>10 chars)',
      points: 6,
      phase: 'execution',
      validate: (r) => sendTeamMessageCount(r) >= 2 && messagesHaveContent(r),
    },
  ],
  tags: ['teammate-coordination'],
}

// ---------------------------------------------------------------------------
// Phase 4: Task Progress — 25 points
// ---------------------------------------------------------------------------

const PHASE_4_PROMPT =
  "Update the 'Audit current site' task to completed. Then check what tasks are " +
  'now available (the design task should be unblocked). Update the design task to in_progress.'

const PHASE_4: AgentEval = {
  id: 'teammate-progress',
  name: 'Teammate Coordination: Task Progress — DAG resolution',
  category: 'teammate-coordination' as any,
  level: 3,
  pipeline: 'teammate-coordination',
  pipelinePhase: 4,
  input: PHASE_4_PROMPT,
  conversationHistory: [{ role: 'user', content: PHASE_4_PROMPT }],
  pipelineFiles: {},
  maxScore: 25,
  validationCriteria: [
    {
      id: 'task-completed',
      description: 'task_update called to mark audit task completed',
      points: 7,
      phase: 'intention',
      validate: (r) => {
        return r.toolCalls
          .filter(tc => tc.name === 'task_update')
          .some(tc => {
            const input = JSON.stringify(tc.input).toLowerCase()
            return input.includes('completed') || input.includes('done') || input.includes('complete')
          })
      },
    },
    {
      id: 'tasks-checked',
      description: 'task_list called to check availability after completion',
      points: 5,
      phase: 'intention',
      validate: (r) => usedTool(r, 'task_list'),
    },
    {
      id: 'task-in-progress',
      description: 'task_update called to mark design task in_progress',
      points: 7,
      phase: 'intention',
      validate: (r) => {
        return r.toolCalls
          .filter(tc => tc.name === 'task_update')
          .some(tc => {
            const input = JSON.stringify(tc.input).toLowerCase()
            return input.includes('in_progress') || input.includes('in-progress') || input.includes('inprogress')
          })
      },
    },
    {
      id: 'dag-resolution',
      description: 'DAG resolution works — task_list called between the two task_updates',
      points: 6,
      phase: 'execution',
      validate: (r) => {
        const calls = r.toolCalls.map((tc, i) => ({ ...tc, idx: i }))
        const updates = calls.filter(tc => tc.name === 'task_update')
        const lists = calls.filter(tc => tc.name === 'task_list')
        if (updates.length < 2 || lists.length < 1) return false
        return lists.some(l => l.idx > updates[0].idx && l.idx < updates[updates.length - 1].idx)
      },
    },
  ],
  tags: ['teammate-coordination'],
}

// ---------------------------------------------------------------------------
// Phase 5: Team Cleanup — 15 points
// ---------------------------------------------------------------------------

const PHASE_5_PROMPT =
  'Send a shutdown request to both teammates, then delete the team.'

const PHASE_5: AgentEval = {
  id: 'teammate-cleanup',
  name: 'Teammate Coordination: Team Cleanup — shutdown and delete',
  category: 'teammate-coordination' as any,
  level: 2,
  pipeline: 'teammate-coordination',
  pipelinePhase: 5,
  input: PHASE_5_PROMPT,
  conversationHistory: [{ role: 'user', content: PHASE_5_PROMPT }],
  pipelineFiles: {},
  maxScore: 15,
  validationCriteria: [
    {
      id: 'shutdown-sent',
      description: 'send_team_message called with shutdown_request type',
      points: 8,
      phase: 'intention',
      validate: (r) => hasShutdownRequest(r),
    },
    {
      id: 'team-deleted',
      description: 'team_delete called to remove the team',
      points: 7,
      phase: 'execution',
      validate: (r) => usedTool(r, 'team_delete'),
    },
  ],
  tags: ['teammate-coordination'],
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const TEAMMATE_COORDINATION_EVALS: AgentEval[] = [
  PHASE_1,
  PHASE_2,
  PHASE_3,
  PHASE_4,
  PHASE_5,
]
