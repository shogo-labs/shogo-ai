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
  const baseSlug = `user-${userIdPrefix}-personal`;
  const workspaceName = `${userName || 'User'} Personal`;

  const result = await prisma.$transaction(async (tx) => {
    // The base slug is normally free — it's assigned once per user at
    // signup. But a user retroactively creating a personal workspace (see
    // `hasPersonalWorkspace` / `POST /api/workspaces/personal`) may already
    // own a workspace at this exact slug: their original signup workspace,
    // mis-backfilled to `kind: 'team'` by the personal-workspace-foundation
    // migration (it only flipped slug-matching workspaces with zero
    // projects to `kind: 'personal'`). Fall back to a random suffix so this
    // create never collides with that pre-existing row.
    const existing = await tx.workspace.findUnique({ where: { slug: baseSlug } });
    const slug = existing ? `${baseSlug}-${nanoid()}` : baseSlug;

    const workspace = await tx.workspace.create({
      data: {
        name: workspaceName,
        slug,
        kind: 'personal',
        // Pin write-ownership to the region that created the workspace so all
        // workspace-scoped writes stay single-writer (replication-safe).
        ...workspaceHomeRegionField(),
      },
    });

    await tx.workspaceAgentProfile.create({
      data: {
        workspaceId: workspace.id,
        name: 'Shogo',
        tagline: 'Your personal AI companion',
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
 * Whether a user already has a `kind: 'personal'` workspace. Used to gate
 * the free "create your personal space" flow (`POST /api/workspaces/personal`).
 *
 * Unlike `getUserOwnedWorkspaceCount` (which counts every owned workspace
 * regardless of `kind`, and drives the *paid* "additional workspace" limit),
 * this stays `false` for users whose original signup workspace was
 * mis-backfilled to `kind: 'team'` by the personal-workspace-foundation
 * migration, even though they already own that (team) workspace — those
 * users are exactly who the free personal-workspace flow targets.
 */
export async function hasPersonalWorkspace(userId: string): Promise<boolean> {
  const member = await prisma.member.findFirst({
    where: {
      userId,
      workspace: { kind: 'personal' },
    },
  });
  return !!member;
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

export type WorkspaceKind = 'personal' | 'team';

/**
 * Normalize a raw `Workspace.kind` column value (or an already-loaded
 * workspace's `kind` field) to the `WorkspaceKind` union, defaulting to
 * `'team'` for anything unrecognized (missing workspace, null, legacy
 * rows). This is the one place that decides what counts as "personal" —
 * every kind-derived query/env-builder should call this on its raw value
 * instead of re-writing the `=== 'personal' ? 'personal' : 'team'` check.
 */
export function normalizeWorkspaceKind(rawKind: string | null | undefined): WorkspaceKind {
  return rawKind === 'personal' ? 'personal' : 'team';
}

/**
 * Single source of truth for "is this workspace personal or team?" when
 * nothing else about the workspace is needed. Several call sites (chat
 * session routing, workspace-runtime resolution) each used to run their
 * own `prisma.workspace.findUnique({ select: { kind: true } })`.
 *
 * Callers that already load the workspace for other fields (e.g. the
 * runtime env builder, which also needs the agent profile name) should
 * fetch `kind` in that same query and pass it through
 * `normalizeWorkspaceKind` instead of issuing a second round-trip here.
 */
export async function getWorkspaceKind(workspaceId: string): Promise<WorkspaceKind> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { kind: true } as any,
  });
  return normalizeWorkspaceKind((workspace as { kind?: string } | null)?.kind);
}

export interface WorkspaceContext {
  hasAccess: boolean;
  kind: WorkspaceKind;
}

/**
 * Combines the two checks almost every workspace-scoped route needs before
 * doing real work: "does this user have access?" and "what kind of
 * workspace is this?" — fetched concurrently so callers pay for one
 * round-trip pair instead of two sequential ones. Previously duplicated as
 * separate `hasWorkspaceAccess()` + `getWorkspaceKind()` calls in
 * `workspace-chat.ts`'s `authorize()`/`resolveOr501()` and
 * `workspace-agent.ts`'s `sessionAuthorize()`.
 */
export async function loadWorkspaceContext(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceContext> {
  const [hasAccess, kind] = await Promise.all([
    hasWorkspaceAccess(workspaceId, userId),
    getWorkspaceKind(workspaceId),
  ]);
  return { hasAccess, kind };
}
