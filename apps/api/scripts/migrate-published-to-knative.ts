// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * migrate-published-to-knative.ts  (SHO-308 §7)
 *
 * Move published sites that are live on metal (`published:{id}` microVMs,
 * SQLite in `data.tar.gz`) to Knative + Postgres.
 *
 * This is the CLI. The two-phase migration itself — maintenance window, freeze,
 * final export, row-count check, edge flip, health check, budget and rollback —
 * lives in `src/services/published-cutover.service.ts`, so it is exercised by
 * unit tests with fakes instead of only by a script nobody can run in CI.
 *
 * Every site runs in TWO phases, so the only downtime is the final data copy:
 *
 *   1. PREPARE (site stays live on metal)
 *      - its `production` environment row, Postgres database and schema
 *      - one image for the live commit
 *      - a warm ksvc at `min-scale: 1`, never given traffic
 *      - a trial load of the current archive into a copy of the database
 *
 *   2. SWITCH (the only downtime), timed end to end
 *      - maintenance on, freeze the microVM, wait for the fresh export
 *      - truncate + reload Postgres, compare per-table row counts
 *      - flip the edge to `knative`, health-check, maintenance off, release the VM
 *
 * Over budget or any failed step rolls the site back to metal automatically.
 *
 * `--rehearse` runs all of phase 1 plus a TIMED switch against copies — a
 * template copy of the database and a `published-{id}-rehearsal` ksvc — so the
 * real downtime can be measured with zero user impact: no freeze, no flag flip.
 *
 * Usage:
 *   bun apps/api/scripts/migrate-published-to-knative.ts --dry-run
 *   bun apps/api/scripts/migrate-published-to-knative.ts --rehearse --limit 5
 *   bun apps/api/scripts/migrate-published-to-knative.ts --yes --limit 10
 *   bun apps/api/scripts/migrate-published-to-knative.ts --yes --project <uuid>
 *   bun apps/api/scripts/migrate-published-to-knative.ts --yes --to metal --project <uuid>
 *
 * Flags:
 *   --dry-run        Print the plan; change nothing (default).
 *   --rehearse       Phase 1 + a timed switch against copies. No user impact.
 *   --yes            Apply the real migration (required to mutate).
 *   --project <id>   Only this project (repeatable).
 *   --limit <n>      Cap how many sites are processed.
 *   --max-downtime <seconds>  Bound on the switch window (default 60).
 *   --max-failures <n>  Stop the batch after this many failed sites (default 3).
 *   --readiness-timeout <seconds>  Phase 1's wait for the ksvc to answer /ready
 *                    (default 300). Outside the downtime window.
 *   --archive-timeout <seconds>  How long to wait for the final export (default 90).
 *   --to metal       Rollback direction: put a site back on metal from the kept
 *                    archive and flip its flag back.
 *
 * Exit 0 when every processed site succeeded, 1 otherwise.
 */

import { prisma } from '../src/lib/prisma'
import {
  defaultCutoverDeps,
  prepareCutoverSite,
  rehearseCutoverSite,
  restoreSiteToMetal,
  switchCutoverSite,
  type CutoverResult,
  type CutoverSite,
} from '../src/services/published-cutover.service'

type Target = 'knative' | 'metal'

interface Cli {
  apply: boolean
  rehearse: boolean
  projectIds: string[]
  limit?: number
  maxDowntimeMs: number
  maxFailures: number
  readinessTimeoutMs: number
  archiveTimeoutMs: number
  to: Target
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = {
    apply: false,
    rehearse: false,
    projectIds: [],
    maxDowntimeMs: 60_000,
    maxFailures: 3,
    readinessTimeoutMs: 300_000,
    archiveTimeoutMs: 90_000,
    to: 'knative',
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--yes') cli.apply = true
    else if (a === '--dry-run') cli.apply = false
    else if (a === '--rehearse') cli.rehearse = true
    else if (a === '--project') cli.projectIds.push(argv[++i])
    else if (a === '--limit') cli.limit = Number(argv[++i])
    else if (a === '--max-downtime') cli.maxDowntimeMs = Number(argv[++i]) * 1000
    else if (a === '--max-failures') cli.maxFailures = Number(argv[++i])
    else if (a === '--readiness-timeout') cli.readinessTimeoutMs = Number(argv[++i]) * 1000
    else if (a === '--archive-timeout') cli.archiveTimeoutMs = Number(argv[++i]) * 1000
    else if (a === '--to') cli.to = argv[++i] === 'metal' ? 'metal' : 'knative'
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: migrate-published-to-knative.ts [--dry-run|--rehearse|--yes] [--project <id>] [--limit <n>] ' +
          '[--max-downtime <s>] [--max-failures <n>] [--readiness-timeout <s>] [--archive-timeout <s>] [--to metal]',
      )
      process.exit(0)
    }
  }
  return cli
}

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`)
const info = (m: string) => console.log(`    · ${m}`)
const bad = (m: string, hint?: string) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`)
  if (hint) console.log(`      ${hint}`)
}

