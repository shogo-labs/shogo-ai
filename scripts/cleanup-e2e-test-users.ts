// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cleanup script for ephemeral Playwright e2e test users.
 *
 * The hosted Playwright suite (e2e/staging/*.test.ts) signs up fresh
 * accounts on every run using addresses shaped like
 * `e2e-<prefix>-<timestamp>@mailnull.com`. That leaves ~200 test users
 * (plus their workspaces, projects, usage events, Stripe customers…)
 * in the production database every CI run, polluting analytics +
 * signup-attribution dashboards.
 *
 * This script:
 *   1. Finds users whose email matches `e2e-%@mailnull.com` and were
 *      created more than `--older-than-days` days ago (default 7).
 *   2. For each user, collects the workspaces where they are the sole
 *      member (orphan-after-delete candidates).
 *   3. Deletes users (cascades sessions/accounts/members/apiKeys/
 *      notifications/starredProjects/signupAttribution/creatorProfile).
 *   4. Deletes now-orphaned workspaces (cascades projects, billing,
 *      usage events, wallets).
 *
 * Safety:
 *   - Defaults to `--dry-run` — no writes unless you pass `--execute`.
 *   - Refuses to run if the workload count exceeds `--max-batch`
 *     (default 1000) to avoid runaway deletes.
 *   - Prints a summary line per user + workspace; pipe to a log file
 *     for audit trail.
 *
 * Run locally:
 *   DATABASE_URL=postgres://... bun scripts/cleanup-e2e-test-users.ts
 *   DATABASE_URL=postgres://... bun scripts/cleanup-e2e-test-users.ts --execute
 *   DATABASE_URL=postgres://... bun scripts/cleanup-e2e-test-users.ts --older-than-days 3 --execute
 *
 * Run in CI (nightly, against prod):
 *   - Ensure DATABASE_URL is the prod connection string (read-write).
 *   - Set --max-batch to a conservative number + --execute.
 *   - See .github/workflows/e2e-cleanup.yml.
 */

import { prisma } from "../apps/api/src/lib/prisma"

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const getArg = (flag: string) => {
  const idx = args.indexOf(flag)
  return idx !== -1 ? args[idx + 1] : undefined
}
const hasFlag = (flag: string) => args.includes(flag)

const execute = hasFlag("--execute")
const olderThanDays = parseInt(getArg("--older-than-days") || "7", 10)
const maxBatch = parseInt(getArg("--max-batch") || "1000", 10)
const emailPattern = getArg("--email-pattern") || "e2e-%@mailnull.com"

const mode = execute ? "EXECUTE" : "DRY-RUN"
// eslint-disable-next-line no-console
console.log(`[cleanup-e2e] mode=${mode} pattern=${emailPattern} olderThanDays=${olderThanDays} maxBatch=${maxBatch}`)

// ─── Main ────────────────────────────────────────────────────────────────────

interface UserRow {
  id: string
  email: string
  createdAt: Date
}

async function main() {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)

  const users = await prisma.user.findMany({
    where: {
      email: { contains: emailPattern.replace(/%/g, "") },
      createdAt: { lt: cutoff },
    },
    select: { id: true, email: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  })

  const matching = users.filter((u: UserRow) =>
    // Poor-man's wildcard — `contains` above is already narrow, but be
    // defensive about accidental matches like `notice-e2e-foo@…`.
    u.email.startsWith("e2e-") && u.email.endsWith("@mailnull.com"),
  )

  // eslint-disable-next-line no-console
  console.log(`[cleanup-e2e] matched ${matching.length} users (from ${users.length} candidates)`)

  if (matching.length > maxBatch) {
    // eslint-disable-next-line no-console
    console.error(
      `[cleanup-e2e] ABORT: matched ${matching.length} users which exceeds --max-batch=${maxBatch}. ` +
        `Re-run with --older-than-days <more-recent> or raise --max-batch if intentional.`,
    )
    process.exit(2)
  }

  if (matching.length === 0) {
    // eslint-disable-next-line no-console
    console.log("[cleanup-e2e] nothing to do.")
    return
  }

  // Collect candidate workspaces: any where *every* member is a match.
  const memberRows = await prisma.member.findMany({
    where: {
      userId: { in: matching.map((u: UserRow) => u.id) },
      workspaceId: { not: null },
    },
    select: { workspaceId: true },
  })
  const workspaceIds = Array.from(
    new Set(memberRows.map((m: { workspaceId: string | null }) => m.workspaceId).filter(Boolean) as string[]),
  )

  const allMembersForCandidateWorkspaces = await prisma.member.findMany({
    where: { workspaceId: { in: workspaceIds } },
    select: { workspaceId: true, userId: true },
  })
  const membersByWorkspace = new Map<string, Set<string>>()
  for (const m of allMembersForCandidateWorkspaces) {
    if (!m.workspaceId) continue
    if (!membersByWorkspace.has(m.workspaceId)) {
      membersByWorkspace.set(m.workspaceId, new Set())
    }
    membersByWorkspace.get(m.workspaceId)!.add(m.userId)
  }
  const matchingIds = new Set(matching.map((u: UserRow) => u.id))
  const orphanWorkspaces = workspaceIds.filter((wid) => {
    const members = membersByWorkspace.get(wid) ?? new Set()
    // Every member must be in the matching set.
    return [...members].every((uid) => matchingIds.has(uid))
  })

  // eslint-disable-next-line no-console
  console.log(
    `[cleanup-e2e] plan: delete ${matching.length} users + ${orphanWorkspaces.length} orphan workspaces`,
  )
  for (const u of matching.slice(0, 5)) {
    // eslint-disable-next-line no-console
    console.log(`  user: ${u.id}  ${u.email}  ${u.createdAt.toISOString()}`)
  }
  if (matching.length > 5) {
    // eslint-disable-next-line no-console
    console.log(`  … and ${matching.length - 5} more`)
  }

  if (!execute) {
    // eslint-disable-next-line no-console
    console.log("[cleanup-e2e] dry-run complete. Re-run with --execute to apply.")
    return
  }

  // Execute deletes. User cascade covers sessions/accounts/members/apiKeys/
  // notifications/starredProjects/signupAttribution/creatorProfile.
  // Workspace cascade covers projects/billing/usage events/wallets.
  let userDeletes = 0
  for (const u of matching) {
    try {
      await prisma.user.delete({ where: { id: u.id } })
      userDeletes++
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[cleanup-e2e] user delete failed for ${u.email}:`, err)
    }
  }

  let workspaceDeletes = 0
  for (const wid of orphanWorkspaces) {
    try {
      await prisma.workspace.delete({ where: { id: wid } })
      workspaceDeletes++
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[cleanup-e2e] workspace delete failed for ${wid}:`, err)
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[cleanup-e2e] done. deleted users=${userDeletes}/${matching.length} ` +
      `workspaces=${workspaceDeletes}/${orphanWorkspaces.length}`,
  )
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[cleanup-e2e] fatal:", err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
