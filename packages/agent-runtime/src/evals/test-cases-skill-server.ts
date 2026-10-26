// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Skill Server Eval Test Cases
 *
 * Tests the agent's ability to create, evolve, and use a skill server —
 * the per-workspace Hono API backed by SQLite that skills can add endpoints to.
 *
 * Covers:
 * - Creating a Prisma schema with the data model and scoring logic
 * - Evolving an existing schema (adding fields and models)
 * - Using the skill server's REST API to persist and query data
 * - Writing a SKILL.md that references the skill server endpoints
 */

import type { AgentEval, EvalResult } from './types'
import {
  responseContains,
  readWorkspaceFile,
  readFileAnyRoute,
  fileWrites,
  pathMatches,
  writtenContent,
  execCommands,
} from './eval-helpers'
import { buildSkillServerSchema } from '../workspace-defaults'

// ---------------------------------------------------------------------------
// Grading helpers
//
// The runtime regenerates routes and pushes the schema itself whenever
// prisma/schema.prisma changes (the prompt tells the agent NOT to run
// `shogo generate` / `prisma db push` by hand), so these evals grade the
// schema and code that end up on disk, not which commands were run. No
// exec/web mocks: the real workspace server answers localhost calls and the
// built-in exec mock keeps account CLIs (gh, …) mocked.
// ---------------------------------------------------------------------------

/** Final schema: the workspace file, else the last full write of it. */
function finalSchema(r: EvalResult): string {
  const disk = readWorkspaceFile(r, 'prisma/schema.prisma')
  if (disk) return disk
  const writes = fileWrites(r).filter(w => pathMatches(w.path, 'prisma/schema.prisma') && w.via !== 'edit_file')
  return writes.length ? writes[writes.length - 1].content : ''
}

