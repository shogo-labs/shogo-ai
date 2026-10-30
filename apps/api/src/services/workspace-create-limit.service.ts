// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one-free-workspace-of-each-kind rule, in one place.
 *
 * Two things create a top-level workspace on the cloud: `POST /api/workspaces`
 * (through `workspaceHooks.beforeCreate`) and `initTargetWorkspace`, which the
 * receiving side of a move calls. The second one used to write the row straight
 * through Prisma, so any signed-in account could mint unlimited `team`
 * workspaces by calling `/api/workspace-moves/receive/init` (SHO-256). Two
 * copies of the rule is how one of them drifts, so both call this.
 *
 * A refusal carries the code and message the create flow already shows, so
 * whichever path refuses, the composer renders the same thing.
 */

import { getUserOwnedWorkspaceCount } from './workspace.service'

export type OwnedWorkspaceKind = 'personal' | 'team'

export interface WorkspaceCreateRefusal {
  ok: false
  error: { code: 'workspace_limit_reached'; message: string }
}

/** `kind` as the create flow reads it: anything that is not `personal` is `team`. */
export function normaliseWorkspaceKind(kind: unknown): OwnedWorkspaceKind {
  return kind === 'personal' ? 'personal' : 'team'
}

/**
 * Whether `userId` may create one more top-level workspace of `kind`.
 *
 * Every account gets one free workspace of EACH kind: one `personal` and one
 * `team`. Only the requested kind's owned count is checked, so a user who
 * already owns their signup `personal` workspace can still create one free
 * `team` workspace (and vice versa for legacy users whose signup workspace
 * stayed `team`). A second workspace of the *same* kind requires a paid
 * subscription, or a free child under a Business/Enterprise parent — that case
 * is decided before this is reached, by `validateChildWorkspaceCreation`.
 */
export async function checkWorkspaceCreateAllowance(
  userId: string,
  kind: OwnedWorkspaceKind,
): Promise<{ ok: true } | WorkspaceCreateRefusal> {
  if ((await getUserOwnedWorkspaceCount(userId, kind)) < 1) return { ok: true }
  return {
    ok: false,
    error: {
      code: 'workspace_limit_reached',
      message:
        kind === 'personal'
          ? 'You already have a personal workspace.'
          : 'You already have a free workspace. Additional workspaces require a paid subscription, or are included free on Business and Enterprise plans.',
    },
  }
}
