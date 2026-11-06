// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Published-app ops (SHO-308 §4/§5).
 *
 * One service behind both the Deployment tab and the agent's `publish`
 * `ops_action`, so the two can never disagree. Everything here reads Knative /
 * Kubernetes data (pods, revisions, pod logs) and the metered usage rows — never
 * metal VM state.
 *
 * An ops action never builds or publishes new code. `redeploy` re-runs the
 * current deployment's image; `rollback` and `promote` switch to an image that
 * already exists.
 */

import { prisma } from '../lib/prisma'
import {
  publishedServiceName,
  publishedSubdomainForEnv,
  type PublishedEnvironmentName,
  type PublishedScaleSettings,
} from '../lib/published-scale'
import {
  clampEnvironmentsForExhaustedWallet,
  createStagingEnvironment,
  deleteEnvironmentRow,
  getEnvironment,
  listEnvironments,
  scaleSettingsOf,
  setEnvironmentScale,
  type PublishedEnvironmentRow,
  type PublishedOpsError,
  type PublishedOpsOk,
} from './published-environments.service'
import { computePublishedCost, roundUsd } from '../config/published-pricing'
import { resolvePublishedRuntimeImage } from '../lib/published-image'
import { publishedImageDigestRef, publishedImageRepositoryOf } from '@shogo/shared-runtime/published-image-ref'

/**
 * The ref to run for a recorded deployment.
 *
 * A row with a digest is served by that digest, not by its tag: the tag is
 * mutable, so rolling back to a tag could serve a newer commit that was pushed
 * onto the same tag. Rows recorded before per-commit builds carry only a tag,
 * and those keep working.
 */
function servingImageRef(row: { imageRef: string | null; imageDigest: string | null }): string | null {
  if (!row.imageRef) return null
  if (!row.imageDigest) return row.imageRef
  return publishedImageDigestRef(publishedImageRepositoryOf(row.imageRef), row.imageDigest)
}

function isKubernetes(): boolean {
  return !!process.env.KUBERNETES_SERVICE_HOST
}

async function manager() {
  const { getKnativeProjectManager } = await import('../lib/knative-project-manager')
  return getKnativeProjectManager()
}

function fail(code: string, message: string, status = 400, details?: Record<string, unknown>): PublishedOpsError {
  return { ok: false, code, message, status, details }
}

export interface PublishedEnvironmentStatus {
  environment: {
    id: string
    name: string
    subdomain: string
    url: string
    scale: PublishedScaleSettings
    dbProvider: string | null
    dbName: string | null
  }
  replicas: { ready: number; total: number; desired: number | null }
  revision: string | null
  pods: Array<{ name: string; phase: string; ready: boolean; restarts: number; startedAt: string | null; revision: string | null }>
  currentDeployment: {
    id: string
    commitSha: string
    imageRef: string
    imageDigest: string | null
    createdAt: string
  } | null
}

function environmentUrl(subdomain: string): string {
  const domain = process.env.PUBLISH_DOMAIN || 'shogo.one'
  return `https://${subdomain}.${domain}`
}

export async function getEnvironmentStatus(
  projectId: string,
  name: PublishedEnvironmentName,
): Promise<PublishedOpsOk<PublishedEnvironmentStatus> | PublishedOpsError> {
  const env = await getEnvironment(projectId, name)
  if (!env) return fail('environment_not_found', `No ${name} environment for this project`, 404)

  let pods: PublishedEnvironmentStatus['pods'] = []
  let revision: string | null = null
  if (isKubernetes()) {
    const mgr = await manager()
    try {
      pods = await mgr.listPublishedPods(projectId, name)
      revision = await mgr.getPublishedRevision(projectId, name)
    } catch (err: any) {
      console.warn(`[published-ops] status ${projectId}/${name} k8s read failed:`, err?.message ?? err)
    }
  }

  const currentDeployment = env.currentDeploymentId
    ? await prisma.publishedDeployment.findUnique({ where: { id: env.currentDeploymentId } })
    : null

  return {
    ok: true,
    value: {
      environment: {
        id: env.id,
        name: env.name,
        subdomain: env.subdomain,
        url: environmentUrl(env.subdomain),
        scale: scaleSettingsOf(env),
        dbProvider: env.dbProvider,
        dbName: env.dbName,
      },
      replicas: {
        ready: pods.filter((p) => p.ready).length,
        total: pods.length,
        desired: null,
      },
      revision,
      pods,
      currentDeployment: currentDeployment
        ? {
            id: currentDeployment.id,
            commitSha: currentDeployment.commitSha,
            imageRef: currentDeployment.imageRef,
            imageDigest: currentDeployment.imageDigest,
            createdAt: currentDeployment.createdAt.toISOString(),
          }
        : null,
    },
  }
}

