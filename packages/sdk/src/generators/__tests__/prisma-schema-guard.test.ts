// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reproduction (P0 build break): the agent, asked only to add a model, rewrote
 * the whole `prisma/schema.prisma` from a stale Prisma-5/6 memory — downgrading
 * the generator to `prisma-client-js` and re-adding `url = env("DATABASE_URL")`
 * to the datasource. On Prisma 7.8 that `url` line is a hard error
 * (`P1012: The datasource property 'url' is no longer supported`), so
 * `prisma generate` / `db push` fail and the app never builds.
 *
 * The exact clobber below is lifted from a real VM eval tool-call:
 *   write_file({ path: "prisma/schema.prisma", content: "generator client {
 *     provider = \"prisma-client-js\" ... datasource db { ... url = env(...) }
 *     ... model Post { ... } " })
 *
 * These tests pin the fixed behavior: the protected header is restored
 * (Prisma-7-correct, wrapped in SHOGO:CUSTOM markers) while the agent's model
 * survives.
 */
import { describe, it, expect } from 'bun:test'
import {
  enforceSchemaHeader,
  headerIsDowngraded,
  hasMarkedSchemaHeader,
  SCHEMA_HEADER_REGION_ID,
  DEFAULT_PRISMA_HEADER,
} from '../prisma-schema-guard'

// What the template ships (Prisma-7-correct, marker-wrapped).
const TEMPLATE_SCHEMA = [
  '// SHOGO:CUSTOM-START prisma-header',
  '// Managed by Shogo. Do not add a datasource `url` or change the generator `provider` — the database URL is configured in prisma.config.ts (Prisma 7+).',
  'generator client {',
  '  provider = "prisma-client"',
  '  output   = "../src/generated/prisma"',
  '}',
  '',
  'datasource db {',
  '  provider = "sqlite"',
  '}',
  '// SHOGO:CUSTOM-END',
  '',
  'model User {',
  '  id    String @id @default(cuid())',
  '  email String @unique',
  '}',
].join('\n')

// What the agent wrote over it (the real clobber).
const AGENT_CLOBBER = [
  'generator client {',
  '  provider = "prisma-client-js"',
  '}',
  '',
  'datasource db {',
  '  provider = "sqlite"',
  '  url      = env("DATABASE_URL")',
  '}',
  '',
  'model Post {',
  '  id        Int      @id @default(autoincrement())',
  '  title     String',
  '  createdAt DateTime @default(now())',
  '}',
].join('\n')

describe('prisma schema header guard', () => {
  it('flags the agent clobber as downgraded (the bug)', () => {
    expect(headerIsDowngraded(AGENT_CLOBBER)).toBe(true)
    expect(hasMarkedSchemaHeader(AGENT_CLOBBER)).toBe(false)
  })

  it('strips the Prisma-6 `url` and restores `prisma-client`, keeping the model', () => {
    const repaired = enforceSchemaHeader(AGENT_CLOBBER)

    // The P1012 trigger is gone.
    expect(/url\s*=\s*env/.test(repaired)).toBe(false)
    expect(headerIsDowngraded(repaired)).toBe(false)

    // Generator is back on the Prisma-7 provider.
    expect(repaired).toContain('provider = "prisma-client"')
    expect(repaired).not.toContain('prisma-client-js')

    // The agent's model is preserved verbatim.
    expect(repaired).toContain('model Post')
    expect(repaired).toContain('title     String')

    // Wrapped in the protected markers.
    expect(hasMarkedSchemaHeader(repaired)).toBe(true)
    expect(repaired).toContain(`SHOGO:CUSTOM-START ${SCHEMA_HEADER_REGION_ID}`)
  })

  it('is idempotent', () => {
    const once = enforceSchemaHeader(AGENT_CLOBBER)
    const twice = enforceSchemaHeader(once)
    expect(twice).toBe(once)
  })

  it('keeps the template schema stable (already correct)', () => {
    expect(headerIsDowngraded(TEMPLATE_SCHEMA)).toBe(false)
    const enforced = enforceSchemaHeader(TEMPLATE_SCHEMA)
    expect(headerIsDowngraded(enforced)).toBe(false)
    expect(enforced).toContain('model User')
    expect(hasMarkedSchemaHeader(enforced)).toBe(true)
    // Enforcing the template is a no-op (template == enforced shape).
    expect(enforceSchemaHeader(enforced)).toBe(enforced)
  })

  it('falls back to the default header when the agent deletes the blocks', () => {
    const modelsOnly = [
      'model Note {',
      '  id    Int    @id @default(autoincrement())',
      '  title String',
      '}',
    ].join('\n')

    const repaired = enforceSchemaHeader(modelsOnly)
    expect(repaired).toContain('generator client')
    expect(repaired).toContain('provider = "prisma-client"')
    expect(repaired).toContain('datasource db')
    expect(repaired).toContain('provider = "sqlite"')
    expect(repaired).toContain('model Note')
    expect(headerIsDowngraded(repaired)).toBe(false)
  })

  it('restores the output path when the agent drops it (prisma-client requires output)', () => {
    // MiMo's variant: correct provider, but no `output` — a hard
    // "An output path is required for the `prisma-client` generator" error.
    const noOutput = [
      'generator client {',
      '  provider = "prisma-client"',
      '}',
      '',
      'datasource db {',
      '  provider = "sqlite"',
      '}',
      '',
      'model Task { id Int @id @default(autoincrement()) title String }',
    ].join('\n')

    expect(headerIsDowngraded(noOutput)).toBe(true)
    const repaired = enforceSchemaHeader(noOutput)
    expect(repaired).toContain('output')
    expect(repaired).toContain('provider = "prisma-client"')
    expect(repaired).toContain('model Task')
    expect(headerIsDowngraded(repaired)).toBe(false)
  })

  it('preserves a custom output path when only the url/provider are bad', () => {
    const customOutput = [
      'generator client {',
      '  provider = "prisma-client-js"',
      '  output   = "../src/db/generated"',
      '}',
      '',
      'datasource db {',
      '  provider = "sqlite"',
      '  url      = env("DATABASE_URL")',
      '}',
      '',
      'model Thing { id Int @id @default(autoincrement()) }',
    ].join('\n')

    const repaired = enforceSchemaHeader(customOutput)
    expect(repaired).toContain('output   = "../src/db/generated"')
    expect(repaired).not.toContain('prisma-client-js')
    expect(/url\s*=\s*env/.test(repaired)).toBe(false)
  })

  it('DEFAULT_PRISMA_HEADER matches the template (no url, prisma-client)', () => {
    expect(headerIsDowngraded(DEFAULT_PRISMA_HEADER)).toBe(false)
    expect(DEFAULT_PRISMA_HEADER).toContain('provider = "prisma-client"')
    expect(DEFAULT_PRISMA_HEADER).not.toContain('url')
  })
})
