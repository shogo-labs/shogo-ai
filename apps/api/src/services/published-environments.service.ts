// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Published environments (SHO-308 §8).
 *
 * A published app runs on Knative in one or more environments:
 *   - `production` — the live site at `{subdomain}.{domain}`
 *   - `staging`    — optional, at `{subdomain}--staging.{domain}`, so a user or
 *                    the agent can load-test and debug before promoting
 *
 * Dev/editing stays on metal and is not modelled here. Scale settings live on
 * the environment (not on Project), and every scale request is clamped to the
 * workspace plan's caps (config/usage-plans.ts).
 */

import { prisma } from '../lib/prisma'
import {
  DEFAULT_PUBLISHED_SCALE,
  normalizePublishedSize,
  publishedLocalStateReason,
  publishedSubdomainForEnv,
  validatePublishedScale,
  type PublishedEnvironmentName,
  type PublishedScaleSettings,
} from '../lib/published-scale'
import { getPublishedPlanCaps, type PublishedPlanCaps } from '../config/usage-plans'

export interface PublishedEnvironmentRow {
  id: string
  projectId: string
  name: string
  subdomain: string
  minReplicas: number
  maxReplicas: number
  size: string
  dbProvider: string | null
  dbName: string | null
  currentDeploymentId: string | null
  /** Set once uploads are served from the shared bucket rather than a pod dir. */
  uploadsShared?: boolean
}

export type PublishedOpsError = {
  ok: false
  code: string
  message: string
  status: number
  details?: Record<string, unknown>
}

export type PublishedOpsOk<T> = { ok: true; value: T }

function fail(code: string, message: string, status = 400, details?: Record<string, unknown>): PublishedOpsError {
  return { ok: false, code, message, status, details }
}

/** The workspace plan caps that apply to a project's published environments. */
export async function getProjectPublishedCaps(projectId: string): Promise<PublishedPlanCaps> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  })
  if (!project?.workspaceId) return getPublishedPlanCaps('free')
  // Resolved lazily so importing this module never pulls billing.service's
  // export list into a request path that doesn't need it (and so a route test
  // that stubs billing still works).
  try {
    const { getEffectivePlanId } = await import('./billing.service')
    const plan = await getEffectivePlanId(project.workspaceId, new Date())
    return getPublishedPlanCaps(plan)
  } catch (err: any) {
    console.warn('[published-environments] could not resolve plan, defaulting to free caps:', err?.message ?? err)
    return getPublishedPlanCaps('free')
  }
}

export async function listEnvironments(projectId: string): Promise<PublishedEnvironmentRow[]> {
  const rows = await prisma.publishedEnvironment.findMany({
    where: { projectId },
    orderBy: { name: 'asc' },
  })
  return rows as PublishedEnvironmentRow[]
}

export async function getEnvironment(
  projectId: string,
  name: PublishedEnvironmentName,
): Promise<PublishedEnvironmentRow | null> {
  const row = await prisma.publishedEnvironment.findUnique({
    where: { projectId_name: { projectId, name } },
  })
  return (row as PublishedEnvironmentRow | null) ?? null
}

/**
 * Ensure the `production` environment row exists for a project. Called on every
 * publish so a project published before this model existed (or one whose
 * backfill migration hasn't run) still gets a row. Idempotent.
 */
export async function ensureProductionEnvironment(
  projectId: string,
  subdomain: string,
  opts?: { alwaysOn?: boolean },
): Promise<PublishedEnvironmentRow> {
  const existing = await getEnvironment(projectId, 'production')
  if (existing) {
    if (existing.subdomain !== subdomain) {
      const updated = await prisma.publishedEnvironment.update({
        where: { id: existing.id },
        data: { subdomain },
      })
      return updated as PublishedEnvironmentRow
    }
    return existing
  }
  const created = await prisma.publishedEnvironment.create({
    data: {
      projectId,
      name: 'production',
      subdomain,
      minReplicas: opts?.alwaysOn ? 1 : DEFAULT_PUBLISHED_SCALE.minReplicas,
      maxReplicas: DEFAULT_PUBLISHED_SCALE.maxReplicas,
      size: DEFAULT_PUBLISHED_SCALE.size,
    },
  })
  return created as PublishedEnvironmentRow
}

export function scaleSettingsOf(env: PublishedEnvironmentRow): PublishedScaleSettings {
  return {
    minReplicas: env.minReplicas,
    maxReplicas: env.maxReplicas,
    size: normalizePublishedSize(env.size),
  }
}

/**
 * Apply a scale change to an environment, clamped to the plan caps.
 *
 * Returns `plan_limit` (with the cap and plan) when the request exceeds what the
 * plan allows, so the API, the dashboard and `ops_action` all report the same
 * thing. The caller is responsible for pushing the new settings to Knative.
 */
