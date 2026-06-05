// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Protected `prisma/schema.prisma` header (generator + datasource blocks).
 *
 * The runtime template ships a Prisma-7-correct header: a `prisma-client`
 * generator and a bare `datasource db { provider = "sqlite" }` (the connection
 * URL lives in `prisma.config.ts`, per Prisma 7+). It is *correct as shipped*.
 *
 * The failure mode this guards against is the agent rewriting the whole schema
 * from a stale Prisma-5/6 mental model when it only meant to add a model — a
 * `write_file` that "helpfully" re-introduces:
 *   - `url = env("DATABASE_URL")` in the datasource block, and/or
 *   - the legacy `prisma-client-js` generator provider.
 * On Prisma 7.8+ the `url` line is a hard error (`P1012: The datasource
 * property 'url' is no longer supported in schema files`), so `prisma generate`
 * / `db push` fail and the app never builds. It's the same class of bug as a
 * `server.tsx` regen clobbering a custom tenant guard: a stray write silently
 * downgrades a managed region.
 *
 * The guard mirrors the SHOGO:CUSTOM approach used for `server.tsx`: the header
 * is wrapped in `// SHOGO:CUSTOM-START prisma-header` ... `// SHOGO:CUSTOM-END`
 * markers (a visible "don't edit this" deterrent), and the runtime re-enforces
 * a sanitized, marked header before the schema is consumed — so a downgrade
 * can't reach Prisma. The agent's *models* are always preserved.
 */

import { CUSTOM_REGION_START, CUSTOM_REGION_END } from './server-custom-regions'

/** Label that identifies the protected header region inside the markers. */
export const SCHEMA_HEADER_REGION_ID = 'prisma-header'

/** Single managed comment carried at the top of the protected region. */
export const SCHEMA_HEADER_MANAGED_COMMENT =
  '// Managed by Shogo. Do not add a datasource `url` or change the generator `provider` — ' +
  'the database URL is configured in prisma.config.ts (Prisma 7+).'

/**
 * Canonical Prisma-7 header for the runtime template (SQLite). Used as the
 * fallback when the agent deleted the generator/datasource blocks entirely.
 * Kept byte-for-byte in sync with `templates/runtime-template/prisma/schema.prisma`.
 */
export const DEFAULT_PRISMA_HEADER = [
  'generator client {',
  '  provider = "prisma-client"',
  '  output   = "../src/generated/prisma"',
  '}',
  '',
  'datasource db {',
  '  provider = "sqlite"',
  '}',
].join('\n')

// Matches a top-level `generator <name> { ... }` or `datasource <name> { ... }`
// block. Prisma header blocks never nest braces, so a non-greedy match up to
// the first line-leading `}` is exact.
const HEADER_BLOCK_RE = /^[ \t]*(generator|datasource)[ \t]+\w+[ \t]*\{[\s\S]*?^[ \t]*\}[ \t]*$/gm

interface HeaderBlock {
  kind: 'generator' | 'datasource'
  text: string
}

function findBlocks(source: string): HeaderBlock[] {
  const blocks: HeaderBlock[] = []
  for (const m of source.matchAll(HEADER_BLOCK_RE)) {
    blocks.push({ kind: m[1] as HeaderBlock['kind'], text: m[0] })
  }
  return blocks
}

function firstBlock(source: string, kind: HeaderBlock['kind']): string | null {
  return findBlocks(source).find((b) => b.kind === kind)?.text ?? null
}

/** Drop every generator/datasource block from `source`, collapsing the holes. */
function stripBlocks(source: string): string {
  return collapseBlankRuns(source.replace(HEADER_BLOCK_RE, ''))
}

function collapseBlankRuns(s: string): string {
  return s.replace(/\n{3,}/g, '\n\n')
}

