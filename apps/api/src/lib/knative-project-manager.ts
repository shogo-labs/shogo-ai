/**
 * Knative Project Manager
 *
 * Manages the lifecycle of per-project Knative Services:
 * - Creates Knative Services for projects on demand
 * - Creates PVCs for project storage and PostgreSQL data
 * - Provides URLs for routing to project pods
 * - Handles scale-to-zero and cold starts
 * - Includes PostgreSQL sidecar container for per-project database
 *
 * Architecture:
 * Each project pod contains two containers:
 * 1. project-runtime: The main application (Claude Code, MCP, Vite)
 * 2. postgres: PostgreSQL 16 sidecar for project data
 *
 * Used by the API to proxy requests to project-specific runtimes.
 */

import * as k8s from "@kubernetes/client-node"
import * as fs from "fs"

// =============================================================================
// Configuration
// =============================================================================

const NAMESPACE = process.env.PROJECT_NAMESPACE || "shogo-workspaces"
const PROJECT_RUNTIME_IMAGE = process.env.PROJECT_RUNTIME_IMAGE || "ghcr.io/shogo-ai/project-runtime:latest"
const KNATIVE_GROUP = "serving.knative.dev"
const KNATIVE_VERSION = "v1"

// Environment detection
const isKubernetes = () => !!process.env.KUBERNETES_SERVICE_HOST

// =============================================================================
// Kubernetes Client Setup
// =============================================================================

let k8sCustomApi: k8s.CustomObjectsApi | null = null
let k8sCoreApi: k8s.CoreV1Api | null = null

function getKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig()

  const serviceAccountDir = "/var/run/secrets/kubernetes.io/serviceaccount"
  const caPath = `${serviceAccountDir}/ca.crt`
  const tokenPath = `${serviceAccountDir}/token`

  if (fs.existsSync(caPath) && fs.existsSync(tokenPath)) {
    const ca = fs.readFileSync(caPath, "utf8")
    const token = fs.readFileSync(tokenPath, "utf8")
    const host = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`

    kc.loadFromOptions({
      clusters: [{ name: "in-cluster", server: host, caData: Buffer.from(ca).toString("base64"), skipTLSVerify: true }],
      users: [{ name: "in-cluster", token }],
      contexts: [{ name: "in-cluster", cluster: "in-cluster", user: "in-cluster" }],
      currentContext: "in-cluster",
    })
    console.log("[KnativeProjectManager] Loaded in-cluster config")
  } else {
    kc.loadFromDefault()
    console.log("[KnativeProjectManager] Loaded default kubeconfig")
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
// Types
// =============================================================================

export interface ProjectPodStatus {
  exists: boolean
  ready: boolean
  url: string | null
  replicas: number
  /** Last ready condition message */
  message?: string
  /** Time when the service was created */
  createdAt?: string
  /** Time when the service was last updated */
  updatedAt?: string
}

export interface ProjectPodInfo {
  projectId: string
  name: string
  status: ProjectPodStatus
}

export interface KnativeProjectManagerConfig {
  namespace?: string
  image?: string
  idleTimeoutSeconds?: number
  memoryLimit?: string
  cpuLimit?: string
  /** S3 bucket for workspaces storage */
  s3WorkspacesBucket?: string
  /** S3 endpoint URL (for MinIO or custom S3) */
  s3Endpoint?: string
  /** S3 region */
  s3Region?: string
  /** Enable S3 path-style access (for MinIO) */
  s3ForcePathStyle?: boolean
  /** PostgreSQL sidecar configuration */
  postgres?: {
    /** Enable PostgreSQL sidecar (default: true) */
    enabled?: boolean
    /** PostgreSQL image (default: postgres:16-alpine) */
    image?: string
    /** PostgreSQL user (default: shogo) */
    user?: string
    /** PostgreSQL password (default: shogo) */
    password?: string
    /** PostgreSQL database name (default: project) */
    database?: string
    /** Memory limit for PostgreSQL container (default: 512Mi) */
    memoryLimit?: string
    /** CPU limit for PostgreSQL container (default: 250m) */
    cpuLimit?: string
    /** Storage size for PostgreSQL PVC (default: 1Gi) */
    storageSize?: string
  }
}

// =============================================================================
// KnativeProjectManager
// =============================================================================

export class KnativeProjectManager {
  private namespace: string
  private image: string
  private idleTimeoutSeconds: number
  private memoryLimit: string
  private cpuLimit: string
  private s3WorkspacesBucket: string | null
  private s3Endpoint: string | null
  private s3Region: string
  private s3ForcePathStyle: boolean
  // PostgreSQL sidecar configuration
  private postgresEnabled: boolean
  private postgresImage: string
  private postgresUser: string
  private postgresPassword: string
  private postgresDatabase: string
  private postgresMemoryLimit: string
  private postgresCpuLimit: string
  private postgresStorageSize: string

  constructor(config: KnativeProjectManagerConfig = {}) {
    this.namespace = config.namespace || NAMESPACE
    this.image = config.image || PROJECT_RUNTIME_IMAGE
    this.idleTimeoutSeconds = config.idleTimeoutSeconds || parseInt(process.env.PROJECT_IDLE_TIMEOUT || "300", 10)
    this.memoryLimit = config.memoryLimit || "2Gi"
    this.cpuLimit = config.cpuLimit || "1000m"
    this.s3WorkspacesBucket = config.s3WorkspacesBucket || process.env.S3_WORKSPACES_BUCKET || null
    this.s3Endpoint = config.s3Endpoint || process.env.S3_ENDPOINT || null
    this.s3Region = config.s3Region || process.env.S3_REGION || "us-east-1"
    this.s3ForcePathStyle = config.s3ForcePathStyle ?? (process.env.S3_FORCE_PATH_STYLE === "true")
    // PostgreSQL sidecar configuration - read from env vars or config
    this.postgresEnabled = config.postgres?.enabled ?? (process.env.POSTGRES_ENABLED !== "false")
    this.postgresImage = config.postgres?.image || process.env.POSTGRES_IMAGE || "postgres:16-alpine"
    this.postgresUser = config.postgres?.user || process.env.POSTGRES_USER || "shogo"
    this.postgresPassword = config.postgres?.password || process.env.POSTGRES_PASSWORD || "shogo"
    this.postgresDatabase = config.postgres?.database || process.env.POSTGRES_DATABASE || "project"
    this.postgresMemoryLimit = config.postgres?.memoryLimit || process.env.POSTGRES_MEMORY_LIMIT || "512Mi"
    this.postgresCpuLimit = config.postgres?.cpuLimit || process.env.POSTGRES_CPU_LIMIT || "250m"
    this.postgresStorageSize = config.postgres?.storageSize || process.env.POSTGRES_STORAGE_SIZE || "1Gi"
  }

  /**
   * Get the internal cluster URL for a project pod.
   * This URL is used for proxying requests from the API to the project runtime.
   */
  getProjectPodUrl(projectId: string): string {
    if (!isKubernetes()) {
      // Local development - use localhost with dynamic port
      // In local mode, the RuntimeManager handles this
      throw new Error("KnativeProjectManager requires Kubernetes environment")
    }

    // Knative Service internal URL format
    return `http://project-${projectId}.${this.namespace}.svc.cluster.local`
  }

  /**
   * Check if a project's Knative Service exists and get its status.
   */
  async getStatus(projectId: string): Promise<ProjectPodStatus> {
    try {
      const api = getCustomApi()
      const response = await api.getNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: KNATIVE_VERSION,
        namespace: this.namespace,
        plural: "services",
        name: `project-${projectId}`,
      })

      const service = response as any
      const metadata = service.metadata || {}
      const status = service.status || {}
      const conditions = status.conditions || []
      const readyCondition = conditions.find((c: any) => c.type === "Ready")

      return {
        exists: true,
        ready: readyCondition?.status === "True",
        url: status.url || this.getProjectPodUrl(projectId),
        replicas: status.actualReplicas || 0,
        message: readyCondition?.message,
        createdAt: metadata.creationTimestamp,
        updatedAt: status.observedGeneration ? metadata.generation?.toString() : undefined,
      }
    } catch (error: any) {
      // Kubernetes client uses error.code for HTTP status codes
      if (error?.code === 404 || error?.response?.statusCode === 404) {
        return { exists: false, ready: false, url: null, replicas: 0 }
      }
      throw error
    }
  }

  /**
   * List all project pods in the namespace.
   */
  async listProjects(): Promise<ProjectPodInfo[]> {
    try {
      const api = getCustomApi()
      const response = await api.listNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: KNATIVE_VERSION,
        namespace: this.namespace,
        plural: "services",
        labelSelector: "shogo.io/component=project-runtime",
      })

      const items = (response as any).items || []
      const projects: ProjectPodInfo[] = []

      for (const service of items) {
        const projectId = service.metadata?.labels?.["shogo.io/project"]
        if (!projectId) continue

        const status = service.status || {}
        const conditions = status.conditions || []
        const readyCondition = conditions.find((c: any) => c.type === "Ready")

        projects.push({
          projectId,
          name: service.metadata?.name,
          status: {
            exists: true,
            ready: readyCondition?.status === "True",
            url: status.url || this.getProjectPodUrl(projectId),
            replicas: status.actualReplicas || 0,
            message: readyCondition?.message,
            createdAt: service.metadata?.creationTimestamp,
          },
        })
      }

      return projects
    } catch (error: any) {
      console.error("[KnativeProjectManager] Failed to list projects:", error)
      throw error
    }
  }

  /**
   * Create a Knative Service for a project.
   * Also creates the PVC for project storage if it doesn't exist.
   */
  async createProject(projectId: string): Promise<string> {
    const createStartTime = Date.now()
    console.log(`[KnativeProjectManager] Creating project: ${projectId}`)

    // Check if already exists
    const statusCheckStart = Date.now()
    const status = await this.getStatus(projectId)
    console.log(`[KnativeProjectManager] Status check took ${Date.now() - statusCheckStart}ms`)
    
    if (status.exists) {
      console.log(`[KnativeProjectManager] Project ${projectId} already exists (total: ${Date.now() - createStartTime}ms)`)
      return this.getProjectPodUrl(projectId)
    }

    // Create PVC first - needed for project code storage
    const pvcStartTime = Date.now()
    await this.ensurePVC(projectId)
    console.log(`[KnativeProjectManager] PVC creation took ${Date.now() - pvcStartTime}ms`)

    // Create Knative Service
    const ksvcStartTime = Date.now()
    const service = this.buildKnativeService(projectId)
    const api = getCustomApi()

    try {
      await api.createNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: KNATIVE_VERSION,
        namespace: this.namespace,
        plural: "services",
        body: service,
      })

      const ksvcDuration = Date.now() - ksvcStartTime
      const totalDuration = Date.now() - createStartTime
      console.log(`[KnativeProjectManager] Created Knative Service: project-${projectId} (ksvc: ${ksvcDuration}ms, total: ${totalDuration}ms)`)
    } catch (error: any) {
      // Handle race condition: if service already exists (409), that's fine
      const statusCode = error?.response?.statusCode || error?.statusCode || error?.body?.code
      if (statusCode === 409 || error?.message?.includes('already exists') || error?.body?.reason === 'AlreadyExists') {
        console.log(`[KnativeProjectManager] Project ${projectId} already exists (race condition handled) (total: ${Date.now() - createStartTime}ms)`)
      } else {
        // Re-throw other errors
        throw error
      }
    }
    
    return this.getProjectPodUrl(projectId)
  }

  /**
   * Delete a project's Knative Service and PVCs.
   * Removes both the project code PVC and PostgreSQL data PVC.
   */
  async deleteProject(projectId: string): Promise<void> {
    console.log(`[KnativeProjectManager] Deleting project: ${projectId}`)

    const api = getCustomApi()
    const coreApi = getCoreApi()

    // Delete Knative Service
    try {
      await api.deleteNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: KNATIVE_VERSION,
        namespace: this.namespace,
        plural: "services",
        name: `project-${projectId}`,
      })
      console.log(`[KnativeProjectManager] Deleted Knative Service: project-${projectId}`)
    } catch (error: any) {
      if (error?.code !== 404 && error?.response?.statusCode !== 404) throw error
    }

    // Delete project code PVC
    try {
      await coreApi.deleteNamespacedPersistentVolumeClaim({
        name: `pvc-project-${projectId}`,
        namespace: this.namespace,
      })
      console.log(`[KnativeProjectManager] Deleted PVC: pvc-project-${projectId}`)
    } catch (error: any) {
      if (error?.code !== 404 && error?.response?.statusCode !== 404) throw error
    }

    // Delete PostgreSQL data PVC
    try {
      await coreApi.deleteNamespacedPersistentVolumeClaim({
        name: `pvc-postgres-${projectId}`,
        namespace: this.namespace,
      })
      console.log(`[KnativeProjectManager] Deleted PVC: pvc-postgres-${projectId}`)
    } catch (error: any) {
      if (error?.code !== 404 && error?.response?.statusCode !== 404) throw error
    }
  }

  /**
   * Wait for a project's pod to be ready.
   * Performs both Knative status checks and active health probes.
   */
  async waitForReady(projectId: string, timeoutMs: number = 60000): Promise<void> {
    const startTime = Date.now()
    let pollCount = 0
    let firstReadyTime: number | null = null

    console.log(`[KnativeProjectManager] waitForReady started for ${projectId} (timeout: ${timeoutMs}ms)`)

    while (Date.now() - startTime < timeoutMs) {
      pollCount++
      const elapsed = Date.now() - startTime
      const status = await this.getStatus(projectId)
      
      if (status.ready) {
        if (!firstReadyTime) {
          firstReadyTime = Date.now() - startTime
          console.log(`[KnativeProjectManager] Project ${projectId} Knative status=ready at ${firstReadyTime}ms (poll #${pollCount})`)
        }
        
        // Double-check with an active health probe
        const healthCheckStart = Date.now()
        const healthy = await this.healthCheck(projectId)
        const healthCheckDuration = Date.now() - healthCheckStart
        
        if (healthy) {
          const totalDuration = Date.now() - startTime
          console.log(`[KnativeProjectManager] Project ${projectId} is ready and healthy (health check: ${healthCheckDuration}ms, total wait: ${totalDuration}ms, polls: ${pollCount})`)
          return
        }
        console.log(`[KnativeProjectManager] Project ${projectId} reports ready but health check failed (${healthCheckDuration}ms), retrying... (elapsed: ${elapsed}ms)`)
      } else {
        // Log status periodically (every 5 polls = ~5 seconds)
        if (pollCount % 5 === 0) {
          console.log(`[KnativeProjectManager] Project ${projectId} not ready yet (replicas: ${status.replicas}, elapsed: ${elapsed}ms, poll #${pollCount})`)
        }
      }
      
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    const totalDuration = Date.now() - startTime
    console.log(`[KnativeProjectManager] Project ${projectId} TIMEOUT after ${totalDuration}ms (polls: ${pollCount}, first ready: ${firstReadyTime || 'never'}ms)`)
    throw new Error(`Project ${projectId} did not become ready within ${timeoutMs}ms`)
  }

  /**
   * Perform an active health check on a project's pod.
   * Returns true if the pod is responding and ready to handle requests.
   * Uses /ready endpoint which verifies the project directory exists.
   */
  async healthCheck(projectId: string): Promise<boolean> {
    try {
      const url = this.getProjectPodUrl(projectId)
      const response = await fetch(`${url}/ready`, {
        method: "GET",
        signal: AbortSignal.timeout(5000), // 5 second timeout
      })
      return response.ok
    } catch (error) {
      // Health check failed - pod not ready or not responding
      return false
    }
  }

  /**
   * Scale a project to a specific number of replicas.
   * Useful for warming up pods before they're needed.
   */
  async scaleProject(projectId: string, replicas: number): Promise<void> {
    const api = getCustomApi()
    
    // Patch the service to update min-scale annotation
    const patch = {
      spec: {
        template: {
          metadata: {
            annotations: {
              "autoscaling.knative.dev/min-scale": replicas.toString(),
            },
          },
        },
      },
    }

    await api.patchNamespacedCustomObject({
      group: KNATIVE_GROUP,
      version: KNATIVE_VERSION,
      namespace: this.namespace,
      plural: "services",
      name: `project-${projectId}`,
      body: patch,
      // Specify the patch type
    }, {
      headers: { "Content-Type": "application/merge-patch+json" },
    })

    console.log(`[KnativeProjectManager] Scaled project ${projectId} to ${replicas} replica(s)`)
  }

  /**
   * Ensure project has PVCs for storage.
   * Creates two PVCs:
   * 1. pvc-project-{id}: For project code/files
   * 2. pvc-postgres-{id}: For PostgreSQL data (if postgres sidecar is enabled)
   */
  private async ensurePVC(projectId: string): Promise<void> {
    const coreApi = getCoreApi()
    const storageClass = process.env.STORAGE_CLASS_NAME || "ebs-sc"

    // Create project code PVC
    await this.createPVCIfNotExists(coreApi, {
      name: `pvc-project-${projectId}`,
      projectId,
      component: "project-storage",
      storageClass,
      size: "1Gi",
    })

    // Create PostgreSQL data PVC if postgres sidecar is enabled
    if (this.postgresEnabled) {
      await this.createPVCIfNotExists(coreApi, {
        name: `pvc-postgres-${projectId}`,
        projectId,
        component: "postgres-storage",
        storageClass,
        size: this.postgresStorageSize,
      })
    }
  }

  /**
   * Create a PVC if it doesn't already exist.
   */
  private async createPVCIfNotExists(
    coreApi: k8s.CoreV1Api,
    options: {
      name: string
      projectId: string
      component: string
      storageClass: string
      size: string
    }
  ): Promise<void> {
    const { name, projectId, component, storageClass, size } = options
    const pvcStartTime = Date.now()

    try {
      await coreApi.readNamespacedPersistentVolumeClaim({ name, namespace: this.namespace })
      console.log(`[KnativeProjectManager] PVC ${name} already exists (check: ${Date.now() - pvcStartTime}ms)`)
      return
    } catch (error: any) {
      if (error?.code !== 404 && error?.response?.statusCode !== 404) throw error
    }

    const pvc: k8s.V1PersistentVolumeClaim = {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name,
        namespace: this.namespace,
        labels: {
          "app.kubernetes.io/part-of": "shogo",
          "shogo.io/project": projectId,
          "shogo.io/component": component,
        },
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: storageClass,
        resources: {
          requests: { storage: size },
        },
      },
    }

    await coreApi.createNamespacedPersistentVolumeClaim({ namespace: this.namespace, body: pvc })
    console.log(`[KnativeProjectManager] Created PVC: ${name} (${Date.now() - pvcStartTime}ms)`)
  }

  /**
   * Build the Knative Service spec for a project.
   * Includes PostgreSQL sidecar container for per-project database.
   */
  private buildKnativeService(projectId: string): any {
    // Build environment variables for project-runtime container
    const env: any[] = [
      { name: "PROJECT_ID", value: projectId },
      { name: "PROJECT_DIR", value: "/app/project" },
      { name: "SCHEMAS_PATH", value: "/app/.schemas" },
      {
        name: "ANTHROPIC_API_KEY",
        valueFrom: {
          secretKeyRef: { name: "anthropic-credentials", key: "api-key" },
        },
      },
    ]

    // Add PostgreSQL DATABASE_URL if postgres sidecar is enabled
    // Uses localhost since postgres runs in the same pod
    if (this.postgresEnabled) {
      env.push({
        name: "DATABASE_URL",
        value: `postgres://${this.postgresUser}:${this.postgresPassword}@localhost:5432/${this.postgresDatabase}`,
      })
    }

    // Add S3 configuration if bucket is specified
    if (this.s3WorkspacesBucket) {
      env.push({ name: "S3_WORKSPACES_BUCKET", value: this.s3WorkspacesBucket })
      env.push({ name: "S3_REGION", value: this.s3Region })
      
      if (this.s3Endpoint) {
        env.push({ name: "S3_ENDPOINT", value: this.s3Endpoint })
      }
      if (this.s3ForcePathStyle) {
        env.push({ name: "S3_FORCE_PATH_STYLE", value: "true" })
      }
      
      // AWS credentials from secrets
      env.push({
        name: "AWS_ACCESS_KEY_ID",
        valueFrom: {
          secretKeyRef: { name: "s3-credentials", key: "access-key", optional: true },
        },
      })
      env.push({
        name: "AWS_SECRET_ACCESS_KEY",
        valueFrom: {
          secretKeyRef: { name: "s3-credentials", key: "secret-key", optional: true },
        },
      })
    }

    // Build containers array
    const containers: any[] = [
      {
        name: "project-runtime",
        image: this.image,
        imagePullPolicy: "Always", // Always pull to get latest staging-latest tag
        ports: [{ containerPort: 8080, name: "http1" }],
        env,
        resources: {
          requests: { memory: "256Mi", cpu: "100m" },
          limits: { memory: this.memoryLimit, cpu: this.cpuLimit },
        },
        volumeMounts: [{ name: "project-data", mountPath: "/app/project" }],
        // Readiness probe - optimized for fast start mode
        // With fast start, /health passes in ~2s, /ready passes after build (~5-10s)
        // Lower initialDelay + higher failureThreshold allows for background build time
        readinessProbe: {
          httpGet: {
            path: "/ready",
            port: 8080,
          },
          initialDelaySeconds: 1,
          periodSeconds: 2,
          timeoutSeconds: 2,
          successThreshold: 1,
          failureThreshold: 30, // Allow up to 60s for build to complete
        },
        // Liveness probe - checks if the pod is still alive
        // /health endpoint always passes quickly with fast start mode
        livenessProbe: {
          httpGet: {
            path: "/health",
            port: 8080,
          },
          initialDelaySeconds: 5,
          periodSeconds: 10,
          timeoutSeconds: 5,
          successThreshold: 1,
          failureThreshold: 3,
        },
      },
    ]

    // Add PostgreSQL sidecar container if enabled
    // NOTE: Knative doesn't allow probes on sidecar containers (only on the main container)
    // The main project-runtime container handles all probing; postgres sidecar just runs alongside
    if (this.postgresEnabled) {
      containers.push({
        name: "postgres",
        image: this.postgresImage,
        env: [
          { name: "POSTGRES_USER", value: this.postgresUser },
          { name: "POSTGRES_PASSWORD", value: this.postgresPassword },
          { name: "POSTGRES_DB", value: this.postgresDatabase },
          // PGDATA must be a subdirectory of the volume mount
          { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" },
        ],
        resources: {
          requests: { memory: "128Mi", cpu: "50m" },
          limits: { memory: this.postgresMemoryLimit, cpu: this.postgresCpuLimit },
        },
        volumeMounts: [
          { name: "postgres-data", mountPath: "/var/lib/postgresql/data" },
        ],
        // No probes allowed on sidecar containers in Knative Serving
      })
    }

    // Build volumes array
    const volumes: any[] = [
      {
        name: "project-data",
        persistentVolumeClaim: { claimName: `pvc-project-${projectId}` },
      },
    ]

    // Add PostgreSQL data volume if enabled
    if (this.postgresEnabled) {
      volumes.push({
        name: "postgres-data",
        persistentVolumeClaim: { claimName: `pvc-postgres-${projectId}` },
      })
    }

    return {
      apiVersion: `${KNATIVE_GROUP}/${KNATIVE_VERSION}`,
      kind: "Service",
      metadata: {
        name: `project-${projectId}`,
        namespace: this.namespace,
        labels: {
          "app.kubernetes.io/part-of": "shogo",
          "shogo.io/project": projectId,
          "shogo.io/component": "project-runtime",
        },
      },
      spec: {
        template: {
          metadata: {
            annotations: {
              "autoscaling.knative.dev/min-scale": "0",
              "autoscaling.knative.dev/max-scale": "1",
              "autoscaling.knative.dev/scale-to-zero-pod-retention-period": `${this.idleTimeoutSeconds}s`,
              "autoscaling.knative.dev/target": "10",
            },
          },
          spec: {
            timeoutSeconds: 600,
            // Security context - fsGroup ensures PVCs are accessible
            // PostgreSQL needs gid 999 (postgres group), project-runtime needs 1001
            // Using 999 allows both to work (postgres is owner, runtime can read/write)
            securityContext: {
              fsGroup: 999,
            },
            containers,
            volumes,
          },
        },
      },
    }
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let _manager: KnativeProjectManager | null = null

export function getKnativeProjectManager(): KnativeProjectManager {
  if (!_manager) {
    _manager = new KnativeProjectManager()
  }
  return _manager
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get the URL for a project pod.
 * In Kubernetes, creates the pod if it doesn't exist and waits for it to be ready.
 * In local dev, throws an error (use RuntimeManager instead).
 */
export async function getProjectPodUrl(projectId: string): Promise<string> {
  if (!isKubernetes()) {
    // Local development fallback
    const basePort = parseInt(process.env.RUNTIME_BASE_PORT || "5200", 10)
    return `http://localhost:${basePort}`
  }

  const totalStartTime = Date.now()
  console.log(`[KnativeProjectManager] getProjectPodUrl started for ${projectId}`)
  
  const manager = getKnativeProjectManager()
  const status = await manager.getStatus(projectId)

  if (!status.exists) {
    // Create the project pod
    console.log(`[KnativeProjectManager] Project ${projectId} does not exist, creating... (elapsed: ${Date.now() - totalStartTime}ms)`)
    await manager.createProject(projectId)
    // Wait for the pod to be ready before returning the URL
    // This prevents "connection refused" errors when proxying immediately after creation
    console.log(`[KnativeProjectManager] Waiting for project ${projectId} to be ready... (elapsed: ${Date.now() - totalStartTime}ms)`)
    await manager.waitForReady(projectId, 60000)
  } else if (!status.ready) {
    // Pod exists but isn't ready (cold start from scale-to-zero)
    // Wait for it to become ready
    console.log(`[KnativeProjectManager] Project ${projectId} exists but not ready (cold start), waiting... (elapsed: ${Date.now() - totalStartTime}ms)`)
    await manager.waitForReady(projectId, 30000)
  } else {
    console.log(`[KnativeProjectManager] Project ${projectId} already running (warm hit) (elapsed: ${Date.now() - totalStartTime}ms)`)
  }

  const totalDuration = Date.now() - totalStartTime
  console.log(`[KnativeProjectManager] getProjectPodUrl completed for ${projectId} in ${totalDuration}ms`)
  return manager.getProjectPodUrl(projectId)
}
