// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * scripts/warm-pool-rescue.ts
 *
 * One-shot CLI to scan the warm-pool namespace for "promoted-but-orphaned"
 * ksvc — pods whose K8s metadata says they are assigned to a project but
 * whose runtime is still in pool mode (the failure mode that produced the
 * 184 stuck pods in staging on 2026-05-13).
 *
 * Default behaviour is a dry-run that prints what it WOULD do. Pass
 * `--apply` to actually evict (or `--apply --heal` to re-issue
 * /pool/assign instead of evicting).
 *
 * Designed to run inside a Job pod that has the `api-service-account`
 * ServiceAccount mounted (for K8s API + DB credentials) — see
 * infra/jobs/warm-pool-rescue.yaml.
 *
 *   bun run scripts/warm-pool-rescue.ts                  # dry-run (default)
 *   bun run scripts/warm-pool-rescue.ts --apply          # evict stuck pods
 *   bun run scripts/warm-pool-rescue.ts --apply --heal   # re-issue /pool/assign
 *   bun run scripts/warm-pool-rescue.ts --namespace shogo-staging-workspaces
 */

import { rescueStuckPromotedPods } from '../apps/api/src/lib/warm-pool-rescue'

interface ParsedArgs {
  namespace?: string
  apply: boolean
  heal: boolean
  help: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { apply: false, heal: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        args.help = true
        break
      case '--apply':
        args.apply = true
        break
      case '--heal':
        args.heal = true
        break
      case '--namespace':
      case '-n':
        args.namespace = argv[++i]
        break
      default:
        if (arg.startsWith('--namespace=')) {
          args.namespace = arg.slice('--namespace='.length)
        } else {
          console.error(`[warm-pool-rescue] Unknown argument: ${arg}`)
          process.exit(2)
        }
    }
  }
  return args
}

function printHelp(): void {
  console.log(`
Usage: bun run scripts/warm-pool-rescue.ts [OPTIONS]

Scan the warm-pool namespace for promoted ksvc whose runtime is still in pool
mode and recover them. Dry-run by default.

Options:
  --namespace, -n NS     Namespace to scan (default: env PROJECT_NAMESPACE
                         or 'shogo-workspaces').
  --apply                Actually mutate state. Without this, prints what it
                         would do.
  --heal                 With --apply, re-issue POST /pool/assign instead of
                         hard-evicting. Only safe once pods support
                         /api/internal/whoami self-discovery.
  -h, --help             Show this help.

Examples:
  bun run scripts/warm-pool-rescue.ts -n shogo-staging-workspaces
  bun run scripts/warm-pool-rescue.ts -n shogo-staging-workspaces --apply
`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    printHelp()
    process.exit(0)
  }

  const namespace = args.namespace
    ?? process.env.PROJECT_NAMESPACE
    ?? 'shogo-workspaces'
  const dryRun = !args.apply
  const mode = args.heal ? 'heal' : 'evict'

  console.log(`[warm-pool-rescue] namespace=${namespace} dryRun=${dryRun} mode=${mode}`)

  const summary = await rescueStuckPromotedPods({
    namespace,
    dryRun,
    mode,
  })

  console.log('')
  console.log('=== Scan summary ===')
  console.log(`scanned: ${summary.scanned}`)
  console.log(`stuck:   ${summary.stuck}`)
  console.log(`evicted: ${summary.evicted}`)
  console.log(`healed:  ${summary.healed}`)
  console.log(`errors:  ${summary.errors}`)

  if (summary.stuck > 0) {
    console.log('')
    console.log('=== Stuck pods ===')
    for (const e of summary.entries) {
      if (!e.stuckInPoolMode && !e.error) continue
      const status = e.error
        ? `error: ${e.error}`
        : e.action
          ? `action: ${e.action}${e.actionError ? ` (failed: ${e.actionError})` : ''}`
          : 'would-mutate'
      console.log(`  ${e.serviceName} (project=${e.projectId ?? 'unknown'}) ${status}`)
    }
  }

  // Non-zero exit if any errors so the Job's restartPolicy: OnFailure can
  // surface a regression in the dashboard. Stuck pods that we successfully
  // recovered do not count as errors.
  process.exit(summary.errors > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('[warm-pool-rescue] FATAL:', err?.stack || err?.message || err)
  process.exit(1)
})
