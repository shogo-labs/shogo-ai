// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace Service - Prisma-based workspace operations
 * Replaces studioCoreDomain.createStore() for workspace/member management
 */

import { prisma, type Prisma } from '../lib/prisma';
import { customAlphabet } from 'nanoid';
import { homeRegionForNewWorkspace } from '../lib/region';

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 6);

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true';

/**
 * `homeRegion` fragment for a new `workspace.create()`. Cloud-only:
 * `schema.local.prisma`'s Workspace model deliberately has no `homeRegion`
 * column (single-region desktop has no use for it), so spreading this in
 * unconditionally makes Prisma reject the local write with "Unknown argument
 * `homeRegion`" — which previously broke the local auto-seed's personal
 * workspace creation on every fresh install (retried 5x, then gave up,
 * leaving the seeded local user with no workspace at all).
 */
function workspaceHomeRegionField(): { homeRegion?: string | null } {
  return isLocalMode ? {} : { homeRegion: homeRegionForNewWorkspace() };
}

export interface CreatePersonalWorkspaceResult {
  workspace: {
    id: string;
    name: string;
    slug: string;
  };
  member: {
    id: string;
    userId: string;
    role: string;
    workspaceId: string;
  };
}

/**
 * Create a personal workspace for a new user.
 * Called from Better Auth signup hook.
 */
export async function createPersonalWorkspace(
  userId: string,
  userName: string
): Promise<CreatePersonalWorkspaceResult> {
  // Generate slug from userId prefix (first 8 chars, no dashes)
  const userIdPrefix = userId.substring(0, 8).replace(/-/g, '');
  const slug = `user-${userIdPrefix}-personal`;
  const workspaceName = `${userName || 'User'} Personal`;

  const result = await prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: {
        name: workspaceName,
        slug,
        // Pin write-ownership to the region that created the workspace so all
        // workspace-scoped writes stay single-writer (replication-safe).
        ...workspaceHomeRegionField(),
      },
    });

    const member = await tx.member.create({
      data: {
        userId,
        role: 'owner',
        workspaceId: workspace.id,
        isBillingAdmin: true,
      },
    });

    return { workspace, member };
  }, { maxWait: 15_000, timeout: 30_000 });

  return {
    workspace: {
      id: result.workspace.id,
      name: result.workspace.name,
      slug: result.workspace.slug,
    },
    member: {
      id: result.member.id,
      userId: result.member.userId,
      role: result.member.role,
      workspaceId: result.member.workspaceId!,
    },
  };
}

/**
 * Get all workspaces for a user (via membership)
 */
export async function getWorkspacesForUser(userId: string) {
  const members = await prisma.member.findMany({
    where: { userId, workspaceId: { not: null } },
    include: {
      workspace: true,
    },
  });

  return members.map((m) => ({
    ...m.workspace!,
    role: m.role,
    isBillingAdmin: m.isBillingAdmin,
  }));
}

/**
 * Get a workspace by ID with authorization check
 */
export async function getWorkspace(workspaceId: string, userId: string) {
  const member = await prisma.member.findFirst({
    where: { workspaceId, userId },
    include: { workspace: true },
  });

  if (!member || !member.workspace) {
    return null;
  }

  return {
    ...member.workspace,
    role: member.role,
    isBillingAdmin: member.isBillingAdmin,
  };
}

/**
 * Get a workspace by slug
 */
export async function getWorkspaceBySlug(slug: string) {
  return prisma.workspace.findUnique({
    where: { slug },
  });
}

/**
 * Update workspace details
 */
export async function updateWorkspace(
  workspaceId: string,
  data: Prisma.WorkspaceUpdateInput
) {
  return prisma.workspace.update({
    where: { id: workspaceId },
    data,
  });
}

/**
 * Create a paid workspace (bypasses the beforeCreate hook limit).
 * Called from the billing workspace-checkout endpoint after Stripe session creation.
 */
export async function createPaidWorkspace(
  userId: string,
  workspaceName: string
): Promise<CreatePersonalWorkspaceResult> {
  const baseSlug = workspaceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const slug = `${baseSlug}-${nanoid()}`;

  const result = await prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: {
        name: workspaceName,
        slug,
        ...workspaceHomeRegionField(),
      },
    });

    const member = await tx.member.create({
      data: {
        userId,
        role: 'owner',
        workspaceId: workspace.id,
        isBillingAdmin: true,
      },
    });

    return { workspace, member };
  });

  return {
    workspace: {
      id: result.workspace.id,
      name: result.workspace.name,
      slug: result.workspace.slug,
    },
    member: {
      id: result.member.id,
      userId: result.member.userId,
      role: result.member.role,
      workspaceId: result.member.workspaceId!,
    },
  };
}

/**
 * Count workspaces owned by a user.
 * Used to enforce the one-free-workspace-per-user limit.
 */
export async function getUserOwnedWorkspaceCount(userId: string): Promise<number> {
  return prisma.member.count({
    where: {
      userId,
      role: 'owner',
      workspaceId: { not: null },
    },
  });
}

/**
 * Check if user has access to workspace
 */
export async function hasWorkspaceAccess(
  workspaceId: string,
  userId: string,
  requiredRoles?: string[]
): Promise<boolean> {
  const member = await prisma.member.findFirst({
    where: {
      workspaceId,
      userId,
      ...(requiredRoles ? { role: { in: requiredRoles as any } } : {}),
    },
  });

  return !!member;
}
