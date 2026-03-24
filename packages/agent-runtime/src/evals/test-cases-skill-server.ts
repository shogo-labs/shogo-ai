// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Skill Server Eval Test Cases
 *
 * Tests the agent's ability to create, evolve, and use a skill server —
 * the per-workspace Hono API backed by SQLite that skills can add endpoints to.
 *
 * Covers:
 * - Creating a Prisma schema + shogo.config.json for a new skill server
 * - Running shogo generate + prisma db push via exec
 * - Evolving an existing schema (adding fields and models)
 * - Using the skill server's REST API to persist and query data
 * - Writing a SKILL.md that references the skill server endpoints
 */

import type { AgentEval } from './types'
import type { ToolMockMap } from './tool-mocks'
import {
  usedTool,
  toolCallArgsContain,
  responseContains,
  execCommandContains,
  toolCallsJson,
} from './eval-helpers'

// ---------------------------------------------------------------------------
// Tool Mocks
// ---------------------------------------------------------------------------

const SKILL_SERVER_BUILD_MOCKS: ToolMockMap = {
  exec: {
    type: 'pattern',
    patterns: [
      {
        match: { command: 'shogo generate' },
        response: {
          stdout: '🚀 Shogo Generate\n   ✓ lead.routes.ts\n   ✓ lead.hooks.ts\n   ✓ scoring-rule.routes.ts\n   ✓ scoring-rule.hooks.ts\n   ✓ index.ts\n✅ Generated 5 files for 2 models',
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: { command: 'prisma db push' },
        response: {
          stdout: '🚀  Your database is now in sync with your Prisma schema.',
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: { command: 'prisma generate' },
        response: {
          stdout: '✓ Generated Prisma Client',
          stderr: '',
          exitCode: 0,
        },
      },
    ],
    default: { stdout: '', stderr: '', exitCode: 0 },
  },
  web: {
    type: 'pattern',
    patterns: [
      {
        match: { url: 'localhost' },
        response: {
          content: JSON.stringify({ ok: true, items: [
            { id: '1', name: 'Acme Corp', companySize: 500, fundingStage: 'Series B', score: 85 },
            { id: '2', name: 'Small LLC', companySize: 10, fundingStage: 'Pre-seed', score: 20 },
          ] }),
          status: 200,
        },
      },
    ],
    default: {
      content: '<html><body>Mock page</body></html>',
      status: 200,
    },
  },
}

const SKILL_SERVER_EVOLVE_MOCKS: ToolMockMap = {
  exec: {
    type: 'pattern',
    patterns: [
      {
        match: { command: 'shogo generate' },
        response: {
          stdout: '🚀 Shogo Generate\n   ✓ todo.routes.ts\n   ✓ tag.routes.ts\n   ✓ index.ts\n✅ Generated 5 files for 2 models',
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: { command: 'prisma db push' },
        response: {
          stdout: '🚀  Your database is now in sync with your Prisma schema.',
          stderr: '',
          exitCode: 0,
        },
      },
    ],
    default: { stdout: '', stderr: '', exitCode: 0 },
  },
}

const SKILL_SERVER_PERSIST_MOCKS: ToolMockMap = {
  web: {
    type: 'pattern',
    patterns: [
      {
        match: { url: 'bookmarks', method: 'POST' },
        response: {
          content: JSON.stringify({ ok: true, data: { id: 'bk-1', url: 'https://react.dev', title: 'React docs' } }),
          status: 201,
        },
      },
      {
        match: { url: 'bookmarks' },
        response: {
          content: JSON.stringify({
            ok: true,
            items: [
              { id: 'bk-1', url: 'https://react.dev', title: 'React docs', createdAt: '2026-03-23T00:00:00Z' },
              { id: 'bk-2', url: 'https://bun.sh', title: 'Bun docs', createdAt: '2026-03-23T00:01:00Z' },
            ],
          }),
          status: 200,
        },
      },
    ],
    default: {
      content: JSON.stringify({ ok: true }),
      status: 200,
    },
  },
  exec: {
    type: 'static',
    response: { stdout: '', stderr: '', exitCode: 0 },
  },
}

// ---------------------------------------------------------------------------
// Pre-seeded workspace files
// ---------------------------------------------------------------------------

const EXISTING_TODO_SCHEMA = `datasource db {
  provider = "sqlite"
}

generator client {
  provider = "prisma-client"
  output   = "./generated/prisma"
}

model Todo {
  id        String   @id @default(cuid())
  title     String
  done      Boolean  @default(false)
  createdAt DateTime @default(now())
}
`

const EXISTING_SHOGO_CONFIG = JSON.stringify({
  schema: './schema.prisma',
  outputs: [
    { dir: './generated', generate: ['routes', 'hooks', 'types'] },
    { dir: '.', generate: ['server'] },
    { dir: '.', generate: ['db'] },
  ],
}, null, 2)

const EXISTING_BOOKMARK_SCHEMA = `datasource db {
  provider = "sqlite"
}

generator client {
  provider = "prisma-client"
  output   = "./generated/prisma"
}

model Bookmark {
  id        String   @id @default(cuid())
  url       String
  title     String
  notes     String?
  createdAt DateTime @default(now())
}
`

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const SKILL_SERVER_EVALS: AgentEval[] = [

  // =========================================================================
  // Case 1: Build a lead scoring skill from scratch
  // Level 3 | Agent creates schema, hooks, runs generate, writes SKILL.md
  // =========================================================================
  {
    id: 'skill-server-build-lead-scorer',
    name: 'Skill Server: Build a lead scoring skill from scratch',
    category: 'skill',
    level: 3,
    input: 'I need a skill that scores incoming leads based on company size and funding stage. Leads with >500 employees or Series B+ should score above 80. Set up a skill server with the data model and scoring logic.',
    maxScore: 100,
    toolMocks: SKILL_SERVER_BUILD_MOCKS,
    validationCriteria: [
      {
        id: 'wrote-schema',
        description: 'Created or edited .shogo/server/schema.prisma with a Lead model',
        points: 20,
        phase: 'execution',
        validate: (r) =>
          r.toolCalls
            .filter((t) => t.name === 'write_file')
            .some((t) => {
              const input = t.input as Record<string, any>
              const path = String(input.path ?? '')
              const content = String(input.content ?? '')
              return path.includes('schema.prisma') && content.toLowerCase().includes('model') && content.toLowerCase().includes('lead')
            }),
      },
      {
        id: 'schema-has-scoring-fields',
        description: 'Schema includes scoring-relevant fields (companySize, fundingStage, score)',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const schemaWrite = r.toolCalls
            .filter((t) => t.name === 'write_file')
            .find((t) => String((t.input as any).path ?? '').includes('schema.prisma'))
          if (!schemaWrite) return false
          const content = String((schemaWrite.input as any).content ?? '').toLowerCase()
          return (
            (content.includes('companysize') || content.includes('company_size') || content.includes('size')) &&
            (content.includes('fundingstage') || content.includes('funding_stage') || content.includes('funding') || content.includes('stage')) &&
            content.includes('score')
          )
        },
      },
      {
        id: 'ran-generate',
        description: 'Ran shogo generate via exec',
        points: 20,
        phase: 'execution',
        validate: (r) => execCommandContains(r, 'shogo generate') || execCommandContains(r, 'shogo gen'),
      },
      {
        id: 'ran-db-push',
        description: 'Ran prisma db push via exec',
        points: 15,
        phase: 'execution',
        validate: (r) => execCommandContains(r, 'prisma db push'),
      },
      {
        id: 'wrote-config',
        description: 'Created shogo.config.json',
        points: 10,
        phase: 'execution',
        validate: (r) =>
          r.toolCalls
            .filter((t) => t.name === 'write_file')
            .some((t) => String((t.input as any).path ?? '').includes('shogo.config.json')),
      },
      {
        id: 'response-describes-scoring',
        description: 'Response explains the scoring logic (>500 employees, Series B)',
        points: 10,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, '500') &&
          (responseContains(r, 'series b') || responseContains(r, 'funding')),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 15 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 15,
      },
    ],
  },

  // =========================================================================
  // Case 2: Evolve an existing skill server schema
  // Level 3 | Agent reads existing schema, adds fields + model, re-generates
  // =========================================================================
  {
    id: 'skill-server-evolve-schema',
    name: 'Skill Server: Evolve an existing schema (add field + model)',
    category: 'skill',
    level: 3,
    workspaceFiles: {
      '.shogo/server/schema.prisma': EXISTING_TODO_SCHEMA,
      '.shogo/server/shogo.config.json': EXISTING_SHOGO_CONFIG,
    },
    input: 'I have a skill server with a Todo model. Add a "priority" field (P0-P3, default P2) to Todo, and add a new Tag model with name and color fields so I can tag my todos.',
    maxScore: 100,
    toolMocks: SKILL_SERVER_EVOLVE_MOCKS,
    validationCriteria: [
      {
        id: 'read-existing-schema',
        description: 'Read the existing schema.prisma first',
        points: 15,
        phase: 'intention',
        validate: (r) =>
          r.toolCalls.some(
            (t) =>
              t.name === 'read_file' &&
              String((t.input as any).path ?? '').includes('schema.prisma'),
          ),
      },
      {
        id: 'added-priority-field',
        description: 'Added a priority field to the Todo model',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const write = r.toolCalls
            .filter((t) => t.name === 'write_file' || t.name === 'edit_file')
            .find((t) => String((t.input as any).path ?? '').includes('schema.prisma'))
          if (!write) return false
          const content = String((write.input as any).content ?? (write.input as any).new_string ?? '').toLowerCase()
          return content.includes('priority')
        },
      },
      {
        id: 'added-tag-model',
        description: 'Added a Tag model with name and color',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const write = r.toolCalls
            .filter((t) => t.name === 'write_file' || t.name === 'edit_file')
            .find((t) => String((t.input as any).path ?? '').includes('schema.prisma'))
          if (!write) return false
          const content = String((write.input as any).content ?? (write.input as any).new_string ?? '').toLowerCase()
          return content.includes('model tag') && content.includes('name') && content.includes('color')
        },
      },
      {
        id: 'regenerated',
        description: 'Ran shogo generate after schema change',
        points: 20,
        phase: 'execution',
        validate: (r) => execCommandContains(r, 'shogo generate'),
      },
      {
        id: 'pushed-db',
        description: 'Ran prisma db push after schema change',
        points: 15,
        phase: 'execution',
        validate: (r) => execCommandContains(r, 'prisma db push'),
      },
      {
        id: 'response-mentions-endpoints',
        description: 'Response mentions the new /api/tags endpoint or tag routes',
        points: 10,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'tag') &&
          (responseContains(r, '/api/') || responseContains(r, 'endpoint') || responseContains(r, 'route')),
      },
    ],
  },

  // =========================================================================
  // Case 3: Use the skill server to persist and query data
  // Level 4 | Agent calls POST + GET on existing skill server endpoints
  // =========================================================================
  {
    id: 'skill-server-persist-data',
    name: 'Skill Server: Persist and query data via REST API',
    category: 'skill',
    level: 4,
    workspaceFiles: {
      '.shogo/server/schema.prisma': EXISTING_BOOKMARK_SCHEMA,
      '.shogo/server/shogo.config.json': EXISTING_SHOGO_CONFIG,
    },
    conversationHistory: [
      {
        role: 'user',
        content: 'I have a skill server running with a Bookmark model. The server is at http://localhost:4100.',
      },
      {
        role: 'assistant',
        content: 'Your skill server is running at http://localhost:4100 with a Bookmark model. You can manage bookmarks via:\n- POST /api/bookmarks — create a bookmark\n- GET /api/bookmarks — list all bookmarks\n- GET /api/bookmarks/:id — get one\n- PATCH /api/bookmarks/:id — update\n- DELETE /api/bookmarks/:id — delete\n\nWhat would you like to do?',
      },
    ],
    input: 'Save these bookmarks: React docs (https://react.dev) and Bun docs (https://bun.sh). Then show me all saved bookmarks.',
    maxScore: 100,
    toolMocks: SKILL_SERVER_PERSIST_MOCKS,
    validationCriteria: [
      {
        id: 'posted-react-bookmark',
        description: 'Called POST /api/bookmarks for React docs',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('react.dev') && (json.includes('post') || usedTool(r, 'web'))
        },
      },
      {
        id: 'posted-bun-bookmark',
        description: 'Called POST /api/bookmarks for Bun docs',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('bun.sh') && (json.includes('post') || usedTool(r, 'web'))
        },
      },
      {
        id: 'fetched-bookmarks',
        description: 'Called GET /api/bookmarks to list saved bookmarks',
        points: 20,
        phase: 'execution',
        validate: (r) =>
          r.toolCalls
            .filter((t) => t.name === 'web')
            .some((t) => {
              const input = t.input as Record<string, any>
              const url = String(input.url ?? '')
              return url.includes('bookmarks') && !url.includes('react.dev') && !url.includes('bun.sh')
            }),
      },
      {
        id: 'response-lists-both',
        description: 'Response mentions both React and Bun bookmarks',
        points: 20,
        phase: 'execution',
        validate: (r) => responseContains(r, 'react') && responseContains(r, 'bun'),
      },
      {
        id: 'used-web-tool',
        description: 'Used the web tool to interact with the skill server',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'web'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 10 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 10,
      },
    ],
  },
]
