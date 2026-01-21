/**
 * Knative Project Manager
 *
 * Manages the lifecycle of per-project Knative Services:
 * - Creates Knative Services for projects on demand
 * - Creates PVCs for project storage
 * - Provides URLs for routing to project pods
 * - Handles scale-to-zero and cold starts
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

  constructor(config: KnativeProjectManagerConfig = {}) {
    this.namespace = config.namespace || NAMESPACE
    this.image = config.image || PROJECT_RUNTIME_IMAGE
    this.idleTimeoutSeconds = config.idleTimeoutSeconds || 300 // 5 minutes
    this.memoryLimit = config.memoryLimit || "2Gi"
    this.cpuLimit = config.cpuLimit || "1000m"
    this.s3WorkspacesBucket = config.s3WorkspacesBucket || process.env.S3_WORKSPACES_BUCKET || null
    this.s3Endpoint = config.s3Endpoint || process.env.S3_ENDPOINT || null
    this.s3Region = config.s3Region || process.env.S3_REGION || "us-east-1"
    this.s3ForcePathStyle = config.s3ForcePathStyle ?? (process.env.S3_FORCE_PATH_STYLE === "true")
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
    console.log(`[KnativeProjectManager] Creating project: ${projectId}`)

    // Check if already exists
    const status = await this.getStatus(projectId)
    if (status.exists) {
      console.log(`[KnativeProjectManager] Project ${projectId} already exists`)
      return this.getProjectPodUrl(projectId)
    }

    // Create PVC first - needed for project code storage
    await this.ensurePVC(projectId)

    // Create Knative Service
    const service = this.buildKnativeService(projectId)
    const api = getCustomApi()

    await api.createNamespacedCustomObject({
      group: KNATIVE_GROUP,
      version: KNATIVE_VERSION,
      namespace: this.namespace,
      plural: "services",
      body: service,
    })

    console.log(`[KnativeProjectManager] Created Knative Service: project-${projectId}`)
    return this.getProjectPodUrl(projectId)
  }

  /**
   * Delete a project's Knative Service and PVC.
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

    // Delete PVC
    try {
      await coreApi.deleteNamespacedPersistentVolumeClaim({
        name: `pvc-project-${projectId}`,
        namespace: this.namespace,
      })
      console.log(`[KnativeProjectManager] Deleted PVC: pvc-project-${projectId}`)
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

    while (Date.now() - startTime < timeoutMs) {
      const status = await this.getStatus(projectId)
      
      if (status.ready) {
        // Double-check with an active health probe
        const healthy = await this.healthCheck(projectId)
        if (healthy) {
          console.log(`[KnativeProjectManager] Project ${projectId} is ready and healthy`)
          return
        }
        console.log(`[KnativeProjectManager] Project ${projectId} reports ready but health check failed, retrying...`)
      }
      
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

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
   * Ensure project has a PVC for storage.
   */
  private async ensurePVC(projectId: string): Promise<void> {
    const coreApi = getCoreApi()
    const pvcName = `pvc-project-${projectId}`

    try {
      await coreApi.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace: this.namespace })
      console.log(`[KnativeProjectManager] PVC ${pvcName} already exists`)
      return
    } catch (error: any) {
      // Kubernetes client uses error.code for HTTP status codes
      if (error?.code !== 404 && error?.response?.statusCode !== 404) throw error
    }

    // Create PVC
    const pvc: k8s.V1PersistentVolumeClaim = {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: pvcName,
        namespace: this.namespace,
        labels: {
          "app.kubernetes.io/part-of": "shogo",
          "shogo.io/project": projectId,
          "shogo.io/component": "project-storage",
        },
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: process.env.STORAGE_CLASS_NAME || "ebs-sc",
        resources: {
          requests: { storage: "1Gi" },
        },
      },
    }

    await coreApi.createNamespacedPersistentVolumeClaim({ namespace: this.namespace, body: pvc })
    console.log(`[KnativeProjectManager] Created PVC: ${pvcName}`)
  }

  /**
   * Build the Knative Service spec for a project.
   */
  private buildKnativeService(projectId: string): any {
    // Build environment variables
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
            // Security context - fsGroup ensures PVC is accessible by appuser (gid 1001)
            securityContext: {
              fsGroup: 1001,
            },
            containers: [
              {
                name: "project-runtime",
                image: this.image,
                ports: [{ containerPort: 8080, name: "http1" }],
                env,
                resources: {
                  requests: { memory: "256Mi", cpu: "100m" },
                  limits: { memory: this.memoryLimit, cpu: this.cpuLimit },
                },
                volumeMounts: [{ name: "project-data", mountPath: "/app/project" }],
                // Readiness probe - checks if the pod is ready to receive traffic
                // Uses /ready endpoint which verifies project directory exists
                readinessProbe: {
                  httpGet: {
                    path: "/ready",
                    port: 8080,
                  },
                  initialDelaySeconds: 5,
                  periodSeconds: 5,
                  timeoutSeconds: 5,
                  successThreshold: 1,
                  failureThreshold: 6,
                },
                // Liveness probe - checks if the pod is still alive
                livenessProbe: {
                  httpGet: {
                    path: "/health",
                    port: 8080,
                  },
                  initialDelaySeconds: 30,
                  periodSeconds: 30,
                  timeoutSeconds: 10,
                  successThreshold: 1,
                  failureThreshold: 3,
                },
              },
            ],
            // PVC for project data - enables code persistence across pod restarts
            volumes: [
              {
                name: "project-data",
                persistentVolumeClaim: { claimName: `pvc-project-${projectId}` },
              },
            ],
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

  const manager = getKnativeProjectManager()
  const status = await manager.getStatus(projectId)

  if (!status.exists) {
    // Create the project pod
    await manager.createProject(projectId)
    // Wait for the pod to be ready before returning the URL
    // This prevents "connection refused" errors when proxying immediately after creation
    console.log(`[KnativeProjectManager] Waiting for project ${projectId} to be ready...`)
    await manager.waitForReady(projectId, 60000)
  } else if (!status.ready) {
    // Pod exists but isn't ready (cold start from scale-to-zero)
    // Wait for it to become ready
    console.log(`[KnativeProjectManager] Project ${projectId} exists but not ready, waiting...`)
    await manager.waitForReady(projectId, 30000)
  }

  return manager.getProjectPodUrl(projectId)
}