function formatSeconds(ms: number | null): string {
  return ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`
}

async function main() {
  const cli = parseArgs(process.argv.slice(2))
  const mode =
    cli.to === 'metal' ? 'ROLLBACK to metal' : cli.rehearse ? 'REHEARSE' : cli.apply ? 'APPLY' : 'DRY-RUN'

  console.log(`\n=== published sites → ${cli.to} (${mode}) ===\n`)
  console.log(`  max downtime per site: ${cli.maxDowntimeMs / 1000}s`)
  console.log(`  readiness wait per site: ${cli.readinessTimeoutMs / 1000}s (outside the window)`)
  console.log(`  archive wait per site: ${cli.archiveTimeoutMs / 1000}s`)
  console.log(`  stop the batch after ${cli.maxFailures} failure(s)\n`)

  const where: any = { publishedSubdomain: { not: null } }
  if (cli.projectIds.length) where.id = { in: cli.projectIds }
  const projects = (await prisma.project.findMany({
    where,
    select: { id: true, publishedSubdomain: true, publishedAlwaysOn: true } as any,
    orderBy: { publishedAt: 'asc' },
    ...(cli.limit ? { take: cli.limit } : {}),
  })) as Array<{ id: string; publishedSubdomain: string; publishedAlwaysOn?: boolean }>

  console.log(`Found ${projects.length} published site(s)${cli.limit ? ` (capped at ${cli.limit})` : ''}.\n`)

  const deps = defaultCutoverDeps()
  const results: CutoverResult[] = []
  let failures = 0

  for (const p of projects) {
    // A batch that keeps going after a run of failures is how one bad image or a
    // region-wide database problem takes every site down in an afternoon. Stop
    // while the operator can still see what the first failures had in common.
    if (failures >= cli.maxFailures) {
      console.log(
        `\nStopping: ${failures} site(s) failed with --max-failures ${cli.maxFailures} still in the list.` +
          ' Nothing else was touched.',
      )
      break
    }
    const site: CutoverSite = {
      projectId: p.id,
      subdomain: p.publishedSubdomain,
      alwaysOn: p.publishedAlwaysOn === true,
    }
    console.log(`\n${site.subdomain} (${site.projectId.slice(0, 8)})${site.alwaysOn ? ' [always-on]' : ''}`)

    if (!cli.apply && !cli.rehearse) {
      info('would prepare the image + database, trial-load, then freeze and switch with limited downtime')
      results.push({
        projectId: site.projectId,
        subdomain: site.subdomain,
        dbBytes: 0,
        prepareMs: 0,
        downtimeMs: null,
        outcome: 'dry-run',
      })
      continue
    }

    if (cli.to === 'metal') {
      const restored = await restoreSiteToMetal(site, deps)
      if (restored.outcome === 'restored') {
        ok(`restored to metal in ${formatSeconds(restored.downtimeMs)}`)
      } else {
        failures++
        bad(`restore failed (${restored.code})`, restored.message)
      }
      results.push(restored)
      continue
    }

    const prepared = await prepareCutoverSite(site, deps, { readinessTimeoutMs: cli.readinessTimeoutMs })
    if (!prepared.ok) {
      failures++
      bad(`prepare failed (${prepared.code})`, prepared.message)
      results.push({
        projectId: site.projectId,
        subdomain: site.subdomain,
        dbBytes: 0,
        prepareMs: 0,
        downtimeMs: null,
        outcome: 'failed',
        code: prepared.code,
        message: prepared.message,
      })
      continue
    }
    ok(`prepare finished in ${formatSeconds(prepared.value.prepareMs)}`)

    const result = cli.rehearse
      ? await rehearseCutoverSite(prepared.value, deps, { readinessTimeoutMs: cli.readinessTimeoutMs })
      : await switchCutoverSite(prepared.value, deps, {
          maxDowntimeMs: cli.maxDowntimeMs,
          archiveTimeoutMs: cli.archiveTimeoutMs,
        })

    if (result.outcome === 'migrated' || result.outcome === 'rehearsed' || result.outcome === 'restored') {
      ok(`${result.outcome} in ${formatSeconds(result.downtimeMs)}`)
    } else {
      failures++
      bad(`${result.outcome} (${result.code})`, result.message)
      for (const m of result.mismatches ?? []) {
        info(`${m.table}: sqlite ${m.sqlite} → postgres ${m.postgres}${m.reason === 'missing_table' ? ' (missing)' : ''}`)
      }
    }
    results.push(result)
  }

  console.log('\n=== report ===\n')
  console.log('  site                              db size    prepare   downtime   result')
  for (const r of results) {
    console.log(
      `  ${r.subdomain.padEnd(32).slice(0, 32)} ${String(`${(r.dbBytes / 1024 / 1024).toFixed(1)}MB`).padEnd(10)} ` +
        `${String(formatSeconds(r.prepareMs)).padEnd(9)} ` +
        `${String(formatSeconds(r.downtimeMs)).padEnd(10)} ${r.outcome}`,
    )
  }

  const failed = results.filter(
    (r) => r.outcome === 'failed' || r.outcome === 'rolled-back',
  ).length
  console.log('')
  process.exit(failed > 0 ? 1 : 0)
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('\nFatal:', e)
    process.exit(1)
  })
}
