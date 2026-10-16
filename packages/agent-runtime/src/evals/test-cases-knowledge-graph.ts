// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Knowledge Graph & Impact Analysis Eval Test Cases
 *
 * Tests the agent's ability to analyze code relationships (via the knowledge
 * graph tools in explore/code-reviewer subagents, or by searching directly):
 * - impact_radius tool to analyze blast radius before making changes
 * - search tool with graph-enhanced results
 * - Understanding file relationships from impact hints on write/edit
 *
 * Scenarios:
 * 1. Agent should use impact_radius before refactoring a central file
 * 2. Agent should use impact_radius when asked about dependencies
 * 3. Agent should read impact hints from write_file results
 * 4. Agent should search across both code and files sources
 * 5. Agent should understand cross-file references in documentation
 */

import type { AgentEval, EvalResult } from './types'
import {
  usedTool,
  responseContains,
  toolCallArgsContain,
  delegatedTo,
  execCommands,
  execIsGrep,
  fileWrites,
  readFileAnyRoute,
  readWorkspaceFile,
  searchCalls,
  searchedAnyRoute,
  wroteFileAnyRoute,
} from './eval-helpers'

// ---------------------------------------------------------------------------
// Grading helpers
//
// impact_radius / detect_changes / review_context are bound to the explore
// and code-reviewer subagents, not the main agent. So these evals grade the
// answer's correctness and accept any sound route to it: those tools (inside
// a subagent), delegating to explore/code-reviewer, or reading/searching the
// dependents directly.
// ---------------------------------------------------------------------------

const GRAPH_TOOLS = ['impact_radius', 'detect_changes', 'review_context']

/** Delegated the analysis to a subagent that has the graph tools. */
function delegatedAnalysis(r: EvalResult): boolean {
  return delegatedTo(r, 'explore') || delegatedTo(r, 'code-reviewer') || delegatedTo(r, 'code_reviewer')
}

/** Analyzed the code via graph tools, delegation, or searching/reading it. */
function analyzedCode(r: EvalResult): boolean {
  return GRAPH_TOOLS.some(t => usedTool(r, t)) || delegatedAnalysis(r) || searchedAnyRoute(r)
}

/** Searched for (or asked a subagent about) `symbols` — e.g. who imports `crypto`. */
function lookedFor(r: EvalResult, ...symbols: string[]): boolean {
  const hit = (text: string) => symbols.some(s => text.toLowerCase().includes(s.toLowerCase()))
  if (GRAPH_TOOLS.some(t => r.toolCalls.some(c => c.name === t && hit(JSON.stringify(c.input))))) return true
  if (r.toolCalls.some(c => c.name === 'agent_spawn' && hit(JSON.stringify(c.input)))) return true
  return searchCalls(r).some(c => c.name !== 'read_file' && hit(JSON.stringify(c.input)))
}

/** Inspected what changed: graph change tools, a reviewer subagent, or git diff/log/status. */
function inspectedChanges(r: EvalResult): boolean {
  return usedTool(r, 'detect_changes') || usedTool(r, 'review_context') || usedTool(r, 'impact_radius') ||
    delegatedAnalysis(r) || execCommands(r).some(c => /\bgit\s+(diff|log|status|show)\b/.test(c))
}

/** Response names a risk assessment in any common vocabulary. */
function mentionsRisk(r: EvalResult): boolean {
  return /\brisk|severity|critical|breaking|high[- ]impact|blast radius/i.test(r.responseText)
}