export interface PublishedEnvironmentMetrics {
  environment: string
  since: string
  requests: number
  errors5xx: number
  p95Ms: number | null
  podSeconds: number
  billedUsd: number
  unbilledUsd: number
  monthToDateUsd: number
  projectionUsd: number
}

/**
 * Requests / latency / errors / cost for an environment, from the metered
 * `PublishedUsageMinute` rows (filled by the collector from Knative's
 * queue-proxy metrics in SigNoz). Cost is what was actually billed, not an
 * estimate.
 */
export async function getEnvironmentMetrics(
  projectId: string,
  name: PublishedEnvironmentName,
  opts?: { sinceMs?: number },
): Promise<PublishedOpsOk<PublishedEnvironmentMetrics> | PublishedOpsError> {
  const env = await getEnvironment(projectId, name)
  if (!env) return fail('environment_not_found', `No ${name} environment for this project`, 404)

  const since = new Date(opts?.sinceMs ?? Date.now() - 24 * 60 * 60 * 1000)
  const rows = await prisma.publishedUsageMinute.findMany({
    where: { environmentId: env.id, minute: { gte: since } },
    orderBy: { minute: 'asc' },
  })

  let requests = 0
  let errors5xx = 0
  let podSeconds = 0
  let billedUsd = 0
  let unbilledUsd = 0
  const latencies: number[] = []
  for (const row of rows) {
    requests += row.requests
    errors5xx += row.errors5xx
    podSeconds += row.podSeconds
    if (row.p95Ms != null) latencies.push(row.p95Ms)
    const cost = computePublishedCost({
      podSeconds: { [scaleSettingsOf(env).size]: row.podSeconds },
      dbStorageBytes: Number(row.dbStorageBytes ?? 0),
      egressBytes: Number(row.egressBytes ?? 0),
      monthFraction: 1 / (30 * 24 * 60),
    }).totalUsd
    if (row.billedAt) billedUsd += cost
    else unbilledUsd += cost
  }
  latencies.sort((a, b) => a - b)
  const p95Ms = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : null

  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const monthRows = await prisma.publishedUsageMinute.findMany({
    where: { environmentId: env.id, minute: { gte: monthStart } },
  })
  let monthToDateUsd = 0
  for (const row of monthRows) {
    monthToDateUsd += computePublishedCost({
      podSeconds: { [scaleSettingsOf(env).size]: row.podSeconds },
      dbStorageBytes: Number(row.dbStorageBytes ?? 0),
      egressBytes: Number(row.egressBytes ?? 0),
      monthFraction: 1 / (30 * 24 * 60),
    }).totalUsd
  }
  const elapsedMs = Date.now() - monthStart.getTime()
  const projectionUsd = elapsedMs > 0 ? (monthToDateUsd / elapsedMs) * 30 * 24 * 60 * 60 * 1000 : monthToDateUsd

  return {
    ok: true,
    value: {
      environment: name,
      since: since.toISOString(),
      requests,
      errors5xx,
      p95Ms,
      podSeconds,
      billedUsd: roundUsd(billedUsd),
      unbilledUsd: roundUsd(unbilledUsd),
      monthToDateUsd: roundUsd(monthToDateUsd),
      projectionUsd: roundUsd(projectionUsd),
    },
  }
}