export async function setEnvironmentScale(
  projectId: string,
  name: PublishedEnvironmentName,
  requested: { minReplicas?: unknown; maxReplicas?: unknown; size?: unknown },
): Promise<PublishedOpsOk<{ environment: PublishedEnvironmentRow; settings: PublishedScaleSettings }> | PublishedOpsError> {
  const env = await getEnvironment(projectId, name)
  if (!env) return fail('environment_not_found', `No ${name} environment for this project`, 404)

  const current = scaleSettingsOf(env)
  const validated = validatePublishedScale({
    minReplicas: requested.minReplicas ?? current.minReplicas,
    maxReplicas: requested.maxReplicas ?? current.maxReplicas,
    size: requested.size ?? current.size,
  })
  if (!validated.ok) return fail(validated.code, validated.message, 400)

  const caps = await getProjectPublishedCaps(projectId)
  if (caps.maxReplicas !== null && validated.settings.maxReplicas > caps.maxReplicas) {
    return fail(
      'plan_limit',
      `Your ${caps.plan} plan allows at most ${caps.maxReplicas} replica(s) per environment.`,
      402,
      { cap: caps.maxReplicas, plan: caps.plan, field: 'maxReplicas' },
    )
  }
  if (!caps.sizes.includes(validated.settings.size)) {
    return fail(
      'plan_limit',
      `Your ${caps.plan} plan does not include the "${validated.settings.size}" size.`,
      402,
      { cap: caps.sizes, plan: caps.plan, field: 'size' },
    )
  }

  // AC 6: a second replica only makes sense once every replica reads the same
  // data. Until the app is on Postgres with object-backed uploads, Knative's
  // per-pod emptyDir means two replicas would serve two different SQLite files.
  if (validated.settings.maxReplicas > 1) {
    const localState = publishedLocalStateReason(env)
    if (localState) {
      return fail('local_state_in_use', localState, 409, {
        field: 'maxReplicas',
        dbProvider: env.dbProvider,
        dbName: env.dbName,
      })
    }
  }

  const updated = await prisma.publishedEnvironment.update({
    where: { id: env.id },
    data: {
      minReplicas: validated.settings.minReplicas,
      maxReplicas: validated.settings.maxReplicas,
      size: validated.settings.size,
    },
  })
  return { ok: true, value: { environment: updated as PublishedEnvironmentRow, settings: validated.settings } }
}

/**
 * Create the optional `staging` environment. Gated on the plan (pro+), and it
 * gets its own subdomain, database, uploads prefix and scale settings.
 */
export async function createStagingEnvironment(
  projectId: string,
): Promise<PublishedOpsOk<PublishedEnvironmentRow> | PublishedOpsError> {
  const production = await getEnvironment(projectId, 'production')
  if (!production) {
    return fail('not_published', 'Publish the app before creating a staging environment', 409)
  }
  const existing = await getEnvironment(projectId, 'staging')
  if (existing) return { ok: true, value: existing }

  const caps = await getProjectPublishedCaps(projectId)
  if (!caps.staging) {
    return fail(
      'plan_limit',
      `Staging environments require the Pro plan or higher (your plan: ${caps.plan}).`,
      402,
      { plan: caps.plan, field: 'staging' },
    )
  }

  const base = production.subdomain.replace(/--staging$/, '')
  const created = await prisma.publishedEnvironment.create({
    data: {
      projectId,
      name: 'staging',
      subdomain: publishedSubdomainForEnv(base, 'staging'),
      minReplicas: 0,
      maxReplicas: Math.min(production.maxReplicas, caps.maxReplicas ?? production.maxReplicas),
      size: production.size,
    },
  })
  return { ok: true, value: created as PublishedEnvironmentRow }
}

/**
 * Delete an environment's row. The caller tears down the ksvc, DomainMapping,
 * KV flag, database and upload prefix first — this only removes the record.
 * Production can't be deleted this way (unpublish handles that).
 */
export async function deleteEnvironmentRow(
  projectId: string,
  name: PublishedEnvironmentName,
): Promise<PublishedOpsOk<{ deleted: boolean }> | PublishedOpsError> {
  if (name === 'production') {
    return fail('cannot_delete_production', 'Unpublish the app to remove production', 409)
  }
  const env = await getEnvironment(projectId, name)
  if (!env) return { ok: true, value: { deleted: false } }
  await prisma.publishedEnvironment.delete({ where: { id: env.id } })
  return { ok: true, value: { deleted: true } }
}

/**
 * Out-of-funds clamp (SHO-308 §9): prod is never taken down. When the wallet is
 * exhausted, prod's max-scale is clamped to 1 and staging is scaled to zero.
 * Returns the environments whose settings changed so the caller can push them.
 */
export async function clampEnvironmentsForExhaustedWallet(
  projectId: string,
): Promise<Array<{ environment: PublishedEnvironmentRow; settings: PublishedScaleSettings }>> {
  const envs = await listEnvironments(projectId)
  const changed: Array<{ environment: PublishedEnvironmentRow; settings: PublishedScaleSettings }> = []
  for (const env of envs) {
    if (env.name === 'production') {
      if (env.maxReplicas <= 1 && env.minReplicas <= 1) continue
      const updated = await prisma.publishedEnvironment.update({
        where: { id: env.id },
        data: { maxReplicas: 1, minReplicas: Math.min(env.minReplicas, 1) },
      })
      changed.push({ environment: updated as PublishedEnvironmentRow, settings: scaleSettingsOf(updated as PublishedEnvironmentRow) })
    } else {
      // Staging is allowed to scale to zero and is capped at one replica: the
      // wallet is empty, so nothing may fan out until funds return.
      if (env.minReplicas === 0 && env.maxReplicas <= 1) continue
      const updated = await prisma.publishedEnvironment.update({
        where: { id: env.id },
        data: { minReplicas: 0, maxReplicas: 1 },
      })
      changed.push({ environment: updated as PublishedEnvironmentRow, settings: scaleSettingsOf(updated as PublishedEnvironmentRow) })
    }
  }
  return changed
}
