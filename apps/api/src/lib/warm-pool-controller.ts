// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Warm Pool Controller
 *
 * Maintains a pool of pre-started, generic runtime pods to eliminate cold start
 * latency for users. Instead of creating a Knative Service from scratch (which
 * requires container scheduling, image extraction, and application boot), the
 * warm pool keeps N pods already running in "pool mode."
 *
 * When a user needs a pod:
 * 1. Claim a warm pod from the pool (instant)
 * 2. POST /pool/assign to the warm pod with project-specific config
 * 3. The pod reconfigures itself in-place (loads S3 data, starts gateway, etc.)
 * 4. Return the warm pod URL immediately — user gets instant service
 * 5. Patch the Knative Service metadata labels to mark the pod as promoted
 *    (metadata-only — no new revision, no pod restart)
 * 6. Save the service name mapping in the database for routing
 *
 * On cold start (scale-to-zero recovery or API redeployment), the stale DB
 * mapping is detected by getProjectPodUrl, cleared, and a fresh warm pod
 * is assigned.
 *
 * Pool pods run with PROJECT_ID=__POOL__, do generic init (start Hono, 
 * pre-warm Claude Code session, load deps into memory), and wait for assignment.
 */

import * as k8s from '@kubernetes/client-node'
import * as fs from 'fs'
import { trace, SpanStatusCode, metrics } from '@opentelemetry/api'
import { generateProxyToken } from './ai-proxy-token'
import * as databaseService from '../services/database.service'
import { ensureCapacityForPods, getCapacitySummary } from './proactive-node-scaler'

const poolTracer = trace.getTracer('shogo-warm-pool')
const meter = metrics.getMeter('shogo-warm-pool')

const poolAvailableGauge = meter.createObservableGauge('warm_pool.available', {
  description: 'Number of available warm pool pods by type',
})
const poolTargetGauge = meter.createObservableGauge('warm_pool.target', {
  description: 'Target warm pool size by type',
})
const poolAssignedCounter = meter.createCounter('warm_pool.assignments', {
  description: 'Total warm pool pod assignments',
})
const poolColdStartCounter = meter.createCounter('warm_pool.cold_starts', {
  description: 'Times a pod was requested but no warm pod was available',
})
const nodeScaleUpCounter = meter.createCounter('warm_pool.node_scale_ups', {
  description: 'Proactive node scale-up events triggered by warm pool',
})

// =============================================================================
// Configuration
// =============================================================================

const NAMESPACE = process.env.PROJECT_NAMESPACE || 'shogo-workspaces'
const PROJECT_RUNTIME_IMAGE =
  process.env.PROJECT_RUNTIME_IMAGE || 'ghcr.io/shogo-ai/project-runtime:latest'
const AGENT_RUNTIME_IMAGE =
  process.env.AGENT_RUNTIME_IMAGE || (() => {
    console.error('[WarmPool] AGENT_RUNTIME_IMAGE env var not set — falling back to ghcr.io default which will likely fail in EKS. Set AGENT_RUNTIME_IMAGE to your ECR image.')
    return 'ghcr.io/shogo-ai/agent-runtime:latest'
  })()
const KNATIVE_GROUP = 'serving.knative.dev'
const KNATIVE_VERSION = 'v1'

const WARM_POOL_ENABLED = process.env.WARM_POOL_ENABLED !== 'false'
const WARM_POOL_RECONCILE_INTERVAL = parseInt(
  process.env.WARM_POOL_RECONCILE_INTERVAL || '30000',
  10
)
const WARM_POOL_MAX_AGE_MS = parseInt(
  process.env.WARM_POOL_MAX_AGE_MS || String(30 * 60 * 1000),
  10
)

// Per-node pool sizing: pool scales with cluster capacity.
// 2 nodes idle → small pool. Pre-scale to 5 nodes → bigger pool.
const WARM_POOL_AGENTS_PER_NODE = parseInt(process.env.WARM_POOL_AGENTS_PER_NODE || '2', 10)
const WARM_POOL_PROJECTS_PER_NODE = parseInt(process.env.WARM_POOL_PROJECTS_PER_NODE || '0', 10)
// Absolute minimum warm pods regardless of node count
const WARM_POOL_MIN_AGENTS = parseInt(process.env.WARM_POOL_MIN_AGENTS || '2', 10)
const WARM_POOL_MIN_PROJECTS = parseInt(process.env.WARM_POOL_MIN_PROJECTS || '0', 10)

// Promoted pod GC: clean up orphaned/idle promoted pods
const PROMOTED_POD_GC_ENABLED = process.env.PROMOTED_POD_GC_ENABLED !== 'false'
const PROMOTED_POD_IDLE_TIMEOUT_MS = parseInt(
  process.env.PROMOTED_POD_IDLE_TIMEOUT_MS || String(30 * 60 * 1000),
  10
)
const PROMOTED_POD_GC_MAX_ORPHANS_PER_CYCLE = 20
const PROMOTED_POD_GC_MAX_IDLE_EVICTIONS_PER_CYCLE = 10

// Promoted pod grace period: skip eviction of pods assigned within this window.
// Newly-promoted pods start at 0 replicas (still pulling/booting) and will
// return 401 until they are ready — the same race condition as namespace GC.
const PROMOTED_POD_GRACE_MS = parseInt(
  process.env.PROMOTED_POD_GRACE_MS || String(2 * 60 * 1000),
  10
)

// Full-namespace GC: sweep ALL Knative services (not just warm-pool-labeled)
// and delete ones that have no matching project in the DB.
const NAMESPACE_GC_INTERVAL_CYCLES = parseInt(process.env.NAMESPACE_GC_INTERVAL_CYCLES || '10', 10) // every N reconcile cycles
const NAMESPACE_GC_MAX_DELETIONS_PER_CYCLE = 50
const NAMESPACE_GC_CREATION_GRACE_MS = 5 * 60 * 1000 // skip services created within the last 5 minutes

const POOL_PROJECT_ID = '__POOL__'
const POOL_LABEL_KEY = 'shogo.io/warm-pool'
const POOL_TYPE_LABEL_KEY = 'shogo.io/warm-pool-type'
const POOL_STATUS_LABEL_KEY = 'shogo.io/warm-pool-status'

export type RuntimeType = 'project' | 'agent'

export interface WarmPodInfo {
  id: string
  serviceName: string
  type: RuntimeType
  url: string
  createdAt: number
  ready: boolean
}

export interface PromotedPodInfo {
  serviceName: string
  type: RuntimeType
  projectId: string
  url: string
  createdAt: number
  /** Unix ms when this pod was first observed as promoted in this process (used for grace period) */
  promotedAt: number
  ready: boolean
}

export interface GcStats {
  orphansDeleted: number
  idleEvictions: number
  namespaceServicesDeleted: number
  lastGcRun: number | null
  lastNamespaceGcRun: number | null
}

export interface WarmPoolConfig {
  projectPoolSize?: number
  agentPoolSize?: number
  reconcileIntervalMs?: number
  maxPodAgeMs?: number
  namespace?: string
}

// =============================================================================
// Kubernetes Client (reuse from knative-project-manager pattern)
// =============================================================================

let k8sCustomApi: k8s.CustomObjectsApi | null = null
let k8sCoreApi: k8s.CoreV1Api | null = null

function getKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig()

  const serviceAccountDir = '/var/run/secrets/kubernetes.io/serviceaccount'
  const caPath = `${serviceAccountDir}/ca.crt`
  const tokenPath = `${serviceAccountDir}/token`

  if (fs.existsSync(caPath) && fs.existsSync(tokenPath)) {
    const ca = fs.readFileSync(caPath, 'utf8')
    const token = fs.readFileSync(tokenPath, 'utf8')
    const host = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`

    kc.loadFromOptions({
      clusters: [
        {
          name: 'in-cluster',
          server: host,
          caData: Buffer.from(ca).toString('base64'),
        },
      ],
      users: [{ name: 'in-cluster', token }],
      contexts: [{ name: 'in-cluster', cluster: 'in-cluster', user: 'in-cluster' }],
      currentContext: 'in-cluster',
    })
  } else {
    kc.loadFromDefault()
  }

  return kc
}

function getCustomApi(): k8s.CustomObjectsApi {
  if (!k8sCustomApi) {
    const kc = getKubeConfig()
    k8sCustomApi = kc.makeApiClient(k8s.CustomObjectsApi)
  }
  return k8sCustomApi
}

function getCoreApi(): k8s.CoreV1Api {
  if (!k8sCoreApi) {
    const kc = getKubeConfig()
    k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api)
  }
  return k8sCoreApi
}

// =============================================================================
// WarmPoolController
// =============================================================================

export class WarmPoolController {
  private namespace: string
  private poolSize: { project: number; agent: number }
  private reconcileIntervalMs: number
  private maxPodAgeMs: number
  private reconcileTimer: ReturnType<typeof setInterval> | null = null

  // Mutable config (can be updated at runtime via updateConfig)
  private _minAgents: number
  private _minProjects: number
  private _agentsPerNode: number
  private _projectsPerNode: number
  private _idleTimeoutMs: number
  private _gcEnabled: boolean

  /** Available (unassigned) warm pods, keyed by a unique id */
  private available = new Map<string, WarmPodInfo>()

  /**
   * Assigned warm pods: projectId -> warm pod info.
   * Used for routing while the real Knative Service is being created in the background.
   */
  private assigned = new Map<string, WarmPodInfo>()

  /**
   * Service names that have been claimed but not yet passed to assign().
   * Bridges the gap between claim() firing an async reconcile and assign()
   * adding the pod to `this.assigned`.
   */
  private claimedServiceNames = new Set<string>()

  /** Pending warm pod creations to avoid duplicate reconciliation */
  private pendingCreations = new Set<string>()

  /** Promoted pods discovered during discoverExistingPods(), used by GC and admin API */
  private promotedPods: PromotedPodInfo[] = []

  /** Cumulative GC statistics for observability */
  private gcStats: GcStats = { orphansDeleted: 0, idleEvictions: 0, namespaceServicesDeleted: 0, lastGcRun: null, lastNamespaceGcRun: null }

  private started = false

  /** Cycle counter for scheduling periodic namespace-wide GC */
  private reconcileCycleCount = 0

  /** Burst detection: timer for rapid replenishment after multiple claims */
  private burstReconcileTimer: ReturnType<typeof setTimeout> | null = null

  constructor(config: WarmPoolConfig = {}) {
    this.namespace = config.namespace || NAMESPACE
    this._minAgents = config.agentPoolSize ?? WARM_POOL_MIN_AGENTS
    this._minProjects = config.projectPoolSize ?? WARM_POOL_MIN_PROJECTS
    this._agentsPerNode = WARM_POOL_AGENTS_PER_NODE
    this._projectsPerNode = WARM_POOL_PROJECTS_PER_NODE
    this._idleTimeoutMs = PROMOTED_POD_IDLE_TIMEOUT_MS
    this._gcEnabled = PROMOTED_POD_GC_ENABLED
    this.poolSize = {
      project: this._minProjects,
      agent: this._minAgents,
    }
    this.reconcileIntervalMs = config.reconcileIntervalMs ?? WARM_POOL_RECONCILE_INTERVAL
    this.maxPodAgeMs = config.maxPodAgeMs ?? WARM_POOL_MAX_AGE_MS
  }

  async start(): Promise<void> {
    if (!WARM_POOL_ENABLED) {
      console.log('[WarmPool] Warm pool disabled (WARM_POOL_ENABLED=false)')
      return
    }

    console.log(
      `[WarmPool] Starting warm pool controller (project: ${this.poolSize.project}, agent: ${this.poolSize.agent})`
    )
    this.started = true

    // Register OTEL observable gauges for real-time pool visibility in SigNoz
    const self = this
    poolAvailableGauge.addCallback((result) => {
      result.observe(self.countAvailable('project'), { type: 'project' })
      result.observe(self.countAvailable('agent'), { type: 'agent' })
    })
    poolTargetGauge.addCallback((result) => {
      result.observe(self.poolSize.project, { type: 'project' })
      result.observe(self.poolSize.agent, { type: 'agent' })
    })

    // Initial reconciliation
    await this.reconcile().catch((err) => {
      console.error('[WarmPool] Initial reconciliation failed:', err.message)
    })

    // Periodic reconciliation
    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch((err) => {
        console.error('[WarmPool] Reconciliation error:', err.message)
      })
    }, this.reconcileIntervalMs)
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer)
      this.reconcileTimer = null
    }
    if (this.burstReconcileTimer) {
      clearTimeout(this.burstReconcileTimer)
      this.burstReconcileTimer = null
    }
    console.log('[WarmPool] Stopped warm pool controller')
  }

  /**
   * Adjust pool size based on the number of ready nodes in the cluster.
   * Pool scales proportionally with cluster capacity:
   *   2 nodes (idle)  → 4 agent pods
   *   5 nodes (load)  → 10 agent pods
   * When nodes scale back down, excess warm pods are recycled naturally
   * (stale pod cleanup removes the oldest ones each reconcile cycle).
   */
  private async adjustPoolSizeForNodes(): Promise<void> {
    try {
      const nodeCount = await this.countReadyNodes()
      if (nodeCount <= 0) return

      const prevProject = this.poolSize.project
      const prevAgent = this.poolSize.agent

      this.poolSize.project = Math.max(this._minProjects, nodeCount * this._projectsPerNode)
      this.poolSize.agent = Math.max(this._minAgents, nodeCount * this._agentsPerNode)

      if (this.poolSize.project !== prevProject || this.poolSize.agent !== prevAgent) {
        console.log(
          `[WarmPool] Node-based sizing: ${nodeCount} nodes → project:${this.poolSize.project} (${this._projectsPerNode}/node), agent:${this.poolSize.agent} (${this._agentsPerNode}/node)`
        )
      }
    } catch (err: any) {
      console.error('[WarmPool] Node count check failed (non-fatal):', err.message)
    }
  }

  /**
   * Count ready managed node group nodes (excludes Karpenter nodes, NotReady, cordoned).
   * Karpenter nodes are ephemeral scale-out capacity and must NOT inflate the warm
   * pool target — otherwise warm pods fill Karpenter nodes and prevent scale-down.
   */
  private async countReadyNodes(): Promise<number> {
    const coreApi = getCoreApi()
    const response = await coreApi.listNode()
    const nodes = response.items || []
    let ready = 0
    let karpenterNodes = 0
    for (const node of nodes) {
      const labels = node.metadata?.labels || {}
      if (labels['karpenter.sh/nodepool']) {
        karpenterNodes++
        continue
      }
      const conditions = node.status?.conditions || []
      const readyCondition = conditions.find((c) => c.type === 'Ready')
      const unschedulable = node.spec?.unschedulable
      if (readyCondition?.status === 'True' && !unschedulable) {
        ready++
      }
    }
    if (karpenterNodes > 0) {
      console.log(`[WarmPool] Node count: ${ready} managed (ready) + ${karpenterNodes} Karpenter (excluded from sizing)`)
    }
    return ready
  }

  /**
   * Reconcile the pool: ensure we have the target number of warm pods per type.
   * Also cleans up pods that are too old (to prevent stale pre-warmed sessions).
   */
  async reconcile(): Promise<void> {
    if (!this.started) return
    this.reconcileCycleCount++

    // Adjust pool size based on cluster node count
    await this.adjustPoolSizeForNodes()

    // Discover existing warm pool services from Kubernetes
    await this.discoverExistingPods()

    // Clean up stale pods (older than maxPodAgeMs).
    // Limit to 1 deletion per pool type per cycle so replacements are created
    // before all warm pods are gone (prevents empty-pool cold starts).
    const now = Date.now()
    const recycledTypes = new Set<string>()
    for (const [id, pod] of this.available) {
      if (now - pod.createdAt > this.maxPodAgeMs) {
        if (recycledTypes.has(pod.type)) continue
        recycledTypes.add(pod.type)
        console.log(
          `[WarmPool] Recycling stale warm pod ${pod.serviceName} (age: ${Math.round(
            (now - pod.createdAt) / 1000
          )}s)`
        )
        this.available.delete(id)
        this.deleteWarmPodService(pod.serviceName).catch((err) => {
          console.error(`[WarmPool] Failed to delete stale pod ${pod.serviceName}:`, err.message)
        })
      }
    }

    // GC orphaned and idle promoted pods (warm-pool-labeled services only)
    await this.gcPromotedPods().catch((err) => {
      console.error('[WarmPool] Promoted pod GC failed (non-fatal):', err.message)
    })

    // Full namespace GC: sweep ALL Knative services (including cold-start projects)
    // Runs every N cycles to avoid hammering the K8s API on every 30s reconcile
    if (this.reconcileCycleCount % NAMESPACE_GC_INTERVAL_CYCLES === 0) {
      await this.gcOrphanedServices().catch((err) => {
        console.error('[WarmPool] Namespace GC failed (non-fatal):', err.message)
      })
    }

    // Trim excess pods when pool shrinks (e.g., nodes scaled down).
    // Delete oldest excess pods, 2 per type per cycle, to converge to target.
    for (const type of ['project', 'agent'] as const) {
      const available = [...this.available.values()].filter((p) => p.type === type)
      const excess = available.length - this.poolSize[type]
      if (excess > 0) {
        const toRemove = available
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(0, Math.min(excess, 2))
        for (const pod of toRemove) {
          console.log(`[WarmPool] Trimming excess ${type} pod ${pod.serviceName} (${available.length} available, target ${this.poolSize[type]})`)
          this.available.delete(pod.id)
          this.deleteWarmPodService(pod.serviceName).catch((err) => {
            console.error(`[WarmPool] Failed to trim pod ${pod.serviceName}:`, err.message)
          })
        }
      }
    }

    // Count available pods per type (only count ready or recently-created ones)
    const counts: Record<RuntimeType, number> = { project: 0, agent: 0 }
    for (const pod of this.available.values()) {
      counts[pod.type]++
    }

    // Also count pending creations to avoid over-provisioning
    const pending: Record<RuntimeType, number> = { project: 0, agent: 0 }
    for (const key of this.pendingCreations) {
      const type = key.startsWith('project-') ? 'project' : 'agent' as RuntimeType
      pending[type]++
    }

    // Create missing warm pods (deficit = target - available - pending)
    const totalDeficit =
      Math.max(0, this.poolSize.project - counts.project - pending.project) +
      Math.max(0, this.poolSize.agent - counts.agent - pending.agent)

    // Proactive node scaling: ensure cluster has capacity BEFORE creating pods
    if (totalDeficit > 0) {
      try {
        const nodesAdded = await ensureCapacityForPods(totalDeficit)
        if (nodesAdded > 0) {
          nodeScaleUpCounter.add(1, { nodes_added: nodesAdded, trigger: 'reconcile' })
          console.log(
            `[WarmPool] Proactive scale-up: requested ${nodesAdded} additional nodes for ${totalDeficit} pods`
          )
        }
      } catch (err: any) {
        console.error('[WarmPool] Proactive scaling check failed (non-fatal):', err.message)
      }
    }

    for (const type of ['project', 'agent'] as const) {
      const deficit = this.poolSize[type] - counts[type] - pending[type]
      if (deficit > 0) {
        console.log(
          `[WarmPool] Replenishing ${type}: creating ${deficit} pods (available: ${counts[type]}, pending: ${pending[type]}, target: ${this.poolSize[type]})`
        )
      }
      for (let i = 0; i < deficit; i++) {
        const id = crypto.randomUUID().slice(0, 8)
        const creationKey = `${type}-${id}`
        if (this.pendingCreations.has(creationKey)) continue

        this.pendingCreations.add(creationKey)
        this.createWarmPod(type, id)
          .then((pod) => {
            if (pod) {
              this.available.set(pod.id, pod)
              console.log(
                `[WarmPool] Created warm pod ${pod.serviceName} (pool: ${type}, now available: ${this.countAvailable(type)}/${this.poolSize[type]})`
              )
            }
          })
          .catch((err) => {
            console.error(`[WarmPool] Failed to create warm ${type} pod:`, err.message)
          })
          .finally(() => {
            this.pendingCreations.delete(creationKey)
          })
      }
    }
  }

  /**
   * Claim a warm pod for assignment to a project.
   * Returns null if no warm pods of the requested type are available.
   *
   * Includes burst detection: when the pool drops below 50%, triggers
   * immediate parallel pod creation instead of waiting for the next
   * 30s reconcile cycle. This handles thundering-herd scenarios where
   * multiple users arrive simultaneously (e.g. dry runs).
   */
  claim(type: RuntimeType): WarmPodInfo | null {
    // Find the oldest available pod of the requested type
    let oldest: WarmPodInfo | null = null
    let oldestId: string | null = null

    for (const [id, pod] of this.available) {
      if (pod.type !== type) continue
      if (!pod.ready) continue
      if (!oldest || pod.createdAt < oldest.createdAt) {
        oldest = pod
        oldestId = id
      }
    }

    if (oldest && oldestId) {
      this.available.delete(oldestId)
      this.claimedServiceNames.add(oldest.serviceName)
      const remaining = this.countAvailable(type)
      const target = this.poolSize[type]
      const utilization = 1 - remaining / target

      poolAssignedCounter.add(1, { type })
      console.log(
        `[WarmPool] Claimed warm pod ${oldest.serviceName} for ${type} (remaining: ${remaining}/${target}, utilization: ${Math.round(utilization * 100)}%)`
      )

      // Burst detection: if pool is more than 50% depleted, schedule
      // an immediate reconcile (debounced to 500ms so concurrent claims
      // within the same burst batch into one reconcile pass)
      if (utilization >= 0.5) {
        console.warn(
          `[WarmPool] BURST DETECTED: ${type} pool at ${Math.round(utilization * 100)}% utilization — scheduling immediate replenishment`
        )
        this.scheduleBurstReconcile()
      } else {
        // Normal replenishment via regular reconcile
        this.reconcile().catch((err) => {
          console.error('[WarmPool] Replenishment reconcile error:', err.message)
        })
      }

      return oldest
    }

    poolColdStartCounter.add(1, { type })
    console.warn(`[WarmPool] COLD START: no warm ${type} pod available — user will experience delay`)
    return null
  }

  /**
   * Schedule a burst reconcile — debounced so multiple rapid claims
   * within 500ms batch into a single reconcile pass.
   */
  private scheduleBurstReconcile(): void {
    if (this.burstReconcileTimer) return // already scheduled
    this.burstReconcileTimer = setTimeout(() => {
      this.burstReconcileTimer = null
      console.log('[WarmPool] Executing burst reconcile...')
      this.reconcile().catch((err) => {
        console.error('[WarmPool] Burst reconcile error:', err.message)
      })
    }, 500)
  }

  /**
   * Assign a claimed warm pod to a specific project.
   * Sends the /pool/assign request, patches Knative annotations for promotion,
   * and saves the service name mapping in the database.
   */
  async assign(
    pod: WarmPodInfo,
    projectId: string,
    envVars: Record<string, string>
  ): Promise<void> {
    return poolTracer.startActiveSpan('warm_pool.assign', {
      attributes: {
        'project.id': projectId,
        'pod.name': pod.serviceName,
        'pod.type': pod.type,
      },
    }, async (span) => {
      const startTime = Date.now()
      try {
        // Defensive: check if another project already maps to this service in DB.
        // This catches collisions from stale state after API restarts.
        try {
          const { prisma } = await import('./prisma')
          const existing = await prisma.project.findFirst({
            where: {
              knativeServiceName: pod.serviceName,
              id: { not: projectId },
            },
            select: { id: true, name: true },
          })
          if (existing) {
            console.warn(
              `[WarmPool] COLLISION GUARD: pod ${pod.serviceName} already mapped to project ${existing.id} (${existing.name}) — clearing stale mapping before assigning to ${projectId}`
            )
            await prisma.project.update({
              where: { id: existing.id },
              data: { knativeServiceName: null },
            })
          }
        } catch (dbErr: any) {
          console.error(`[WarmPool] Collision check failed (non-fatal):`, dbErr.message)
        }

        const response = await fetch(`${pod.url}/pool/assign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, env: envVars }),
          signal: AbortSignal.timeout(60000),
        })

        if (!response.ok) {
          const body = await response.text()
          throw new Error(`Assignment failed (${response.status}): ${body}`)
        }

        this.assigned.set(projectId, pod)
        this.claimedServiceNames.delete(pod.serviceName)
        const duration = Date.now() - startTime
        span.setAttribute('assign.duration_ms', duration)
        span.setStatus({ code: SpanStatusCode.OK })
        console.log(
          `[WarmPool] Assigned ${pod.serviceName} to project ${projectId} in ${duration}ms`
        )

        // Promote the warm pod: patch annotations and save DB mapping.
        // This is non-blocking — the pod is already serving the project.
        this.promoteWarmPod(pod, projectId).catch((err) => {
          console.error(
            `[WarmPool] Failed to promote ${pod.serviceName} for ${projectId} (non-fatal):`,
            err.message
          )
        })
      } catch (err: any) {
        this.claimedServiceNames.delete(pod.serviceName)
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
        span.recordException(err)
        console.error(
          `[WarmPool] Failed to assign ${pod.serviceName} to ${projectId}:`,
          err.message
        )
        throw err
      } finally {
        span.end()
      }
    })
  }

  /**
   * Promote a warm pod to a permanent project pod.
   * Patches Knative Service annotations (no new Revision) and saves
   * the service name mapping in the database for routing.
   *
   * The label patch is the critical gate: if it fails, we skip the DB save
   * to avoid a state where the pod looks "available" to the reconciler but
   * has a DB mapping — the root cause of warm-pool collisions.
   */
  private async promoteWarmPod(pod: WarmPodInfo, projectId: string): Promise<void> {
    const t0 = Date.now()
    const api = getCustomApi()
    const { mergePatchKnativeService } = await import('./knative-project-manager')

    // Step 1 (CRITICAL): patch metadata labels to mark this pod as promoted.
    // If this fails, bail out entirely — leaving the label as "available" while
    // saving a DB mapping causes collisions on API restart.
    const metadataPatch = {
      metadata: {
        annotations: {
          'shogo.io/assigned-project': projectId,
        },
        labels: {
          [POOL_STATUS_LABEL_KEY]: 'promoted',
          'shogo.io/project': projectId,
        },
      },
    }

    try {
      await mergePatchKnativeService(this.namespace, pod.serviceName, metadataPatch)
      console.log(
        `[WarmPool] Patched metadata on ${pod.serviceName} for ${projectId} (${Date.now() - t0}ms)`
      )
    } catch (err: any) {
      console.error(
        `[WarmPool] CRITICAL: Failed to patch metadata on ${pod.serviceName} for ${projectId} — aborting promotion to prevent collision:`,
        err.message
      )
      return
    }

    // NOTE: We intentionally do NOT patch the Knative spec.template here.
    // Changing the spec creates a new Revision, which replaces the running pod,
    // destroying the in-memory agent gateway, local workspace files, and canvas
    // state. The metadata labels/annotations above are sufficient for the warm
    // pool controller to identify promoted pods. For cold-start recovery after
    // scale-to-zero, getProjectPodUrl detects the stale mapping and re-assigns
    // a fresh warm pod.

    // Step 2: save the DB mapping, clearing any stale mapping from a previous
    // project that may have been assigned to this same service name.
    try {
      const { prisma } = await import('./prisma')

      await prisma.$transaction(async (tx) => {
        // Clear stale mappings: any OTHER project pointing to this service
        // is no longer valid — set its knativeServiceName to null.
        const stale = await tx.project.updateMany({
          where: {
            knativeServiceName: pod.serviceName,
            id: { not: projectId },
          },
          data: { knativeServiceName: null },
        })
        if (stale.count > 0) {
          console.warn(
            `[WarmPool] Cleared stale knativeServiceName from ${stale.count} project(s) that previously mapped to ${pod.serviceName}`
          )
        }

        await tx.project.update({
          where: { id: projectId },
          data: { knativeServiceName: pod.serviceName },
        })
      })

      console.log(
        `[WarmPool] Saved knativeServiceName=${pod.serviceName} for ${projectId} (${Date.now() - t0}ms)`
      )
    } catch (err: any) {
      console.error(
        `[WarmPool] Failed to save knativeServiceName for ${projectId}:`,
        err.message
      )
    }
  }

  /**
   * Get the URL for a project that's currently served by an assigned warm pod.
   * Returns null if the project isn't on a warm pod.
   */
  getAssignedUrl(projectId: string): string | null {
    const pod = this.assigned.get(projectId)
    return pod?.url ?? null
  }

  /**
   * Check if a project is currently being served by a warm pod.
   */
  isAssigned(projectId: string): boolean {
    return this.assigned.has(projectId)
  }


  /**
   * Evict a project from its current warm pod so the next request
   * claims a fresh one (with up-to-date env vars and image).
   *
   * Steps:
   *  1. Remove from in-memory assigned map
   *  2. Clear knativeServiceName in the database
   *  3. Delete the old Knative Service (async, best-effort)
   *
   * The next chat/runtime request triggers getProjectPodUrl() which
   * claims a new warm pod from the pool.
   */
  async evictProject(projectId: string): Promise<{ evicted: boolean; oldService?: string }> {
    const pod = this.assigned.get(projectId)

    // Clear in-memory state regardless of whether we found it
    this.assigned.delete(projectId)

    // Clear DB mapping
    let oldServiceName: string | undefined
    try {
      const { prisma } = await import('./prisma')
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { knativeServiceName: true },
      })
      oldServiceName = project?.knativeServiceName ?? pod?.serviceName
      if (project?.knativeServiceName) {
        await prisma.project.update({
          where: { id: projectId },
          data: { knativeServiceName: null },
        })
      }
    } catch (err: any) {
      console.error(`[WarmPool] evictProject: DB cleanup failed for ${projectId}:`, err.message)
    }

    // Delete the old Knative Service (best-effort, non-blocking)
    const serviceToDelete = oldServiceName
    if (serviceToDelete) {
      (async () => {
        try {
          const api = getCustomApi()
          await api.deleteNamespacedCustomObject({
            group: KNATIVE_GROUP,
            version: KNATIVE_VERSION,
            namespace: this.namespace,
            plural: 'services',
            name: serviceToDelete,
          })
          console.log(`[WarmPool] evictProject: deleted Knative Service ${serviceToDelete}`)
        } catch (err: any) {
          if (err.statusCode !== 404) {
            console.error(`[WarmPool] evictProject: failed to delete ${serviceToDelete}:`, err.message)
          }
        }
      })()
    }

    console.log(`[WarmPool] evictProject: evicted project ${projectId} from ${oldServiceName || '(not found)'}`)
    return { evicted: !!oldServiceName, oldService: oldServiceName }
  }

  /**
   * Get pool status for monitoring/debugging.
   */
  getStatus(): {
    enabled: boolean
    available: { project: number; agent: number }
    assigned: number
    targetSize: { project: number; agent: number }
  } {
    return {
      enabled: WARM_POOL_ENABLED && this.started,
      available: {
        project: this.countAvailable('project'),
        agent: this.countAvailable('agent'),
      },
      assigned: this.assigned.size,
      targetSize: this.poolSize,
    }
  }

  /**
   * Get the current runtime config (for admin API reads).
   */
  getConfig(): {
    warmPoolMinAgents: number
    warmPoolMinProjects: number
    warmPoolAgentsPerNode: number
    warmPoolProjectsPerNode: number
    reconcileIntervalMs: number
    maxPodAgeMs: number
    promotedPodIdleTimeoutMs: number
    promotedPodGcEnabled: boolean
  } {
    return {
      warmPoolMinAgents: this._minAgents,
      warmPoolMinProjects: this._minProjects,
      warmPoolAgentsPerNode: this._agentsPerNode,
      warmPoolProjectsPerNode: this._projectsPerNode,
      reconcileIntervalMs: this.reconcileIntervalMs,
      maxPodAgeMs: this.maxPodAgeMs,
      promotedPodIdleTimeoutMs: this._idleTimeoutMs,
      promotedPodGcEnabled: this._gcEnabled,
    }
  }

  /**
   * Update runtime config. Partial updates supported — only provided fields change.
   * Restarts the reconcile timer if the interval changes.
   */
  updateConfig(patch: {
    warmPoolMinAgents?: number
    warmPoolMinProjects?: number
    warmPoolAgentsPerNode?: number
    warmPoolProjectsPerNode?: number
    reconcileIntervalMs?: number
    maxPodAgeMs?: number
    promotedPodIdleTimeoutMs?: number
    promotedPodGcEnabled?: boolean
  }): void {
    const changes: string[] = []

    if (patch.warmPoolMinAgents !== undefined && patch.warmPoolMinAgents !== this._minAgents) {
      this._minAgents = patch.warmPoolMinAgents
      changes.push(`minAgents=${patch.warmPoolMinAgents}`)
    }
    if (patch.warmPoolMinProjects !== undefined && patch.warmPoolMinProjects !== this._minProjects) {
      this._minProjects = patch.warmPoolMinProjects
      changes.push(`minProjects=${patch.warmPoolMinProjects}`)
    }
    if (patch.warmPoolAgentsPerNode !== undefined && patch.warmPoolAgentsPerNode !== this._agentsPerNode) {
      this._agentsPerNode = patch.warmPoolAgentsPerNode
      changes.push(`agentsPerNode=${patch.warmPoolAgentsPerNode}`)
    }
    if (patch.warmPoolProjectsPerNode !== undefined && patch.warmPoolProjectsPerNode !== this._projectsPerNode) {
      this._projectsPerNode = patch.warmPoolProjectsPerNode
      changes.push(`projectsPerNode=${patch.warmPoolProjectsPerNode}`)
    }
    if (patch.maxPodAgeMs !== undefined && patch.maxPodAgeMs !== this.maxPodAgeMs) {
      this.maxPodAgeMs = patch.maxPodAgeMs
      changes.push(`maxPodAgeMs=${patch.maxPodAgeMs}`)
    }
    if (patch.promotedPodIdleTimeoutMs !== undefined && patch.promotedPodIdleTimeoutMs !== this._idleTimeoutMs) {
      this._idleTimeoutMs = patch.promotedPodIdleTimeoutMs
      changes.push(`idleTimeoutMs=${patch.promotedPodIdleTimeoutMs}`)
    }
    if (patch.promotedPodGcEnabled !== undefined && patch.promotedPodGcEnabled !== this._gcEnabled) {
      this._gcEnabled = patch.promotedPodGcEnabled
      changes.push(`gcEnabled=${patch.promotedPodGcEnabled}`)
    }

    // Recalculate pool size immediately with new min values
    this.poolSize.agent = Math.max(this._minAgents, this.poolSize.agent)
    this.poolSize.project = Math.max(this._minProjects, this.poolSize.project)

    // Restart timer if interval changed
    if (patch.reconcileIntervalMs !== undefined && patch.reconcileIntervalMs !== this.reconcileIntervalMs) {
      this.reconcileIntervalMs = patch.reconcileIntervalMs
      changes.push(`reconcileIntervalMs=${patch.reconcileIntervalMs}`)
      if (this.reconcileTimer && this.started) {
        clearInterval(this.reconcileTimer)
        this.reconcileTimer = setInterval(() => {
          this.reconcile().catch((err) => {
            console.error('[WarmPool] Reconciliation error:', err.message)
          })
        }, this.reconcileIntervalMs)
      }
    }

    if (changes.length > 0) {
      console.log(`[WarmPool] Config updated: ${changes.join(', ')}`)
      // Trigger immediate reconcile to apply new settings
      if (this.started) {
        this.reconcile().catch((err) => {
          console.error('[WarmPool] Post-config reconciliation error:', err.message)
        })
      }
    }
  }

  /**
   * Get extended status including cluster capacity, promoted pods, and GC stats.
   * Used by health/status endpoints and admin API for operational visibility.
   */
  async getExtendedStatus() {
    const base = this.getStatus()
    try {
      const capacity = await getCapacitySummary()
      return {
        ...base,
        cluster: capacity,
        promotedPods: this.promotedPods,
        gcStats: this.gcStats,
      }
    } catch {
      return { ...base, cluster: null, promotedPods: this.promotedPods, gcStats: this.gcStats }
    }
  }

  /**
   * Get the list of promoted pods (for admin API).
   */
  getPromotedPods(): PromotedPodInfo[] {
    return [...this.promotedPods]
  }

  /**
   * Get GC statistics (for admin API).
   */
  getGcStats(): GcStats {
    return { ...this.gcStats }
  }

  /**
   * Garbage-collect orphaned and idle promoted pods.
   *
   * Phase 1 (orphan GC): For each promoted service, check if the DB
   * knativeServiceName still maps to it. If not, the service is orphaned
   * (the project was re-assigned to a newer warm pod) -- delete it.
   *
   * Phase 2 (idle detection): For non-orphan promoted pods, probe the
   * pod's /pool/activity endpoint. If idle longer than the timeout, evict.
   */
  async gcPromotedPods(): Promise<{ orphansDeleted: number; idleEvicted: number }> {
    if (!this._gcEnabled || this.promotedPods.length === 0) {
      return { orphansDeleted: 0, idleEvicted: 0 }
    }

    this.gcStats.lastGcRun = Date.now()
    let orphansDeleted = 0
    let idleEvicted = 0

    // Phase 1: Orphan GC via DB batch query
    try {
      const { prisma } = await import('./prisma')
      const serviceNames = this.promotedPods.map((p) => p.serviceName)

      const mappedProjects = await prisma.project.findMany({
        where: { knativeServiceName: { in: serviceNames } },
        select: { id: true, knativeServiceName: true, name: true },
      })
      const activeServiceNames = new Set(
        mappedProjects.map((p) => p.knativeServiceName).filter(Boolean)
      )

      for (const pod of this.promotedPods) {
        if (orphansDeleted >= PROMOTED_POD_GC_MAX_ORPHANS_PER_CYCLE) break
        if (activeServiceNames.has(pod.serviceName)) continue

        // Skip pods in their grace period — the DB write for knativeServiceName
        // may still be in-flight when orphan GC runs after a rapid assignment.
        const ageMs = Date.now() - pod.promotedAt
        if (ageMs < PROMOTED_POD_GRACE_MS) {
          console.log(
            `[WarmPool GC] Skipping recently-promoted orphan candidate ${pod.serviceName} (age ${Math.round(ageMs / 1000)}s < grace ${PROMOTED_POD_GRACE_MS / 1000}s)`
          )
          continue
        }

        console.log(
          `[WarmPool GC] Deleting orphaned promoted pod ${pod.serviceName} (project ${pod.projectId} no longer maps to it)`
        )
        this.deleteWarmPodService(pod.serviceName).catch((err) => {
          console.error(`[WarmPool GC] Failed to delete orphan ${pod.serviceName}:`, err.message)
        })
        orphansDeleted++
        this.gcStats.orphansDeleted++
      }

      // Phase 2: Idle detection for non-orphan promoted pods
      const activePods = this.promotedPods.filter((p) =>
        activeServiceNames.has(p.serviceName)
      )

      for (const pod of activePods) {
        if (idleEvicted >= PROMOTED_POD_GC_MAX_IDLE_EVICTIONS_PER_CYCLE) break

        // Grace period: skip eviction for pods promoted within the last
        // PROMOTED_POD_GRACE_MS. A freshly-assigned pod returns 401 on
        // /pool/activity until it has fully initialised with project config.
        const ageMs = Date.now() - pod.promotedAt
        if (ageMs < PROMOTED_POD_GRACE_MS) {
          console.log(
            `[WarmPool GC] Skipping recently-promoted pod ${pod.serviceName} for project ${pod.projectId} (age ${Math.round(ageMs / 1000)}s < grace ${PROMOTED_POD_GRACE_MS / 1000}s)`
          )
          continue
        }

        try {
          const { deriveRuntimeToken } = await import('./runtime-token')
          const resp = await fetch(`${pod.url}/pool/activity`, {
            signal: AbortSignal.timeout(5000),
            headers: { 'x-runtime-token': deriveRuntimeToken(pod.projectId) },
          })
          if (resp.ok) {
            const activity = await resp.json() as { idleSeconds: number }
            if (activity.idleSeconds * 1000 < this._idleTimeoutMs) continue
            console.log(
              `[WarmPool GC] Evicting idle promoted pod ${pod.serviceName} for project ${pod.projectId} (idle ${activity.idleSeconds}s, timeout ${this._idleTimeoutMs / 1000}s)`
            )
          } else {
            console.log(
              `[WarmPool GC] Evicting unresponsive promoted pod ${pod.serviceName} for project ${pod.projectId} (status ${resp.status})`
            )
          }
        } catch {
          console.log(
            `[WarmPool GC] Evicting unreachable promoted pod ${pod.serviceName} for project ${pod.projectId}`
          )
        }

        await this.evictProject(pod.projectId).catch((err) => {
          console.error(`[WarmPool GC] Failed to evict ${pod.projectId}:`, err.message)
        })
        idleEvicted++
        this.gcStats.idleEvictions++
      }
    } catch (err: any) {
      console.error('[WarmPool GC] GC cycle failed:', err.message)
    }

    if (orphansDeleted > 0 || idleEvicted > 0) {
      console.log(
        `[WarmPool GC] Cycle complete: ${orphansDeleted} orphans deleted, ${idleEvicted} idle evicted (totals: ${this.gcStats.orphansDeleted} orphans, ${this.gcStats.idleEvictions} idle)`
      )
    }

    return { orphansDeleted, idleEvicted }
  }

  /**
   * Full-namespace GC: sweep ALL Knative services in the workspaces namespace
   * and aggressively delete services that are no longer needed.
   *
   * Two categories of deletions:
   *   1. Orphans — no matching project in DB (load test leftovers, deleted projects)
   *   2. Scaled-to-zero — project exists but pod is inactive. The warm pool provides
   *      a faster return-visit experience than Knative scale-from-zero, so keeping
   *      these services around only wastes Kourier/Envoy route capacity.
   *
   * When deleting a scaled-to-zero service with a DB mapping, we clear the
   * knativeServiceName so getProjectPodUrl() claims a warm pod on next visit.
   *
   * Runs every NAMESPACE_GC_INTERVAL_CYCLES reconcile cycles (~5 min at 30s interval).
   */
  async gcOrphanedServices(): Promise<number> {
    this.gcStats.lastNamespaceGcRun = Date.now()
    let deleted = 0

    try {
      const api = getCustomApi()
      const response = await api.listNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: KNATIVE_VERSION,
        namespace: this.namespace,
        plural: 'services',
        labelSelector: 'app.kubernetes.io/part-of=shogo',
      })

      const allServices = (response as any).items || []

      const candidateServices: {
        name: string
        projectId: string | null
        replicas: number
        createdAt: number
      }[] = []

      for (const svc of allServices) {
        const name: string = svc.metadata?.name
        if (!name) continue

        // Skip services managed by the warm pool (available, claimed, or assigned)
        if (this.available.has(name)) continue
        if (this.claimedServiceNames.has(name)) continue
        if ([...this.assigned.values()].some((p) => p.serviceName === name)) continue
        // Skip system services
        if (name === 'mcp-workspace-1') continue

        const labels = svc.metadata?.labels || {}
        const status = svc.status || {}

        // Skip warm pool pods that are still in "available" status
        if (name.startsWith('warm-pool-') && labels[POOL_STATUS_LABEL_KEY] === 'available') continue

        let projectId: string | null = null
        if (labels['shogo.io/project']) {
          projectId = labels['shogo.io/project']
        } else if (name.startsWith('project-')) {
          projectId = name.replace('project-', '')
        }

        const replicas = status.actualReplicas ?? 0
        const createdAt = svc.metadata?.creationTimestamp
          ? new Date(svc.metadata.creationTimestamp).getTime()
          : 0

        candidateServices.push({ name, projectId, replicas, createdAt })
      }

      if (candidateServices.length === 0) return 0

      const { prisma } = await import('./prisma')

      const serviceNames = candidateServices.map((s) => s.name)
      const projectIds = candidateServices.map((s) => s.projectId).filter(Boolean) as string[]

      const mappedProjects = await prisma.project.findMany({
        where: {
          OR: [
            { knativeServiceName: { in: serviceNames } },
            ...(projectIds.length > 0 ? [{ id: { in: projectIds } }] : []),
          ],
        },
        select: { id: true, knativeServiceName: true },
      })

      const activeServiceNames = new Set(
        mappedProjects.map((p) => p.knativeServiceName).filter(Boolean)
      )
      const activeProjectIds = new Set(mappedProjects.map((p) => p.id))

      // Collect DB mappings to clear for scaled-to-zero services
      const dbMappingsToClear: string[] = []

      const now = Date.now()

      for (const svc of candidateServices) {
        if (deleted >= NAMESPACE_GC_MAX_DELETIONS_PER_CYCLE) break

        const isOrphan = !activeServiceNames.has(svc.name) &&
                         !(svc.projectId && activeProjectIds.has(svc.projectId))
        const isScaledToZero = svc.replicas === 0
        const isRecentlyCreated = svc.createdAt > 0 && (now - svc.createdAt) < NAMESPACE_GC_CREATION_GRACE_MS

        if (isOrphan && !isRecentlyCreated) {
          console.log(
            `[WarmPool GC:namespace] Deleting orphaned service ${svc.name} (project ${svc.projectId || 'unknown'} not in DB)`
          )
        } else if (isScaledToZero && !isRecentlyCreated) {
          console.log(
            `[WarmPool GC:namespace] Deleting scaled-to-zero service ${svc.name} (project ${svc.projectId || 'unknown'} — warm pool will handle next visit)`
          )
          if (activeServiceNames.has(svc.name)) {
            dbMappingsToClear.push(svc.name)
          }
        } else {
          // Service is running, recently created (still starting), or has a valid DB mapping — leave it
          continue
        }

        this.deleteWarmPodService(svc.name).catch((err) => {
          console.error(`[WarmPool GC:namespace] Failed to delete ${svc.name}:`, err.message)
        })
        deleted++
        this.gcStats.namespaceServicesDeleted++
      }

      // Clear DB mappings for deleted services so getProjectPodUrl() claims warm pods
      if (dbMappingsToClear.length > 0) {
        await prisma.project.updateMany({
          where: { knativeServiceName: { in: dbMappingsToClear } },
          data: { knativeServiceName: null },
        }).catch((err: any) => {
          console.error(`[WarmPool GC:namespace] Failed to clear ${dbMappingsToClear.length} DB mappings:`, err.message)
        })
      }

      if (deleted > 0) {
        console.log(
          `[WarmPool GC:namespace] Cycle complete: ${deleted} services deleted (total: ${this.gcStats.namespaceServicesDeleted}, remaining: ${allServices.length - deleted})`
        )
      }
    } catch (err: any) {
      console.error('[WarmPool GC:namespace] Failed:', err.message)
    }

    return deleted
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  private countAvailable(type: RuntimeType): number {
    let count = 0
    for (const pod of this.available.values()) {
      if (pod.type === type && pod.ready) count++
    }
    return count
  }

  /**
   * Build the environment variables needed for assigning a project to a warm pod.
   * This gathers everything a project pod needs: DATABASE_URL, AI_PROXY_TOKEN, S3 config, etc.
   */
  async buildProjectEnv(projectId: string): Promise<Record<string, string>> {
    const startTime = Date.now()
    const env: Record<string, string> = {
      PROJECT_ID: projectId,
    }

    // AI Proxy token
    const tokenStart = Date.now()
    let projectType: string | null = null
    try {
      const { prisma } = await import('./prisma')
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { workspaceId: true, type: true, templateId: true, name: true },
      })
      if (project) {
        projectType = project.type
        if (project.templateId) env.TEMPLATE_ID = project.templateId
        if (project.name) env.AGENT_NAME = project.name
        const { getProjectOwnerUserId } = await import('./project-user-context')
        const ownerUserId = await getProjectOwnerUserId(projectId)
        env.AI_PROXY_TOKEN = await generateProxyToken(
          projectId,
          project.workspaceId,
          ownerUserId,
          7 * 24 * 60 * 60 * 1000
        )
      }
    } catch (err: any) {
      console.error(`[WarmPool] Failed to generate proxy token for ${projectId}:`, err.message)
    }
    console.log(`[WarmPool] buildProjectEnv: proxy token took ${Date.now() - tokenStart}ms (type=${projectType})`)

    // Database URL — skip for AGENT projects (they use filesystem/S3, not a project database)
    if (projectType !== 'AGENT') {
      const dbStart = Date.now()
      try {
        const dbInfo = await databaseService.provisionDatabase(projectId)
        if (dbInfo) {
          env.DATABASE_URL = dbInfo.connectionUrl
        }
      } catch (err: any) {
        console.error(`[WarmPool] Failed to provision database for ${projectId}:`, err.message)
      }
      console.log(`[WarmPool] buildProjectEnv: DB provisioning took ${Date.now() - dbStart}ms`)
    } else {
      console.log(`[WarmPool] buildProjectEnv: skipping DB provisioning for AGENT project`)
    }

    // Per-project runtime auth tokens (deterministic — derived from signing secret + projectId)
    const { deriveRuntimeToken, deriveWebhookToken } = await import('./runtime-token')
    env.RUNTIME_AUTH_SECRET = deriveRuntimeToken(projectId)
    env.WEBHOOK_TOKEN = deriveWebhookToken(projectId)

    // S3 config
    if (process.env.S3_WORKSPACES_BUCKET) {
      env.S3_WORKSPACES_BUCKET = process.env.S3_WORKSPACES_BUCKET
      env.S3_REGION = process.env.S3_REGION || 'us-east-1'
      env.S3_WATCH_ENABLED = 'true'
      env.S3_SYNC_INTERVAL = '30000'
      if (process.env.S3_ENDPOINT) env.S3_ENDPOINT = process.env.S3_ENDPOINT
      if (process.env.S3_FORCE_PATH_STYLE === 'true') env.S3_FORCE_PATH_STYLE = 'true'
    }

    console.log(`[WarmPool] buildProjectEnv: total ${Date.now() - startTime}ms for ${projectId}`)
    return env
  }

  /**
   * Discover existing warm pool Knative Services from Kubernetes.
   * Syncs the in-memory pool with actual cluster state.
   */
  private async discoverExistingPods(): Promise<void> {
    try {
      const api = getCustomApi()
      const response = await api.listNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: KNATIVE_VERSION,
        namespace: this.namespace,
        plural: 'services',
        labelSelector: `${POOL_LABEL_KEY}=true`,
      })

      const items = (response as any).items || []
      const discoveredIds = new Set<string>()
      const newPromotedPods: PromotedPodInfo[] = []

      for (const service of items) {
        const name = service.metadata?.name
        const labels = service.metadata?.labels || {}
        const type = labels[POOL_TYPE_LABEL_KEY] as RuntimeType
        const status = labels[POOL_STATUS_LABEL_KEY]
        const createdAt = new Date(service.metadata?.creationTimestamp).getTime()
        const id = name

        if (!name || !type) continue
        discoveredIds.add(id)

        // Collect promoted pods for GC and admin visibility
        if (status === 'assigned' || status === 'promoted') {
          const projectId = labels['shogo.io/project'] || ''
          const conditions = service.status?.conditions || []
          const readyCondition = conditions.find((c: any) => c.type === 'Ready')
          // Preserve promotedAt from the existing in-memory record so the grace
          // period is anchored to when this process first observed the promotion,
          // not to when the K8s service was created (which is earlier).
          const existing = this.promotedPods.find((p) => p.serviceName === name)
          newPromotedPods.push({
            serviceName: name,
            type,
            projectId,
            url: `http://${name}.${this.namespace}.svc.cluster.local`,
            createdAt,
            promotedAt: existing?.promotedAt ?? Date.now(),
            ready: readyCondition?.status === 'True',
          })
          continue
        }

        // Skip pods that have been claimed or assigned but whose label hasn't
        // been patched to 'promoted' yet.  claimedServiceNames covers the window
        // between claim() and assign(); the assigned map covers the window
        // between assign() and the async label patch.
        if (this.claimedServiceNames.has(name)) continue
        const isAssigned = [...this.assigned.values()].some(p => p.serviceName === name)
        if (isAssigned) continue

        // Check readiness from Knative service conditions
        const conditions = service.status?.conditions || []
        const readyCondition = conditions.find((c: any) => c.type === 'Ready')
        const ready = readyCondition?.status === 'True'

        // Detect permanently broken services (e.g. wrong image, RevisionMissing)
        // and clean them up so the pool can replace them
        const isBroken =
          readyCondition?.status === 'False' &&
          (readyCondition?.reason === 'RevisionMissing' ||
           readyCondition?.reason === 'ContainerMissing' ||
           readyCondition?.reason === 'RevisionFailed')
        if (isBroken) {
          console.warn(
            `[WarmPool] Deleting broken warm pod ${name} (reason: ${readyCondition?.reason})`
          )
          this.available.delete(id)
          this.deleteWarmPodService(name).catch((err) => {
            console.error(`[WarmPool] Failed to delete broken pod ${name}:`, err.message)
          })
          continue
        }

        const url = `http://${name}.${this.namespace}.svc.cluster.local`

        const existing = this.available.get(id)
        if (existing) {
          existing.ready = ready
          continue
        }

        this.available.set(id, {
          id,
          serviceName: name,
          type,
          url,
          createdAt,
          ready,
        })
      }

      // Remove from in-memory map any pods that no longer exist in k8s
      for (const [id] of this.available) {
        if (!discoveredIds.has(id)) {
          this.available.delete(id)
        }
      }

      this.promotedPods = newPromotedPods
    } catch (err: any) {
      console.error('[WarmPool] Failed to discover existing pods:', err.message)
    }
  }

  /**
   * Create a warm pool Knative Service.
   */
  private async createWarmPod(type: RuntimeType, id: string): Promise<WarmPodInfo | null> {
    const serviceName = `warm-pool-${type}-${id}`
    const image = type === 'agent' ? AGENT_RUNTIME_IMAGE : PROJECT_RUNTIME_IMAGE
    const workDir = type === 'agent' ? '/app/agent' : '/app/project'

    const env: Array<{ name: string; value?: string; valueFrom?: any }> = [
      { name: 'PROJECT_ID', value: POOL_PROJECT_ID },
      { name: 'PROJECT_DIR', value: workDir },
      ...(type === 'agent' ? [{ name: 'AGENT_DIR', value: workDir }] : []),
      { name: 'SCHEMAS_PATH', value: '/app/.schemas' },
      { name: 'WARM_POOL_MODE', value: 'true' },
    ]

    // AI Proxy URL (no token yet — assigned later)
    const systemNamespace = process.env.SYSTEM_NAMESPACE || 'shogo-system'
    const apiUrl =
      process.env.API_URL ||
      process.env.SHOGO_API_URL ||
      `http://api.${systemNamespace}.svc.cluster.local`
    env.push({ name: 'AI_PROXY_URL', value: `${apiUrl}/api/ai/v1` })
    env.push({ name: 'TOOLS_PROXY_URL', value: `${apiUrl}/api/tools` })

    // OTEL tracing — propagate to warm pool pods so they send traces to SigNoz
    if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      env.push({ name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: process.env.OTEL_EXPORTER_OTLP_ENDPOINT })
      env.push({ name: 'OTEL_SERVICE_NAME', value: `shogo-${type}-runtime` })
      if (process.env.SIGNOZ_INGESTION_KEY) {
        env.push({
          name: 'SIGNOZ_INGESTION_KEY',
          valueFrom: {
            secretKeyRef: { name: 'signoz-credentials', key: 'SIGNOZ_INGESTION_KEY', optional: true },
          },
        })
      }
    }

    // S3 config for the runtime (but no project data to sync yet)
    if (process.env.S3_WORKSPACES_BUCKET) {
      env.push({ name: 'S3_WORKSPACES_BUCKET', value: process.env.S3_WORKSPACES_BUCKET })
      env.push({ name: 'S3_REGION', value: process.env.S3_REGION || 'us-east-1' })
      if (process.env.S3_ENDPOINT) {
        env.push({ name: 'S3_ENDPOINT', value: process.env.S3_ENDPOINT })
      }
      if (process.env.S3_FORCE_PATH_STYLE === 'true') {
        env.push({ name: 'S3_FORCE_PATH_STYLE', value: 'true' })
      }
      // AWS credentials
      env.push({
        name: 'AWS_ACCESS_KEY_ID',
        valueFrom: {
          secretKeyRef: { name: 's3-credentials', key: 'access-key', optional: true },
        },
      })
      env.push({
        name: 'AWS_SECRET_ACCESS_KEY',
        valueFrom: {
          secretKeyRef: { name: 's3-credentials', key: 'secret-key', optional: true },
        },
      })
    }

    const service = {
      apiVersion: `${KNATIVE_GROUP}/${KNATIVE_VERSION}`,
      kind: 'Service',
      metadata: {
        name: serviceName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/part-of': 'shogo',
          [POOL_LABEL_KEY]: 'true',
          [POOL_TYPE_LABEL_KEY]: type,
          [POOL_STATUS_LABEL_KEY]: 'available',
          'shogo.io/component': type === 'agent' ? 'agent-runtime' : 'project-runtime',
        },
      },
      spec: {
        template: {
          metadata: {
            annotations: {
              'autoscaling.knative.dev/min-scale': '1',
              'autoscaling.knative.dev/max-scale': '1',
            },
          },
          spec: {
            timeoutSeconds: 600,
            securityContext: { fsGroup: 999 },
            affinity: {
              nodeAffinity: {
                preferredDuringSchedulingIgnoredDuringExecution: [
                  {
                    weight: 100,
                    preference: {
                      matchExpressions: [
                        {
                          key: 'karpenter.sh/nodepool',
                          operator: 'DoesNotExist',
                        },
                      ],
                    },
                  },
                ],
              },
            },
            containers: [
              {
                name: type === 'agent' ? 'agent-runtime' : 'project-runtime',
                image,
                imagePullPolicy: 'Always',
                ports: [{ containerPort: 8080, name: 'http1' }],
                env,
                resources: {
                  requests: { memory: '256Mi', cpu: '200m' },
                  limits: { memory: '2Gi', cpu: '1000m' },
                },
                volumeMounts: [{ name: 'project-data', mountPath: workDir }],
                readinessProbe: {
                  httpGet: { path: '/ready', port: 8080 },
                  initialDelaySeconds: 3,
                  periodSeconds: 3,
                  timeoutSeconds: 3,
                  successThreshold: 1,
                  failureThreshold: 40,
                },
                livenessProbe: {
                  httpGet: { path: '/health', port: 8080 },
                  initialDelaySeconds: 10,
                  periodSeconds: 15,
                  timeoutSeconds: 5,
                  successThreshold: 1,
                  failureThreshold: 5,
                },
              },
            ],
            volumes: [
              {
                name: 'project-data',
                emptyDir: { sizeLimit: '2Gi' },
              },
            ],
          },
        },
      },
    }

    const api = getCustomApi()
    try {
      await api.createNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: KNATIVE_VERSION,
        namespace: this.namespace,
        plural: 'services',
        body: service,
      })
    } catch (err: any) {
      const statusCode = err?.response?.statusCode || err?.statusCode || err?.body?.code
      if (
        statusCode === 409 ||
        err?.message?.includes('already exists') ||
        err?.body?.reason === 'AlreadyExists'
      ) {
        console.log(`[WarmPool] Warm pod ${serviceName} already exists`)
      } else {
        throw err
      }
    }

    const url = `http://${serviceName}.${this.namespace}.svc.cluster.local`
    return {
      id: serviceName,
      serviceName,
      type,
      url,
      createdAt: Date.now(),
      ready: false, // will be updated by discovery on next reconcile
    }
  }

  /**
   * Delete a warm pool Knative Service.
   */
  private async deleteWarmPodService(serviceName: string): Promise<void> {
    try {
      const api = getCustomApi()
      await api.deleteNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: KNATIVE_VERSION,
        namespace: this.namespace,
        plural: 'services',
        name: serviceName,
      })
      console.log(`[WarmPool] Deleted warm pod service: ${serviceName}`)
    } catch (err: any) {
      if (err?.code !== 404 && err?.response?.statusCode !== 404) {
        throw err
      }
    }
  }

}

