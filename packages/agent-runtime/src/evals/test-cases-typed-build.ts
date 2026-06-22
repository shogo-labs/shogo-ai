// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Typed-Build Evals
 *
 * Reproduces the #1 code-quality error Hoshi (mimo-v2.5) produces in production:
 * `Property 'X' does not exist on type 'Y'` — i.e. the model invents
 * field/property names instead of grounding on the schema/types that actually
 * exist (see HOSHI_CODING_FINDINGS.md, ~470 such diagnostics in 7 days).
 *
 * The trick: each fixture defines a schema / typed surface using *deliberately
 * non-default field names* (`headline`, `bodyText`, `authorEmail`, ...). The
 * task then asks for a feature whose "obvious" names (`title`, `body`,
 * `author`, ...) would be wrong. A model that hallucinates the conventional
 * names produces lint-dirty, property-does-not-exist code; a grounded model
 * reads the schema and uses the real names.
 *
 * Scoring is primarily deterministic (which field names appear in the written
 * code) so the eval is meaningful even when the LSP/Prisma client isn't fully
 * generated, with `read_lints`-based criteria layered on top.
 *
 * Track: --track typed-build
 */

import type { AgentEval, EvalResult, ToolCallRecord } from './types'

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isCodeFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx)$/.test(path) && !path.endsWith('.d.ts')
}

function writeOrEditCalls(r: EvalResult): ToolCallRecord[] {
  return r.toolCalls.filter(t => t.name === 'write_file' || t.name === 'edit_file')
}

/** Concatenated content of every code file the agent wrote or edited. */
function allWrittenCode(r: EvalResult): string {
  return writeOrEditCalls(r)
    .filter(t => isCodeFile(String((t.input as Record<string, unknown>).path ?? '')))
    .map(t => {
      const input = t.input as Record<string, unknown>
      return String(input.content ?? input.new_string ?? input.newString ?? '')
    })
    .join('\n')
}

function wroteAnyCode(r: EvalResult): boolean {
  return allWrittenCode(r).trim().length > 0
}

/** How many of `names` appear anywhere in the written code. */
function countReferenced(r: EvalResult, names: string[]): number {
  const code = allWrittenCode(r)
  return names.filter(n => code.includes(n)).length
}

/**
 * True if the written code never accesses any of the hallucinated `props` as a
 * member (`.title`, `obj?.author`, etc.). Uses a word-boundary so `.bodyText`
 * does not count as an access of `.body`.
 */
function codeAvoidsPropertyAccess(r: EvalResult, props: string[]): boolean {
  const code = allWrittenCode(r)
  return !props.some(p => new RegExp(`\\.${p}\\b`).test(code))
}

function usedReadLints(r: EvalResult): boolean {
  return r.toolCalls.some(t => t.name === 'read_lints')
}

function parseLintOk(t: ToolCallRecord): boolean | null {
  try {
    const out = typeof t.output === 'string' ? JSON.parse(t.output) : t.output
    if (out && typeof out === 'object' && 'ok' in (out as Record<string, unknown>)) {
      return (out as Record<string, unknown>).ok === true
    }
    return null
  } catch {
    return null
  }
}

/** True if the last read_lints call reported a clean result. False if it never ran. */
function lastReadLintsClean(r: EvalResult): boolean {
  const lintCalls = r.toolCalls.filter(t => t.name === 'read_lints')
  if (lintCalls.length === 0) return false
  return parseLintOk(lintCalls[lintCalls.length - 1]) === true
}

/** True if the agent fixed any lint failure it surfaced (or never had one). */
function selfCorrectedIfNeeded(r: EvalResult): boolean {
  const lintCalls = r.toolCalls.filter(t => t.name === 'read_lints')
  const firstWithErrors = lintCalls.findIndex(t => parseLintOk(t) === false)
  if (firstWithErrors === -1) return true
  return lintCalls.slice(firstWithErrors + 1).some(t => parseLintOk(t) === true)
}

// ---------------------------------------------------------------------------
// Workspace fixtures — non-default field names on purpose
// ---------------------------------------------------------------------------

const POSTS_SCHEMA = `// Prisma schema — note the field names are intentionally NOT the conventional
// title/body/author/createdAt. Code must use these exact names.
datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

generator client {
  provider = "prisma-client-js"
}

model Post {
  id          String   @id @default(cuid())
  headline    String
  bodyText    String
  authorEmail String
  publishedAt DateTime @default(now())
}
`