export async function getEnvironmentLogs(
  projectId: string,
  name: PublishedEnvironmentName,
  opts?: { podName?: string; tailLines?: number },
): Promise<PublishedOpsOk<{ logs: string }> | PublishedOpsError> {
  const env = await getEnvironment(projectId, name)
  if (!env) return fail('environment_not_found', `No ${name} environment for this project`, 404)
  if (!isKubernetes()) return { ok: true, value: { logs: '' } }
  const mgr = await manager()
  try {
    const logs = await mgr.readPublishedLogs(projectId, name, opts)
    return { ok: true, value: { logs } }
  } catch (err: any) {
    return fail('logs_unavailable', err?.message ?? 'Could not read pod logs', 502)
  }
}

/**
 * Out-of-funds clamp, applied end to end (SHO-308 §9).
 *
 * `clampEnvironmentsForExhaustedWallet` only rewrites the rows; Knative keeps
 * serving until the new scale is pushed, so this is the function the billing job
 * calls. Prod is never taken down — it is held at max-scale 1 — and staging is
 * dropped to zero. Returns the environments that were actually re-scaled.
 */
export async function applyExhaustedWalletClamp(
  projectId: string,
): Promise<Array<{ environment: PublishedEnvironmentRow; settings: PublishedScaleSettings; applied: boolean }>> {
  const changed = await clampEnvironmentsForExhaustedWallet(projectId)
  if (changed.length === 0) return []
  const k8s = isKubernetes()
  const results: Array<{ environment: PublishedEnvironmentRow; settings: PublishedScaleSettings; applied: boolean }> = []
  for (const change of changed) {
    let applied = false
    if (k8s) {
      try {
        const mgr = await manager()
        await mgr.setPublishedScale(projectId, change.settings, change.environment.name as PublishedEnvironmentName)
        applied = true
      } catch (err: any) {
        // Leave `applied: false` so the caller can retry and the owner is told
        // the site is still running at its old scale.
        console.warn(
          `[published-ops] clamp ${projectId}/${change.environment.name} could not reach Knative:`,
          err?.message ?? err,
        )
      }
    }
    results.push({ ...change, applied })
  }
  return results
}

/**
 * Deploy state for one environment. Staging has its own row state so a failed
 * staging build can never mark production failed (SHO-308 §8).
 */
export async function setEnvironmentPublishStatus(
  environmentId: string,
  status: 'idle' | 'building' | 'uploading' | 'configuring' | 'live' | 'failed',
  error?: string | null,
): Promise<void> {
  await prisma.publishedEnvironment.update({
    where: { id: environmentId },
    data: { publishStatus: status, publishError: error ?? null, publishStatusAt: new Date() },
  })
}

/**
 * The container image a publish just ran, for `PublishedDeployment.imageRef`.
 * Per-commit images come from §2; until then every environment runs the shared
 * runtime image, which is still a real reference — recording `''` would let
 * `promote` patch production to no image at all.
 */
export function resolvePublishedImageRef(): string {
  return resolvePublishedRuntimeImage()
}

/** Apply a scale change and push it to Knative (no republish). */
export async function scaleEnvironment(
  projectId: string,
  name: PublishedEnvironmentName,
  requested: { minReplicas?: unknown; maxReplicas?: unknown; size?: unknown },
): Promise<PublishedOpsOk<{ environment: PublishedEnvironmentRow; settings: PublishedScaleSettings }> | PublishedOpsError> {
  const res = await setEnvironmentScale(projectId, name, requested)
  if (!res.ok) return res
  if (isKubernetes()) {
    const mgr = await manager()
    try {
      await mgr.setPublishedScale(projectId, res.value.settings, name)
    } catch (err: any) {
      return fail('scale_apply_failed', err?.message ?? 'Could not apply scale to Knative', 502)
    }
  }
  return res
}

