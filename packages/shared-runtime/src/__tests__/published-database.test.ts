// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for the published-database helpers (SHO-308 §1): one database and
// one Secret per published environment, a DATABASE_URL that goes through the
// PgBouncer pooler, and the "would this schema push destroy data?" classifier
// that AC 2 turns into `destructive_schema_change`.

import { describe, test, expect } from 'bun:test'
import {
  publishedDbName,
  publishedDbSecretName,
  toPublishedDatabaseUrl,
  assertPublishedDatabaseUrl,
  classifySchemaChange,
  describeDestructiveChanges,
  parseSchema,
  PUBLISHED_DB_CONNECTION_LIMIT,
} from '../published-database'

const PROJECT = '6b67a256-8a1e-4419-8888-4a677782673b'

describe('published database naming', () => {
  test('production keeps the historical project_<uuid> name', () => {
    expect(publishedDbName(PROJECT, 'production')).toBe(
      'project_6b67a256_8a1e_4419_8888_4a677782673b',
    )
  })

  test('staging gets its own database in the same cluster', () => {
    const prod = publishedDbName(PROJECT, 'production')
    const staging = publishedDbName(PROJECT, 'staging')
    expect(staging).toBe(`${prod}_staging`)
    expect(staging).not.toBe(prod)
  })

  test('the name defaults to production so an existing database is reused', () => {
    expect(publishedDbName(PROJECT)).toBe(publishedDbName(PROJECT, 'production'))
  })

  test('a non-UUID project id is refused rather than interpolated into SQL', () => {
    expect(() => publishedDbName('p1')).toThrow(/expected UUID/)
    expect(() => publishedDbName('drop table users; --')).toThrow(/expected UUID/)
  })

  test('names stay inside the 63-byte identifier limit', () => {
    for (const env of ['production', 'staging'] as const) {
      expect(publishedDbName(PROJECT, env).length).toBeLessThanOrEqual(63)
    }
  })

  test('the secret name is the one the ksvc mounts', () => {
    expect(publishedDbSecretName(PROJECT, 'production')).toBe(
      `published-db-${PROJECT}-production`,
    )
    expect(publishedDbSecretName(PROJECT, 'staging')).toBe(
      `published-db-${PROJECT}-staging`,
    )
  })
})

describe('published database URL', () => {
  const direct = `postgres://project_x:s3cret@projects-pg-rw.shogo-system.svc.cluster.local:5432/project_x`

  test('is rewritten to the pooler with the flags Prisma needs', () => {
    const url = new URL(
      toPublishedDatabaseUrl(direct, {
        poolerHost: 'projects-pg-pooler-rw.shogo-system.svc.cluster.local',
      }),
    )
    expect(url.hostname).toBe('projects-pg-pooler-rw.shogo-system.svc.cluster.local')
    expect(url.searchParams.get('pgbouncer')).toBe('true')
    expect(url.searchParams.get('connection_limit')).toBe(PUBLISHED_DB_CONNECTION_LIMIT)
    // Credentials and database survive the rewrite untouched.
    expect(url.username).toBe('project_x')
    expect(url.password).toBe('s3cret')
    expect(url.pathname).toBe('/project_x')
  })

  test('a pooler host is optional (used by tests and cutover scripts)', () => {
    const url = new URL(toPublishedDatabaseUrl(direct))
    expect(url.hostname).toBe('projects-pg-rw.shogo-system.svc.cluster.local')
    expect(url.searchParams.get('pgbouncer')).toBe('true')
  })

  test('an existing connection_limit is replaced, not duplicated', () => {
    const url = toPublishedDatabaseUrl(`${direct}?connection_limit=20`)
    expect(url.match(/connection_limit=/g)?.length).toBe(1)
    expect(url).toContain(`connection_limit=${PUBLISHED_DB_CONNECTION_LIMIT}`)
  })

  test('a non-Postgres URL is refused', () => {
    expect(() => toPublishedDatabaseUrl('file:./dev.db')).toThrow(/must be Postgres/)
    expect(() => toPublishedDatabaseUrl('not a url')).toThrow(/invalid URL/)
  })

  test('the guard rejects a URL that bypasses the pooler', () => {
    expect(() => assertPublishedDatabaseUrl(direct)).toThrow(/pgbouncer=true/)
    expect(() =>
      assertPublishedDatabaseUrl(toPublishedDatabaseUrl(direct)),
    ).not.toThrow()
  })
})