// =============================================================================
// Singleton
// =============================================================================

let _controller: WarmPoolController | null = null

export function getWarmPoolController(): WarmPoolController {
  if (!_controller) {
    _controller = new WarmPoolController()
  }
  return _controller
}

/**
 * Load persisted infrastructure settings from the DB and apply to the controller.
 */
async function loadPersistedSettings(controller: WarmPoolController): Promise<void> {
  try {
    const { prisma } = await import('./prisma')
    const settings = await prisma.platformSetting.findMany({
      where: { key: { startsWith: 'infra.' } },
    })

    if (settings.length === 0) return

    const patch: Record<string, any> = {}
    for (const s of settings) {
      const key = s.key.replace('infra.', '')
      if (key === 'promotedPodGcEnabled') {
        patch[key] = s.value === 'true'
      } else {
        const val = parseInt(s.value, 10)
        if (Number.isFinite(val) && val >= 0) {
          patch[key] = val
        }
      }
    }

    if (Object.keys(patch).length > 0) {
      controller.updateConfig(patch)
      console.log(`[WarmPool] Loaded ${Object.keys(patch).length} persisted settings from DB`)
    }
  } catch (err: any) {
    console.warn('[WarmPool] Failed to load persisted settings (non-fatal):', err.message)
  }
}

/**
 * Initialize and start the warm pool controller.
 * Call this at API server startup (in Kubernetes only).
 */
export async function startWarmPool(): Promise<WarmPoolController> {
  const controller = getWarmPoolController()
  await loadPersistedSettings(controller)
  await controller.start()
  return controller
}
