// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Postgres at publish, schema half (SHO-308 §1): the conversion, the hash and
 * the seed SQL the publish path depends on.
 */

import { describe, expect, it } from 'bun:test'
import {
  buildPublishSchema,
  buildSeedSql,
  countSeedRows,
  dropOrphanedSeedRows,
  orderSeedTables,
  parseBooleanColumns,
  parseModelTables,
  parseSeedRelations,
  parseSerialIdColumns,
  publishedSchemaHash,
  quoteLiteral,
  PublishSchemaError,
} from '../published-schema'

const SQLITE_SCHEMA = `datasource db {
  provider = "sqlite"
}

generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  posts Post[]
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int
  author   User   @relation(fields: [authorId], references: [id])
}

model Category {
  id       Int        @id @default(autoincrement())
  name     String
  parentId Int?
  parent   Category?  @relation("Tree", fields: [parentId], references: [id])
  children Category[] @relation("Tree")
}
`

describe('buildPublishSchema', () => {
  it('converts a SQLite schema to the Postgres one that gets pushed', () => {
    const built = buildPublishSchema(SQLITE_SCHEMA)
    expect(built.content).toContain('provider = "postgresql"')
    expect(built.content).not.toContain('provider = "sqlite"')
    expect(built.transformed).toBe(true)
    expect(built.hash).toBe(publishedSchemaHash(built.content))
  })

  it('keeps autoincrement ids as autoincrement() (auto() is MongoDB-only)', () => {
    const built = buildPublishSchema(SQLITE_SCHEMA)
    expect(built.content).toContain('@id @default(autoincrement())')
    expect(built.content).not.toContain('auto()')
  })

  it('leaves an already-Postgres schema untouched', () => {
    const pg = SQLITE_SCHEMA.replace('provider = "sqlite"', 'provider = "postgresql"')
    const built = buildPublishSchema(pg)
    expect(built.content).toBe(pg)
    expect(built.transformed).toBe(false)
    expect(built.warnings).toEqual([])
  })

  it('refuses a schema with no datasource provider', () => {
    expect(() => buildPublishSchema('model A { id Int @id }')).toThrow(PublishSchemaError)
    try {
      buildPublishSchema('model A { id Int @id }')
    } catch (err: any) {
      expect(err.code).toBe('no_provider')
    }
  })
})

describe('publishedSchemaHash', () => {
  it('ignores comments, blank lines and indentation', () => {
    const a = publishedSchemaHash(SQLITE_SCHEMA)
    const reformatted = SQLITE_SCHEMA.replace(/\n  /g, '\n').replace('model User {', '// a note\nmodel User {')
    expect(publishedSchemaHash(reformatted)).toBe(a)
  })

  it('changes when a field changes', () => {
    const a = publishedSchemaHash(SQLITE_SCHEMA)
    expect(publishedSchemaHash(SQLITE_SCHEMA.replace('title    String', 'title    String?'))).not.toBe(a)
  })
})

describe('seed ordering', () => {
  it('maps models to their physical tables', () => {
    const tables = parseModelTables(SQLITE_SCHEMA)
    expect(tables.get('User')).toBe('User')
    expect(tables.get('Post')).toBe('Post')
    expect(
      parseModelTables('model Blog {\n  id Int @id\n  @@map("blogs")\n}').get('Blog'),
    ).toBe('blogs')
  })

  it('reads only the side that holds the foreign key, with the FK columns', () => {
    const relations = parseSeedRelations(SQLITE_SCHEMA)
    expect(relations).toEqual([
      { child: 'Post', parent: 'User', childColumns: ['authorId'], parentColumns: ['id'] },
      { child: 'Category', parent: 'Category', childColumns: ['parentId'], parentColumns: ['id'] },
    ])
  })

  it('inserts referenced tables first', () => {
    const ordered = orderSeedTables(
      ['Post', 'User'],
      parseSeedRelations(SQLITE_SCHEMA),
      parseModelTables(SQLITE_SCHEMA),
    )
    expect(ordered).toEqual(['User', 'Post'])
  })

  it('keeps declaration order for a cycle rather than dropping a table', () => {
    const schema = `model A {
  id Int @id
  bId Int
  b   B   @relation(fields: [bId], references: [id])
}
model B {
  id Int @id
  aId Int
  a   A   @relation(fields: [aId], references: [id])
}`
    const ordered = orderSeedTables(['A', 'B'], parseSeedRelations(schema), parseModelTables(schema))
    expect(ordered.sort()).toEqual(['A', 'B'])
  })

  it('flags autoincrement ids so their sequences are reset', () => {
    const serial = parseSerialIdColumns(SQLITE_SCHEMA)
    expect(serial.get('User')).toBe('id')
    expect(serial.get('Post')).toBe('id')
  })
})

