// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * transfer-official-creator-to-admin.ts
 *
 * One-shot data migration that moves ownership of every first-party
 * Shogo template (the "Built for Shogo" rail in the marketplace) from
 * the auto-seeded synthetic `shogo-official@shogo.ai` user onto the
 * real `admin@shogo.ai` account so an operator can manage those
 * listings (publish/unpublish, push versions, etc.) from a normal
 * sign-in session.
 *
 * Replaces the previous `migrate-templates-to-marketplace.ts` boot
 * seed for the purpose of who-owns-what. After this runs and the boot
 * seed is removed, restarts cannot re-introduce a parallel
 * `shogo-official` owner.
 *
 * Pointer rewrites performed (in order, inside a single transaction):
 *   1. `CreatorProfile.userId`: moved from the old user to admin.
 *      - If admin already has a CreatorProfile, the listings / badges /
 *        transactions / follows are re-pointed at admin's profile and
 *        the old profile row is deleted instead. Refuses to proceed if
 *        both profiles have Stripe Connect ids (manual review needed —
 *        you don't want to silently strand a payout account).
 *   2. `Project.createdBy` on every `template-<id>` row: rewritten to
 *      admin's user id so the source projects look like admin made
 *      them.
 *   3. `Member { userId: shogo-official.id, workspaceId: shogo-official.ws }`:
 *      replaced by an admin-as-owner membership in the same workspace.
 *   4. `User { email: 'shogo-official@shogo.ai' }`: deleted. Cascade
 *      handles any remaining membership / session / api-key rows
 *      attached to the synthetic user.
 *
 * Idempotency:
 *   - If the old user is already gone, exits cleanly with "already
 *     migrated".
 *   - If the CreatorProfile is already on admin, only the project /
 *     membership / user-delete steps run (each guarded by a
 *     pre-check).
 *
 * Safety order: cascade rules on CreatorProfile.userId would wipe
 * every MarketplaceListing if we deleted the synthetic user before
 * moving the profile, so the user delete is the LAST step and runs
 * inside the same transaction as the reassignments.
 *
 * Usage:
 *   bun apps/api/scripts/transfer-official-creator-to-admin.ts
 *   bun apps/api/scripts/transfer-official-creator-to-admin.ts --dry-run
 */

import { prisma } from '../src/lib/prisma'

const ADMIN_EMAIL = 'admin@shogo.ai'
const OFFICIAL_EMAIL = 'shogo-official@shogo.ai'
const OFFICIAL_WORKSPACE_SLUG = 'shogo-official'

interface RunTransferOptions {
  dryRun?: boolean
  quiet?: boolean
}

interface TransferStats {
  oldUserFound: boolean
  oldProfileFound: boolean
  adminProfileFound: boolean
  /** 'move' = reassigned existing profile to admin. 'merge' = collapsed into pre-existing admin profile. 'noop' = no profile change. */
  profileStrategy: 'move' | 'merge' | 'noop'
  listingsRepointed: number
  badgesRepointed: number
  transactionsRepointed: number
  followsRepointed: number
  oldProfileDeleted: boolean
  projectsRewritten: number
  workspaceMembershipUpserted: boolean
  oldMembershipsDeleted: number
  oldUserDeleted: boolean
}

function emptyStats(): TransferStats {
  return {
    oldUserFound: false,
    oldProfileFound: false,
    adminProfileFound: false,
    profileStrategy: 'noop',
    listingsRepointed: 0,
    badgesRepointed: 0,
    transactionsRepointed: 0,
    followsRepointed: 0,
    oldProfileDeleted: false,
    projectsRewritten: 0,
    workspaceMembershipUpserted: false,
    oldMembershipsDeleted: 0,
    oldUserDeleted: false,
  }
}

/**
 * Workhorse. Returns per-step counts so the CLI wrapper can print a
 * before/after summary that an operator can sanity-check against the
 * dry-run output.
 *
 * Wraps every write in `prisma.$transaction(async (tx) => …)` so a
 * mid-migration failure leaves the DB in its pre-run state. Dry-run
 * uses the same transaction skeleton but routes every mutating call
 * through a `count`-only path.
 */
export async function runTransfer(
  opts: RunTransferOptions = {},
): Promise<TransferStats> {
  const { dryRun = false, quiet = false } = opts
  const log = (msg: string) => {
    if (!quiet) console.log(`[transfer-official] ${msg}`)
  }

  log(dryRun ? 'starting (DRY RUN — no writes)' : 'starting')

  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } })
  if (!admin) {
    throw new Error(
      `Refusing to run: admin user '${ADMIN_EMAIL}' does not exist. ` +
      `Create the account via the normal signup flow first.`,
    )
  }
  log(`admin user id=${admin.id}`)

  const oldUser = await prisma.user.findUnique({ where: { email: OFFICIAL_EMAIL } })
  if (!oldUser) {
    log(`old user '${OFFICIAL_EMAIL}' not found — already migrated, exiting`)
    return emptyStats()
  }
  log(`old synthetic user id=${oldUser.id}`)

  if (oldUser.id === admin.id) {
    // Shouldn't happen unless the emails were swapped on a single row,
    // but guard against accidental self-delete.
    throw new Error(
      `Old user and admin user resolved to the same id (${admin.id}); refusing to delete.`,
    )
  }

  const oldProfile = await prisma.creatorProfile.findUnique({
    where: { userId: oldUser.id },
  })
  const adminProfile = await prisma.creatorProfile.findUnique({
    where: { userId: admin.id },
  })

  const stats = emptyStats()
  stats.oldUserFound = true
  stats.oldProfileFound = oldProfile != null
  stats.adminProfileFound = adminProfile != null

  if (oldProfile && adminProfile && oldProfile.id !== adminProfile.id) {
    if (oldProfile.stripeCustomAccountId && adminProfile.stripeCustomAccountId) {
      throw new Error(
        `Both creator profiles have Stripe Connect accounts ` +
        `(old=${oldProfile.stripeCustomAccountId}, admin=${adminProfile.stripeCustomAccountId}). ` +
        `Resolve manually before re-running this script.`,
      )
    }
  }

  // The shogo-official workspace may or may not still exist (depends
  // on whether the boot seed has run against this DB). Either way, we
  // only touch its membership row if the workspace is present.
  const oldWorkspace = await prisma.workspace.findUnique({
    where: { slug: OFFICIAL_WORKSPACE_SLUG },
  })

  // Count-only previews for the dry-run path. We compute these
  // up-front so dry-run output mirrors the production write path.
  const templateProjectsToRewrite = await prisma.project.count({
    where: { createdBy: oldUser.id, id: { startsWith: 'template-' } },
  })
  const oldUserMembershipsInOldWs = oldWorkspace
    ? await prisma.member.count({
        where: { userId: oldUser.id, workspaceId: oldWorkspace.id },
      })
    : 0
  const oldUserMembershipsAnywhere = await prisma.member.count({
    where: { userId: oldUser.id },
  })

  log(`creator profile state: old=${!!oldProfile} admin=${!!adminProfile}`)
  log(`template-* projects to rewrite createdBy on: ${templateProjectsToRewrite}`)
  log(
    `old user memberships in shogo-official workspace: ${oldUserMembershipsInOldWs} ` +
    `(total across all workspaces: ${oldUserMembershipsAnywhere} — extras will cascade on user delete)`,
  )

  if (dryRun) {
    const listingsCount = oldProfile
      ? await prisma.marketplaceListing.count({ where: { creatorId: oldProfile.id } })
      : 0
    const badgesCount = oldProfile
      ? await prisma.creatorBadge.count({ where: { creatorId: oldProfile.id } })
      : 0
    const txCount = oldProfile
      ? await prisma.marketplaceTransaction.count({ where: { creatorId: oldProfile.id } })
      : 0
    const followsCount = oldProfile
      ? await prisma.creatorFollow.count({ where: { creatorId: oldProfile.id } })
      : 0

    stats.profileStrategy =
      !oldProfile ? 'noop' : !adminProfile ? 'move' : 'merge'
    stats.listingsRepointed = stats.profileStrategy === 'merge' ? listingsCount : 0
    stats.badgesRepointed = stats.profileStrategy === 'merge' ? badgesCount : 0
    stats.transactionsRepointed = stats.profileStrategy === 'merge' ? txCount : 0
    stats.followsRepointed = stats.profileStrategy === 'merge' ? followsCount : 0
    stats.oldProfileDeleted = stats.profileStrategy === 'merge'
    stats.projectsRewritten = templateProjectsToRewrite
    stats.workspaceMembershipUpserted = !!oldWorkspace
    stats.oldMembershipsDeleted = oldUserMembershipsAnywhere
    stats.oldUserDeleted = true

    log(`DRY RUN — planned profile strategy: ${stats.profileStrategy}`)
    log(`DRY RUN — would repoint listings=${stats.listingsRepointed} badges=${stats.badgesRepointed} tx=${stats.transactionsRepointed} follows=${stats.followsRepointed}`)
    log(`DRY RUN — would delete old profile: ${stats.oldProfileDeleted}`)
    log(`DRY RUN — would rewrite ${stats.projectsRewritten} project rows`)
    log(`DRY RUN — would upsert admin membership in shogo-official workspace: ${stats.workspaceMembershipUpserted}`)
    log(`DRY RUN — would delete synthetic user (cascading ${stats.oldMembershipsDeleted} membership rows)`)
    return stats
  }

  await prisma.$transaction(async (tx) => {
    if (oldProfile && !adminProfile) {
      await tx.creatorProfile.update({
        where: { id: oldProfile.id },
        data: { userId: admin.id },
      })
      stats.profileStrategy = 'move'
      log(`moved CreatorProfile ${oldProfile.id} userId → ${admin.id}`)
    } else if (oldProfile && adminProfile) {
      const repointListings = await tx.marketplaceListing.updateMany({
        where: { creatorId: oldProfile.id },
        data: { creatorId: adminProfile.id },
      })
      const repointBadges = await tx.creatorBadge.updateMany({
        where: { creatorId: oldProfile.id },
        data: { creatorId: adminProfile.id },
      })
      const repointTx = await tx.marketplaceTransaction.updateMany({
        where: { creatorId: oldProfile.id },
        data: { creatorId: adminProfile.id },
      })
      const repointFollows = await tx.creatorFollow.updateMany({
        where: { creatorId: oldProfile.id },
        data: { creatorId: adminProfile.id },
      })
      stats.listingsRepointed = repointListings.count
      stats.badgesRepointed = repointBadges.count
      stats.transactionsRepointed = repointTx.count
      stats.followsRepointed = repointFollows.count

      await tx.creatorProfile.delete({ where: { id: oldProfile.id } })
      stats.oldProfileDeleted = true
      stats.profileStrategy = 'merge'
      log(
        `merged: listings=${repointListings.count} badges=${repointBadges.count} ` +
        `tx=${repointTx.count} follows=${repointFollows.count}, ` +
        `deleted old profile ${oldProfile.id}`,
      )
    } else {
      stats.profileStrategy = 'noop'
      log(`no CreatorProfile on old user — skipping profile step`)
    }

    const projectsUpdate = await tx.project.updateMany({
      where: { createdBy: oldUser.id, id: { startsWith: 'template-' } },
      data: { createdBy: admin.id },
    })
    stats.projectsRewritten = projectsUpdate.count
    log(`rewrote Project.createdBy on ${projectsUpdate.count} template-* rows`)

    if (oldWorkspace) {
      // Member has no compound unique on (userId, workspaceId), so we
      // can't use upsert — fall back to findFirst + create. The old
      // user's membership rows in this workspace will cascade away
      // with the user delete below, so no explicit delete is needed.
      const existingAdminMembership = await tx.member.findFirst({
        where: { userId: admin.id, workspaceId: oldWorkspace.id },
      })
      if (!existingAdminMembership) {
        await tx.member.create({
          data: {
            userId: admin.id,
            workspaceId: oldWorkspace.id,
            role: 'owner',
          },
        })
        stats.workspaceMembershipUpserted = true
        log(`added admin as owner of workspace ${oldWorkspace.id} (${OFFICIAL_WORKSPACE_SLUG})`)
      } else {
        stats.workspaceMembershipUpserted = true
        log(`admin already a member of workspace ${oldWorkspace.id} — leaving role unchanged`)
      }
    } else {
      log(`shogo-official workspace not present — skipping membership step`)
    }

    // Recount memberships inside the txn so the stat reflects exactly
    // what's about to cascade. Anything still on the old user (in any
    // workspace) will be cascade-deleted by the user.delete below.
    stats.oldMembershipsDeleted = await tx.member.count({
      where: { userId: oldUser.id },
    })

    await tx.user.delete({ where: { id: oldUser.id } })
    stats.oldUserDeleted = true
    log(`deleted synthetic user ${oldUser.id} (cascaded ${stats.oldMembershipsDeleted} member rows)`)
  })

  log('done')
  return stats
}

if (import.meta.main) {
  const dryRun = process.argv.includes('--dry-run')
  runTransfer({ dryRun })
    .then((stats) => {
      console.log('[transfer-official] summary:', JSON.stringify(stats, null, 2))
    })
    .then(() => prisma.$disconnect())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('[transfer-official] failed:', err)
      await prisma.$disconnect().catch(() => undefined)
      process.exit(1)
    })
}