/**
 * Roll back to an earlier deployment's image. Data is NOT rolled back — the
 * database keeps its current contents, and the UI says so.
 */
export async function rollbackEnvironment(
  projectId: string,
  name: PublishedEnvironmentName,
  deploymentId?: string,
): Promise<PublishedOpsOk<{ deploymentId: string; imageRef: string }> | PublishedOpsError> {
  const env = await getEnvironment(projectId, name)
  if (!env) return fail('environment_not_found', `No ${name} environment for this project`, 404)

  const current = env.currentDeploymentId
    ? await prisma.publishedDeployment.findUnique({ where: { id: env.currentDeploymentId } })
    : null

  // "Roll back" has to mean a different image. Excluding only the current row
  // would happily pick a superseded twin that serves the same image and change
  // nothing, so exclude anything running the image we are already on.
  const target = deploymentId
    ? await prisma.publishedDeployment.findFirst({ where: { id: deploymentId, environmentId: env.id } })
    : await prisma.publishedDeployment.findFirst({
        where: {
          environmentId: env.id,
          id: { not: env.currentDeploymentId ?? '' },
          ...(current?.imageRef ? { imageRef: { not: current.imageRef } } : {}),
        },
        orderBy: { createdAt: 'desc' },
      })
  if (!target) return fail('deployment_not_found', 'No earlier deployment to roll back to', 404)
  if (!target.imageRef) {
    // A deployment row with no image can only come from a publish that never
    // recorded one. Rolling back to it would patch the ksvc to no image at all.
    return fail('image_missing', 'That deployment has no recorded image to serve', 409)
  }
  const targetImage = servingImageRef(target)!

  if (isKubernetes()) {
    const mgr = await manager()
    try {
      await mgr.setPublishedImage(projectId, targetImage, name)
    } catch (err: any) {
      return fail('rollback_failed', err?.message ?? 'Could not roll back the Knative revision', 502)
    }
  }

  const created = await prisma.publishedDeployment.create({
    data: {
      environmentId: env.id,
      commitSha: target.commitSha,
      imageRef: targetImage,
      imageDigest: target.imageDigest,
      schemaHash: target.schemaHash,
      promotedFromId: target.id,
      status: 'ready',
    },
  })
  await prisma.publishedEnvironment.update({
    where: { id: env.id },
    data: { currentDeploymentId: created.id },
  })
  return { ok: true, value: { deploymentId: created.id, imageRef: targetImage } }
}

/** Re-run the current deployment's image (no build). */
export async function redeployEnvironment(
  projectId: string,
  name: PublishedEnvironmentName,
): Promise<PublishedOpsOk<{ deploymentId: string; imageRef: string }> | PublishedOpsError> {
  const env = await getEnvironment(projectId, name)
  if (!env) return fail('environment_not_found', `No ${name} environment for this project`, 404)
  if (!env.currentDeploymentId) return fail('no_deployment', 'This environment has no deployment yet', 409)
  const current = await prisma.publishedDeployment.findUnique({ where: { id: env.currentDeploymentId } })
  if (!current) return fail('no_deployment', 'This environment has no deployment yet', 409)
  if (!current.imageRef) return fail('image_missing', 'The current deployment has no recorded image', 409)
  const currentImage = servingImageRef(current)!

  if (isKubernetes()) {
    const mgr = await manager()
    try {
      await mgr.setPublishedImage(projectId, currentImage, name)
    } catch (err: any) {
      return fail('redeploy_failed', err?.message ?? 'Could not redeploy', 502)
    }
  }
  return { ok: true, value: { deploymentId: current.id, imageRef: currentImage } }
}

/**
 * Promote staging's exact image to production — no rebuild, so what was
 * load-tested is what goes live.
 */
