// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Instance Service — workspace instance size management.
 *
 * Handles reading/updating the instance size, syncing from Stripe,
 * and applying resource overrides to running project pods.
 */

import { prisma, InstanceSize, SubscriptionStatus, BillingInterval } from '../lib/prisma'
import {
  type InstanceSizeName,
  INSTANCE_SIZES,
  getKubernetesResourceOverrides,
} from '../config/instance-sizes'

export async function getInstanceForWorkspace(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      instanceSize: true,
      storageUsage: {
        select: {
          totalBytes: true,
          projectCount: true,
          lastCalculatedAt: true,
        },
      },
    },
  })

  if (!workspace) return null

  const size = workspace.instanceSize as InstanceSizeName
  const spec = INSTANCE_SIZES[size]

  return {
    size,
    spec,
    storage: workspace.storageUsage
      ? {
          totalBytes: Number(workspace.storageUsage.totalBytes),
          projectCount: workspace.storageUsage.projectCount,
          limitBytes: spec.storageLimitBytes,
          lastCalculatedAt: workspace.storageUsage.lastCalculatedAt,
        }
      : null,
  }
}

export async function getInstanceSubscription(workspaceId: string) {
  return prisma.instanceSubscription.findUnique({
    where: { workspaceId },
  })
}

export async function syncInstanceFromStripe(
  workspaceId: string,
  stripeSubscriptionId: string,
  stripeCustomerId: string,
  instanceSize: InstanceSizeName,
  status: SubscriptionStatus,
  billingInterval: BillingInterval,
  currentPeriodStart: Date,
  currentPeriodEnd: Date,
) {
  await prisma.$transaction(async (tx) => {
    await tx.instanceSubscription.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        stripeSubscriptionId,
        stripeCustomerId,
        instanceSize: instanceSize as InstanceSize,
        status,
        billingInterval,
        currentPeriodStart,
        currentPeriodEnd,
      },
      update: {
        stripeSubscriptionId,
        stripeCustomerId,
        instanceSize: instanceSize as InstanceSize,
        status,
        billingInterval,
        currentPeriodStart,
        currentPeriodEnd,
      },
    })

    await tx.workspace.update({
      where: { id: workspaceId },
      data: { instanceSize: instanceSize as InstanceSize },
    })
  })
}

export async function downgradeToMicro(workspaceId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.workspace.update({
      where: { id: workspaceId },
      data: { instanceSize: 'micro' as InstanceSize },
    })

    await tx.instanceSubscription.deleteMany({
      where: { workspaceId },
    })
  })
}

/**
 * Build the full set of resource overrides to apply to a project's
 * Knative service based on its workspace's instance size.
 * All sizes use shared nodes — no nodeSelector or tolerations needed.
 */
export function buildProjectResourceOverrides(_workspaceId: string, size: InstanceSizeName) {
  return getKubernetesResourceOverrides(size)
}

/**
 * Get project resource overrides for a given project by looking up its
 * workspace's instance size.
 */
export async function getProjectResourceOverrides(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      workspace: {
        select: { id: true, instanceSize: true },
      },
    },
  })

  if (!project?.workspace) return null

  const size = project.workspace.instanceSize as InstanceSizeName
  return buildProjectResourceOverrides(project.workspace.id, size)
}

/**
 * Apply instance size changes to all active project pods in a workspace.
 * Called after a size upgrade/downgrade so running pods get new resource specs.
 */
export async function applyInstanceToRuntime(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { instanceSize: true },
  })
  if (!workspace) return

  const size = workspace.instanceSize as InstanceSizeName
  const overrides = buildProjectResourceOverrides(workspaceId, size)

  const projects = await prisma.project.findMany({
    where: { workspaceId, knativeServiceName: { not: null } },
    select: { id: true, knativeServiceName: true },
  })

  if (projects.length === 0) return

  if (!process.env.KUBERNETES_SERVICE_HOST) return

  const { getKnativeProjectManager } = await import('../lib/knative-project-manager')
  const manager = getKnativeProjectManager()

  for (const project of projects) {
    try {
      await manager.patchProjectResources(project.id, overrides)
    } catch (err: any) {
      console.error(
        `[Instance] Failed to patch resources for project ${project.id}:`,
        err.message
      )
    }
  }
}