/** Wrote to source/docs (not memory/notes). */
function wroteWorkspaceSource(r: EvalResult): boolean {
  return fileWrites(r).some(w => /^(src|files)\//.test(w.path))
}

// ---------------------------------------------------------------------------
// Workspace fixtures
// ---------------------------------------------------------------------------

const GRAPH_WORKSPACE_FILES: Record<string, string> = {
  'src/auth.ts': [
    'import { hashPassword } from "./crypto"',
    'import { UserModel } from "./models/user"',
    '',
    'export async function authenticate(email: string, password: string) {',
    '  const user = await UserModel.findByEmail(email)',
    '  if (!user) throw new Error("User not found")',
    '  const valid = await hashPassword(password) === user.passwordHash',
    '  return valid ? user : null',
    '}',
    '',
    'export async function createSession(userId: string) {',
    '  return { token: crypto.randomUUID(), userId, expiresAt: Date.now() + 86400000 }',
    '}',
  ].join('\n'),
  'src/crypto.ts': [
    'export async function hashPassword(password: string): Promise<string> {',
    '  return Bun.password.hash(password)',
    '}',
    '',
    'export function generateToken(): string {',
    '  return crypto.randomUUID()',
    '}',
  ].join('\n'),
  'src/models/user.ts': [
    'export class UserModel {',
    '  id: string = ""',
    '  email: string = ""',
    '  passwordHash: string = ""',
    '',
    '  static async findByEmail(email: string): Promise<UserModel | null> {',
    '    return null',
    '  }',
    '}',
  ].join('\n'),
  'src/api/login.ts': [
    'import { authenticate, createSession } from "../auth"',
    '',
    'export async function handleLogin(req: Request) {',
    '  const { email, password } = await req.json()',
    '  const user = await authenticate(email, password)',
    '  if (!user) return new Response("Unauthorized", { status: 401 })',
    '  const session = await createSession(user.id)',
    '  return Response.json(session)',
    '}',
  ].join('\n'),
  'src/api/register.ts': [
    'import { hashPassword } from "../crypto"',
    'import { UserModel } from "../models/user"',
    '',
    'export async function handleRegister(req: Request) {',
    '  const { email, password } = await req.json()',
    '  const hash = await hashPassword(password)',
    '  return Response.json({ ok: true })',
    '}',
  ].join('\n'),
  'files/auth-flow.md': [
    '# Authentication Flow',
    '',
    '## Login Process',
    'The login endpoint calls src/auth.ts which validates credentials.',
    'Password hashing is handled by src/crypto.ts.',
    '',
    '## Registration',
    'New users go through src/api/register.ts.',
    '',
    '## Security Notes',
    'See security-checklist.md for requirements.',
  ].join('\n'),
  'files/security-checklist.md': [
    '# Security Checklist',
    '',
    '- [ ] Rate limiting on login endpoint',
    '- [ ] Password complexity requirements',
    '- [ ] Session token rotation',
    '- [x] Password hashing with bcrypt',
    '',
    'Related: auth-flow.md',
  ].join('\n'),
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const KNOWLEDGE_GRAPH_EVALS: AgentEval[] = [

  // =========================================================================
  // Case 1: Use impact_radius before refactoring
  // Level 2 | Agent should check blast radius before modifying a core file
  // =========================================================================
  {
    id: 'graph-impact-before-refactor',
    name: 'Knowledge Graph: checks impact radius before refactoring auth module',
    category: 'tool-system',
    level: 2,
    input: 'I want to change the password hashing algorithm in src/crypto.ts from bcrypt to argon2. Before you make any changes, tell me what other files would be affected.',
    maxScore: 100,
    workspaceFiles: GRAPH_WORKSPACE_FILES,
    validationCriteria: [
      {
        id: 'used-impact-radius',
        description: 'Analyzed the blast radius (impact_radius, delegation to explore/code-reviewer, or searching/reading dependents)',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'impact_radius') || delegatedAnalysis(r) ||
          (lookedFor(r, 'crypto', 'hashPassword', 'generateToken') ||
            (readFileAnyRoute(r, 'src/auth.ts') && readFileAnyRoute(r, 'src/api/register.ts'))),
      },
      {
        id: 'impact-targets-crypto',
        description: 'The analysis targeted src/crypto.ts / its exports',
        points: 15,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'impact_radius', 'crypto') || lookedFor(r, 'crypto', 'hashPassword'),
      },
      {
        id: 'mentions-auth',
        description: 'Response mentions src/auth.ts as affected',
        points: 15,
        phase: 'execution',
        validate: (r) => responseContains(r, 'auth.ts'),
      },
      {
        id: 'mentions-register',
        description: 'Response mentions register as affected',
        points: 15,
        phase: 'execution',
        validate: (r) => responseContains(r, 'register'),
      },
      {
        id: 'did-not-write-yet',
        description: 'Did NOT modify source files (the user asked for analysis first)',
        points: 15,
        phase: 'execution',
        validate: (r) => analyzedCode(r) && !wroteWorkspaceSource(r),
      },
      {
        id: 'comprehensive-analysis',
        description: 'Response covers the transitive impact (login flow via auth.ts)',
        points: 10,
        phase: 'execution',
        validate: (r) => responseContains(r, 'login'),
      },
    ],
  },

  // =========================================================================
  // Case 2: Dependency analysis question
  // Level 2 | Agent should use impact_radius to answer "what depends on X?"
  // =========================================================================
  {
    id: 'graph-dependency-analysis',
    name: 'Knowledge Graph: analyzes dependencies of a module',
    category: 'tool-system',
    level: 2,
    input: 'What files depend on the UserModel class? I need to understand the dependency chain before I add a new field.',
    maxScore: 100,
    workspaceFiles: GRAPH_WORKSPACE_FILES,
    validationCriteria: [
      {
        id: 'used-impact-or-search',
        description: 'Found dependents (impact_radius, delegation, or searching for UserModel)',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'impact_radius') || delegatedAnalysis(r) || lookedFor(r, 'UserModel', 'models/user'),
      },
      {
        id: 'read-user-model',
        description: 'Read the user model file to understand the class',
        points: 15,
        phase: 'intention',
        validate: (r) => readFileAnyRoute(r, 'src/models/user.ts') || lookedFor(r, 'UserModel') || delegatedAnalysis(r),
      },
      {
        id: 'identifies-auth-dependency',
        description: 'Identifies src/auth.ts as a dependent',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, 'auth.ts'),
      },
      {
        id: 'identifies-register-dependency',
        description: 'Identifies src/api/register.ts as a dependent',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, 'register'),
      },
      {
        id: 'mentions-login-chain',
        description: 'Mentions the login endpoint is transitively affected',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, 'login'),
      },
    ],
  },

  // =========================================================================
  // Case 3: Cross-source search (code + docs)
  // Level 2 | Agent searches across code and file docs for auth info
  // =========================================================================
  {
    id: 'graph-cross-source-search',
    name: 'Knowledge Graph: cross-source search finds code and docs',
    category: 'tool-system',
    level: 2,
    input: 'Find everything in our workspace related to authentication — both the code implementation and any documentation.',
    maxScore: 100,
    workspaceFiles: GRAPH_WORKSPACE_FILES,
    validationCriteria: [
      {
        id: 'searched-code',
        description: 'Searched the code (search tool, shell grep/find, or delegation)',
        points: 20,
        phase: 'intention',
        validate: (r) => searchedAnyRoute(r) || delegatedAnalysis(r),
      },
      {
        id: 'searched-files',
        description: 'Also covered the docs under files/ (search tool, reading them, or a workspace-wide grep)',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'search') || delegatedAnalysis(r) ||
          readFileAnyRoute(r, (p) => p.startsWith('files/') || p.includes('/files/')) ||
          execCommands(r).some(c => execIsGrep(c) && /files|\s\.(\s|$)|-r/.test(c)),
      },
      {
        id: 'found-auth-code',
        description: 'Response mentions code implementation (auth.ts, login.ts)',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, 'auth.ts') || responseContains(r, 'login'),
      },
      {
        id: 'found-auth-docs',
        description: 'Response mentions documentation (auth-flow.md)',
        points: 20,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'auth-flow') ||
          responseContains(r, 'authentication flow') ||
          responseContains(r, 'security'),
      },
      {
        id: 'comprehensive-overview',
        description: 'Provides a comprehensive overview spanning code and docs',
        points: 20,
        phase: 'execution',
        validate: (r) => r.responseText.length > 200,
      },
    ],
  },

  // =========================================================================
  // Case 4: Impact-aware editing
  // Level 3 | Agent should notice impact hints after editing a file
  // =========================================================================
  {
    id: 'graph-impact-aware-editing',
    name: 'Knowledge Graph: notices impact hints when editing files',
    category: 'tool-system',
    level: 3,
    input: 'Add a `lastLoginAt` timestamp field to the UserModel class in src/models/user.ts and update the authenticate function in src/auth.ts to set it on successful login.',
    maxScore: 100,
    workspaceFiles: GRAPH_WORKSPACE_FILES,
    validationCriteria: [
      {
        id: 'read-before-edit',
        description: 'Read the target files before editing',
        points: 15,
        phase: 'intention',
        validate: (r) => readFileAnyRoute(r, 'src/models/user.ts') || readFileAnyRoute(r, 'src/auth.ts'),
      },
      {
        id: 'edited-user-model',
        description: 'Edited the UserModel to add lastLoginAt field',
        points: 25,
        phase: 'execution',
        validate: (r) => /lastLoginAt/.test(readWorkspaceFile(r, 'src/models/user.ts')) ||
          wroteFileAnyRoute(r, 'src/models/user.ts', 'lastLoginAt'),
      },
      {
        id: 'edited-auth',
        description: 'Edited auth.ts to set lastLoginAt on login',
        points: 25,
        phase: 'execution',
        validate: (r) => /lastLoginAt/.test(readWorkspaceFile(r, 'src/auth.ts')) ||
          wroteFileAnyRoute(r, 'src/auth.ts', 'lastLoginAt'),
      },
      {
        id: 'both-files-updated',
        description: 'Both user model and auth files were modified',
        points: 20,
        phase: 'execution',
        validate: (r) => wroteFileAnyRoute(r, 'src/models/user.ts') && wroteFileAnyRoute(r, 'src/auth.ts'),
      },
      {
        id: 'no-broken-imports',
        description: 'auth.ts still imports hashPassword and UserModel after the edit',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          if (!wroteFileAnyRoute(r, 'src/auth.ts')) return false
          const auth = readWorkspaceFile(r, 'src/auth.ts')
          if (!auth) return true
          return /import\s*\{[^}]*hashPassword[^}]*\}\s*from\s*["']\.\/crypto["']/.test(auth) &&
            /import\s*\{[^}]*UserModel[^}]*\}\s*from\s*["']\.\/models\/user["']/.test(auth)
        },
      },
    ],
  },

  // =========================================================================
  // Case 5: Documentation relationship awareness
  // Level 2 | Agent understands relationships between docs via graph
  // =========================================================================
  {
    id: 'graph-doc-relationships',
    name: 'Knowledge Graph: understands document relationships',
    category: 'tool-system',
    level: 2,
    input: 'I need to update the security checklist. What other documentation files reference it or are related to it?',
    maxScore: 100,
    workspaceFiles: GRAPH_WORKSPACE_FILES,
    validationCriteria: [
      {
        id: 'used-impact-or-search',
        description: 'Found related docs (impact_radius, delegation, or searching/reading the docs)',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'impact_radius') || delegatedAnalysis(r) || lookedFor(r, 'security-checklist', 'security checklist', 'checklist') ||
          readFileAnyRoute(r, 'files/auth-flow.md'),
      },
      {
        id: 'found-auth-flow-reference',
        description: 'Identified auth-flow.md as referencing the security checklist',
        points: 30,
        phase: 'execution',
        validate: (r) => responseContains(r, 'auth-flow'),
      },
      {
        id: 'read-checklist',
        description: 'Read the security checklist to understand its content',
        points: 20,
        phase: 'intention',
        validate: (r) =>
          readFileAnyRoute(r, 'files/security-checklist.md') ||
          usedTool(r, 'search') ||
          usedTool(r, 'impact_radius') ||
          delegatedAnalysis(r),
      },
      {
        id: 'provides-actionable-info',
        description: 'Response provides actionable information about relationships',
        points: 25,
        phase: 'execution',
        validate: (r) => r.responseText.length > 100,
      },
    ],
  },

  // =========================================================================
  // Case 6: detect_changes for code review preparation
  // Level 2 | Agent uses detect_changes to analyze what changed
  // =========================================================================
  {
    id: 'graph-detect-changes-review',
    name: 'Knowledge Graph: uses detect_changes to analyze code changes',
    category: 'tool-system',
    level: 2,
    input: 'I just made some changes to the auth module. Can you analyze what changed and tell me the risk level and if there are any test gaps?',
    maxScore: 100,
    workspaceFiles: GRAPH_WORKSPACE_FILES,
    validationCriteria: [
      {
        id: 'used-detect-changes',
        description: 'Inspected the changes (detect_changes/review_context, a code-reviewer/explore subagent, or git diff/log/status)',
        points: 30,
        phase: 'intention',
        validate: (r) => inspectedChanges(r),
      },
      {
        id: 'mentions-risk',
        description: 'Response gives a risk assessment (risk / severity / critical / breaking)',
        points: 20,
        phase: 'execution',
        validate: (r) => mentionsRisk(r),
      },
      {
        id: 'mentions-test-gaps',
        description: 'Response mentions test coverage or test gaps',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, 'test') || responseContains(r, 'coverage'),
      },
      {
        id: 'read-or-searched-context',
        description: 'Read files or used search/impact tools for additional context',
        points: 15,
        phase: 'intention',
        validate: (r) => analyzedCode(r),
      },
      {
        id: 'comprehensive-response',
        description: 'Provides comprehensive analysis',
        points: 15,
        phase: 'execution',
        validate: (r) => r.responseText.length > 150,
      },
    ],
  },

  // =========================================================================
  // Case 7: review_context for comprehensive PR review
  // Level 2 | Agent uses review_context for full review bundle
  // =========================================================================
  {
    id: 'graph-review-context-pr',
    name: 'Knowledge Graph: uses review_context for PR review',
    category: 'tool-system',
    level: 2,
    input: 'I need to review the recent changes to our codebase. Give me a comprehensive review of what changed, what the risks are, and what I should pay attention to.',
    maxScore: 100,
    workspaceFiles: GRAPH_WORKSPACE_FILES,
    validationCriteria: [
      {
        id: 'used-review-context',
        description: 'Inspected the changes (review_context/detect_changes, a code-reviewer/explore subagent, or git diff/log/status)',
        points: 30,
        phase: 'intention',
        validate: (r) => inspectedChanges(r),
      },
      {
        id: 'mentions-affected-files',
        description: 'Response mentions specific affected files',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, '.ts') || responseContains(r, '.py') || responseContains(r, 'file'),
      },
      {
        id: 'mentions-guidance',
        description: 'Response includes review guidance or recommendations',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, 'recommend') || responseContains(r, 'attention') ||
          responseContains(r, 'review') || responseContains(r, 'guidance') || responseContains(r, 'suggest'),
      },
      {
        id: 'mentions-risk-or-impact',
        description: 'Mentions risk scores or impact',
        points: 15,
        phase: 'execution',
        validate: (r) => mentionsRisk(r) || responseContains(r, 'impact'),
      },
      {
        id: 'comprehensive-review',
        description: 'Provides a comprehensive review (>200 chars)',
        points: 15,
        phase: 'execution',
        validate: (r) => r.responseText.length > 200,
      },
    ],
  },
]
