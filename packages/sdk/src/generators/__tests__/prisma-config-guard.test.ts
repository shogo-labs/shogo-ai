// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import {
  configIsDowngraded,
  enforcePrismaConfig,
  DEFAULT_PRISMA_CONFIG,
} from '../prisma-config-guard'

const HEALTHY = `import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? 'file:./dev.db',
  },
})
`

// The exact shape mimo produced in the codegen-safety eval: URL under a
// \`migrate\` resolver, no \`datasource.url\` → \`db push\` hard-errors.
const MIGRATE_URL_SHAPE = `import path from 'node:path'
import { defineConfig } from 'prisma/config'

export default defineConfig({
  earlyAccess: true,
  schema: path.join('prisma', 'schema.prisma'),
  migrate: {
    async url() {
      return process.env.DATABASE_URL ?? 'file:./prisma/dev.db'
    },
  },
})
`

describe('configIsDowngraded', () => {
  test('healthy config with datasource.url is not downgraded', () => {
    expect(configIsDowngraded(HEALTHY)).toBe(false)
  })

  test('canonical default is not downgraded (idempotent)', () => {
    expect(configIsDowngraded(DEFAULT_PRISMA_CONFIG)).toBe(false)
  })

  test('migrate.url shape (no datasource.url) is downgraded', () => {
    expect(configIsDowngraded(MIGRATE_URL_SHAPE)).toBe(true)
  })

  test('datasource block without a url is downgraded', () => {
    const noUrl = `export default defineConfig({\n  datasource: {\n    provider: 'sqlite',\n  },\n})\n`
    expect(configIsDowngraded(noUrl)).toBe(true)
  })

  test('missing datasource entirely is downgraded', () => {
    const noDs = `export default defineConfig({ schema: 'prisma/schema.prisma' })\n`
    expect(configIsDowngraded(noDs)).toBe(true)
  })

  test('empty / whitespace file is downgraded', () => {
    expect(configIsDowngraded('')).toBe(true)
    expect(configIsDowngraded('   \n  ')).toBe(true)
  })

  test('the Prisma env() helper form is accepted (any url: is fine)', () => {
    const envHelper = `import { defineConfig, env } from 'prisma/config'\n\nexport default defineConfig({\n  datasource: { url: env('DATABASE_URL') },\n})\n`
    expect(configIsDowngraded(envHelper)).toBe(false)
  })
})

describe('enforcePrismaConfig', () => {
  test('heals the migrate.url shape to the canonical config', () => {
    const healed = enforcePrismaConfig(MIGRATE_URL_SHAPE)
    expect(healed).toBe(DEFAULT_PRISMA_CONFIG)
    expect(configIsDowngraded(healed)).toBe(false)
    expect(healed).toContain('datasource: {')
    expect(healed).toContain('url: process.env.DATABASE_URL')
  })

  test('leaves a healthy config untouched', () => {
    expect(enforcePrismaConfig(HEALTHY)).toBe(HEALTHY)
  })

  test('is idempotent — re-enforcing the canonical config is a no-op', () => {
    expect(enforcePrismaConfig(DEFAULT_PRISMA_CONFIG)).toBe(DEFAULT_PRISMA_CONFIG)
  })
})