/** Rewrite a generator block's provider from the legacy `prisma-client-js`. */
function sanitizeGenerator(block: string): string {
  return block.replace(/(provider\s*=\s*["'])prisma-client-js(["'])/g, '$1prisma-client$2')
}

/** True when a generator block declares an `output = ...` path. */
function generatorHasOutput(block: string): boolean {
  return /^\s*output\s*=/m.test(block)
}

/** True when a generator block is the Prisma client generator (new or legacy). */
function isClientGenerator(block: string): boolean {
  return /provider\s*=\s*["']prisma-client(-js)?["']/.test(block)
}

/** Remove any `url = ...` line from a datasource block (Prisma 7 moved it). */
function sanitizeDatasource(block: string): string {
  return block
    .split('\n')
    .filter((line) => !/^\s*url\s*=/.test(line))
    .join('\n')
}

/**
 * True when the schema's header carries a Prisma-7 violation that would break
 * `prisma generate` / `db push`:
 *   - any `datasource` block declares a `url = ...` line, or
 *   - any `generator` block uses the legacy `prisma-client-js` provider, or
 *   - the Prisma client `generator` is missing its required `output = ...` path
 *     ("An output path is required for the `prisma-client` generator").
 * Marker presence is irrelevant — we inspect the actual blocks.
 */
export function headerIsDowngraded(schema: string): boolean {
  for (const block of findBlocks(schema)) {
    if (block.kind === 'datasource' && /^\s*url\s*=/m.test(block.text)) return true
    if (block.kind === 'generator') {
      if (/prisma-client-js/.test(block.text)) return true
      if (isClientGenerator(block.text) && !generatorHasOutput(block.text)) return true
    }
  }
  return false
}

/** True when the schema already wraps its header in the SHOGO:CUSTOM markers. */
export function hasMarkedSchemaHeader(schema: string): boolean {
  return splitHeaderRegion(schema).regionBody !== null
}

/**
 * Split out the protected header region (the lines between
 * `// SHOGO:CUSTOM-START prisma-header` and the next `// SHOGO:CUSTOM-END`),
 * returning its inner body and the schema with that region removed. When no
 * marked region exists, `regionBody` is `null` and `rest` is the input.
 */
function splitHeaderRegion(schema: string): { regionBody: string | null; rest: string } {
  const lines = schema.split('\n')
  let startIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (
      trimmed.startsWith(CUSTOM_REGION_START) &&
      trimmed.slice(CUSTOM_REGION_START.length).trim() === SCHEMA_HEADER_REGION_ID
    ) {
      startIdx = i
      break
    }
  }
  if (startIdx === -1) return { regionBody: null, rest: schema }

  let endIdx = -1
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith(CUSTOM_REGION_END)) {
      endIdx = i
      break
    }
  }
  if (endIdx === -1) return { regionBody: null, rest: schema }

  const regionBody = lines.slice(startIdx + 1, endIdx).join('\n')
  const rest = [...lines.slice(0, startIdx), ...lines.slice(endIdx + 1)].join('\n')
  return { regionBody, rest }
}

/**
 * Re-establish the protected, Prisma-7-correct header at the top of the schema
 * while preserving every model the agent wrote.
 *
 * Sourcing for each header block, in priority order:
 *   1. the existing marked region (the last managed header), then
 *   2. a loose block already in the schema (sanitized in place — `url` stripped,
 *      `prisma-client-js` → `prisma-client`), then
 *   3. the corresponding block from `fallbackHeader` (default: the SQLite
 *      template header) when the agent deleted it entirely.
 *
 * Idempotent: enforcing an already-enforced schema returns it unchanged.
 */
export function enforceSchemaHeader(
  schema: string,
  fallbackHeader: string = DEFAULT_PRISMA_HEADER,
): string {
  const { regionBody, rest } = splitHeaderRegion(schema)
  const headerSource = regionBody ?? ''

  const canonicalGenerator =
    firstBlock(fallbackHeader, 'generator') ?? firstBlock(DEFAULT_PRISMA_HEADER, 'generator')!
  // Keep the existing generator only when it still declares an output path —
  // a `prisma-client` generator with no `output` is a hard error, so a stray
  // write that dropped it gets the canonical block (which carries the output)
  // restored rather than preserved.
  const candidateGenerator = firstBlock(headerSource, 'generator') ?? firstBlock(rest, 'generator')
  const generator =
    candidateGenerator && generatorHasOutput(candidateGenerator) ? candidateGenerator : canonicalGenerator

  const datasource =
    firstBlock(headerSource, 'datasource') ??
    firstBlock(rest, 'datasource') ??
    firstBlock(fallbackHeader, 'datasource') ??
    firstBlock(DEFAULT_PRISMA_HEADER, 'datasource')!

  const headerBody = [
    SCHEMA_HEADER_MANAGED_COMMENT,
    sanitizeGenerator(generator).trim(),
    '',
    sanitizeDatasource(datasource).trim(),
  ].join('\n')

  const region = [`${CUSTOM_REGION_START} ${SCHEMA_HEADER_REGION_ID}`, headerBody, CUSTOM_REGION_END].join('\n')

  // Everything that isn't the header: the models, enums, etc.
  const body = stripBlocks(rest).trim()

  return body ? `${region}\n\n${body}\n` : `${region}\n`
}
