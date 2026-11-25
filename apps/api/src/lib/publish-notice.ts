/**
 * The seed notice a publish records on its environment row (SHO-551 §F).
 *
 * A publish answers 202 and finishes in the background (SHO-542), so the report
 * of rows a seed could not carry cannot ride the response — it is written to
 * `PublishedEnvironment.publishNotice` and served by the environment status GET.
 *
 * The rule this module exists to hold, and to be testable on its own: **only a
 * seed that actually ran may change that record.** A republish of an environment
 * whose Postgres schema already exists copies no rows, so it has nothing to say.
 * Writing `null` from there would erase the first seed's report, and for a
 * migration that report is the only record of what was left behind.
 */
export interface SeedOrphanCount {
  table: string
  count: number
}

export interface SeedNoticeDecision {
  /** Whether the environment row should be written this publish. */
  write: boolean
  /** The notice to store — `null` clears a stale one from an earlier seed. */
  notice: string | null
}

/**
 * Decide what a publish records about its seed.
 *
 * - no seed ran → `{ write: false }`: leave whatever an earlier seed recorded.
 * - a seed ran with orphans → the report, naming every table and count.
 * - a seed ran clean → `{ write: true, notice: null }`, which clears a notice
 *   from an earlier seed that did have orphans.
 */
export function seedNoticeWrite(input: {
  seeded: boolean
  orphans: readonly SeedOrphanCount[]
}): SeedNoticeDecision {
  if (!input.seeded) return { write: false, notice: null }
  const total = input.orphans.reduce((sum, orphan) => sum + orphan.count, 0)
  if (total === 0) return { write: true, notice: null }
  const tableList = input.orphans.map((orphan) => `${orphan.table} (${orphan.count})`).join(', ')
  return {
    write: true,
    notice:
      `${total} row(s) referencing deleted records were not copied to Postgres ` +
      `(${tableList}). They are still in the SQLite archive and can be recovered.`,
  }
}
