// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { createUserRoutes, setPrisma as setPrismaUser } from './user.routes'
import {
  createWorkspaceRoutes,
  setPrisma as setPrismaWorkspace,
  setWorkspaceHooks,
} from './workspace.routes'
import type { WorkspaceHooks } from './workspace.hooks'
import { createProjectRoutes, setPrisma as setPrismaProject } from './project.routes'
import { createProjectFolderRoutes, setPrisma as setPrismaProjectFolder } from './project-folder.routes'
import { createStarredProjectRoutes, setPrisma as setPrismaStarredProject } from './starred-project.routes'
import { createMemberRoutes, setPrisma as setPrismaMember } from './member.routes'
import { createBillingAccountRoutes, setPrisma as setPrismaBillingAccount } from './billing-account.routes'
import { createInvitationRoutes, setPrisma as setPrismaInvitation } from './invitation.routes'
import { createFolderRoutes, setPrisma as setPrismaFolder } from './folder.routes'
import { createNotificationRoutes, setPrisma as setPrismaNotification } from './notification.routes'
import { createSubscriptionRoutes, setPrisma as setPrismaSubscription } from './subscription.routes'
import { createUsageWalletRoutes, setPrisma as setPrismaUsageWallet } from './usage-wallet.routes'
import { createUsageEventRoutes, setPrisma as setPrismaUsageEvent } from './usage-event.routes'
import { createWorkspaceGrantRoutes, setPrisma as setPrismaWorkspaceGrant } from './workspace-grant.routes'
import { createChatSessionRoutes, setPrisma as setPrismaChatSession } from './chat-session.routes'
import { createChatSessionProjectRoutes, setPrisma as setPrismaChatSessionProject } from './chat-session-project.routes'
import { createChatMessageRoutes, setPrisma as setPrismaChatMessage } from './chat-message.routes'
import { createToolCallLogRoutes, setPrisma as setPrismaToolCallLog } from './tool-call-log.routes'
import { createFeatureSessionRoutes, setPrisma as setPrismaFeatureSession } from './feature-session.routes'

/**
 * Local generated CRUD surface without the cloud hook aggregator.
 *
 * Most route files intentionally use empty hooks because the desktop database
 * is local. Workspaces are different now that local mode supports both team
 * and personal workspaces: the picker must only receive workspaces for the
 * signed-in user, and a stale/deep-linked workspace must not be readable just
 * because it exists in the local SQLite file.
 */
export function createLocalGeneratedRoutes(prisma: any): Hono {
  setPrismaUser(prisma)
  setPrismaWorkspace(prisma)
  setWorkspaceHooks(localWorkspaceHooks)
  setPrismaProject(prisma)
  setPrismaProjectFolder(prisma)
  setPrismaStarredProject(prisma)
  setPrismaMember(prisma)
  setPrismaBillingAccount(prisma)
  setPrismaInvitation(prisma)
  setPrismaFolder(prisma)
  setPrismaNotification(prisma)
  setPrismaSubscription(prisma)
  setPrismaUsageWallet(prisma)
  setPrismaUsageEvent(prisma)
  setPrismaWorkspaceGrant(prisma)
  setPrismaChatSession(prisma)
  setPrismaChatSessionProject(prisma)
  setPrismaChatMessage(prisma)
  setPrismaToolCallLog(prisma)
  setPrismaFeatureSession(prisma)

  const router = new Hono()
  router.route('/users', createUserRoutes())
  router.route('/workspaces', createWorkspaceRoutes())
  router.route('/projects', createProjectRoutes())
  router.route('/project-folders', createProjectFolderRoutes())
  router.route('/starred-projects', createStarredProjectRoutes())
  router.route('/members', createMemberRoutes())
  router.route('/billing-accounts', createBillingAccountRoutes())
  router.route('/invitations', createInvitationRoutes())
  router.route('/folders', createFolderRoutes())
  router.route('/notifications', createNotificationRoutes())
  router.route('/subscriptions', createSubscriptionRoutes())
  router.route('/usage-wallets', createUsageWalletRoutes())
  router.route('/usage-events', createUsageEventRoutes())
  router.route('/workspace-grants', createWorkspaceGrantRoutes())
  router.route('/chat-sessions', createChatSessionRoutes())
  router.route('/chat-session-projects', createChatSessionProjectRoutes())
  router.route('/chat-messages', createChatMessageRoutes())
  router.route('/tool-call-logs', createToolCallLogRoutes())
  router.route('/feature-sessions', createFeatureSessionRoutes())
  return router
}

/**
 * Keep local workspace discovery/access aligned with the workspace-scoped
 * APIs. We deliberately do not install the full cloud hook set here: local
 * workspace creation has different limits and does not need cloud billing
 * checks. Listing and reading still need membership scoping so a team row
 * cannot be mistaken for the user's personal workspace (or vice versa).
 */
export const localWorkspaceHooks: WorkspaceHooks = {
  beforeList: async (ctx) => {
    if (!ctx.userId) {
      return {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication required' },
      }
    }
    return {
      ok: true,
      data: {
        where: {
          members: {
            some: { userId: ctx.userId },
          },
        },
      },
    }
  },

  beforeGet: async (id, ctx) => {
    if (!ctx.userId) {
      return {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication required' },
      }
    }
    const member = await ctx.prisma.member.findFirst({
      where: { userId: ctx.userId, workspaceId: id },
    })
    return member
      ? { ok: true }
      : {
          ok: false,
          error: { code: 'forbidden', message: 'Access denied to this workspace' },
        }
  },
}
