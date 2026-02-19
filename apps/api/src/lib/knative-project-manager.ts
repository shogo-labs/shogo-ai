/**
 * Knative Project Manager
 *
 * Manages the lifecycle of per-project Knative Services:
 * - Creates Knative Services for projects on demand
 * - Provisions per-project databases on shared CloudNativePG cluster
 * - Provides URLs for routing to project pods
 * - Handles scale-to-zero and cold starts
 *
 * Architecture:
 * Each project pod contains a single container:
 * 1. project-runtime: The main application (Claude Code, MCP, Vite)
 *
 * Database:
 * Projects use a shared CloudNativePG PostgreSQL cluster (projects-pg).
 * Each project gets its own database (project_{uuid}) provisioned on demand.
 * This replaces the previous PostgreSQL sidecar pattern for:
 * - Better resource utilization (no per-pod postgres overhead)
 * - Faster cold starts (no postgres startup wait)
 * - Centralized backups (CloudNativePG handles WAL archiving)
 * - Portable across EKS, k3s, and bare metal
 *
 * Used by the API to proxy requests to project-specific runtimes.
 */

import * as k8s from "@kubernetes/client-node"
import * as fs from "fs"
import { generateProxyToken } from './ai-proxy-token'
import * as databaseService from '../services/database.service'

// =============================================================================
// Configuration
// =============================================================================

const NAMESPACE = process.env.PROJECT_NAMESPACE || "shogo-workspaces"
const PROJECT_RUNTIME_IMAGE = process.env.PROJECT_RUNTIME_IMAGE || "ghcr.io/shogo-ai/project-runtime:latest"
const AGENT_RUNTIME_IMAGE = process.env.AGENT_RUNTIME_IMAGE || "ghcr.io/shogo-ai/agent-runtime:latest"
const KNATIVE_GROUP = "serving.knative.dev"
const KNATIVE_VERSION = "v1"

// Preview subdomain configuration
// Format varies by environment:
//   Staging:    preview--{projectId}.staging.shogo.ai  (requires *.staging.shogo.ai cert)
//   Production: preview--{projectId}.shogo.ai         (uses existing *.shogo.ai cert)
// 
// This keeps subdomains clean and allows different certs per environment.
const PREVIEW_BASE_DOMAIN = process.env.PREVIEW_BASE_DOMAIN || "shogo.ai"
const PREVIEW_ENVIRONMENT = process.env.PREVIEW_ENVIRONMENT || process.env.ENVIRONMENT || "staging"
const IS_PRODUCTION = PREVIEW_ENVIRONMENT === "production" || PREVIEW_ENVIRONMENT === "prod"

// Log preview configuration on module load
console.log(`[knative-project-manager] Preview config: PREVIEW_BASE_DOMAIN=${PREVIEW_BASE_DOMAIN}, PREVIEW_ENVIRONMENT=${PREVIEW_ENVIRONMENT}, IS_PRODUCTION=${IS_PRODUCTION}`)

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
  /** Preview subdomain URL (when DomainMapping exists) */
  previewUrl?: string
}

/**
 * Build the preview subdomain for a project.
 * Format varies by environment:
 *   Staging:    preview--{projectId}.staging.shogo.ai
 *   Production: preview--{projectId}.shogo.ai
 */
export function getPreviewSubdomain(projectId: string): string {
  if (IS_PRODUCTION) {
    // Production: preview--{id}.shogo.ai
    return `preview--${projectId}.${PREVIEW_BASE_DOMAIN}`
  }
  // Non-production (staging, dev, etc.): preview--{id}.{env}.shogo.ai
  return `preview--${projectId}.${PREVIEW_ENVIRONMENT}.${PREVIEW_BASE_DOMAIN}`
}

/**
 * Get the full preview URL for a project (with https://)
 */