describe('parseSchema', () => {
  const schema = `
datasource db {
  provider = "sqlite"
}

model Post {
  id        String   @id @default(cuid())
  title     String
  body      String?
  views     Int      @default(0)
  tags      String[]
  createdAt DateTime @default(now())

  @@index([createdAt])
}

enum Role {
  ADMIN
  USER
}
`

  test('reads models, fields and modifiers', () => {
    const parsed = parseSchema(schema)
    const post = parsed.models.get('Post')!
    expect(post.get('id')!.hasDefault).toBe(true)
    expect(post.get('body')!.optional).toBe(true)
    expect(post.get('views')!.type).toBe('Int')
    expect(post.get('tags')!.list).toBe(true)
    expect(post.get('createdAt')!.hasDefault).toBe(true)
  })

  test('reads enum values and ignores block attributes', () => {
    const parsed = parseSchema(schema)
    expect([...parsed.enums.get('Role')!]).toEqual(['ADMIN', 'USER'])
    expect(parsed.models.get('Post')!.has('@@index')).toBe(false)
  })
})

describe('classifySchemaChange (AC 2)', () => {
  const base = `
model Post {
  id        String   @id
  title     String
  body      String?
}
`

  test('a schema that only adds an optional column is not destructive', () => {
    const next = base.replace('body      String?', 'body      String?\n  views     Int?')
    expect(classifySchemaChange(base, next)).toEqual([])
  })

  test('adding a required column without a default is refused', () => {
    const next = base.replace('body      String?', 'body      String?\n  views     Int')
    const changes = classifySchemaChange(base, next)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.kind).toBe('required_without_default')
    expect(changes[0]!.name).toBe('Post.views')
  })

  test('adding a required column with a default is allowed', () => {
    const next = base.replace('body      String?', 'body      String?\n  views     Int @default(0)')
    expect(classifySchemaChange(base, next)).toEqual([])
  })

  test('dropping a column is destructive', () => {
    const next = base.replace('  body      String?\n', '')
    const changes = classifySchemaChange(base, next)
    expect(changes.map((c) => c.kind)).toEqual(['dropped_field'])
    expect(changes[0]!.name).toBe('Post.body')
  })

  test('dropping a model is destructive', () => {
    const changes = classifySchemaChange(base, base.replace(/model Post[\s\S]*?\n}/, ''))
    expect(changes.map((c) => c.kind)).toEqual(['dropped_model'])
  })

  test('changing a column type is destructive', () => {
    const next = base.replace('title     String', 'title     Int')
    const changes = classifySchemaChange(base, next)
    expect(changes.map((c) => c.kind)).toEqual(['changed_type'])
  })

  test('making an optional column required is destructive', () => {
    const next = base.replace('body      String?', 'body      String')
    expect(classifySchemaChange(base, next).map((c) => c.kind)).toEqual([
      'required_without_default',
    ])
  })

  test('removing an enum value is destructive', () => {
    const before = `enum Role {\n  ADMIN\n  USER\n}\n${base}`
    const after = `enum Role {\n  ADMIN\n}\n${base}`
    const changes = classifySchemaChange(before, after)
    expect(changes.map((c) => c.kind)).toEqual(['removed_enum_value'])
    expect(changes[0]!.name).toBe('Role.USER')
  })

  test('a brand-new project (no previous schema) has nothing to destroy', () => {
    expect(classifySchemaChange('', base)).toEqual([])
  })

  test('the summary names the first few changes and the override', () => {
    const changes = classifySchemaChange(base, base.replace(/model Post[\s\S]*?\n}/, ''))
    const text = describeDestructiveChanges(changes)
    expect(text).toContain('model Post would be dropped')
    expect(text).toContain('allow_data_loss')
    expect(describeDestructiveChanges([])).toBe('')
  })
})
