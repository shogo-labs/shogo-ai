// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Ephemeral Playwright accounts (`e2e/staging/*.test.ts`).
 *
 * Every hosted e2e run signs up throwaway users shaped like
 * `e2e-<prefix>-<timestamp>@mailnull.com`. Left alone they pile up: on staging
 * they were 97% of the runtimes a rootfs pre-warm tried to boot. This module is
 * the one definition of "an e2e account" and the one way to delete one.
 */

import { prisma as defaultPrisma } from '../lib/prisma'

type Db = typeof defaultPrisma
type Logger = Pick<Console, 'log' | 'warn'>

/** True for the e2e signup shape. The prefix check keeps real mailnull users out. */
export function isE2eTestEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const e = email.toLowerCase()
  return e.startsWith('e2e-') && e.endsWith('@mailnull.com')
}

/**
 * The workspaces among `workspaceIds` whose every member is an e2e account. A
 * workspace with no members is never included: nothing proves it is a test one.
 */
export async function e2eOnlyWorkspaceIds(workspaceIds: string[], db: Db = defaultPrisma): Promise<Set<string>> {
  const ids = [...new Set(workspaceIds.filter(Boolean))]
  const out = new Set<string>()
  for (let i = 0; i < ids.length; i += 500) {
    const members = await db.member.findMany({
      where: { workspaceId: { in: ids.slice(i, i + 500) } },
      select: { workspaceId: true, user: { select: { email: true } } },
    })
    const real = new Set<string>()
    const seen = new Set<string>()
    for (const m of members) {
      if (!m.workspaceId) continue
      seen.add(m.workspaceId)
      if (!isE2eTestEmail(m.user?.email)) real.add(m.workspaceId)
    }
    for (const id of seen) if (!real.has(id)) out.add(id)
  }
  return out
}

export interface E2eCleanupResult {
  users: number
  workspaces: number
  projects: number
  failed: string[]
}

/**
 * Delete e2e users and every workspace only e2e users belong to. Each project in
 * those workspaces has its runtime torn down first, like a user delete does, so
 * no ksvc or metal snapshot outlives its rows. Non-e2e users are skipped.
 */
export async function deleteE2eTestUsers(
  userIds: string[],
  opts: {
    db?: Db
    destroyRuntime?: (projectId: string) => Promise<void>
    logger?: Logger
  } = {},
): Promise<E2eCleanupResult> {
  const db = opts.db ?? defaultPrisma
  const logger = opts.logger ?? console
  const destroyRuntime = opts.destroyRuntime ?? defaultDestroyRuntime
  const result: E2eCleanupResult = { users: 0, workspaces: 0, projects: 0, failed: [] }

  const users = (
    await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
  ).filter((u) => isE2eTestEmail(u.email))
  if (users.length === 0) return result

  const memberships = await db.member.findMany({
    where: { userId: { in: users.map((u) => u.id) }, workspaceId: { not: null } },
    select: { workspaceId: true },
  })
  const workspaces = [...(await e2eOnlyWorkspaceIds(memberships.map((m) => m.workspaceId as string), db))]

  for (const workspaceId of workspaces) {
    const projects = await db.project.findMany({ where: { workspaceId }, select: { id: true } })
    for (const p of projects) {
      await destroyRuntime(p.id).catch((err: any) =>
        logger.warn(`[e2e-cleanup] runtime teardown for ${p.id} failed: ${err?.message ?? err}`),
      )
    }
    try {
      await db.workspace.delete({ where: { id: workspaceId } })
      result.workspaces++
      result.projects += projects.length
    } catch (err: any) {
      result.failed.push(`workspace:${workspaceId}`)
      logger.warn(`[e2e-cleanup] workspace delete failed for ${workspaceId}: ${err?.message ?? err}`)
    }
  }

  for (const u of users) {
    try {
      await db.user.delete({ where: { id: u.id } })
      result.users++
    } catch (err: any) {
      result.failed.push(`user:${u.id}`)
      logger.warn(`[e2e-cleanup] user delete failed for ${u.email}: ${err?.message ?? err}`)
    }
  }
  return result
}

async function defaultDestroyRuntime(projectId: string): Promise<void> {
  if (process.env.SHOGO_LOCAL_MODE === 'true') return
  const { destroyProjectRuntime } = await import('../lib/substrate')
  await destroyProjectRuntime(projectId)
}
