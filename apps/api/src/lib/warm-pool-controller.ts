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
 * 5. In the background, create the real `project-{id}` Knative Service so
 *    future cold starts work correctly with the right env vars
 * 6. Once the real service has a pod running, delete the warm pool service
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
const WARM_POOL_PROJECT_SIZE = parseInt(process.env.WARM_POOL_PROJECT_SIZE || '2', 10)
const WARM_POOL_AGENT_SIZE = parseInt(process.env.WARM_POOL_AGENT_SIZE || '2', 10)
const WARM_POOL_RECONCILE_INTERVAL = parseInt(
  process.env.WARM_POOL_RECONCILE_INTERVAL || '30000',
  10
)
const WARM_POOL_MAX_AGE_MS = parseInt(
  process.env.WARM_POOL_MAX_AGE_MS || String(30 * 60 * 1000),
  10
)
const WARM_POOL_DYNAMIC_SIZING = process.env.WARM_POOL_DYNAMIC_SIZING !== 'false'
const WARM_POOL_MIN_PER_TYPE = 2
const WARM_POOL_PODS_PER_USER = 2 // 1 project + 1 agent per active user

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
    // @kubernetes/client-node's skipTLSVerify doesn't reliably propagate
    // in bun's fetch runtime; enforce at the process level for K8s API calls.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

    const token = fs.readFileSync(tokenPath, 'utf8')
    const host = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`

    kc.loadFromOptions({
      clusters: [
        {
          name: 'in-cluster',
          server: host,
          skipTLSVerify: true,
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

// =============================================================================
// WarmPoolController
// =============================================================================

export class WarmPoolController {
  private namespace: string
  private poolSize: { project: number; agent: number }
  private reconcileIntervalMs: number
  private maxPodAgeMs: number
  private reconcileTimer: ReturnType<typeof setInterval> | null = null

  /** Available (unassigned) warm pods, keyed by a unique id */
  private available = new Map<string, WarmPodInfo>()

  /**
   * Assigned warm pods: projectId -> warm pod info.
   * Used for routing while the real Knative Service is being created in the background.
   */
  private assigned = new Map<string, WarmPodInfo>()

  /** Pending warm pod creations to avoid duplicate reconciliation */
  private pendingCreations = new Set<string>()

  private started = false

  /** Burst detection: timer for rapid replenishment after multiple claims */
  private burstReconcileTimer: ReturnType<typeof setTimeout> | null = null

  constructor(config: WarmPoolConfig = {}) {
    this.namespace = config.namespace || NAMESPACE
    this.poolSize = {
      project: config.projectPoolSize ?? WARM_POOL_PROJECT_SIZE,
      agent: config.agentPoolSize ?? WARM_POOL_AGENT_SIZE,
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
   * Dynamically adjust pool size based on recent project creation activity.
   * When many projects are being created (dry run), scale up the pool so
   * new pods are ready before users need them.
   */
  private async adjustPoolSizeForLoad(): Promise<void> {
    if (!WARM_POOL_DYNAMIC_SIZING) return

    try {
      const { prisma } = await import('./prisma')
      // Count projects created in the last 15 minutes as a proxy for active users
      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000)
      const recentProjects = await prisma.project.count({
        where: { createdAt: { gte: fifteenMinAgo } },
      })

      // Each active user typically needs 1 project pod + 1 agent pod.
      // Scale pool to cover the next wave of users.
      const desiredPerType = Math.max(
        WARM_POOL_MIN_PER_TYPE,
        Math.min(recentProjects * WARM_POOL_PODS_PER_USER, WARM_POOL_PROJECT_SIZE * 2)
      )

      const prevProject = this.poolSize.project
      const prevAgent = this.poolSize.agent

      this.poolSize.project = Math.max(WARM_POOL_PROJECT_SIZE, desiredPerType)
      this.poolSize.agent = Math.max(WARM_POOL_AGENT_SIZE, desiredPerType)

      if (this.poolSize.project !== prevProject || this.poolSize.agent !== prevAgent) {
        console.log(
          `[WarmPool] Dynamic sizing: ${recentProjects} projects in last 15m → pool adjusted to project:${this.poolSize.project}, agent:${this.poolSize.agent}`
        )
      }
    } catch (err: any) {
      // Non-fatal — keep using current pool size
      console.error('[WarmPool] Dynamic sizing check failed:', err.message)
    }
  }

  /**
   * Reconcile the pool: ensure we have the target number of warm pods per type.
   * Also cleans up pods that are too old (to prevent stale pre-warmed sessions).
   */
  async reconcile(): Promise<void> {
    if (!this.started) return

    // Dynamically adjust pool size based on current load
    await this.adjustPoolSizeForLoad()

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

    // Clean up assigned pods whose real Knative Service is now running
    for (const [projectId, pod] of this.assigned) {
      const realServiceReady = await this.isRealServiceReady(projectId)
      if (realServiceReady) {
        console.log(
          `[WarmPool] Real service for ${projectId} is ready, cleaning up warm pod ${pod.serviceName}`
        )
        this.assigned.delete(projectId)
        this.deleteWarmPodService(pod.serviceName).catch((err) => {
          console.error(
            `[WarmPool] Failed to delete assigned pod ${pod.serviceName}:`,
            err.message
          )
        })
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
   * Sends the /pool/assign request and stores the mapping for routing.
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
        const response = await fetch(`${pod.url}/pool/assign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, env: envVars }),
          signal: AbortSignal.timeout(30000),
        })

        if (!response.ok) {
          const body = await response.text()
          throw new Error(`Assignment failed (${response.status}): ${body}`)
        }

        this.assigned.set(projectId, pod)
        const duration = Date.now() - startTime
        span.setAttribute('assign.duration_ms', duration)
        span.setStatus({ code: SpanStatusCode.OK })
        console.log(
          `[WarmPool] Assigned ${pod.serviceName} to project ${projectId} in ${duration}ms`
        )
      } catch (err: any) {
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
   * Get extended status including cluster capacity (async).
   * Used by health/status endpoints for operational visibility.
   */
  async getExtendedStatus() {
    const base = this.getStatus()
    try {
      const capacity = await getCapacitySummary()
      return { ...base, cluster: capacity }
    } catch {
      return { ...base, cluster: null }
    }
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
    const env: Record<string, string> = {
      PROJECT_ID: projectId,
    }

    // AI Proxy token
    try {
      const { prisma } = await import('./prisma')
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { workspaceId: true },
      })
      if (project) {
        env.AI_PROXY_TOKEN = await generateProxyToken(
          projectId,
          project.workspaceId,
          'system',
          7 * 24 * 60 * 60 * 1000
        )
      }
    } catch (err: any) {
      console.error(`[WarmPool] Failed to generate proxy token for ${projectId}:`, err.message)
    }

    // Database URL
    try {
      const dbInfo = await databaseService.provisionDatabase(projectId)
      if (dbInfo) {
        env.DATABASE_URL = dbInfo.connectionUrl
      }
    } catch (err: any) {
      console.error(`[WarmPool] Failed to provision database for ${projectId}:`, err.message)
    }

    // S3 config
    if (process.env.S3_WORKSPACES_BUCKET) {
      env.S3_WORKSPACES_BUCKET = process.env.S3_WORKSPACES_BUCKET
      env.S3_REGION = process.env.S3_REGION || 'us-east-1'
      env.S3_WATCH_ENABLED = 'true'
      env.S3_SYNC_INTERVAL = '30000'
      if (process.env.S3_ENDPOINT) env.S3_ENDPOINT = process.env.S3_ENDPOINT
      if (process.env.S3_FORCE_PATH_STYLE === 'true') env.S3_FORCE_PATH_STYLE = 'true'
    }

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

      for (const service of items) {
        const name = service.metadata?.name
        const labels = service.metadata?.labels || {}
        const type = labels[POOL_TYPE_LABEL_KEY] as RuntimeType
        const status = labels[POOL_STATUS_LABEL_KEY]
        const createdAt = new Date(service.metadata?.creationTimestamp).getTime()
        const id = name

        if (!name || !type) continue
        discoveredIds.add(id)

        // Skip if assigned to a project
        if (status === 'assigned') continue

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
    const systemNamespace = process.env.SYSTEM_NAMESPACE || 'shogo-staging-system'
    const apiUrl =
      process.env.API_URL ||
      process.env.SHOGO_API_URL ||
      `http://api.${systemNamespace}.svc.cluster.local`
    env.push({ name: 'AI_PROXY_URL', value: `${apiUrl}/api/ai/v1` })

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
            containers: [
              {
                name: type === 'agent' ? 'agent-runtime' : 'project-runtime',
                image,
                imagePullPolicy: 'Always',
                ports: [{ containerPort: 8080, name: 'http1' }],
                env,
                resources: {
                  requests: { memory: '256Mi', cpu: '100m' },
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

  /**
   * Check if the real project Knative Service (project-{id}) is ready.
   */
  private async isRealServiceReady(projectId: string): Promise<boolean> {
    try {
      const api = getCustomApi()
      const response = await api.getNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: KNATIVE_VERSION,
        namespace: this.namespace,
        plural: 'services',
        name: `project-${projectId}`,
      })

      const service = response as any
      const conditions = service.status?.conditions || []
      const readyCondition = conditions.find((c: any) => c.type === 'Ready')
      if (readyCondition?.status !== 'True') return false

      // Double-check with health probe
      const url = `http://project-${projectId}.${this.namespace}.svc.cluster.local`
      const healthResp = await fetch(`${url}/ready`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      })
      return healthResp.ok
    } catch {
      return false
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
 * Initialize and start the warm pool controller.
 * Call this at API server startup (in Kubernetes only).
 */
export async function startWarmPool(): Promise<WarmPoolController> {
  const controller = getWarmPoolController()
  await controller.start()
  return controller
}
