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
// Lifecycle: Plan Creation — 20 points
//
// These three lifecycle cases were originally a single sequential pipeline,
// but pipeline phases (a) couldn't HTTP-seed fixtures into VM workers and
// (b) leaked cumulative tool calls into later phases' intention checks (the
// trivial-guard could never pass once an earlier phase called create_plan).
// They are now independent standalone evals that seed their own state via
// workspaceFiles + conversationHistory.
// ---------------------------------------------------------------------------

const PHASE_1_PROMPT =
  'I want to build a user authentication system with JWT tokens, password hashing, ' +
  'and role-based access control. Create a plan for how to implement this.'

const PHASE_1: AgentEval = {
  id: 'plan-creation',
  name: 'Plan Lifecycle: Creation — create a structured plan in plan mode',
  category: 'plan',
  level: 2,
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
// Lifecycle: Plan Update — 20 points (standalone; seeds the prior plan file)
// ---------------------------------------------------------------------------

const PHASE_2_PROMPT =
  'Actually, I also need OAuth2 support with Google and GitHub providers. Update the existing plan to include this.'

const PHASE_2: AgentEval = {
  id: 'plan-update',
  name: 'Plan Lifecycle: Update — modify existing plan with new requirements',
  category: 'plan',
  level: 3,
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
  workspaceFiles: {
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
// Lifecycle: Trivial Task — should NOT create a plan — 15 points (standalone)
// ---------------------------------------------------------------------------

const PHASE_3_PROMPT =
  "Fix the typo in the README.md file — it says 'teh' instead of 'the' on line 5."

const PHASE_3: AgentEval = {
  id: 'plan-trivial-guard',
  name: 'Plan Lifecycle: Trivial Guard — do not create plan for simple tasks',
  category: 'plan',
  level: 1,
  input: PHASE_3_PROMPT,
  conversationHistory: [],
  workspaceFiles: {
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
// Standalone creation cases — surface inconsistent create_plan behavior
//
// The flaky failure mode is the model *skipping* create_plan when it should
// produce one. These independent evals stress that across varied phrasing,
// domains, and interaction modes, plus negative guards against over-triggering.
// ---------------------------------------------------------------------------

// Seed files so the "researched-first" criterion is satisfiable — the agent
// has something real to read before drafting a plan.
const APP_SEED_FILES: Record<string, string> = {
  'README.md':
    '# Acme App\n\nA multi-service application. Backend in apps/api, mobile in apps/mobile.\n',
  'apps/api/src/server.ts':
    "import { createServer } from './lib/server'\n\nexport const app = createServer()\n",
  'apps/api/src/routes/index.ts':
    "export const routes = ['/users', '/posts', '/auth']\n",
}

interface PlanCreationSpec {
  id: string
  name: string
  prompt: string
  level: 1 | 2 | 3 | 4 | 5
  /** Keywords the plan body should reference (any match). */
  domainTerms: string[]
  /** Defaults to 'plan'. Set 'agent' for auto-plan cases. */
  interactionMode?: 'agent' | 'plan'
  /** Whether to require read-only research before create_plan. Defaults true. */
  requireResearch?: boolean
}

function makePlanCreationEval(spec: PlanCreationSpec): AgentEval {
  const requireResearch = spec.requireResearch ?? true
  const criteria = [
    {
      id: 'create-plan-called',
      description: 'create_plan tool was called',
      points: 10,
      phase: 'intention' as const,
      validate: (r: EvalResult) => usedTool(r, 'create_plan'),
    },
    {
      id: 'plan-mentions-domain',
      description: `Plan content references the requested domain (${spec.domainTerms.join('/')})`,
      points: 5,
      phase: 'execution' as const,
      validate: (r: EvalResult) => planBodyContainsAny(r, spec.domainTerms),
    },
    {
      id: 'plan-has-todos',
      description: 'Plan includes at least 2 actionable todos',
      points: 5,
      phase: 'execution' as const,
      validate: (r: EvalResult) => planTodoCount(r) >= 2,
    },
  ]
  if (requireResearch) {
    criteria.push({
      id: 'researched-first',
      description: 'Agent used read-only tools before creating the plan',
      points: 5,
      phase: 'intention' as const,
      validate: (r: EvalResult) => {
        const createIdx = r.toolCalls.findIndex(tc => tc.name === 'create_plan')
        if (createIdx <= 0) return false
        const priorTools = r.toolCalls.slice(0, createIdx)
        return priorTools.some(tc =>
          tc.name === 'read_file' || tc.name === 'search' || tc.name === 'web'
        )
      },
    })
  }
  return {
    id: spec.id,
    name: spec.name,
    category: 'plan',
    level: spec.level,
    interactionMode: spec.interactionMode ?? 'plan',
    input: spec.prompt,
    conversationHistory: [],
    workspaceFiles: APP_SEED_FILES,
    maxScore: criteria.reduce((sum, c) => sum + c.points, 0),
    validationCriteria: criteria,
    tags: ['plan'],
  }
}

// A. Explicit plan requests — varied phrasing and domains -------------------

const GRAPHQL_MIGRATION = makePlanCreationEval({
  id: 'plan-create-graphql-migration',
  name: 'Plan Creation: GraphQL migration — explicit "draft an implementation plan"',
  prompt:
    'Draft an implementation plan to migrate our REST API to GraphQL. ' +
    'Cover the schema design, resolver layer, and a phased rollout.',
  level: 3,
  domainTerms: ['graphql', 'resolver', 'schema'],
})

const ETL_PIPELINE = makePlanCreationEval({
  id: 'plan-create-etl-pipeline',
  name: 'Plan Creation: ETL pipeline — "outline a step-by-step plan"',
  prompt:
    'Outline a step-by-step plan to build a nightly ETL pipeline that loads data ' +
    'from Postgres into BigQuery, with validation and alerting on failures.',
  level: 3,
  domainTerms: ['etl', 'postgres', 'bigquery', 'pipeline'],
})

const MULTI_TENANT = makePlanCreationEval({
  id: 'plan-create-multi-tenant',
  name: 'Plan Creation: multi-tenant — indirect "lay it out as a plan"',
  prompt:
    'How should I approach adding multi-tenant support to the backend so each ' +
    'organization has isolated data? Lay it out as a plan.',
  level: 4,
  domainTerms: ['tenant', 'isolation', 'organization'],
})

const PRODUCT_LAUNCH = makePlanCreationEval({
  id: 'plan-create-product-launch',
  name: 'Plan Creation: product launch — non-engineering breadth',
  prompt:
    'Plan a product launch for our new mobile app. Include marketing, ' +
    'beta testing, and a go-live timeline.',
  level: 2,
  domainTerms: ['launch', 'marketing', 'beta', 'timeline'],
  // Non-code request; don't require codebase research first.
  requireResearch: false,
})

// B. Agent-mode auto-plan — complex task, no literal "plan" word ------------

const AGENT_MODE_AUTOPLAN = makePlanCreationEval({
  id: 'plan-create-agent-mode-autoplan',
  name: 'Plan Creation: agent-mode auto-plan — complex feature without the word "plan"',
  prompt:
    'Add real-time collaborative editing to the app: live presence indicators, ' +
    'conflict resolution for simultaneous edits, and offline sync that reconciles ' +
    'when reconnecting.',
  level: 4,
  domainTerms: ['presence', 'conflict', 'offline', 'sync', 'collaborat'],
  interactionMode: 'agent',
  // Auto-plan from complexity; the model may dive into reading first or plan up front.
  requireResearch: false,
})

// C. Negative / over-trigger guards — should NOT create a plan --------------

const GUARD_PURE_QUESTION: AgentEval = {
  id: 'plan-guard-pure-question',
  name: 'Plan Guard: explanation request — do not create a plan for a question',
  category: 'plan',
  level: 1,
  input: 'Explain how our JWT refresh flow works.',
  conversationHistory: [],
  workspaceFiles: {
    'apps/api/src/auth/jwt.ts':
      'export function refresh(token: string) {\n  // rotate refresh token, issue new access token\n  return { accessToken: "...", refreshToken: "..." }\n}\n',
  },
  maxScore: 10,
  antiPatterns: ['plan-for-trivial-task'],
  validationCriteria: [
    {
      id: 'no-create-plan',
      description: 'Agent does NOT call create_plan for an explanation request',
      points: 5,
      phase: 'intention',
      validate: (r) => neverUsedTool(r, 'create_plan'),
    },
    {
      id: 'answers-question',
      description: 'Response actually explains the refresh flow',
      points: 5,
      phase: 'interaction',
      validate: (r) => {
        const text = r.responseText.toLowerCase()
        return text.includes('token') || text.includes('refresh') || text.includes('jwt')
      },
    },
  ],
  tags: ['plan'],
}

const GUARD_SINGLE_FILE_EDIT: AgentEval = {
  id: 'plan-guard-single-file-edit',
  name: 'Plan Guard: trivial rename — do not create a plan for a one-line edit',
  category: 'plan',
  level: 1,
  input: "Rename the variable `cfg` to `config` in src/utils.ts.",
  conversationHistory: [],
  workspaceFiles: {
    'src/utils.ts':
      'const cfg = { retries: 3 }\n\nexport function getRetries() {\n  return cfg.retries\n}\n',
  },
  maxScore: 10,
  antiPatterns: ['plan-for-trivial-task'],
  validationCriteria: [
    {
      id: 'no-create-plan',
      description: 'Agent does NOT call create_plan for a trivial rename',
      points: 5,
      phase: 'intention',
      validate: (r) => neverUsedTool(r, 'create_plan'),
    },
    {
      id: 'no-update-plan',
      description: 'Agent does NOT call update_plan for a trivial rename',
      points: 5,
      phase: 'intention',
      validate: (r) => neverUsedTool(r, 'update_plan'),
    },
  ],
  tags: ['plan'],
}

export const PLAN_CREATION_EVALS: AgentEval[] = [
  GRAPHQL_MIGRATION,
  ETL_PIPELINE,
  MULTI_TENANT,
  PRODUCT_LAUNCH,
  AGENT_MODE_AUTOPLAN,
  GUARD_PURE_QUESTION,
  GUARD_SINGLE_FILE_EDIT,
]

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const PLAN_EVALS: AgentEval[] = [PHASE_1, PHASE_2, PHASE_3, ...PLAN_CREATION_EVALS]
