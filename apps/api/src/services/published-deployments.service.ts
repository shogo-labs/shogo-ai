// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Published deployments (SHO-308 §2).
 *
 * A deployment is one prebuilt container image for one commit, recorded against
 * one environment. Publishing builds the image once; rollback and promote reuse
 * a `PublishedDeployment` row rather than rebuilding.
 */

import { prisma } from '../lib/prisma'

export interface RecordDeploymentInput {
  environmentId: string
  commitSha: string
  imageRef: string
  imageDigest?: string | null
  schemaHash?: string | null
  revisionName?: string | null
  promotedFromId?: string | null
  createdBy?: string | null
  status?: 'pending' | 'building' | 'ready' | 'failed' | 'superseded'
}

export interface RecordedDeployment {
  id: string
  environmentId: string
  commitSha: string
  imageRef: string
  imageDigest: string | null
  status: string
}

/**
 * Record a deployment and, when it is `ready`, make it the environment's
 * current one. Supersedes the previous deployment so the history stays ordered.
 */
export async function recordPublishedDeployment(
  input: RecordDeploymentInput,
): Promise<RecordedDeployment> {
  const status = input.status ?? 'pending'
  const created = await prisma.publishedDeployment.create({
    data: {
      environmentId: input.environmentId,
      commitSha: input.commitSha,
      imageRef: input.imageRef,
      imageDigest: input.imageDigest ?? null,
      schemaHash: input.schemaHash ?? null,
      revisionName: input.revisionName ?? null,
      promotedFromId: input.promotedFromId ?? null,
      createdBy: input.createdBy ?? null,
      status,
    },
  })

  if (status === 'ready') {
    await prisma.publishedEnvironment.update({
      where: { id: input.environmentId },
      data: { currentDeploymentId: created.id },
    })
    await prisma.publishedDeployment.updateMany({
      where: {
        environmentId: input.environmentId,
        id: { not: created.id },
        status: 'ready',
      },
      data: { status: 'superseded' },
    })
  }

  return {
    id: created.id,
    environmentId: created.environmentId,
    commitSha: created.commitSha,
    imageRef: created.imageRef,
    imageDigest: created.imageDigest,
    status: created.status,
  }
}

/**
 * Complete a deployment recorded as `pending`: it is now serving, so it becomes
 * the environment's current one and supersedes the previous `ready` row.
 *
 * The publish flow records `pending` before it waits for the revision, and calls
 * this only once the substrate confirms the runtime answered (SHO-536 §C).
 */
export async function markPublishedDeploymentReady(id: string): Promise<void> {
  const row = await prisma.publishedDeployment.findUnique({ where: { id } })
  if (!row) return
  await prisma.publishedDeployment.update({ where: { id }, data: { status: 'ready' } })
  await prisma.publishedEnvironment.update({
    where: { id: row.environmentId },
    data: { currentDeploymentId: id },
  })
  await prisma.publishedDeployment.updateMany({
    where: { environmentId: row.environmentId, id: { not: id }, status: 'ready' },
    data: { status: 'superseded' },
  })
}

/**
 * Fail a deployment that never served, leaving the previous one current.
 *
 * `recordPublishedDeployment(..., 'ready')` used to be called as soon as the
 * ksvc was created, so a revision that died with ExitCode137 still superseded
 * the healthy deployment before it (SHO-536 §C).
 */
export async function markPublishedDeploymentFailed(id: string): Promise<void> {
  await prisma.publishedDeployment.update({ where: { id }, data: { status: 'failed' } })
}

/** The environment's deployment history, newest first (for the Deployment tab). */
export async function listDeployments(environmentId: string, limit = 20) {
  const rows = await prisma.publishedDeployment.findMany({
    where: { environmentId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return rows.map((r) => ({
    id: r.id,
    commitSha: r.commitSha,
    imageRef: r.imageRef,
    imageDigest: r.imageDigest,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  }))
}