const CAMPAIGN_TYPES = `// Shared API types. The frontend MUST use exactly these property names.
export interface Campaign {
  id: string
  campaignName: string
  sendAt: string
  recipientCount: number
  isDraft: boolean
}

export async function fetchCampaigns(): Promise<Campaign[]> {
  const res = await fetch('/api/campaigns')
  const data = await res.json()
  return data.items as Campaign[]
}
`

// ---------------------------------------------------------------------------
// Evals
// ---------------------------------------------------------------------------

export const TYPED_BUILD_EVALS: AgentEval[] = [
  {
    id: 'typed-build-prisma-field-fidelity',
    name: 'Use real Prisma field names, not conventional ones',
    category: 'code-agent',
    level: 3,
    input: [
      'A `Post` model is already defined in `prisma/schema.prisma`.',
      'Build a React component `src/components/PostList.tsx` that fetches posts from `/api/posts`',
      'and renders, for each post, its headline, its body text, the author, and the publish date.',
      'Use the exact field names from the schema — read it first if you are unsure.',
    ].join('\n'),
    workspaceFiles: { 'prisma/schema.prisma': POSTS_SCHEMA },
    useRuntimeTemplate: true,
    useSkillServer: true,
    validationCriteria: [
      {
        id: 'read-the-schema',
        description: 'Agent read the schema (or grepped) before writing code',
        points: 2,
        phase: 'intention',
        validate: (r) => r.toolCalls.some(t =>
          (t.name === 'read_file' || t.name === 'grep') &&
          JSON.stringify(t.input).toLowerCase().includes('schema'),
        ),
      },
      {
        id: 'wrote-component',
        description: 'Agent wrote a code file for the component',
        points: 2,
        phase: 'execution',
        validate: (r) => wroteAnyCode(r),
      },
      {
        id: 'uses-real-field-names',
        description: 'Code references at least 3 of the 4 real fields (headline/bodyText/authorEmail/publishedAt)',
        points: 5,
        phase: 'execution',
        validate: (r) => countReferenced(r, ['headline', 'bodyText', 'authorEmail', 'publishedAt']) >= 3,
      },
      {
        id: 'no-hallucinated-fields',
        description: 'Code does not access invented fields (.title/.body/.author/.createdAt)',
        points: 5,
        phase: 'execution',
        validate: (r) => codeAvoidsPropertyAccess(r, ['title', 'body', 'author', 'createdAt']),
      },
      {
        id: 'used-read-lints',
        description: 'Agent ran read_lints to check its code',
        points: 2,
        phase: 'execution',
        validate: (r) => usedReadLints(r),
      },
      {
        id: 'final-lint-clean',
        description: 'Final read_lints result was clean',
        points: 3,
        phase: 'execution',
        validate: (r) => lastReadLintsClean(r),
      },
    ],
    antiPatterns: [
      'Accessed post.title / post.body / post.author (fields that do not exist)',
      'Shipped code with "Property does not exist" type errors',
    ],
    maxScore: 19,
  },

  {
    id: 'typed-build-api-type-fidelity',
    name: 'Consume a typed API surface without inventing properties',
    category: 'code-agent',
    level: 3,
    input: [
      'The file `src/types/api.ts` exports a `Campaign` interface and a `fetchCampaigns()` helper.',
      'Build `src/components/CampaignTable.tsx` that calls `fetchCampaigns()` and renders a table',
      'with columns for the campaign name, the scheduled send time, and the number of recipients.',
      'Import the types — do not redefine them — and use the exact property names from the interface.',
    ].join('\n'),
    workspaceFiles: { 'src/types/api.ts': CAMPAIGN_TYPES },
    useRuntimeTemplate: true,
    validationCriteria: [
      {
        id: 'read-the-types',
        description: 'Agent read src/types/api.ts before writing the component',
        points: 2,
        phase: 'intention',
        validate: (r) => r.toolCalls.some(t =>
          t.name === 'read_file' &&
          String((t.input as Record<string, unknown>).path ?? '').includes('api.ts'),
        ),
      },
      {
        id: 'imported-shared-type',
        description: 'Component imports Campaign / fetchCampaigns instead of redefining them',
        points: 4,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return /import[^;]*\b(Campaign|fetchCampaigns)\b[^;]*from/.test(code)
        },
      },
      {
        id: 'uses-real-property-names',
        description: 'Code references the real properties (campaignName/sendAt/recipientCount)',
        points: 5,
        phase: 'execution',
        validate: (r) => countReferenced(r, ['campaignName', 'sendAt', 'recipientCount']) >= 2,
      },
      {
        id: 'no-hallucinated-properties',
        description: 'Code does not access invented properties (.name/.scheduledAt/.recipients/.title)',
        points: 5,
        phase: 'execution',
        validate: (r) => codeAvoidsPropertyAccess(r, ['scheduledAt', 'recipients', 'title']),
      },
      {
        id: 'final-lint-clean',
        description: 'Final read_lints result was clean (or self-corrected)',
        points: 3,
        phase: 'execution',
        validate: (r) => lastReadLintsClean(r) || selfCorrectedIfNeeded(r),
      },
    ],
    antiPatterns: [
      'Redefined the Campaign interface locally instead of importing it',
      'Accessed campaign.name / campaign.recipients (properties that do not exist)',
    ],
    maxScore: 19,
  },

  {
    id: 'typed-build-from-scratch-strict',
    name: 'Define a schema then consume only the fields it declares',
    category: 'code-agent',
    level: 4,
    input: [
      'Build a small "support tickets" feature from scratch:',
      '1. In `prisma/schema.prisma`, add a `Ticket` model with fields:',
      '   `id`, `subject` (String), `severity` (String), `reporterEmail` (String), `openedAt` (DateTime).',
      '2. Add a `src/components/TicketList.tsx` that fetches `/api/tickets` and lists each ticket\u2019s',
      '   subject, severity, reporter, and opened date.',
      'The component must reference only fields that exist on the model. Verify with read_lints before finishing.',
    ].join('\n'),
    useRuntimeTemplate: true,
    useSkillServer: true,
    validationCriteria: [
      {
        id: 'wrote-schema-with-model',
        description: 'Schema write declares model Ticket with the requested fields',
        points: 4,
        phase: 'execution',
        validate: (r) => {
          const schemaWrite = writeOrEditCalls(r).find(t =>
            String((t.input as Record<string, unknown>).path ?? '').includes('schema.prisma'),
          )
          if (!schemaWrite) return false
          const input = schemaWrite.input as Record<string, unknown>
          const content = String(input.content ?? input.new_string ?? '')
          return /model\s+Ticket/.test(content) &&
            content.includes('subject') &&
            content.includes('severity') &&
            content.includes('reporterEmail') &&
            content.includes('openedAt')
        },
      },
      {
        id: 'wrote-component',
        description: 'Agent wrote the TicketList component',
        points: 2,
        phase: 'execution',
        validate: (r) => writeOrEditCalls(r).some(t =>
          String((t.input as Record<string, unknown>).path ?? '').includes('TicketList'),
        ),
      },
      {
        id: 'uses-declared-fields',
        description: 'Component references the fields it declared (subject/severity/reporterEmail/openedAt)',
        points: 4,
        phase: 'execution',
        validate: (r) => countReferenced(r, ['subject', 'severity', 'reporterEmail', 'openedAt']) >= 3,
      },
      {
        id: 'no-hallucinated-fields',
        description: 'Component does not access invented fields (.title/.priority/.email/.createdAt/.reporter)',
        points: 4,
        phase: 'execution',
        validate: (r) => codeAvoidsPropertyAccess(r, ['title', 'priority', 'createdAt', 'reporter']),
      },
      {
        id: 'used-read-lints',
        description: 'Agent ran read_lints before finishing',
        points: 2,
        phase: 'execution',
        validate: (r) => usedReadLints(r),
      },
      {
        id: 'final-lint-clean',
        description: 'Final read_lints result was clean',
        points: 3,
        phase: 'execution',
        validate: (r) => lastReadLintsClean(r),
      },
      {
        id: 'self-corrected',
        description: 'Any surfaced lint failure was fixed before finishing',
        points: 2,
        phase: 'execution',
        validate: (r) => selfCorrectedIfNeeded(r),
      },
    ],
    antiPatterns: [
      'Accessed fields the schema never declared',
      'Finished without running read_lints',
    ],
    maxScore: 21,
  },
]