describe('seed SQL', () => {
  it('quotes identifiers and every scalar a SQLite row can hold', () => {
    expect(quoteLiteral(null)).toBe('NULL')
    expect(quoteLiteral(42)).toBe('42')
    expect(quoteLiteral(0)).toBe('0')
    expect(quoteLiteral(true)).toBe('TRUE')
    expect(quoteLiteral("O'Brien")).toBe("'O''Brien'")
    expect(quoteLiteral(Buffer.from('hi'))).toBe("'\\x6869'::bytea")
  })

  it('emits one multi-row INSERT, then moves the sequence past the rows', () => {
    const sql = buildSeedSql([
      {
        table: 'User',
        columns: ['id', 'email'],
        rows: [
          [1, 'a@example.com'],
          [2, 'b@example.com'],
        ],
        serialIdColumn: 'id',
      },
    ])
    expect(sql).toContain('BEGIN;')
    expect(sql).toContain('INSERT INTO "User" ("id", "email") VALUES')
    expect(sql).toContain("(1, 'a@example.com'),")
    // One statement for both rows: a self-reference inside one INSERT is
    // resolved at statement end, so a single row-per-INSERT load would fail.
    expect(sql.match(/INSERT INTO/g)).toHaveLength(1)
    // The table name is quoted inside the literal (that argument is parsed as a
    // name, so `'User'` folds to `user` and fails with `relation "user" does not
    // exist`, aborting the whole seed transaction). The column is plain: it is
    // compared to the attribute name as a string, so quoting it fails.
    expect(sql).toContain(
      `setval(pg_get_serial_sequence('"User"', 'id'), GREATEST((SELECT COALESCE(MAX("id"), 0) FROM "User"), 1))`,
    )
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true)
  })

  it('quotes a mapped table name but passes the column name literally', () => {
    const sql = buildSeedSql([
      {
        table: 'app_user',
        columns: ['Id', 'email'],
        rows: [[7, 'a@example.com']],
        serialIdColumn: 'Id',
      },
    ])
    // `'"app_user"'` resolves the table; `'Id'` must reach the lookup verbatim so
    // a PascalCase id column still matches.
    expect(sql).toContain(`pg_get_serial_sequence('"app_user"', 'Id')`)
  })

  it('skips empty tables but still counts what is being copied', () => {
    const tables = [
      { table: 'User', columns: ['id'], rows: [[1]], serialIdColumn: 'id' },
      { table: 'Post', columns: ['id'], rows: [] },
    ]
    const sql = buildSeedSql(tables)
    expect(sql).not.toContain('"Post"')
    expect(countSeedRows(tables)).toEqual({ tables: 1, rows: 1 })
  })
})

