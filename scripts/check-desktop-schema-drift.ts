// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Compare the desktop SQLite migration history
 * (`apps/desktop/prisma/migrations/`) against the SQLite Prisma schema
 * (`prisma/schema.local.prisma`) and fail loudly on unexpected drift.
 *
 * Why this exists
 * ---------------
 * The desktop track ships two artefacts that must agree:
 *
 *   1. The migration history under `apps/desktop/prisma/migrations/`,
 *      which is what `prisma migrate deploy` replays at runtime in the
 *      packaged app.
 *   2. The schema file `prisma/schema.local.prisma`, which is what
 *      `prisma generate` consumes to produce the Prisma Client TS types.
 *
 * When these drift, the symptom depends on the direction:
 *
 *   * **Schema has model X, migrations don't create it** — runtime
 *     queries against X compile fine (the TS types exist) but throw
 *     `no such table: X` in production. This is the failure mode that
 *     bricked v1.7.8 for every user: `schema.local.prisma` had
 *     `MarketplaceListing`, `MarketplaceInstall`, etc. since the cloud
 *     track added them in April, but the desktop migration tree only
 *     received the *follow-up* ALTERs (`baselineManifest`, audit
 *     columns) — never the base CREATE TABLEs. The desktop binary
 *     therefore tried to ALTER a table that didn't exist on first
 *     launch, the migration was recorded as failed, P3009 tripped, and
 *     every subsequent launch silently exited.
 *
 *   * **Migrations create table X, schema doesn't have it** — opposite
 *     symptom: production has the table but no model, so the Prisma
 *     Client has no way to query it. Less catastrophic (the app starts)
 *     but means the table is dead weight.
 *
 * How the check works
 * -------------------
 * We delegate the comparison to `prisma migrate diff` — Prisma's
 * built-in tool for exactly this purpose, which already knows the full
 * SQLite dialect (enums become TEXT, JSONB becomes TEXT, `String[]`
 * becomes TEXT with a JSON-encoded default, FKs get inlined into
 * CREATE TABLE, partial indexes are handled, etc.). Rolling our own
 * PG→SQLite translator would mean reimplementing all of that.
 *
 * The command:
 *
 *   prisma migrate diff
 *     --from-migrations apps/desktop/prisma/migrations
 *     --to-schema       prisma/schema.local.prisma
 *
 * exits with code 2 when the migrations don't match the schema and
 * prints a one-line summary per drifting table. We parse those lines
 * and bucket each entry into:
 *
 *   * **Unexpected drift** — the table isn't in `ACCEPTED_DRIFT`
 *     below. Fail the check; print Prisma's full SQL fix-up and a
 *     pointer to `bun run db:migrate:desktop` for generating the
 *     corrective migration.
 *
 *   * **Accepted drift** — the table is in `ACCEPTED_DRIFT`. Print a
 *     warning and pass. The intent is to drain this list over time;
 *     new entries should only land with a follow-up ticket.
 *
 * The allow-list pattern (rather than blanket `--exit-code` enforcement)
 * is the only practical way to introduce this check without a flag-day
 * cleanup of pre-existing drift. Once the list is empty we can flip
 * the script to fail unconditionally and delete the allow-list machinery.
 *
 * Usage
 * -----
 *   bun scripts/check-desktop-schema-drift.ts                # default summary + accepted-only OK
 *   bun scripts/check-desktop-schema-drift.ts --strict       # fail on any drift, ignore allow-list
 *   bun scripts/check-desktop-schema-drift.ts --script       # emit the SQL needed to fix the drift
 *   bun scripts/check-desktop-schema-drift.ts --quiet        # suppress "all clean" output
 *
 * Exit codes
 * ----------
 *   0  no drift, or drift only on accepted tables
 *   1  unexpected drift detected (or, with --strict, any drift)
 *   2  prisma CLI failed (migration replay broken, bun not on PATH, etc.)
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

interface Cli {
  strict: boolean
  script: boolean
  quiet: boolean
}

export interface DriftEntry {
  table: string
  kind: 'redefined' | 'changed' | 'added' | 'removed'
  raw: string
}

interface KnownDrift {
  reason: string
}

const MIGRATIONS_DIR = 'apps/desktop/prisma/migrations'
const SCHEMA = 'prisma/schema.local.prisma'
const REPO_ROOT = resolve(import.meta.dir, '..')

/**
 * Tables that we know are out-of-sync between the migration history and
 * `schema.local.prisma` as of when this check was introduced. Each is
 * a pre-existing drift, not a regression — keep the list ratcheted:
 *
 *   * NEVER add an entry as the "fix" for a failing PR — instead, run
 *     `bun run db:migrate:desktop --name <name>` to generate the
 *     corrective migration and ship that.
 *   * REMOVE an entry as soon as the underlying drift is fixed; the
 *     check will then guard against regression on that table.
 *
 * To regenerate this baseline, run
 *   `bun x prisma migrate diff --from-migrations apps/desktop/prisma/migrations \
 *      --to-schema prisma/schema.local.prisma`
 * and add every table the output mentions, with a one-line note
 * indicating what is known about the drift on it.
 */
