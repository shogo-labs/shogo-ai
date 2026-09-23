// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import crypto from 'node:crypto'
import { auth } from '../auth'
import { prisma } from './prisma'
import { createPaidWorkspace, createPersonalWorkspace, getUserOwnedWorkspaceCount } from '../services/workspace.service'

/** Restore persisted provider settings and seed the single local user. */
export async function bootstrapLocalDatabase(): Promise<void> {
  const localDb = prisma as any
  try {
    const savedConfig = await localDb.localConfig.findMany({})
    for (const row of savedConfig) {
      if (row.key === 'SHOGO_CLOUD_URL') {
        await localDb.localConfig.deleteMany({ where: { key: row.key } }).catch(() => {})
        continue
      }
      if (!process.env[row.key]) process.env[row.key] = row.value
    }
  } catch (err: any) {
    console.warn('[LocalMode] Could not restore local config:', err?.message ?? err)
  }

  // Find (or create) the single local user. Unlike the cloud signup path,
  // desktop has no "Create new workspace" UI at all (`create-local-app.ts`
  // intentionally excludes the generic workspace CRUD routes that carry
  // `workspaceHooks`, to keep the desktop bundle tree-shakeable) — so a
  // local user can never reach the flow that would give them a second
  // workspace of either kind. We seed whichever kind(s) they're missing
  // below, keeping this in sync with the cloud rule that every account gets
  // one free workspace of *each* kind.
  let localUserId: string | null = null
  try {
    const existingUser = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } })
    if (existingUser) {
      localUserId = existingUser.id
    } else {
      const password = crypto.randomBytes(24).toString('base64')
      const response = await auth.api.signUpEmail({
        body: {
          name: process.env.SHOGO_LOCAL_USER_NAME || 'Local User',
          email: process.env.SHOGO_LOCAL_USER_EMAIL || 'local@shogo.local',
          password,
        },
      })
      if (response?.user) {
        localUserId = response.user.id
        await localDb.localConfig.upsert({
          where: { key: 'local_user_password' },
          update: { value: password },
          create: { key: 'local_user_password', value: password },
        })
      }
    }
  } catch (err: any) {
    console.error('[LocalMode] Failed to auto-seed user:', err?.message ?? err)
  }

  // Backfill whichever free workspace kind the user is missing. Runs on
  // every boot (not just fresh installs), so upgrades from an older build
  // get caught up too — and we can't assume which kind an old install
  // already has:
  //   - The very first local-mode builds predate `createPersonalWorkspace`
  //     being wired into the signup hook at all, so their one-and-only
  //     workspace was created with the schema default, `kind: 'team'`
  //     (see `Workspace.kind @default(team)`), leaving them with *no*
  //     personal workspace — the mirror image of the cloud
  //     personal-workspace-foundation migration's fallout (see
  //     `createPersonalWorkspace`'s slug-collision comment above).
  //   - Newer builds's signup hook creates `kind: 'personal'` up front, so
  //     those users are only ever missing the `team` workspace.
  // Checking both counts independently (instead of assuming one already
  // exists) handles either history correctly, and is a no-op once a user
  // has both.
  if (localUserId) {
    const user = await prisma.user.findUnique({ where: { id: localUserId }, select: { name: true } })
    const userName = user?.name || 'Local User'

    try {
      const ownedPersonalCount = await getUserOwnedWorkspaceCount(localUserId, 'personal')
      if (ownedPersonalCount === 0) {
        await createPersonalWorkspace(localUserId, userName)
        console.log('[LocalMode] Seeded personal workspace for local user')
      }
    } catch (err: any) {
      console.error('[LocalMode] Failed to seed personal workspace:', err?.message ?? err)
    }

    try {
      const ownedTeamCount = await getUserOwnedWorkspaceCount(localUserId, 'team')
      if (ownedTeamCount === 0) {
        await createPaidWorkspace(localUserId, `${userName} Team`)
        console.log('[LocalMode] Seeded team workspace for local user')
      }
    } catch (err: any) {
      console.error('[LocalMode] Failed to seed team workspace:', err?.message ?? err)
    }
  }
}
