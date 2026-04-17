// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { AgentEval, EvalResult } from './types'
import {
  usedTool,
  neverUsedTool,
  toolCallArgsContain,
  toolCallsJson,
  planToolArgsContain,
  planTodoCount,
} from './eval-helpers'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function updatePlanHasFilepath(r: EvalResult): boolean {
  return r.toolCalls
    .filter(tc => tc.name === 'update_plan')
    .some(tc => {
      const input = tc.input as Record<string, any>
      return typeof input.filepath === 'string' && input.filepath.includes('.plan.md')
    })
}

function planBodyContainsAny(r: EvalResult, terms: string[]): boolean {
  const json = toolCallsJson(r)
  return terms.some(t => json.includes(t.toLowerCase()))
}

// Synthetic plan file content for phase 2 (simulates what phase 1 would have written)
const PHASE_1_PLAN_FILE = `---
name: "JWT Auth System"
overview: "Build a user authentication system with JWT tokens, password hashing, and role-based access control."
createdAt: "2026-04-15T00:00:00.000Z"
status: pending
todos:
  - id: setup-auth-middleware
    content: "Create JWT authentication middleware with token verification and refresh logic"
    status: pending
  - id: password-hashing
    content: "Implement password hashing with bcrypt and secure storage"
    status: pending
  - id: rbac-system
    content: "Build role-based access control with permission guards"
    status: pending
---

# JWT Auth System

## Implementation Plan

### 1. JWT Authentication Middleware
- Create middleware that verifies JWT tokens on protected routes
- Implement token refresh logic with short-lived access tokens and long-lived refresh tokens
- Store refresh tokens securely with rotation on use

### 2. Password Hashing
- Use bcrypt for password hashing with appropriate salt rounds
- Implement secure password validation on login
- Add password strength requirements

### 3. Role-Based Access Control
- Define roles (admin, user, moderator) with granular permissions
- Create permission guard middleware that checks user roles
- Add role assignment and management endpoints
`

// ---------------------------------------------------------------------------
// Phase 1: Plan Creation — 20 points
// ---------------------------------------------------------------------------

const PHASE_1_PROMPT =
  'I want to build a user authentication system with JWT tokens, password hashing, ' +
  'and role-based access control. Create a plan for how to implement this.'

const PHASE_1: AgentEval = {
  id: 'plan-creation',
  name: 'Plan Lifecycle: Creation — create a structured plan in plan mode',
  category: 'plan',
  level: 2,
  pipeline: 'plan-lifecycle',
  pipelinePhase: 1,
  interactionMode: 'plan',
  input: PHASE_1_PROMPT,
  conversationHistory: [],
  maxScore: 20,
  validationCriteria: [
    {
      id: 'create-plan-called',
      description: 'create_plan tool was called',
      points: 5,
      phase: 'intention',
      validate: (r) => usedTool(r, 'create_plan'),
    },
    {
      id: 'plan-mentions-jwt',
      description: 'Plan content references JWT/token authentication',
      points: 5,
      phase: 'execution',
      validate: (r) => planBodyContainsAny(r, ['jwt', 'token']),
    },
    {
      id: 'plan-has-todos',
      description: 'Plan includes at least 2 actionable todos',
      points: 5,
      phase: 'execution',
      validate: (r) => planTodoCount(r) >= 2,
    },
    {
      id: 'researched-first',
      description: 'Agent used read-only tools before creating the plan',
      points: 5,
      phase: 'intention',
      validate: (r) => {
        const createIdx = r.toolCalls.findIndex(tc => tc.name === 'create_plan')
        if (createIdx <= 0) return false
        const priorTools = r.toolCalls.slice(0, createIdx)
        return priorTools.some(tc =>
          tc.name === 'read_file' || tc.name === 'search' || tc.name === 'web'
        )
      },
    },
  ],
  tags: ['plan'],
}

// ---------------------------------------------------------------------------
// Phase 2: Plan Update — 20 points
// ---------------------------------------------------------------------------

const PHASE_2_PROMPT =
  'Actually, I also need OAuth2 support with Google and GitHub providers. Update the existing plan to include this.'