export function getPreviewUrl(projectId: string): string {
  return `https://${getPreviewSubdomain(projectId)}`
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
  /** Shared PostgreSQL configuration (CloudNativePG) */
  postgres?: {
    /** Enable shared PostgreSQL database provisioning (default: true) */
    enabled?: boolean
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
  // Shared PostgreSQL configuration (CloudNativePG)
  private postgresEnabled: boolean

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
    // Shared PostgreSQL configuration (CloudNativePG cluster)
    this.postgresEnabled = config.postgres?.enabled ?? (process.env.POSTGRES_ENABLED !== "false")
  }

  /**
   * Get the internal cluster URL for a project pod.
   * This URL is used for proxying requests from the API to the project runtime.
   */
  getProjectPodUrl(projectId: string): string {
    if (!isKubernetes()) {
      // Local development requires Knative
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
   * Create a DomainMapping for the project's preview subdomain.
   * Maps preview--{projectId}--{env}.{domain} to the Knative Service.
   */
  async createPreviewDomainMapping(projectId: string): Promise<void> {
    const domainName = getPreviewSubdomain(projectId)
    const serviceName = `project-${projectId}`
    
    console.log(`[KnativeProjectManager] Creating DomainMapping: ${domainName} -> ${serviceName}`)
    
    const api = getCustomApi()
    
    const domainMapping = {
      apiVersion: `${KNATIVE_GROUP}/v1beta1`,
      kind: "DomainMapping",
      metadata: {
        name: domainName,
        namespace: this.namespace,
        labels: {
          "app.kubernetes.io/part-of": "shogo",
          "shogo.io/project": projectId,
          "shogo.io/component": "preview-domain",
        },
      },
      spec: {
        ref: {
          name: serviceName,
          kind: "Service",
          apiVersion: `${KNATIVE_GROUP}/${KNATIVE_VERSION}`,
        },
      },
    }
    
    try {
      await api.createNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: "v1beta1",
        namespace: this.namespace,
        plural: "domainmappings",
        body: domainMapping,
      })
      console.log(`[KnativeProjectManager] Created DomainMapping: ${domainName}`)
    } catch (error: any) {
      // Handle race condition: if DomainMapping already exists, that's fine
      const statusCode = error?.response?.statusCode || error?.statusCode || error?.body?.code
      if (statusCode === 409 || error?.message?.includes('already exists') || error?.body?.reason === 'AlreadyExists') {
        console.log(`[KnativeProjectManager] DomainMapping ${domainName} already exists`)
      } else {
        console.error(`[KnativeProjectManager] Failed to create DomainMapping ${domainName}:`, error)
        throw error
      }
    }
  }

  /**
   * Delete a project's preview DomainMapping.
   */
  async deletePreviewDomainMapping(projectId: string): Promise<void> {
    const domainName = getPreviewSubdomain(projectId)
    const api = getCustomApi()
    
    try {
      await api.deleteNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: "v1beta1",
        namespace: this.namespace,
        plural: "domainmappings",
        name: domainName,
      })
      console.log(`[KnativeProjectManager] Deleted DomainMapping: ${domainName}`)
    } catch (error: any) {
      if (error?.code !== 404 && error?.response?.statusCode !== 404) {
        console.error(`[KnativeProjectManager] Failed to delete DomainMapping ${domainName}:`, error)
        throw error
      }
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
   *
   * Deduplicates concurrent calls — if multiple requests arrive for the same project,
   * they share a single creation promise (prevents duplicate DB provisioning and K8s resource races).
   */
  async createProject(projectId: string): Promise<string> {
    // Check if there's already a pending creation for this project
    const pending = pendingCreateRequests.get(projectId)
    if (pending) {
      const waitTime = Date.now() - pending.startTime
      console.log(`[KnativeProjectManager] Joining existing createProject for ${projectId} (already in progress ${waitTime}ms)`)
      return pending.promise
    }

    const startTime = Date.now()
    const createPromise = this._doCreateProject(projectId)

    // Store the pending request so concurrent callers can join
    pendingCreateRequests.set(projectId, {
      promise: createPromise,
      startTime,
    })

    // Ensure cleanup happens regardless of outcome
    createPromise.finally(() => {
      pendingCreateRequests.delete(projectId)
    })

    // Safety cleanup for stale entries (in case of memory leaks)
    setTimeout(() => {
      const entry = pendingCreateRequests.get(projectId)
      if (entry && Date.now() - entry.startTime > 5 * 60 * 1000) {
        console.log(`[KnativeProjectManager] Cleaning up stale createProject request for ${projectId}`)
        pendingCreateRequests.delete(projectId)
      }
    }, 5 * 60 * 1000)

    return createPromise
  }

  /**
   * Internal implementation of project creation (called once per project, guarded by dedup map).
   */
  private async _doCreateProject(projectId: string): Promise<string> {
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
    const service = await this.buildKnativeService(projectId)
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
    
    // Create DomainMapping for preview subdomain (non-blocking, log errors but don't fail)
    try {
      await this.createPreviewDomainMapping(projectId)
    } catch (error: any) {
      console.error(`[KnativeProjectManager] Failed to create preview DomainMapping for ${projectId}:`, error.message)
      // Don't fail project creation - DomainMapping is a nice-to-have
    }
    
    return this.getProjectPodUrl(projectId)
  }

  /**
   * Delete a project's Knative Service, DomainMapping, and PVCs.
   * Removes both the project code PVC and PostgreSQL data PVC.
   */
  async deleteProject(projectId: string): Promise<void> {
    console.log(`[KnativeProjectManager] Deleting project: ${projectId}`)

    const api = getCustomApi()
    const coreApi = getCoreApi()

    // Delete preview DomainMapping first
    try {
      await this.deletePreviewDomainMapping(projectId)
    } catch (error: any) {
      console.error(`[KnativeProjectManager] Failed to delete preview DomainMapping for ${projectId}:`, error.message)
      // Continue with service deletion even if DomainMapping fails
    }

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

    // Note: Both project code and postgres now use emptyDir + S3 sync/backup
    // Cleanup legacy PVCs if they exist from older deployments
    try {
      await coreApi.deleteNamespacedPersistentVolumeClaim({
        name: `pvc-project-${projectId}`,
        namespace: this.namespace,
      })
      console.log(`[KnativeProjectManager] Deleted legacy PVC: pvc-project-${projectId}`)
    } catch (error: any) {
      // Ignore not found - expected for new projects using emptyDir
      if (error?.code !== 404 && error?.response?.statusCode !== 404) throw error
    }

    // Cleanup legacy PostgreSQL PVC if exists from older deployments
    try {
      await coreApi.deleteNamespacedPersistentVolumeClaim({
        name: `pvc-postgres-${projectId}`,
        namespace: this.namespace,
      })
      console.log(`[KnativeProjectManager] Deleted legacy PVC: pvc-postgres-${projectId}`)
    } catch (error: any) {
      // Ignore not found - expected for new projects using emptyDir + S3 backup
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
    })

    console.log(`[KnativeProjectManager] Scaled project ${projectId} to ${replicas} replica(s)`)
  }

  /**
   * Ensure project has PVCs for storage.
   * 
   * Note: Both project code/files AND PostgreSQL data now use emptyDir (ephemeral storage).
   * - Project files are synced to/from S3 for persistence
   * - PostgreSQL data is backed up to S3 using pg_dump on shutdown and restored on startup
   * 
   * This approach avoids:
   * - EBS Multi-Attach errors (EBS is ReadWriteOnce, causes issues with Knative scale-to-zero)
   * - EFS permission issues (chown errors with postgres user)
   * 
   * No PVCs are created - everything uses emptyDir + S3 backup.
   */
  private async ensurePVC(projectId: string): Promise<void> {
    // No PVCs needed anymore - both project files and postgres use emptyDir + S3 sync/backup
    // This method is kept for backwards compatibility and cleanup of legacy PVCs
    console.log(`[KnativeProjectManager] No PVC creation needed for ${projectId} (using emptyDir + S3)`)
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
      accessMode?: string  // ReadWriteOnce (EBS) or ReadWriteMany (EFS)
    }
  ): Promise<void> {
    const { name, projectId, component, storageClass, size, accessMode = "ReadWriteOnce" } = options
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
        accessModes: [accessMode],
        storageClassName: storageClass,
        resources: {
          requests: { storage: size },
        },
      },
    }

    await coreApi.createNamespacedPersistentVolumeClaim({ namespace: this.namespace, body: pvc })
    console.log(`[KnativeProjectManager] Created PVC: ${name} with ${accessMode} (${Date.now() - pvcStartTime}ms)`)
  }

  /**
   * Build the Knative Service spec for a project.
   * Includes PostgreSQL sidecar container for per-project database.
   */
  private async buildKnativeService(projectId: string): Promise<any> {
    // Look up project type to select the correct runtime image
    const { prisma } = await import('./prisma')
    const projectRecord = await prisma.project.findUnique({
      where: { id: projectId },
      select: { type: true },
    })
    const isAgentProject = projectRecord?.type === 'AGENT'
    const runtimeImage = isAgentProject ? AGENT_RUNTIME_IMAGE : this.image
    const runtimeComponent = isAgentProject ? 'agent-runtime' : 'project-runtime'
    const workDir = isAgentProject ? '/app/agent' : '/app/project'

    // Build environment variables for runtime container
    const env: any[] = [
      { name: "PROJECT_ID", value: projectId },
      { name: "PROJECT_DIR", value: workDir },
      ...(isAgentProject ? [{ name: "AGENT_DIR", value: workDir }] : []),
      { name: "SCHEMAS_PATH", value: "/app/.schemas" },
      // Auth secret for validating preview JWT tokens
      {
        name: "BETTER_AUTH_SECRET",
        valueFrom: {
          secretKeyRef: { name: "preview-secrets", key: "BETTER_AUTH_SECRET" },
        },
      },
    ]

    // AI Proxy configuration
    // When the proxy is configured, the project-runtime routes ALL AI calls
    // (including Claude Code CLI) through the proxy. No raw API keys are exposed.
    //
    // How it works:
    // - AI_PROXY_URL + AI_PROXY_TOKEN are injected into the pod
    // - project-runtime sets ANTHROPIC_BASE_URL → proxy's Anthropic-native endpoint
    // - project-runtime sets ANTHROPIC_API_KEY → proxy token (validated by proxy)
    // - The proxy forwards to the real Anthropic API using server-side keys
    //
    // Fallback: If proxy token generation fails, inject the raw ANTHROPIC_API_KEY
    // from K8s secrets so the pod can still function.
    // Derive the API service URL from the pod's own namespace (e.g., shogo-staging-system)
    // The API is a Knative service exposed on port 80 via kourier
    const systemNamespace = process.env.SYSTEM_NAMESPACE || 'shogo-staging-system'
    const apiUrl = process.env.API_URL || process.env.SHOGO_API_URL || `http://api.${systemNamespace}.svc.cluster.local`
    env.push({ name: "AI_PROXY_URL", value: `${apiUrl}/api/ai/v1` })

    let proxyTokenGenerated = false

    // Generate a long-lived proxy token for this project (7 days, refreshed on pod creation)
    try {
      // Look up the project's workspace for billing context
      const { prisma } = await import('./prisma')
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { workspaceId: true },
      })
      if (project) {
        const proxyToken = await generateProxyToken(
          projectId,
          project.workspaceId,
          'system', // System-generated token for the runtime
          7 * 24 * 60 * 60 * 1000 // 7 days
        )
        env.push({ name: "AI_PROXY_TOKEN", value: proxyToken })
        proxyTokenGenerated = true
        console.log(`[KnativeProjectManager] Generated AI proxy token for project ${projectId} (no raw API key exposed)`)
      } else {
        console.warn(`[KnativeProjectManager] Project ${projectId} not found, skipping AI proxy token`)
      }
    } catch (err: any) {
      console.error(`[KnativeProjectManager] Failed to generate AI proxy token for ${projectId}:`, err.message)
    }

    // If proxy token generation failed, AI features will be unavailable in the pod.
    // We intentionally do NOT fall back to injecting the raw ANTHROPIC_API_KEY secret
    // to prevent exposing API keys to user code running inside project pods.
    if (!proxyTokenGenerated) {
      console.warn(`[KnativeProjectManager] AI proxy token not generated for ${projectId} — AI features will be unavailable in this pod`)
    }

    // Add PostgreSQL DATABASE_URL for shared CloudNativePG cluster
    // Database is provisioned per-project on the shared projects-pg cluster
    // Credentials are stored in a K8s Secret and referenced via secretKeyRef
    // so that password rotation doesn't require pod recreation
    if (this.postgresEnabled) {
      // Retry database provisioning up to 3 times (CNPG cluster may be briefly unavailable)
      let dbInfo: Awaited<ReturnType<typeof databaseService.provisionDatabase>> | null = null
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          dbInfo = await databaseService.provisionDatabase(projectId)
          break
        } catch (err: any) {
          console.error(`[KnativeProjectManager] Database provisioning attempt ${attempt}/3 failed for ${projectId}:`, err.message)
          if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt))
          }
        }
      }

      if (dbInfo) {
        const credSecretName = databaseService.dbSecretName(projectId)
        // If the Secret was created (password is non-empty), reference it via secretKeyRef.
        // This is the preferred path: password lives only in the Secret, not in the ksvc spec.
        // If the Secret wasn't created (legacy project, empty password), fall back to inline value.
        if (dbInfo.password) {
          env.push({
            name: "DATABASE_URL",
            valueFrom: {
              secretKeyRef: {
                name: credSecretName,
                key: "database-url",
              },
            },
          })
          console.log(`[KnativeProjectManager] Provisioned database "${dbInfo.databaseName}" for project ${projectId} (credentials in Secret "${credSecretName}")`)
        } else {
          // Legacy fallback: K8s Secret doesn't exist yet. Use inline value.
          // This path is temporary — the migration script will create the missing Secrets.
          env.push({
            name: "DATABASE_URL",
            value: dbInfo.connectionUrl,
          })
          console.log(`[KnativeProjectManager] Provisioned database "${dbInfo.databaseName}" for project ${projectId} (legacy: inline credentials)`)
        }
      } else {
        // DATABASE_URL is required for all templates — fail the project creation
        throw new Error(`Failed to provision database for project ${projectId} after 3 attempts. Check CloudNativePG cluster health.`)
      }
      // Disable postgres S3 backup (CloudNativePG handles backups via Barman)
      env.push({ name: "POSTGRES_S3_BACKUP_ENABLED", value: "false" })
    }

    // Add S3 configuration if bucket is specified
    // S3 sync is critical for emptyDir volumes - provides persistence across restarts
    if (this.s3WorkspacesBucket) {
      env.push({ name: "S3_WORKSPACES_BUCKET", value: this.s3WorkspacesBucket })
      env.push({ name: "S3_REGION", value: this.s3Region })
      // Enable file watching for real-time sync (required for emptyDir persistence)
      env.push({ name: "S3_WATCH_ENABLED", value: "true" })
      // Sync every 30 seconds for faster backup
      env.push({ name: "S3_SYNC_INTERVAL", value: "30000" })
      
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
        name: runtimeComponent,
        image: runtimeImage,
        imagePullPolicy: "Always", // Always pull to get latest staging-latest tag
        ports: [{ containerPort: 8080, name: "http1" }],
        env,
        resources: {
          requests: { memory: "256Mi", cpu: "100m" },
          limits: { memory: this.memoryLimit, cpu: this.cpuLimit },
        },
        volumeMounts: [{ name: "project-data", mountPath: workDir }],
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

    // NOTE: PostgreSQL sidecar removed. Projects now use shared CloudNativePG cluster.
    // Database is provisioned per-project via databaseService.provisionDatabase()
    // and the DATABASE_URL env var points to the shared cluster.

    // Build volumes array
    // Project data uses emptyDir for faster cold starts (~6s faster than EBS)
    // Files are synced to/from S3 for persistence across restarts
    const volumes: any[] = [
      {
        name: "project-data",
        emptyDir: { sizeLimit: "2Gi" },
      },
    ]

    // NOTE: postgres-data volume removed. Database is on shared CloudNativePG cluster.

    return {
      apiVersion: `${KNATIVE_GROUP}/${KNATIVE_VERSION}`,
      kind: "Service",
      metadata: {
        name: `project-${projectId}`,
        namespace: this.namespace,
        labels: {
          "app.kubernetes.io/part-of": "shogo",
          "shogo.io/project": projectId,
          "shogo.io/component": runtimeComponent,
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
 * Request deduplication cache for createProject.
 * When multiple requests try to create the same project simultaneously,
 * they share a single creation promise. This prevents duplicate database
 * provisioning and Kubernetes resource creation races.
 */
const pendingCreateRequests = new Map<string, {
  promise: Promise<string>
  startTime: number
}>()

/**
 * Request deduplication cache for getProjectPodUrl.
 * When multiple requests come in for the same project during cold start,
 * they all share the same promise instead of each creating separate waits.
 * This prevents redundant API calls and race conditions.
 */
const pendingPodRequests = new Map<string, {
  promise: Promise<string>
  startTime: number
}>()

// Clean up stale entries after 5 minutes
const PENDING_REQUEST_CLEANUP_MS = 5 * 60 * 1000

/**
 * Get the URL for a project pod.
 * In Kubernetes, creates the pod if it doesn't exist and waits for it to be ready.
 * In local dev without Knative, throws an error.
 * 
 * This function deduplicates concurrent requests - if multiple requests come in
 * for the same project while it's starting, they all share the same wait promise.
 *
 * Warm Pool integration:
 * When a project doesn't have a running Knative Service, this function attempts
 * to claim a warm pod from the pool first. If a warm pod is available:
 * 1. The warm pod is assigned the project identity (instant)
 * 2. The warm pod URL is returned immediately
 * 3. The real Knative Service is created in the background (for future cold starts)
 * If no warm pod is available, falls back to cold start.
 */
export async function getProjectPodUrl(projectId: string): Promise<string> {
  if (!isKubernetes()) {
    // Local development fallback
    const basePort = parseInt(process.env.RUNTIME_BASE_PORT || "5200", 10)
    return `http://localhost:${basePort}`
  }

  // Check if there's already a pending request for this project
  const pending = pendingPodRequests.get(projectId)
  if (pending) {
    const waitTime = Date.now() - pending.startTime
    console.log(`[KnativeProjectManager] Joining existing wait for ${projectId} (already waiting ${waitTime}ms)`)
    return pending.promise
  }

  const totalStartTime = Date.now()
  console.log(`[KnativeProjectManager] getProjectPodUrl started for ${projectId}`)
  
  // Create the actual work promise
  const workPromise = (async (): Promise<string> => {
    try {
      const manager = getKnativeProjectManager()

      // Check if this project is already served by a warm pool pod
      const { getWarmPoolController } = await import('./warm-pool-controller')
      const warmPool = getWarmPoolController()
      const warmUrl = warmPool.getAssignedUrl(projectId)
      if (warmUrl) {
        console.log(`[KnativeProjectManager] Project ${projectId} served by warm pool (elapsed: ${Date.now() - totalStartTime}ms)`)
        return warmUrl
      }

      const status = await manager.getStatus(projectId)

      if (!status.exists) {
        // Project doesn't have a Knative Service — try warm pool first
        const warmPodUrl = await tryClaimWarmPod(projectId, manager)
        if (warmPodUrl) {
          const totalDuration = Date.now() - totalStartTime
          console.log(`[KnativeProjectManager] getProjectPodUrl completed for ${projectId} via warm pool in ${totalDuration}ms`)
          return warmPodUrl
        }

        // No warm pod available — fall back to cold start
        console.log(`[KnativeProjectManager] Project ${projectId} does not exist, creating (cold start)... (elapsed: ${Date.now() - totalStartTime}ms)`)
        await manager.createProject(projectId)
        console.log(`[KnativeProjectManager] Waiting for project ${projectId} to be ready... (elapsed: ${Date.now() - totalStartTime}ms)`)
        await manager.waitForReady(projectId, 180000)
      } else if (!status.ready) {
        // Pod exists but isn't ready (cold start from scale-to-zero)
        console.log(`[KnativeProjectManager] Project ${projectId} exists but not ready (cold start), waiting... (elapsed: ${Date.now() - totalStartTime}ms)`)
        await manager.waitForReady(projectId, 120000)
      } else {
        console.log(`[KnativeProjectManager] Project ${projectId} already running (warm hit) (elapsed: ${Date.now() - totalStartTime}ms)`)
      }

      const totalDuration = Date.now() - totalStartTime
      console.log(`[KnativeProjectManager] getProjectPodUrl completed for ${projectId} in ${totalDuration}ms`)
      return manager.getProjectPodUrl(projectId)
    } finally {
      // Clean up the pending request when done (success or failure)
      pendingPodRequests.delete(projectId)
    }
  })()

  // Store the pending request so other callers can join
  pendingPodRequests.set(projectId, {
    promise: workPromise,
    startTime: totalStartTime,
  })

  // Cleanup stale entries periodically (in case of memory leaks)
  setTimeout(() => {
    const entry = pendingPodRequests.get(projectId)
    if (entry && Date.now() - entry.startTime > PENDING_REQUEST_CLEANUP_MS) {
      console.log(`[KnativeProjectManager] Cleaning up stale pending request for ${projectId}`)
      pendingPodRequests.delete(projectId)
    }
  }, PENDING_REQUEST_CLEANUP_MS)

  return workPromise
}

/**
 * Attempt to claim a warm pod for a project.
 * If successful, assigns the project to the warm pod and kicks off
 * background creation of the real Knative Service.
 * Returns the warm pod URL on success, null on failure/unavailability.
 */
async function tryClaimWarmPod(
  projectId: string,
  manager: KnativeProjectManager
): Promise<string | null> {
  try {
    const { getWarmPoolController } = await import('./warm-pool-controller')
    const warmPool = getWarmPoolController()
    const poolStatus = warmPool.getStatus()
    if (!poolStatus.enabled) return null

    // Determine runtime type
    const { prisma } = await import('./prisma')
    const projectRecord = await prisma.project.findUnique({
      where: { id: projectId },
      select: { type: true },
    })
    const runtimeType = projectRecord?.type === 'AGENT' ? 'agent' as const : 'project' as const

    // Try to claim a warm pod
    const pod = warmPool.claim(runtimeType)
    if (!pod) {
      console.log(`[KnativeProjectManager] No warm ${runtimeType} pod available for ${projectId}`)
      return null
    }

    console.log(`[KnativeProjectManager] Claimed warm pod ${pod.serviceName} for ${projectId}`)

    // Build project-specific env vars
    const envVars = await warmPool.buildProjectEnv(projectId)

    // Assign the project to the warm pod (sends /pool/assign)
    await warmPool.assign(pod, projectId, envVars)

    // Create the real Knative Service in the background so future
    // cold starts (after the warm pod scales to zero) work correctly.
    // This is fire-and-forget — the warm pod is already serving.
    manager.createProject(projectId).catch((err) => {
      console.error(
        `[KnativeProjectManager] Background createProject for ${projectId} failed:`,
        err.message
      )
    })

    return pod.url
  } catch (err: any) {
    console.error(`[KnativeProjectManager] Warm pool claim failed for ${projectId}:`, err.message)
    return null
  }
}