export const ACCEPTED_DRIFT: Record<string, KnownDrift> = {
  agent_configs: {
    reason:
      'Pre-existing drift discovered when this check was added (2026-05-21). Detailed audit pending.',
  },
  agent_eval_sets: {
    reason:
      'Pre-existing drift discovered when this check was added (2026-05-21). Detailed audit pending.',
  },
  budget_alerts: {
    reason:
      'Pre-existing drift discovered when this check was added (2026-05-21). Detailed audit pending.',
  },
  eval_runs: {
    reason:
      'Pre-existing drift discovered when this check was added (2026-05-21); diff shows `tags` nullable in history vs NOT NULL DEFAULT \'[]\' in schema (the corrective COALESCE is in Prisma\'s emitted SQL).',
  },
  model_experiments: {
    reason:
      'Pre-existing drift discovered when this check was added (2026-05-21). Detailed audit pending.',
  },
  projects: {
    reason:
      'Pre-existing drift discovered when this check was added (2026-05-21). Detailed audit pending.',
  },
  subagent_model_overrides: {
    reason:
      'Pre-existing drift discovered when this check was added (2026-05-21). Detailed audit pending.',
  },
  usage_wallets: {
    reason:
      'Pre-existing drift discovered when this check was added (2026-05-21). Detailed audit pending.',
  },
  workspace_grants: {
    reason:
      'Pre-existing drift discovered when this check was added (2026-05-21). Detailed audit pending.',
  },
  signup_attributions: {
    reason:
      'Pre-existing drift discovered when this check was added (2026-05-21); only the autogenerated unique index is redefined, table columns themselves are aligned.',
  },
}

function parseCli(): Cli {
  const args = process.argv.slice(2)
  return {
    strict: args.includes('--strict'),
    script: args.includes('--script'),
    quiet: args.includes('--quiet'),
  }
}

function runMigrateDiff(extraArgs: string[]): {
  stdout: string
  stderr: string
  exitCode: number
} {
  // Invoke via `bun x` to match how every other Prisma command is
  // called from package.json. `bun x` resolves the local `prisma`
  // dependency without needing a global install, which is critical
  // for CI runners that only have bun on PATH.
  //
  // Note: we use `spawnSync` (not `Bun.spawnSync`) so the script is
  // also runnable under `node` for the rare cases where someone
  // invokes scripts outside of bun (e.g. an `npm run` chain).
  const result = spawnSync(
    process.platform === 'win32' ? 'bun.exe' : 'bun',
    [
      'x',
      'prisma',
      'migrate',
      'diff',
      '--from-migrations',
      MIGRATIONS_DIR,
      '--to-schema',
      SCHEMA,
      ...extraArgs,
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      // Prisma reads SHOGO_LOCAL_MODE to pick which schema to use as
      // its config default. Force it on so prisma.config.ts resolves
      // the SQLite schema, matching what `migrate diff` is comparing
      // against. (`--to-schema` is explicit so this is technically
      // belt-and-suspenders, but it avoids the v7 PrismaConfigEnvError
      // crash if `DATABASE_URL` happens to be unset.)
      env: { ...process.env, SHOGO_LOCAL_MODE: 'true' },
    },
  )
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
  }
}

export function parseDrift(output: string): DriftEntry[] {
  const entries: DriftEntry[] = []
  for (const line of output.split('\n')) {
    // Prisma's summary format is documented at
    // https://www.prisma.io/docs/orm/reference/prisma-cli-reference#migrate-diff
    // but the actual emitted strings are stable enough to parse with
    // regex. The four shapes we care about for SQLite:
    //
    //   [*] Redefined table `name`
    //   [*] Changed the `name` table
    //   [+] Added the `name` table
    //   [-] Removed the `name` table
    //
    // Nested per-column/per-index lines are ignored — once a table is
    // listed, we treat the whole table as drifting.
    let m: RegExpExecArray | null
    if ((m = /^\[\*\] Redefined table `([^`]+)`/.exec(line))) {
      entries.push({ table: m[1]!, kind: 'redefined', raw: line.trim() })
    } else if ((m = /^\[\*\] Changed the `([^`]+)` table/.exec(line))) {
      entries.push({ table: m[1]!, kind: 'changed', raw: line.trim() })
    } else if ((m = /^\[\+\] Added the `([^`]+)` table/.exec(line))) {
      entries.push({ table: m[1]!, kind: 'added', raw: line.trim() })
    } else if ((m = /^\[-\] Removed the `([^`]+)` table/.exec(line))) {
      entries.push({ table: m[1]!, kind: 'removed', raw: line.trim() })
    }
  }
  return entries
}

