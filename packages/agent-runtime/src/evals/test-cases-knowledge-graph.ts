// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Knowledge Graph & Impact Analysis Eval Test Cases
 *
 * Tests the agent's ability to use the workspace knowledge graph for:
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

import type { AgentEval } from './types'
import {
  usedTool,
  neverUsedTool,
  responseContains,
  toolCallArgsContain,
} from './eval-helpers'

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
        description: 'Used impact_radius tool to check blast radius',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'impact_radius'),
      },
      {
        id: 'impact-targets-crypto',
        description: 'impact_radius was called with src/crypto.ts',
        points: 15,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'impact_radius', 'crypto'),
      },
      {
        id: 'mentions-auth',
        description: 'Response mentions src/auth.ts as affected',
        points: 15,
        phase: 'execution',
        validate: (r) => responseContains(r, 'auth'),
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
        description: 'Did NOT modify files before analyzing impact',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const impactIdx = r.toolCalls.findIndex(t => t.name === 'impact_radius')
          const writeIdx = r.toolCalls.findIndex(t => t.name === 'write_file' || t.name === 'edit_file')
          return impactIdx >= 0 && (writeIdx < 0 || impactIdx < writeIdx)
        },
      },
      {
        id: 'comprehensive-analysis',
        description: 'Response provides a comprehensive list of affected areas',
        points: 10,
        phase: 'execution',
        validate: (r) => responseContains(r, 'hash') || responseContains(r, 'password'),
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
        description: 'Used impact_radius or search to find dependencies',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'impact_radius') || usedTool(r, 'search'),
      },
      {
        id: 'read-user-model',
        description: 'Read the user model file to understand the class',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'read_file') || usedTool(r, 'search'),
      },
      {
        id: 'identifies-auth-dependency',
        description: 'Identifies src/auth.ts as a dependent',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, 'auth'),
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
        description: 'Used search to search code files',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'search'),
      },
      {
        id: 'searched-files',
        description: 'Used search to search user files/docs',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'search'),
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
        validate: (r) => usedTool(r, 'read_file'),
      },
      {
        id: 'edited-user-model',
        description: 'Edited the UserModel to add lastLoginAt field',
        points: 25,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'edit_file', 'lastLoginAt') ||
          toolCallArgsContain(r, 'write_file', 'lastLoginAt'),
      },
      {
        id: 'edited-auth',
        description: 'Edited auth.ts to set lastLoginAt on login',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const authEdits = r.toolCalls.filter(t =>
            (t.name === 'edit_file' || t.name === 'write_file') &&
            String((t.input as any)?.path ?? '').includes('auth')
          )
          return authEdits.length > 0
        },
      },
      {
        id: 'both-files-updated',
        description: 'Both user model and auth files were modified',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const writtenPaths = r.toolCalls
            .filter(t => t.name === 'edit_file' || t.name === 'write_file')
            .map(t => String((t.input as any)?.path ?? ''))
          return writtenPaths.some(p => p.includes('user')) &&
            writtenPaths.some(p => p.includes('auth'))
        },
      },
      {
        id: 'no-broken-imports',
        description: 'Did not break existing import statements',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const authWrites = r.toolCalls
            .filter(t => (t.name === 'edit_file' || t.name === 'write_file') &&
              String((t.input as any)?.path ?? '').includes('auth'))
          if (authWrites.length === 0) return false
          const lastContent = String((authWrites[authWrites.length - 1].input as any)?.content ??
            (authWrites[authWrites.length - 1].input as any)?.new_string ?? '')
          return !lastContent.includes('undefined') || lastContent.includes('import')
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
        description: 'Used impact_radius or search to find related docs',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'impact_radius') || usedTool(r, 'search'),
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
          toolCallArgsContain(r, 'read_file', 'security') ||
          usedTool(r, 'search') ||
          usedTool(r, 'impact_radius'),
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
        description: 'Used detect_changes or review_context tool',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'detect_changes') || usedTool(r, 'review_context'),
      },
      {
        id: 'mentions-risk',
        description: 'Response mentions risk or risk score',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, 'risk'),
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
        validate: (r) => usedTool(r, 'read_file') || usedTool(r, 'search') ||
          usedTool(r, 'impact_radius') || usedTool(r, 'detect_changes') || usedTool(r, 'review_context'),
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
        description: 'Used review_context or detect_changes tool',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'review_context') || usedTool(r, 'detect_changes'),
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
        validate: (r) => responseContains(r, 'risk') || responseContains(r, 'impact'),
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