describe('seed SQL for Boolean columns', () => {
  // Prisma stores a Boolean in SQLite as INTEGER 0/1. Postgres rejects an integer
  // for a boolean column ("column \"active\" is of type boolean but expression is
  // of type integer"), so the seed has to emit real boolean literals.
  const SCHEMA = `datasource db {
  provider = "sqlite"
}

model Item {
  id        Int     @id @default(autoincrement())
  label     String
  active    Boolean @default(true)
  archived  Boolean?
  tags      String  @default("[]")
}
`

  it('finds scalar Boolean columns per physical table', () => {
    const booleans = parseBooleanColumns(SCHEMA)
    expect(booleans.get('Item')).toEqual(['active', 'archived'])
  })

  it('emits TRUE/FALSE for a Boolean column whatever SQLite hands back', () => {
    const sql = buildSeedSql([
      {
        table: 'Item',
        columns: ['id', 'label', 'active', 'archived', 'tags'],
        rows: [
          [1, 'one', 1, 0, '[]'],
          [2, 'two', 0, null, '["a"]'],
          [3, 'three', true, false, '[]'],
        ],
        serialIdColumn: 'id',
        booleanColumns: ['active', 'archived'],
      },
    ])
    expect(sql).toContain('(1, \'one\', TRUE, FALSE, \'[]\')')
    expect(sql).toContain('(2, \'two\', FALSE, NULL, \'["a"]\')')
    expect(sql).toContain('(3, \'three\', TRUE, FALSE, \'[]\')')
  })

  it('quotes a String column as before when only other columns are Boolean', () => {
    const sql = buildSeedSql([
      {
        table: 'Item',
        columns: ['id', 'label', 'active'],
        rows: [[1, '1', 1]],
        booleanColumns: ['active'],
      },
    ])
    expect(sql).toContain("(1, '1', TRUE)")
  })
})

// SHO-551: seed rows that reference deleted parents (FK targets) must be
// filtered out before the seed SQL is built, so Postgres doesn't reject
// the whole seed with a foreign key violation.
describe('dropping orphaned seed rows', () => {
  const schema = `
model Application {
  id    String @id
  title String
  stages StageChange[]
}
model StageChange {
  id            String      @id
  applicationId String
  application   Application @relation(fields: [applicationId], references: [id])
  note          String
}
`
  const relations = parseSeedRelations(schema)
  const modelTables = parseModelTables(schema)

  const apps: import('../published-schema').SeedTableData = {
    table: 'Application',
    columns: ['id', 'title'],
    rows: [['app1', 'App 1'], ['app2', 'App 2']],
  }
  const stages: import('../published-schema').SeedTableData = {
    table: 'StageChange',
    columns: ['id', 'applicationId', 'note'],
    rows: [
      ['s1', 'app1', 'valid'],
      ['s2', 'app2', 'valid'],
      ['s3', 'deleted-app', 'orphan 1'],
      ['s4', 'gone-app', 'orphan 2'],
    ],
  }

  it('drops children of deleted parents and reports them', () => {
    const { tables, orphans } = dropOrphanedSeedRows([apps, stages], relations, modelTables)
    const sc = tables.find((t: any) => t.table === 'StageChange')!
    expect(sc.rows).toHaveLength(2)
    expect(sc.rows.map((r: any) => r[0])).toEqual(['s1', 's2'])
    expect(orphans).toHaveLength(1)
    expect(orphans[0]).toMatchObject({ table: 'StageChange', count: 2 })
    expect(orphans[0].sampleIds).toContain('deleted-app')
  })

  it('keeps valid rows and tables with no FK intact', () => {
    const { tables, orphans } = dropOrphanedSeedRows([apps, stages], relations, modelTables)
    const appTable = tables.find((t: any) => t.table === 'Application')!
    expect(appTable.rows).toHaveLength(2)
    expect(orphans.map((o: any) => o.table)).not.toContain('Application')
  })

  it('reports sample ids for the orphaned rows', () => {
    const { orphans } = dropOrphanedSeedRows([apps, stages], relations, modelTables)
    expect(orphans[0].sampleIds).toContain('deleted-app')
    expect(orphans[0].sampleIds).toContain('gone-app')
  })

  it('handles tables with no relations without touching them', () => {
    const { tables, orphans } = dropOrphanedSeedRows([apps], [], modelTables)
    expect(tables[0].rows).toHaveLength(2)
    expect(orphans).toHaveLength(0)
  })
})
