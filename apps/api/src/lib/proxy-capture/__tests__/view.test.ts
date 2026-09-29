import { describe, expect, test } from 'bun:test'

const migration = await Bun.file(
  `${import.meta.dir}/../../../../../../prisma/migrations/20260926050000_add_proxy_capture_training_data/migration.sql`,
).text()

describe('ai_analysis_turns migration view', () => {
  test('unifies chat and proxy rows with source and turn metadata', () => {
    expect(migration).toContain('CREATE VIEW "ai_analysis_turns"')
    expect(migration).toContain("'cloud_chat'::TEXT AS \"source\"")
    expect(migration).toContain('FROM "proxy_turns" p')
    expect(migration).toContain('UNION ALL')
    expect(migration).toContain('p."userId" AS "userId"')
  })
})