export async function promoteStagingToProduction(
  projectId: string,
): Promise<PublishedOpsOk<{ deploymentId: string; imageRef: string }> | PublishedOpsError> {
  const staging = await getEnvironment(projectId, 'staging')
  if (!staging) return fail('environment_not_found', 'This project has no staging environment', 404)
  if (!staging.currentDeploymentId) return fail('no_deployment', 'Staging has no deployment to promote', 409)
  const source = await prisma.publishedDeployment.findUnique({ where: { id: staging.currentDeploymentId } })
  if (!source) return fail('no_deployment', 'Staging has no deployment to promote', 409)
  if (!source.imageRef) {
    return fail('image_missing', 'Staging has no recorded image to promote — redeploy staging first', 409)
  }
  const promotedImage = servingImageRef(source)!

  const production = await getEnvironment(projectId, 'production')
  if (!production) return fail('not_published', 'Publish the app before promoting', 409)

  if (isKubernetes()) {
    const mgr = await manager()
    try {
      await mgr.setPublishedImage(projectId, promotedImage, 'production')
    } catch (err: any) {
      return fail('promote_failed', err?.message ?? 'Could not promote to production', 502)
    }
  }

  const created = await prisma.publishedDeployment.create({
    data: {
      environmentId: production.id,
      commitSha: source.commitSha,
      imageRef: promotedImage,
      imageDigest: source.imageDigest,
      schemaHash: source.schemaHash,
      promotedFromId: source.id,
      status: 'ready',
    },
  })
  await prisma.publishedEnvironment.update({
    where: { id: production.id },
    data: { currentDeploymentId: created.id },
  })
  return { ok: true, value: { deploymentId: created.id, imageRef: promotedImage } }
}

export async function createEnvironment(
  projectId: string,
  name: PublishedEnvironmentName,
): Promise<PublishedOpsOk<PublishedEnvironmentRow> | PublishedOpsError> {
  if (name === 'production') {
    return fail('invalid_environment', 'Production is created by publishing, not by create_env', 400)
  }
  return createStagingEnvironment(projectId)
}

/**
 * Delete an environment: its ksvc, DomainMapping, edge flag and row. Production
 * is never deleted here (unpublish handles that), and deleting staging leaves
 * production untouched.
 */
export async function deleteEnvironment(
  projectId: string,
  name: PublishedEnvironmentName,
): Promise<PublishedOpsOk<{ deleted: boolean }> | PublishedOpsError> {
  const env = await getEnvironment(projectId, name)
  if (!env) return { ok: true, value: { deleted: false } }

  if (isKubernetes()) {
    const mgr = await manager()
    await mgr.deletePublishedService(projectId, name).catch(() => {})
    await mgr.deletePublishedDomainMapping(env.subdomain).catch(() => {})
  }
  try {
    const { clearServerBackedFlag } = await import('../lib/cloudflare-server-backed-kv')
    await clearServerBackedFlag(env.subdomain)
  } catch {
    // Edge KV is best-effort; the row removal is what matters.
  }
  // The environment's database goes with it (SHO-308 §1): a deleted staging env
  // must not leave a Postgres database and its credentials Secret behind.
  // Best-effort — the ksvc is already gone, and a stranded database is
  // recoverable whereas a failed teardown mid-flight is not.
  const { dropEnvironmentDatabase } = await import('./published-database.service')
  const dropped = await dropEnvironmentDatabase(projectId, name)
  if (!dropped.dropped && dropped.error) {
    console.warn(
      `[published-ops] ${projectId}/${name} deleted but its database was not dropped: ${dropped.error}`,
    )
  }
  return deleteEnvironmentRow(projectId, name)
}

/** Every environment for a project, with its live status. */
export async function listEnvironmentStatuses(projectId: string) {
  const envs = await listEnvironments(projectId)
  const out = []
  for (const env of envs) {
    const status = await getEnvironmentStatus(projectId, env.name as PublishedEnvironmentName)
    if (status.ok) out.push(status.value)
  }
  return out
}

export { publishedServiceName, publishedSubdomainForEnv }