const PHASE_2: AgentEval = {
  id: 'plan-update',
  name: 'Plan Lifecycle: Update — modify existing plan with new requirements',
  category: 'plan',
  level: 3,
  pipeline: 'plan-lifecycle',
  pipelinePhase: 2,
  interactionMode: 'plan',
  input: PHASE_2_PROMPT,
  conversationHistory: [
    { role: 'user', content: PHASE_1_PROMPT },
    {
      role: 'assistant',
      content: 'I\'ve created a plan for the JWT authentication system with password hashing and role-based access control. ' +
        'The plan is saved at .shogo/plans/jwt-auth-system_abc12345.plan.md with 3 implementation tasks.',
    },
  ],
  pipelineFiles: {
    '.shogo/plans/jwt-auth-system_abc12345.plan.md': PHASE_1_PLAN_FILE,
  },
  maxScore: 20,
  validationCriteria: [
    {
      id: 'update-plan-called',
      description: 'update_plan called instead of create_plan',
      points: 5,
      phase: 'intention',
      validate: (r) => usedTool(r, 'update_plan') && neverUsedTool(r, 'create_plan'),
    },
    {
      id: 'mentions-oauth',
      description: 'Updated plan references OAuth, Google, or GitHub',
      points: 5,
      phase: 'execution',
      validate: (r) => planBodyContainsAny(r, ['oauth', 'google', 'github']),
    },
    {
      id: 'has-filepath',
      description: 'update_plan call references the existing plan file',
      points: 5,
      phase: 'execution',
      validate: (r) => updatePlanHasFilepath(r),
    },
    {
      id: 'preserves-original',
      description: 'Updated plan retains original JWT/auth content',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const updateCalls = r.toolCalls.filter(tc => tc.name === 'update_plan')
        if (updateCalls.length === 0) return false
        const lastUpdate = updateCalls[updateCalls.length - 1]
        const input = lastUpdate.input as Record<string, any>
        const planText = (input.plan ?? '').toLowerCase()
        return planText.includes('jwt') || planText.includes('password') || planText.includes('role')
      },
    },
  ],
  tags: ['plan'],
}

// ---------------------------------------------------------------------------
// Phase 3: Trivial Task — should NOT create a plan — 15 points
// ---------------------------------------------------------------------------

const PHASE_3_PROMPT =
  "Fix the typo in the README.md file — it says 'teh' instead of 'the' on line 5."

const PHASE_3: AgentEval = {
  id: 'plan-trivial-guard',
  name: 'Plan Lifecycle: Trivial Guard — do not create plan for simple tasks',
  category: 'plan',
  level: 1,
  pipeline: 'plan-lifecycle',
  pipelinePhase: 3,
  input: PHASE_3_PROMPT,
  conversationHistory: [],
  pipelineFiles: {
    'README.md': '# My Project\n\nA cool project.\n\nThis is teh best project ever.\n\nEnjoy!\n',
  },
  maxScore: 15,
  antiPatterns: ['plan-for-trivial-task'],
  validationCriteria: [
    {
      id: 'no-create-plan',
      description: 'Agent does NOT call create_plan for a trivial fix',
      points: 5,
      phase: 'intention',
      validate: (r) => neverUsedTool(r, 'create_plan'),
    },
    {
      id: 'no-update-plan',
      description: 'Agent does NOT call update_plan for a trivial fix',
      points: 5,
      phase: 'intention',
      validate: (r) => neverUsedTool(r, 'update_plan'),
    },
    {
      id: 'acknowledges-simplicity',
      description: 'Response indicates the task is straightforward',
      points: 5,
      phase: 'interaction',
      validate: (r) => {
        const text = r.responseText.toLowerCase()
        return text.includes('fix') || text.includes('typo') || text.includes('simple') ||
          text.includes('done') || text.includes('corrected') || text.includes('updated')
      },
    },
  ],
  tags: ['plan'],
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const PLAN_EVALS: AgentEval[] = [PHASE_1, PHASE_2, PHASE_3]