/** Body of `model <name> { … }` in a Prisma schema ('' if absent). */
function modelBlock(schema: string, name: string): string {
  const m = schema.match(new RegExp(`model\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'i'))
  return m ? m[1] : ''
}

/** Schema text the agent produced: final schema plus every edit to it. */
function schemaWork(r: EvalResult): string {
  return `${finalSchema(r)}\n${writtenContent(r, 'prisma/schema.prisma')}`
}

/** Every HTTP call the agent made, via the web tool or curl. */
function httpCalls(r: EvalResult): string[] {
  const web = r.toolCalls.filter(t => t.name === 'web').map(t => JSON.stringify(t.input))
  const curl = execCommands(r).filter(c => /\bcurl\b/.test(c))
  return [...web, ...curl]
}

// ---------------------------------------------------------------------------
// Pre-seeded workspace files
// ---------------------------------------------------------------------------

const EXISTING_TODO_SCHEMA = buildSkillServerSchema(`model Todo {
  id        String   @id @default(cuid())
  title     String
  done      Boolean  @default(false)
  createdAt DateTime @default(now())
}`)

const EXISTING_BOOKMARK_SCHEMA = buildSkillServerSchema(`model Bookmark {
  id        String   @id @default(cuid())
  url       String
  title     String
  notes     String?
  createdAt DateTime @default(now())
}`)

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const SKILL_SERVER_EVALS: AgentEval[] = [

  // =========================================================================
  // Case 1: Build a lead scoring skill from scratch
  // Level 3 | Agent creates schema + scoring logic (runtime regenerates)
  // =========================================================================
  {
    id: 'skill-server-build-lead-scorer',
    name: 'Skill Server: Build a lead scoring skill from scratch',
    category: 'skill',
    level: 3,
    input: 'I need a skill that scores incoming leads based on company size and funding stage. Leads with >500 employees or Series B+ should score above 80. Set up a skill server with the data model and scoring logic.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-schema',
        description: 'prisma/schema.prisma defines a Lead model',
        points: 25,
        phase: 'execution',
        validate: (r) => modelBlock(finalSchema(r), 'Lead') !== '' || /model\s+Lead\b/i.test(writtenContent(r, 'prisma/schema.prisma')),
      },
      {
        id: 'schema-has-scoring-fields',
        description: 'Lead model includes scoring-relevant fields (company size, funding stage, score)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const content = (modelBlock(finalSchema(r), 'Lead') || writtenContent(r, 'prisma/schema.prisma')).toLowerCase()
          return /company_?size|employees|headcount|size/.test(content) && /funding|stage/.test(content) && content.includes('score')
        },
      },
      {
        id: 'scoring-logic-implemented',
        description: 'Code outside the schema implements the thresholds (>500 employees, Series B+)',
        points: 35,
        phase: 'execution',
        validate: (r) => fileWrites(r).some(w =>
          !pathMatches(w.path, 'prisma/schema.prisma') && /\.(ts|tsx|js|py)$/.test(w.path) &&
          /500/.test(w.content) && /series[\s_-]?b|series_?[bcdef]\b|SERIES_B/i.test(w.content)),
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
  // Level 3 | Agent reads existing schema, adds fields + model (runtime regenerates)
  // =========================================================================
  {
    id: 'skill-server-evolve-schema',
    name: 'Skill Server: Evolve an existing schema (add field + model)',
    category: 'skill',
    level: 3,
    useSkillServer: true,
    workspaceFiles: {
      'prisma/schema.prisma': EXISTING_TODO_SCHEMA,
    },
    input: 'I have a skill server with a Todo model. Add a "priority" field (P0-P3, default P2) to Todo, and add a new Tag model with name and color fields so I can tag my todos.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'read-existing-schema',
        description: 'Read the existing schema.prisma first',
        points: 15,
        phase: 'intention',
        validate: (r) => readFileAnyRoute(r, 'prisma/schema.prisma'),
      },
      {
        id: 'added-priority-field',
        description: 'Added a priority field to the Todo model',
        points: 20,
        phase: 'execution',
        validate: (r) => /priority/i.test(modelBlock(finalSchema(r), 'Todo')) ||
          (!readWorkspaceFile(r, 'prisma/schema.prisma') && /priority/i.test(writtenContent(r, 'prisma/schema.prisma'))),
      },
      {
        id: 'added-tag-model',
        description: 'Added a Tag model with name and color',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const tag = modelBlock(finalSchema(r), 'Tag') || (/model\s+tag\b/i.test(schemaWork(r)) ? schemaWork(r) : '')
          return /\bname\b/i.test(tag) && /\bcolou?r\b/i.test(tag)
        },
      },
      {
        id: 'priority-default-p2',
        description: 'Priority covers P0-P3 and defaults to P2',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const schema = schemaWork(r)
          return /P0/.test(schema) && /P3/.test(schema) && /@default\(\s*"?P2"?\s*\)/.test(schema)
        },
      },
      {
        id: 'kept-existing-todo-fields',
        description: 'Existing Todo fields (title, done, createdAt) are still in the final schema',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const todo = modelBlock(finalSchema(r), 'Todo')
          return /\btitle\b/.test(todo) && /\bdone\b/.test(todo) && /\bcreatedAt\b/.test(todo)
        },
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
    useSkillServer: true,
    workspaceFiles: {
      'prisma/schema.prisma': EXISTING_BOOKMARK_SCHEMA,
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
    validationCriteria: [
      {
        id: 'posted-react-bookmark',
        description: 'POSTed the React docs bookmark (web tool or curl)',
        points: 20,
        phase: 'execution',
        validate: (r) => httpCalls(r).some(c => c.includes('react.dev') && /post|-d\s|--data/i.test(c)),
      },
      {
        id: 'posted-bun-bookmark',
        description: 'POSTed the Bun docs bookmark (web tool or curl)',
        points: 20,
        phase: 'execution',
        validate: (r) => httpCalls(r).some(c => c.includes('bun.sh') && /post|-d\s|--data/i.test(c)),
      },
      {
        id: 'fetched-bookmarks',
        description: 'Listed bookmarks with a GET /api/bookmarks',
        points: 20,
        phase: 'execution',
        validate: (r) => httpCalls(r).some(c =>
          /api\/bookmarks/.test(c) && !c.includes('react.dev') && !c.includes('bun.sh') && !/"method":"(post|patch|put|delete)"|-X\s*(POST|PATCH|PUT|DELETE)/i.test(c)),
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
        description: 'Talked to the server over HTTP (web tool or curl)',
        points: 10,
        phase: 'intention',
        validate: (r) => httpCalls(r).some(c => /bookmarks/.test(c)),
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
