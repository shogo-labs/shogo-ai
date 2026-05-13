// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Warm Pool Rescue
 *
 * Detects warm-pool ksvc that K8s metadata says are "promoted" to a project
 * but whose runtime is still in pool mode (`/health` returns
 * `poolMode: true`). This is the "promoted-but-orphaned" failure mode where
 * the underlying pod was recreated by K8s (OOM, drain, deploy, eviction)
 * after `/pool/assign` ran. Container `emptyDir` was wiped, so the
 * `.shogo-pool-assignment` marker is gone and `checkSelfAssign()` finds
 * nothing to fetch — leaving the pod permanently 401-ing.
 *
 * Two recovery modes:
 *
 *   - `mode: 'evict'` (default, safe) — `evictProject(projectId, { deleteService: true })`.
 *     Drops the DB mapping, deletes the ksvc + DomainMapping. Next user
 *     request claims a fresh warm pod. No risk of leaving partial state.
 *
 *   - `mode: 'heal'` — re-issue `POST /pool/assign` with fresh env. Faster
 *     for the user (their session isn't interrupted) and preserves any
 *     warmed deps in the pod's emptyDir, but only safe once the pod also
 *     supports the `/api/internal/whoami/:serviceName` self-discovery
 *     fallback added in the same change set — otherwise a healed pod that
 *     gets recreated again immediately re-orphans.
 *
 * Both modes are gated by `dryRun: true` (default). Callers MUST set
 * `dryRun: false` to actually mutate.
 */

import { trace } from '@opentelemetry/api'

const tracer = trace.getTracer('shogo-warm-pool-rescue')

const POOL_STATUS_LABEL_KEY = 'shogo.io/warm-pool-status'

/** Per-pod scan result. */
export interface RescueScanEntry {
  /** Knative service name, e.g. `warm-pool-67bd0389`. */
  serviceName: string
  /** Project the K8s metadata claims this pod is assigned to. */
  projectId: string | null
  /** In-cluster URL we probed. */
  url: string
  /** True if the pod is reachable AND `/health` returned `poolMode: true`. */
  stuckInPoolMode: boolean
  /** Raw `/health` JSON, when reachable. */
  health?: Record<string, unknown>
  /** Reason we couldn't determine state, if any. */
  error?: string
  /** Action taken when not in dry-run. */
  action?: 'evicted' | 'healed' | 'skipped'
  /** Error encountered while applying the action. */
  actionError?: string
}

export interface RescueOptions {
  /** Workspaces namespace, defaults to `process.env.PROJECT_NAMESPACE` then `shogo-workspaces`. */
  namespace?: string
  /** When true (default), do not mutate state. */
  dryRun?: boolean
  /** What to do with stuck pods. Defaults to `'evict'`. */
  mode?: 'evict' | 'heal'
  /** Per-pod `/health` request timeout. Defaults to 5s. */
  healthTimeoutMs?: number
  /** Per-pod `/pool/assign` timeout when mode='heal'. Defaults to 30s. */
  assignTimeoutMs?: number
  /** Logger. Defaults to `console`. */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>
}

export interface RescueSummary {
  scanned: number
  stuck: number
  evicted: number
  healed: number
  errors: number
  entries: RescueScanEntry[]
}

/**
 * Scan all promoted warm-pool ksvc in `namespace` and (optionally) recover
 * pods stuck in pool mode. Imports `WarmPoolController` lazily so the
 * top-level import graph remains light enough to use this from a Job pod
 * that doesn't otherwise own the controller singleton.
 */
export async function rescueStuckPromotedPods(
  options: RescueOptions = {},
): Promise<RescueSummary> {
  const namespace = options.namespace
    ?? process.env.PROJECT_NAMESPACE
    ?? 'shogo-workspaces'
  const dryRun = options.dryRun ?? true
  const mode = options.mode ?? 'evict'
  const healthTimeoutMs = options.healthTimeoutMs ?? 5_000
  const assignTimeoutMs = options.assignTimeoutMs ?? 30_000
  const log = options.logger ?? console

  return tracer.startActiveSpan('warm_pool.rescue', async (span) => {
    span.setAttribute('rescue.namespace', namespace)
    span.setAttribute('rescue.dry_run', dryRun)
    span.setAttribute('rescue.mode', mode)

    const summary: RescueSummary = {
      scanned: 0, stuck: 0, evicted: 0, healed: 0, errors: 0, entries: [],
    }

    const promoted = await listPromotedKsvc(namespace, log)
    summary.scanned = promoted.length
    log.log(`[WarmPoolRescue] Scanning ${promoted.length} promoted ksvc in ${namespace} (dryRun=${dryRun}, mode=${mode})`)

    for (const ksvc of promoted) {
      const entry: RescueScanEntry = {
        serviceName: ksvc.serviceName,
        projectId: ksvc.projectId,
        url: ksvc.url,
        stuckInPoolMode: false,
      }
      summary.entries.push(entry)

      try {
        const health = await probeHealth(ksvc.url, healthTimeoutMs)
        entry.health = health
        // The runtime emits poolMode=true while still PROJECT_ID=__POOL__.
        // If the pod is healthy and not in pool mode, leave it alone.
        if (health?.poolMode !== true) continue
        entry.stuckInPoolMode = true
        summary.stuck++
      } catch (err: any) {
        entry.error = err?.message ?? String(err)
        summary.errors++
        log.warn(`[WarmPoolRescue] ${ksvc.serviceName}: probe failed (${entry.error}) — leaving alone`)
        continue
      }

      log.warn(
        `[WarmPoolRescue] ${ksvc.serviceName}: STUCK (project=${ksvc.projectId ?? 'unknown'}, health.projectId=${entry.health?.projectId ?? 'unknown'})`,
      )

      if (dryRun) {
        entry.action = 'skipped'
        continue
      }

      try {
        if (mode === 'evict') {
          if (!ksvc.projectId) {
            entry.actionError = 'cannot evict without projectId from labels'
            summary.errors++
            continue
          }
          const { getWarmPoolController } = await import('./warm-pool-controller')
          const wp = getWarmPoolController()
          await wp.evictProject(ksvc.projectId, { deleteService: true })
          entry.action = 'evicted'
          summary.evicted++
          log.log(`[WarmPoolRescue] ${ksvc.serviceName}: hard-evicted project ${ksvc.projectId}`)
        } else {
          if (!ksvc.projectId) {
            entry.actionError = 'cannot heal without projectId from labels'
            summary.errors++
            continue
          }
          const { buildProjectEnv } = await import('./runtime/build-project-env')
          const env = await buildProjectEnv(ksvc.projectId, { logPrefix: 'WarmPoolRescue' })
          const res = await fetch(`${ksvc.url}/pool/assign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: ksvc.projectId, env }),
            signal: AbortSignal.timeout(assignTimeoutMs),
          })
          if (!res.ok) {
            const body = await res.text().catch(() => '<no body>')
            throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
          }
          entry.action = 'healed'
          summary.healed++
          log.log(`[WarmPoolRescue] ${ksvc.serviceName}: healed via /pool/assign for project ${ksvc.projectId}`)
        }
      } catch (err: any) {
        entry.actionError = err?.message ?? String(err)
        summary.errors++
        log.error(`[WarmPoolRescue] ${ksvc.serviceName}: action failed: ${entry.actionError}`)
      }
    }

    span.setAttribute('rescue.scanned', summary.scanned)
    span.setAttribute('rescue.stuck', summary.stuck)
    span.setAttribute('rescue.evicted', summary.evicted)
    span.setAttribute('rescue.healed', summary.healed)
    span.setAttribute('rescue.errors', summary.errors)
    span.end()

    log.log(
      `[WarmPoolRescue] Done: scanned=${summary.scanned} stuck=${summary.stuck} evicted=${summary.evicted} healed=${summary.healed} errors=${summary.errors}`,
    )
    return summary
  })
}

interface PromotedKsvc {
  serviceName: string
  projectId: string | null
  url: string
}

async function listPromotedKsvc(
  namespace: string,
  log: Pick<Console, 'log' | 'warn' | 'error'>,
): Promise<PromotedKsvc[]> {
  // Lazy import: avoid pulling the entire k8s client + warm pool singleton
  // graph into callers that only want the rescue summary type.
  const k8s = await import('@kubernetes/client-node')
  const fs = await import('fs')

  const kc = new k8s.KubeConfig()
  const saDir = '/var/run/secrets/kubernetes.io/serviceaccount'
  if (fs.existsSync(`${saDir}/token`) && fs.existsSync(`${saDir}/ca.crt`)) {
    const ca = fs.readFileSync(`${saDir}/ca.crt`, 'utf8')
    const token = fs.readFileSync(`${saDir}/token`, 'utf8')
    const host = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`
    kc.loadFromOptions({
      clusters: [{ name: 'in-cluster', server: host, caData: Buffer.from(ca).toString('base64') }],
      users: [{ name: 'in-cluster', token }],
      contexts: [{ name: 'in-cluster', cluster: 'in-cluster', user: 'in-cluster' }],
      currentContext: 'in-cluster',
    })
  } else {
    kc.loadFromDefault()
  }
  const api = kc.makeApiClient(k8s.CustomObjectsApi)

  const result = await api.listNamespacedCustomObject({
    group: 'serving.knative.dev',
    version: 'v1',
    namespace,
    plural: 'services',
    labelSelector: `${POOL_STATUS_LABEL_KEY}=promoted`,
  }) as any

  const items: any[] = result?.items ?? []
  log.log(`[WarmPoolRescue] Found ${items.length} promoted ksvc in ${namespace}`)

  return items.map((svc) => ({
    serviceName: svc?.metadata?.name as string,
    projectId: (svc?.metadata?.labels?.['shogo.io/project']
      ?? svc?.metadata?.annotations?.['shogo.io/assigned-project']
      ?? null) as string | null,
    url: `http://${svc?.metadata?.name}.${namespace}.svc.cluster.local`,
  })).filter((r) => !!r.serviceName)
}

async function probeHealth(url: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${url}/health`, {
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  const ct = res.headers.get('content-type') || ''
  if (!ct.includes('application/json')) {
    return null
  }
  return await res.json() as Record<string, unknown>
}
