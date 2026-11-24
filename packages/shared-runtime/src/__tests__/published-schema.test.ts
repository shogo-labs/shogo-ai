// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Postgres at publish, schema half (SHO-308 §1): the conversion, the hash and
 * the seed SQL the publish path depends on.
 */

import { describe, expect, it } from 'bun:test'
import {
  buildPublishSchema,
  buildSeedChunks,
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

// SHO-551 AC 1: KIF's shape — one deleted parent with three child tables, plus a
// grandchild that only becomes an orphan once its own parent row is dropped.
// `attachments` is listed *before* `stage_changes` deliberately: a single pass in
// array order sees the still-unfiltered parent and keeps the grandchild, which is
// exactly the defect QA reproduced.
describe('dropping orphaned seed rows through several levels', () => {
  const schema = `
model Application {
  id       String       @id
  title    String
  stages   StageChange[]
  payments Payment[]
  reviews  Review[]
}
model StageChange {
  id            String       @id
  applicationId String
  application   Application  @relation(fields: [applicationId], references: [id])
  attachments   Attachment[]
}
model Attachment {
  id            String      @id
  stageChangeId String
  stageChange   StageChange @relation(fields: [stageChangeId], references: [id])
  url           String
}
model Payment {
  id            String      @id
  applicationId String
  application   Application @relation(fields: [applicationId], references: [id])
  amount        Int
}
model Review {
  id            String      @id
  applicationId String
  application   Application @relation(fields: [applicationId], references: [id])
  rating        Int
}
`
  const relations = parseSeedRelations(schema)
  const modelTables = parseModelTables(schema)

  type SeedTableData = import('../published-schema').SeedTableData

  const make = () => ({
    attachments: {
      table: 'Attachment',
      columns: ['id', 'stageChangeId', 'url'],
      rows: [
        ['a1', 's1', 'ok'],
        ['a2', 's2', 'grandchild of a dropped row'],
      ],
    } as SeedTableData,
    stages: {
      table: 'StageChange',
      columns: ['id', 'applicationId'],
      rows: [
        ['s1', 'app1', 'valid'],
        ['s2', 'deleted-app', 'orphan'],
        ['s3', 'app2', 'valid'],
      ],
    } as SeedTableData,
    payments: {
      table: 'Payment',
      columns: ['id', 'applicationId', 'amount'],
      rows: [
        ['p1', 'app1', 100],
        ['p2', 'gone-app', 200],
      ],
    } as SeedTableData,
    reviews: {
      table: 'Review',
      columns: ['id', 'applicationId', 'rating'],
      rows: [
        ['r1', 'deleted-app', 5],
        ['r2', 'gone-app', 1],
      ],
    } as SeedTableData,
    applications: {
      table: 'Application',
      columns: ['id', 'title'],
      rows: [
        ['app1', 'App 1'],
        ['app2', 'App 2'],
      ],
    } as SeedTableData,
  })

  const run = () => {
    const fixture = make()
    return dropOrphanedSeedRows(
      [fixture.attachments, fixture.stages, fixture.payments, fixture.reviews, fixture.applications],
      relations,
      modelTables,
    )
  }

  const rowsOf = (tables: SeedTableData[], table: string) =>
    tables.find((t) => t.table === table)!.rows.map((row) => row[0])

  it('drops orphans in all three child tables', () => {
    const { tables } = run()
    expect(rowsOf(tables, 'Application')).toEqual(['app1', 'app2'])
    expect(rowsOf(tables, 'StageChange')).toEqual(['s1', 's3'])
    expect(rowsOf(tables, 'Payment')).toEqual(['p1'])
    expect(rowsOf(tables, 'Review')).toEqual([])
  })

  it('drops a grandchild whose own parent row was dropped', () => {
    const { tables } = run()
    expect(rowsOf(tables, 'Attachment')).toEqual(['a1'])
  })

  it('reports one entry per dropped relation with counts and samples', () => {
    const { orphans } = run()
    const byTable = Object.fromEntries(orphans.map((o) => [o.table, o]))
    expect(byTable.StageChange).toMatchObject({ column: 'applicationId', parent: 'Application', count: 1 })
    expect(byTable.StageChange.sampleIds).toEqual(['deleted-app'])
    expect(byTable.Attachment).toMatchObject({ column: 'stageChangeId', parent: 'StageChange', count: 1 })
    expect(byTable.Attachment.sampleIds).toEqual(['s2'])
    expect(byTable.Payment).toMatchObject({ count: 1 })
    expect(byTable.Review).toMatchObject({ count: 2 })
    expect(orphans).toHaveLength(4)
  })

  it('leaves the input tables untouched', () => {
    const fixture = make()
    dropOrphanedSeedRows([fixture.stages, fixture.applications], relations, modelTables)
    expect(fixture.stages.rows).toHaveLength(3)
  })
})

// §G4: a seed bigger than one request body is loaded in bounded chunks, so the
// 64 MB per-request limit stops being a limit on what an app may own. Nada App's
// builder dev.db is 91 MB, one table ~68 MB of SQL on its own.
describe('chunked seed SQL', () => {
  const table = (rows: number, width = 40) => ({
    table: 'LiveSessionEvent',
    columns: ['id', 'payload'],
    rows: Array.from({ length: rows }, (_, i) => [i + 1, 'p'.repeat(width)]),
    serialIdColumn: 'id',
  })

  it('keeps a small seed in one chunk, identical to buildSeedSql', () => {
    const tables = [table(10)]
    const chunks = buildSeedChunks(tables, 8 * 1024 * 1024)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(buildSeedSql(tables))
  })

  it('splits a large seed into bounded, self-contained transactions', () => {
    // 4,000 rows at ~50 bytes each is ~200 KB; a 40 KB chunk cannot hold it.
    const chunks = buildSeedChunks([table(4_000)], 40_000)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.startsWith('BEGIN;')).toBe(true)
      expect(chunk.trimEnd().endsWith('COMMIT;')).toBe(true)
      expect(Buffer.byteLength(chunk, 'utf-8')).toBeLessThanOrEqual(40_000)
      // Every chunk loads on its own: one transaction per request.
      expect(chunk.match(/BEGIN;/g)).toHaveLength(1)
      expect(chunk.match(/COMMIT;/g)).toHaveLength(1)
    }
  })

  it('loses no row and keeps the order across chunks', () => {
    const tables = [table(4_000)]
    const chunks = buildSeedChunks(tables, 40_000)
    const ids = [...chunks.join('\n').matchAll(/\((\d+), 'p/g)].map((m) => Number(m[1]))
    expect(ids).toEqual(Array.from({ length: 4_000 }, (_, i) => i + 1))
  })

  it('keeps parent tables ahead of children across a chunk boundary', () => {
    const parent = { table: 'User', columns: ['id'], rows: Array.from({ length: 60 }, (_, i) => [i + 1]) }
    const child = {
      table: 'Post',
      columns: ['id', 'authorId'],
      rows: Array.from({ length: 60 }, (_, i) => [i + 1, i + 1]),
    }
    const chunks = buildSeedChunks([parent, child], 1_000)
    expect(chunks.length).toBeGreaterThan(1)
    const joined = chunks.join('\n')
    expect(joined.indexOf('INSERT INTO "User"')).toBeLessThan(joined.indexOf('INSERT INTO "Post"'))
  })

  it('resets the sequence in the chunk that carried the rows', () => {
    const chunks = buildSeedChunks([table(2_000)], 4_000)
    const last = chunks[chunks.length - 1]!
    expect(last).toContain(`setval(pg_get_serial_sequence('"LiveSessionEvent"', 'id')`)
  })

  it('gives a single enormous row its own chunk rather than splitting it', () => {
    const wide = {
      table: 'Blob',
      columns: ['id', 'body'],
      rows: [[1, 'x'.repeat(50_000)]],
    }
    const chunks = buildSeedChunks([wide], 1_000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('BEGIN;')
    expect(chunks[0]!.length).toBeGreaterThan(50_000)
  })
})
