// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * migrate-publishing-to-metal.ts
 *
 * One-shot cutover that makes the METAL substrate authoritative for EXISTING
 * published sites. New publishes already land on metal once the fleet is enabled
 * (see isPublishMetalAuthoritative / getPublishSubstrate); this backfills the
 * sites that were published while Knative still owned publishing.
 *
 * What a migration actually IS here (why it's cheap + reversible):
 *   - Static apps already serve edge-only (PUBLISH_BUCKET + the *.shogo.one
 *     Worker) on BOTH substrates — there is nothing runtime-side to move. Their
 *     SERVER_BACKED edge flag is absent; the only leftover is a possible dormant
 *     nginx `published-{id}` ksvc from the pre-edge-only era.
 *   - Server-backed apps are cut over by flipping the SERVER_BACKED edge flag
 *     from `knative` → `metal`. That re-points the Worker's `/api/*` proxy at the
 *     API published endpoint, which resolves (and lazily BOOTS, scale-to-zero
 *     style) the project's `published:{id}` microVM on the next request. The
 *     writable state (`{subdomain}/data.tar.gz`) already lives in the shared
 *     PUBLISH_DATA_BUCKET, so the metal host hydrates it host-side on cold boot —
 *     no data copy is needed.
 *
 * We do NOT boot metal VMs from this script: the warm-pool controller's host
 * fleet is registered in the live API process (in-memory), not in a standalone
 * job. Flipping the flag is enough — the first visitor (or the wake endpoint)
 * boots the VM in-process. Always-on apps warm on their first request.
 *
 * Reversibility: the flag flip is the whole cutover. To roll back, set
 * `PUBLISH_SUBSTRATE=knative` on the API and re-run with `--to knative` (or
 * flip the KV back), and the dormant Knative ksvc serves again — UNLESS you
 * passed `--teardown-knative`, which deletes the ksvc + DomainMapping. Keep the
 * Knative side until you're confident; teardown is the final decommission step.
 *
 * Required env (same vars the api ksvc reads):
 *   DATABASE_URL                        — to list published projects.
 *   CF_API_TOKEN (or CF_CUSTOM_HOSTNAMES_TOKEN), CF_ACCOUNT_ID,
 *   CF_SERVER_BACKED_KV_NAMESPACE_ID    — to read/flip the SERVER_BACKED flag.
 *                                         Without these the routing flip is
 *                                         impossible and the script aborts.
 *   PROJECT_NAMESPACE                   — only when --teardown-knative (to reach
 *                                         the published ksvc/DomainMapping).
 *
 * Usage:
 *   bun apps/api/scripts/migrate-publishing-to-metal.ts --dry-run
 *   bun apps/api/scripts/migrate-publishing-to-metal.ts --yes
 *   bun apps/api/scripts/migrate-publishing-to-metal.ts --yes --teardown-knative
 *   bun apps/api/scripts/migrate-publishing-to-metal.ts --project-id <uuid> --yes
 *
 * Flags:
 *   --dry-run            Print the plan; make no changes (default when neither
 *                        --dry-run nor --yes is given).
 *   --yes                Actually apply the changes (required to mutate).
 *   --project-id <uuid>  Migrate a single project (repeatable).
 *   --limit <n>          Cap the number of projects processed.
 *   --to metal|knative   Target backend for the flag (default metal). `knative`
 *                        is the rollback direction.
 *   --teardown-knative   Also delete the dormant published ksvc + DomainMapping
 *                        (irreversible for that site's Knative runtime).
 *
 * Exit code 0 when all processed sites succeed, 1 if any failed.
 */

import { prisma } from '../src/lib/prisma'
import {
  getServerBackedKvConfig,
  getServerBackedBackend,
  setServerBackedFlag,
  clearServerBackedFlag,
  type ServerBackedBackend,
} from '../src/lib/cloudflare-server-backed-kv'
import { isPublishMetalAuthoritative } from '../src/lib/publish-substrate-config'

interface Cli {
  apply: boolean
  projectIds: string[]
  limit?: number
  to: ServerBackedBackend
  teardownKnative: boolean
}

function parseArgs(argv: string[]): Cli {
  let apply = false
  let dryRun = false
  const projectIds: string[] = []
  let limit: number | undefined
  let to: ServerBackedBackend = 'metal'
  let teardownKnative = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--yes' || a === '--apply') apply = true
    else if (a === '--dry-run') dryRun = true
    else if (a === '--project-id') projectIds.push(argv[++i])
    else if (a === '--limit') limit = Math.max(0, parseInt(argv[++i], 10) || 0)
    else if (a === '--to') {
      const next = (argv[++i] || '').toLowerCase()
      if (next !== 'metal' && next !== 'knative') throw new Error('--to must be metal|knative')
      to = next
    } else if (a === '--teardown-knative') teardownKnative = true
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: migrate-publishing-to-metal.ts [--dry-run|--yes] [--project-id <uuid>]... ' +
          '[--limit <n>] [--to metal|knative] [--teardown-knative]',
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown arg: ${a}`)
    }
  }
  // Default to a dry run unless the operator explicitly opts in with --yes, so a
  // bare invocation can never mutate routing by accident.
  if (dryRun) apply = false
  return { apply, projectIds, limit, to, teardownKnative }
}

// Tiny colorized loggers (match validate-custom-domains.ts style).
function ok(label: string, detail?: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
}
function warn(label: string, detail?: string) {
  console.log(`  \x1b[33m!\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
}
function bad(label: string, detail?: string) {
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
}
function info(msg: string) {
  console.log(`  \x1b[2m·\x1b[0m ${msg}`)
}

/**
 * Best-effort teardown of a site's dormant Knative published runtime (ksvc +
 * DomainMapping). Never throws — a leftover is a cost/cleanliness issue, not a
 * correctness one once the edge flag points at metal.
 */
async function teardownKnativePublished(projectId: string, subdomain: string): Promise<void> {
  const { getKnativeProjectManager } = await import('../src/lib/knative-project-manager')
  const manager = getKnativeProjectManager()
  await manager.deletePublishedDomainMapping(subdomain).catch((e: any) =>
    warn(`deletePublishedDomainMapping(${subdomain}) failed (non-fatal)`, e?.message ?? String(e)),
  )
  await manager.deletePublishedService(projectId).catch((e: any) =>
    warn(`deletePublishedService(${projectId}) failed (non-fatal)`, e?.message ?? String(e)),
  )
}

async function main() {
  const cli = parseArgs(process.argv.slice(2))

  console.log('\n=== publishing → metal cutover ===\n')
  console.log(cli.apply ? '  MODE: APPLY (mutating)\n' : '  MODE: DRY-RUN (no changes)\n')

  // 1. Preflight: the SERVER_BACKED KV is the routing switch. Without it we
  //    cannot flip anything — abort loudly rather than silently no-op.
  if (!getServerBackedKvConfig()) {
    bad(
      'SERVER_BACKED KV is not configured',
      'set CF_API_TOKEN (or CF_CUSTOM_HOSTNAMES_TOKEN) + CF_ACCOUNT_ID + CF_SERVER_BACKED_KV_NAMESPACE_ID',
    )
    process.exit(1)
  }
  ok('SERVER_BACKED KV configured')

  // 2. Sanity: forward cutover expects publishing to be metal-authoritative on
  //    the API (so wake/republish target metal too). Warn but proceed — the KV
  //    flip alone re-points live traffic; the API config just needs to match.
  if (cli.to === 'metal' && !isPublishMetalAuthoritative()) {
    warn(
      'publishing is NOT metal-authoritative on this env',
      "set SHOGO_METAL_ENABLED=true (or PUBLISH_SUBSTRATE=metal) on the API so wake/republish also target metal",
    )
  } else if (cli.to === 'metal') {
    ok('publishing is metal-authoritative on this env')
  }
  if (cli.teardownKnative && !process.env.PROJECT_NAMESPACE) {
    bad('--teardown-knative needs PROJECT_NAMESPACE to reach the published ksvc/DomainMapping')
    process.exit(1)
  }

  // 3. Gather published projects.
  const where: any = { publishedSubdomain: { not: null } }
  if (cli.projectIds.length) where.id = { in: cli.projectIds }
  const projects = (await prisma.project.findMany({
    where,
    select: {
      id: true,
      publishedSubdomain: true,
      publishedAlwaysOn: true,
      publishStatus: true,
    } as any,
    orderBy: { publishedAt: 'asc' },
    ...(cli.limit ? { take: cli.limit } : {}),
  })) as Array<{ id: string; publishedSubdomain: string; publishedAlwaysOn?: boolean; publishStatus?: string }>

  console.log(`\nFound ${projects.length} published project(s)${cli.limit ? ` (capped at ${cli.limit})` : ''}.\n`)

  const counts = {
    flipped: 0, // server-backed knative → metal (or metal → knative on rollback)
    alreadyTarget: 0, // KV already on the requested backend
    static: 0, // no flag (edge-only) — nothing to route-flip
    tornDown: 0, // dormant Knative published runtime removed
    failed: 0,
  }

  for (const p of projects) {
    const subdomain = p.publishedSubdomain
    const tag = `${subdomain} (${p.id.slice(0, 8)})`
    console.log(`\n${tag}${p.publishedAlwaysOn ? ' [always-on]' : ''}`)

    let current: ServerBackedBackend | null
    try {
      current = await getServerBackedBackend(subdomain)
    } catch (e: any) {
      counts.failed++
      bad('could not read SERVER_BACKED flag', e?.message ?? String(e))
      continue
    }

    // Static / edge-only: no flag to flip. Optionally sweep a stale ksvc.
    if (current === null) {
      counts.static++
      info('static (edge-only) — no SERVER_BACKED flag; nothing to route-flip')
      if (cli.teardownKnative) {
        if (cli.apply) {
          await teardownKnativePublished(p.id, subdomain)
          counts.tornDown++
          ok('swept any dormant Knative published runtime')
        } else {
          info('would sweep any dormant Knative published runtime (--teardown-knative)')
        }
      }
      continue
    }

    if (current === cli.to) {
      counts.alreadyTarget++
      ok(`already on ${cli.to}`)
      // Even when already migrated, honor an explicit teardown request.
      if (cli.teardownKnative && cli.to === 'metal') {
        if (cli.apply) {
          await teardownKnativePublished(p.id, subdomain)
          counts.tornDown++
          ok('removed dormant Knative published runtime')
        } else {
          info('would remove dormant Knative published runtime (--teardown-knative)')
        }
      }
      continue
    }

    // Needs a flip: server-backed on the OTHER backend.
    if (!cli.apply) {
      info(`would flip SERVER_BACKED ${current} → ${cli.to}`)
      if (cli.teardownKnative && cli.to === 'metal') info('would remove dormant Knative published runtime')
      continue
    }

    try {
      const set = await setServerBackedFlag(subdomain, cli.to)
      if (!set) throw new Error('KV write returned false')
      counts.flipped++
      ok(`flipped SERVER_BACKED ${current} → ${cli.to}`)
    } catch (e: any) {
      counts.failed++
      bad('KV flip failed', e?.message ?? String(e))
      continue
    }

    // Only tear down Knative AFTER the edge points at metal, so a flip that
    // fails never leaves a site with no backend.
    if (cli.teardownKnative && cli.to === 'metal') {
      await teardownKnativePublished(p.id, subdomain)
      counts.tornDown++
      ok('removed dormant Knative published runtime')
    }
  }

  console.log('\n=== summary ===')
  console.log(`  flipped to ${cli.to}:      ${counts.flipped}`)
  console.log(`  already on ${cli.to}:      ${counts.alreadyTarget}`)
  console.log(`  static (edge-only):        ${counts.static}`)
  if (cli.teardownKnative) console.log(`  Knative torn down:         ${counts.tornDown}`)
  console.log(`  failed:                    ${counts.failed}`)
  if (!cli.apply) console.log('\n  (dry run — re-run with --yes to apply)')

  return counts.failed === 0
}

main()
  .then((success) => {
    console.log(
      success
        ? '\n\x1b[32mDONE\x1b[0m — publishing cutover complete.\n'
        : '\n\x1b[31mFAIL\x1b[0m — one or more sites failed to migrate (see above).\n',
    )
    return prisma.$disconnect().finally(() => process.exit(success ? 0 : 1))
  })
  .catch(async (err) => {
    console.error('\n\x1b[31mFATAL\x1b[0m', err)
    await prisma.$disconnect().catch(() => {})
    process.exit(1)
  })