function main(): void {
  const cli = parseCli()

  if (!existsSync(resolve(REPO_ROOT, MIGRATIONS_DIR))) {
    console.error(`[drift] Could not find ${MIGRATIONS_DIR}. Run from repo root.`)
    process.exit(2)
  }
  if (!existsSync(resolve(REPO_ROOT, SCHEMA))) {
    console.error(`[drift] Could not find ${SCHEMA}. Run from repo root.`)
    process.exit(2)
  }

  // `--script` mode: pass through to prisma verbatim. This is the
  // "show me the SQL needed to fix it" affordance for developers.
  if (cli.script) {
    const r = runMigrateDiff(['--script'])
    process.stdout.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
    process.exit(r.exitCode === 0 ? 0 : 1)
  }

  const r = runMigrateDiff([])

  // Prisma exits 0 on success regardless of drift unless --exit-code
  // is passed. Any non-zero exit here is a tooling failure (couldn't
  // replay migrations, couldn't read schema, bun-not-on-PATH, etc.).
  if (r.exitCode !== 0) {
    console.error(`[drift] prisma migrate diff failed (exit code ${r.exitCode}).`)
    if (r.stdout) console.error(r.stdout)
    if (r.stderr) console.error(r.stderr)
    console.error(
      `\nThis usually means the migration history under ${MIGRATIONS_DIR} can't be ` +
        `replayed against an empty SQLite DB. Run \`bun run check:migrations\` to see ` +
        `the underlying SQL error.`,
    )
    process.exit(2)
  }

  const drift = parseDrift(r.stdout)
  const unexpected = drift.filter((d) => !(d.table in ACCEPTED_DRIFT))
  const accepted = drift.filter((d) => d.table in ACCEPTED_DRIFT)

  if (cli.strict) {
    if (drift.length === 0) {
      if (!cli.quiet) {
        console.log(`[drift] OK (--strict) — migration history matches ${SCHEMA} exactly.`)
      }
      process.exit(0)
    }
    console.error(
      `[drift] FAIL (--strict) — ${drift.length} table(s) drift between ` +
        `${MIGRATIONS_DIR} and ${SCHEMA}:`,
    )
    for (const d of drift) console.error(`  - ${d.raw}`)
    console.error(
      `\nRun \`bun scripts/check-desktop-schema-drift.ts --script\` to see the corrective SQL,\n` +
        `or \`bun run db:migrate:desktop --name <snake_case>\` to generate a new migration.`,
    )
    process.exit(1)
  }

  if (unexpected.length > 0) {
    console.error(
      `[drift] FAIL — ${unexpected.length} table(s) drift between ${MIGRATIONS_DIR} ` +
        `and ${SCHEMA} that are NOT on the accepted-drift allow-list:`,
    )
    for (const d of unexpected) console.error(`  - ${d.raw}`)
    console.error(
      `\nThis is the bug class that bricked v1.7.8: schema.local.prisma references\n` +
        `models that the migration history doesn't materialise, so the desktop binary\n` +
        `fails on first launch with "no such table: X" and Prisma's P3009 lock kicks in.\n\n` +
        `Fix:\n` +
        `  1. Run \`bun scripts/check-desktop-schema-drift.ts --script\` to see the SQL.\n` +
        `  2. Run \`bun run db:migrate:desktop --name <snake_case>\` to generate the\n` +
        `     migration file under ${MIGRATIONS_DIR}/.\n` +
        `  3. Commit the new migration alongside the schema change.\n` +
        `  4. Re-run this check; the table should disappear from the failure list.\n`,
    )
    if (accepted.length > 0) {
      console.error(
        `Note: ${accepted.length} other table(s) also drift but are on the accepted-drift\n` +
          `allow-list in scripts/check-desktop-schema-drift.ts (pre-existing tech debt).\n`,
      )
    }
    process.exit(1)
  }

  if (accepted.length > 0 && !cli.quiet) {
    console.warn(
      `[drift] WARN — ${accepted.length} table(s) drift but are on the accepted-drift ` +
        `allow-list (pre-existing tech debt):`,
    )
    for (const d of accepted) {
      const note = ACCEPTED_DRIFT[d.table]!.reason
      console.warn(`  - ${d.raw}`)
      console.warn(`      ${note}`)
    }
    console.warn(
      `\nTo retire an entry: fix the drift (\`bun run db:migrate:desktop --name <name>\`), ` +
        `confirm the table no longer appears in this output, then remove it from\n` +
        `ACCEPTED_DRIFT in scripts/check-desktop-schema-drift.ts.\n`,
    )
    process.exit(0)
  }

  if (!cli.quiet) {
    console.log(`[drift] OK — migration history matches ${SCHEMA} (no drift, no accepted drift).`)
  }
  process.exit(0)
}

// Guard the side-effecting entrypoint so other scripts (e.g.
// `scripts/dev-all.ts`'s migrate doctor) can import `ACCEPTED_DRIFT` and
// `parseDrift` without triggering the CLI's `process.exit`.
if (import.meta.main) {
  main()
}
