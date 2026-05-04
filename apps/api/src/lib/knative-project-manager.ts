// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Knative Project Manager
 *
 * Manages the lifecycle of per-project Knative Services:
 * - Creates Knative Services for development projects (runtime containers)
 * - Creates lightweight published services (nginx + S3 init container)
 * - Manages DomainMappings for preview and published subdomains
 * - Provides URLs for routing to project pods
 * - Handles scale-to-zero and cold starts
 *
 * Architecture:
 * Development projects: Single runtime container (agent-runtime)
 *   with emptyDir volume synced to/from S3.
 * Published apps: nginx:alpine serving static files from emptyDir,
 *   populated by an init container that syncs from S3.
 *   DomainMapping routes {subdomain}.shogo.one -> published-{projectId}.
 *
 * Used by the API to proxy requests to project-specific runtimes.
 */

import * as k8s from "@kubernetes/client-node"
import * as fs from "fs"
import { trace, SpanStatusCode } from "@opentelemetry/api"
import { generateProxyToken } from './ai-proxy-token'
import * as databaseService from '../services/database.service'
import { upsertPreviewDnsRecord, deletePreviewDnsRecord } from './cloudflare-dns'
import { RUNTIME_CONFIG } from '@shogo/shared-runtime'
import type { InstanceSizeName } from '../config/instance-sizes'

const knativeTracer = trace.getTracer('shogo-knative-manager')

// =============================================================================
// Configuration
// =============================================================================

const NAMESPACE = process.env.PROJECT_NAMESPACE || "shogo-workspaces"
const KNATIVE_GROUP = "serving.knative.dev"
const KNATIVE_VERSION = "v1"

// Preview subdomain configuration
// Format varies by environment:
//   Non-production: preview--{projectId}.{env}.{baseDomain}
//   Production:     preview--{projectId}.{baseDomain}
const PREVIEW_BASE_DOMAIN = process.env.PREVIEW_BASE_DOMAIN || "example.com"
const PREVIEW_ENVIRONMENT = process.env.PREVIEW_ENVIRONMENT || process.env.ENVIRONMENT || "dev"
const IS_PRODUCTION = PREVIEW_ENVIRONMENT === "production" || PREVIEW_ENVIRONMENT === "prod"

// Log preview configuration on module load
console.log(`[knative-project-manager] Preview config: PREVIEW_BASE_DOMAIN=${PREVIEW_BASE_DOMAIN}, PREVIEW_ENVIRONMENT=${PREVIEW_ENVIRONMENT}, IS_PRODUCTION=${IS_PRODUCTION}`)

// Hash a project UUID to a stable 32-bit integer for use as a PostgreSQL
// advisory lock key. Uses a simple FNV-1a hash to distribute evenly.
function hashProjectIdToLockKey(projectId: string): number {
  let hash = 0x811c9dc5 // FNV offset basis
  for (let i = 0; i < projectId.length; i++) {
    hash ^= projectId.charCodeAt(i)
    hash = (hash * 0x01000193) | 0 // FNV prime, force 32-bit
  }
  return hash
}

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
      clusters: [{ name: "in-cluster", server: host, caData: Buffer.from(ca).toString("base64") }],
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

/**
 * Perform a JSON Merge Patch (RFC 7386) on a Knative Service.
 * The @kubernetes/client-node library defaults to JSON Patch (RFC 6902, array
 * of operations) for PATCH calls, but we need Merge Patch (plain object).
 * This helper uses raw fetch with the correct Content-Type header.
 */
export async function mergePatchKnativeService(
  namespace: string,
  serviceName: string,
  patch: Record<string, any>,
): Promise<void> {
  const kc = getKubeConfig()
  const cluster = kc.getCurrentCluster()
  if (!cluster) throw new Error('No current K8s cluster configured')

  const user = kc.getCurrentUser()
  const url = `${cluster.server}/apis/${KNATIVE_GROUP}/${KNATIVE_VERSION}/namespaces/${namespace}/services/${serviceName}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/merge-patch+json',
    'Accept': 'application/json',
  }
  if (user?.token) {
    headers['Authorization'] = `Bearer ${user.token}`
  }

  const resp = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(patch),
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Merge-patch failed (${resp.status}): ${body}`)
  }
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
 *   Non-production: preview--{projectId}.{env}.{baseDomain}
 *   Production:     preview--{projectId}.{baseDomain}
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
    this.image = config.image || RUNTIME_CONFIG.image()
    // Default 30 min: scale-to-zero retention has to outlast normal
    // user-think-time between chat turns. The previous 300s caused
    // pods to recycle between every message, forcing cold-start S3
    // restores that block the runtime's `/ready` probe.
    this.idleTimeoutSeconds = config.idleTimeoutSeconds || parseInt(process.env.PROJECT_IDLE_TIMEOUT || "1800", 10)
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
   * Get the internal cluster URL for a project pod by convention (project-{id}).
   * For promoted warm pods with custom service names, use resolveProjectPodUrl().
   */
  getProjectPodUrl(projectId: string): string {
    if (!isKubernetes()) {
      throw new Error("KnativeProjectManager requires Kubernetes environment")
    }
    return `http://project-${projectId}.${this.namespace}.svc.cluster.local`
  }

  /**
   * Resolve the actual service URL for a project, checking DB mapping first.
   * Falls back to the project-{id} convention for legacy projects.
   */
  async resolveProjectPodUrl(projectId: string): Promise<string> {
    if (!isKubernetes()) {
      throw new Error("KnativeProjectManager requires Kubernetes environment")
    }

    try {
      const { prisma } = await import('./prisma')
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { knativeServiceName: true },
      })

      if (project?.knativeServiceName) {
        return `http://${project.knativeServiceName}.${this.namespace}.svc.cluster.local`
      }
    } catch (err: any) {
      console.error(`[KnativeProjectManager] Failed to look up knativeServiceName for ${projectId}:`, err.message)
    }

    return `http://project-${projectId}.${this.namespace}.svc.cluster.local`
  }

  /**
   * Check if a project's Knative Service exists and get its status.
   * Checks both the DB-mapped service name and the legacy project-{id} convention.
   */
  async getStatus(projectId: string): Promise<ProjectPodStatus> {
    const serviceName = await this.resolveServiceName(projectId)
    return this.getServiceStatus(serviceName, projectId)
  }

  async getServiceStatus(serviceName: string, projectId: string): Promise<ProjectPodStatus> {
    try {
      const api = getCustomApi()
      const response = await api.getNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: KNATIVE_VERSION,
        namespace: this.namespace,
        plural: "services",
        name: serviceName,
      })

      const service = response as any
      const metadata = service.metadata || {}
      const status = service.status || {}
      const conditions = status.conditions || []
      const readyCondition = conditions.find((c: any) => c.type === "Ready")

      return {
        exists: true,
        ready: readyCondition?.status === "True",
        url: status.url || `http://${serviceName}.${this.namespace}.svc.cluster.local`,
        replicas: status.actualReplicas || 0,
        message: readyCondition?.message,
        createdAt: metadata.creationTimestamp,
        updatedAt: status.observedGeneration ? metadata.generation?.toString() : undefined,
      }
    } catch (error: any) {
      if (error?.code === 404 || error?.response?.statusCode === 404) {
        return { exists: false, ready: false, url: null, replicas: 0 }
      }
      throw error
    }
  }

  /**
   * Create a DomainMapping for the project's preview subdomain.
   * Maps preview--{projectId}--{env}.{domain} to the Knative Service.
   * @param serviceName - Override the target service name (defaults to project-{id}).
   *   Pass the warm pool service name when the project is served by a warm pod.
   */
  async createPreviewDomainMapping(projectId: string, serviceName?: string): Promise<void> {
    const domainName = getPreviewSubdomain(projectId)
    const resolvedServiceName = serviceName || `project-${projectId}`
    
    console.log(`[KnativeProjectManager] Creating DomainMapping: ${domainName} -> ${resolvedServiceName}`)
    
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
          name: resolvedServiceName,
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
      const statusCode = error?.response?.statusCode || error?.statusCode || error?.body?.code
      if (statusCode === 409 || error?.message?.includes('already exists') || error?.body?.reason === 'AlreadyExists') {
        console.log(`[KnativeProjectManager] DomainMapping ${domainName} already exists — updating target to ${resolvedServiceName}`)
        await this.updatePreviewDomainMapping(projectId, resolvedServiceName)
      } else {
        console.error(`[KnativeProjectManager] Failed to create DomainMapping ${domainName}:`, error)
        throw error
      }
    }

    // Keep the Cloudflare A record for this hostname pointing at this
    // cluster's Kourier LB so cross-region routing picks the right origin.
    // No-op when CF_* env vars are unset (single-region / local dev).
    await upsertPreviewDnsRecord(domainName)
  }

  /**
   * Update an existing preview DomainMapping to point to a different Knative Service.
   * Used when a warm pool pod is evicted and re-assigned to a new pod.
   * Uses raw fetch with merge-patch+json content type since the K8s client
   * defaults to JSON Patch (RFC 6902) which doesn't work for spec.ref updates.
   */
  async updatePreviewDomainMapping(projectId: string, newServiceName: string): Promise<void> {
    const domainName = getPreviewSubdomain(projectId)

    const patch = {
      spec: {
        ref: {
          name: newServiceName,
          kind: "Service",
          apiVersion: `${KNATIVE_GROUP}/${KNATIVE_VERSION}`,
        },
      },
    }

    const kc = getKubeConfig()
    const cluster = kc.getCurrentCluster()
    if (!cluster) throw new Error('No current K8s cluster configured')

    const user = kc.getCurrentUser()
    const url = `${cluster.server}/apis/${KNATIVE_GROUP}/v1beta1/namespaces/${this.namespace}/domainmappings/${domainName}`

    const headers: Record<string, string> = {
      'Content-Type': 'application/merge-patch+json',
      'Accept': 'application/json',
    }
    if (user?.token) {
      headers['Authorization'] = `Bearer ${user.token}`
    }

    try {
      const resp = await fetch(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(patch),
      })

      if (resp.ok) {
        console.log(`[KnativeProjectManager] Updated DomainMapping ${domainName} -> ${newServiceName}`)
      } else if (resp.status === 404) {
        console.log(`[KnativeProjectManager] DomainMapping ${domainName} not found — creating fresh`)
        await this.createPreviewDomainMapping(projectId, newServiceName)
      } else {
        const body = await resp.text()
        console.error(`[KnativeProjectManager] Failed to update DomainMapping ${domainName}: ${resp.status} ${body}`)
      }
    } catch (error: any) {
      console.error(`[KnativeProjectManager] Failed to update DomainMapping ${domainName}:`, error)
      throw error
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

    // Remove the matching Cloudflare record (no-op when unconfigured).
    await deletePreviewDnsRecord(domainName)
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
        labelSelector: "shogo.io/component=runtime",
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
   * List all Knative services in the namespace (agent-runtime).
   * Used by the infra metrics collector to count all running pods.
   */
  async listAllServices(): Promise<ProjectPodInfo[]> {
    try {
      const api = getCustomApi()
      const response = await api.listNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: KNATIVE_VERSION,
        namespace: this.namespace,
        plural: "services",
        labelSelector: "app.kubernetes.io/part-of=shogo",
      })

      const items = (response as any).items || []
      const services: ProjectPodInfo[] = []

      for (const service of items) {
        const projectId = service.metadata?.labels?.["shogo.io/project"] || service.metadata?.name || ''
        const status = service.status || {}
        const conditions = status.conditions || []
        const readyCondition = conditions.find((c: any) => c.type === "Ready")

        services.push({
          projectId,
          name: service.metadata?.name,
          status: {
            exists: true,
            ready: readyCondition?.status === "True",
            url: status.url || '',
            replicas: status.actualReplicas || 0,
            message: readyCondition?.message,
            createdAt: service.metadata?.creationTimestamp,
          },
        })
      }

      return services
    } catch (error: any) {
      console.error("[KnativeProjectManager] Failed to list all services:", error)
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
    }

    // Save the service name in the database for routing
    try {
      const { prisma } = await import('./prisma')
      await prisma.project.update({
        where: { id: projectId },
        data: { knativeServiceName: `project-${projectId}` },
      })
    } catch (err: any) {
      console.error(`[KnativeProjectManager] Failed to save knativeServiceName for ${projectId}:`, err.message)
    }
    
    return this.getProjectPodUrl(projectId)
  }

  /**
   * Delete a project's Knative Service, DomainMapping, and PVCs.
   * Handles both promoted warm pods (custom service name) and legacy project-{id} services.
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
    }

    // Resolve the actual service name (may be a promoted warm pod)
    const serviceName = await this.resolveServiceName(projectId)

    // Delete the Knative Service
    try {
      await api.deleteNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: KNATIVE_VERSION,
        namespace: this.namespace,
        plural: "services",
        name: serviceName,
      })
      console.log(`[KnativeProjectManager] Deleted Knative Service: ${serviceName}`)
    } catch (error: any) {
      if (error?.code !== 404 && error?.response?.statusCode !== 404) throw error
    }

    // Also try deleting the legacy project-{id} service if the resolved name is different
    if (serviceName !== `project-${projectId}`) {
      try {
        await api.deleteNamespacedCustomObject({
          group: KNATIVE_GROUP,
          version: KNATIVE_VERSION,
          namespace: this.namespace,
          plural: "services",
          name: `project-${projectId}`,
        })
        console.log(`[KnativeProjectManager] Deleted legacy Knative Service: project-${projectId}`)
      } catch (error: any) {
        if (error?.code !== 404 && error?.response?.statusCode !== 404) throw error
      }
    }

    // Clear the DB mapping
    try {
      const { prisma } = await import('./prisma')
      await prisma.project.update({
        where: { id: projectId },
        data: { knativeServiceName: null },
      })
    } catch {
      // Project may already be deleted from DB
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
   * Resolves the actual Knative Service name from the DB before scaling.
   */
  async scaleProject(projectId: string, replicas: number): Promise<void> {
    const serviceName = await this.resolveServiceName(projectId)
    
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

    await mergePatchKnativeService(this.namespace, serviceName, patch)

    console.log(`[KnativeProjectManager] Scaled project ${projectId} (service: ${serviceName}) to ${replicas} replica(s)`)
  }

  /**
   * Resolve the Knative Service name for a project.
   * Checks the DB for a saved knativeServiceName (promoted warm pod),
   * falls back to the project-{id} convention.
   */
  private async resolveServiceName(projectId: string): Promise<string> {
    try {
      const { prisma } = await import('./prisma')
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { knativeServiceName: true },
      })
      if (project?.knativeServiceName) {
        return project.knativeServiceName
      }
    } catch (err: any) {
      console.error(`[KnativeProjectManager] Failed to resolve service name for ${projectId}:`, err.message)
    }
    return `project-${projectId}`
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
    const { prisma } = await import('./prisma')
    const projectRecord = await prisma.project.findUnique({
      where: { id: projectId },
      select: { templateId: true, name: true, workspaceId: true, settings: true },
    })
    const projectTechStackId = (() => {
      const s = projectRecord?.settings as { techStackId?: string } | null | undefined
      return s?.techStackId ?? null
    })()
    // Single unified runtime image. The base image pre-warms Bun's tarball
    // cache with the Expo + RN dependency tree, so mobile and web projects
    // share the same pod image (see Dockerfile.base). Per-stack pod sizing
    // is handled separately in instance-sizes.ts.
    const runtimeImage = RUNTIME_CONFIG.image()
    const runtimeComponent = RUNTIME_CONFIG.componentLabel
    const workDir = RUNTIME_CONFIG.workDir

    const extraEnvEntries = Object.entries(RUNTIME_CONFIG.extraEnv).map(([name, value]) => ({ name, value }))
    const env: any[] = [
      { name: "PROJECT_ID", value: projectId },
      { name: "PROJECT_DIR", value: workDir },
      // PUBLIC_PREVIEW_URL is the externally-reachable URL the runtime advertises
      // to its agents (for QA subagents, browser-use, etc.). In k8s this is the
      // preview--{id}.{env}.shogo.ai subdomain served via the DomainMapping
      // created by createPreviewDomainMapping(). Locally the runtime falls back
      // to http://localhost:${PORT}/ when this is unset.
      { name: "PUBLIC_PREVIEW_URL", value: getPreviewUrl(projectId) },
      ...extraEnvEntries,
      ...(projectRecord?.templateId ? [{ name: "TEMPLATE_ID", value: projectRecord.templateId }] : []),
      ...(projectRecord?.name ? [{ name: "AGENT_NAME", value: projectRecord.name }] : []),
      ...(projectRecord?.workspaceId ? [{ name: "WORKSPACE_ID", value: projectRecord.workspaceId }] : []),
      { name: "SCHEMAS_PATH", value: "/app/.schemas" },
      { name: "ENABLE_PTY", value: "0" },
    ]

    // AI Proxy configuration
    // When the proxy is configured, the runtime routes ALL AI calls
    // through the proxy. No raw API keys are exposed.
    //
    // How it works:
    // - AI_PROXY_URL + AI_PROXY_TOKEN are injected into the pod
    // - runtime sets ANTHROPIC_BASE_URL → proxy's Anthropic-native endpoint
    // - runtime sets ANTHROPIC_API_KEY → proxy token (validated by proxy)
    // - The proxy forwards to the real Anthropic API using server-side keys
    //
    // Fallback: If proxy token generation fails, inject the raw ANTHROPIC_API_KEY
    // from K8s secrets so the pod can still function.
    // Derive the API service URL from the pod's own namespace
    // The API is a Knative service exposed on port 80 via kourier
    const systemNamespace = process.env.SYSTEM_NAMESPACE || 'shogo-system'
    const apiUrl = process.env.API_URL || process.env.SHOGO_API_URL || `http://api.${systemNamespace}.svc.cluster.local`
    env.push({ name: "AI_PROXY_URL", value: `${apiUrl}/api/ai/v1` })
    env.push({ name: "TOOLS_PROXY_URL", value: `${apiUrl}/api/tools` })

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
        const { getProjectOwnerUserId } = await import('./project-user-context')
        const ownerUserId = await getProjectOwnerUserId(projectId)
        const proxyToken = await generateProxyToken(
          projectId,
          project.workspaceId,
          ownerUserId,
          7 * 24 * 60 * 60 * 1000 // 7 days
        )
        env.push({ name: "AI_PROXY_TOKEN", value: proxyToken })
        proxyTokenGenerated = true
        console.log(`[KnativeProjectManager] Generated AI proxy token for project ${projectId} (owner: ${ownerUserId})`)
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

    // Per-project runtime auth tokens (deterministic — derived from signing secret + projectId).
    // RUNTIME_AUTH_SECRET becomes the pod's bearer capability to call the
    // Shogo API on behalf of its project. Operator gotchas (rotation,
    // synthetic userId, pod = capability boundary, etc.) are documented
    // in apps/api/src/lib/runtime-token.md — read before changing how
    // this env var is constructed or exposed.
    const { deriveRuntimeToken, deriveWebhookToken } = await import('./runtime-token')
    env.push({ name: "RUNTIME_AUTH_SECRET", value: deriveRuntimeToken(projectId) })
    env.push({ name: "WEBHOOK_TOKEN", value: deriveWebhookToken(projectId) })

    // Inject public-facing URL so agent-runtime can build OAuth callback URLs (Composio, etc.)
    if (process.env.BETTER_AUTH_URL) {
      env.push({ name: "BETTER_AUTH_URL", value: process.env.BETTER_AUTH_URL })
    }

    // Public API URL for browser-facing contexts (e.g. webchat widget embed snippets)
    if (process.env.SHOGO_PUBLIC_API_URL) {
      env.push({ name: "SHOGO_PUBLIC_API_URL", value: process.env.SHOGO_PUBLIC_API_URL })
    }

    // Third-party API keys (Composio, Serper, OpenAI embeddings) are NOT
    // injected into pods. Agents proxy these requests through the API server
    // via TOOLS_PROXY_URL, which holds the real keys server-side.

    // Dev projects use SQLite (DATABASE_URL defaults to file:./prisma/dev.db in runtime).
    // No external database provisioning needed. Published apps get PostgreSQL sidecars (Phase 5).
    console.log(`[KnativeProjectManager] Dev project ${projectId} uses SQLite — no database provisioning`)

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

    // OTEL tracing — propagate to project/agent pods so they send traces to SigNoz
    if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      env.push({ name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: process.env.OTEL_EXPORTER_OTLP_ENDPOINT })
      env.push({ name: "OTEL_SERVICE_NAME", value: `shogo-${runtimeComponent}` })
      env.push({
        name: "SIGNOZ_INGESTION_KEY",
        valueFrom: {
          secretKeyRef: { name: "signoz-credentials", key: "SIGNOZ_INGESTION_KEY", optional: true },
        },
      })
    }

    // Resolve instance size for this workspace to determine resource allocation
    const { buildProjectResourceOverrides } = await import('../services/instance.service')
    const { applyTechStackFloor, getMobileDiskSizeLimit, isMobileTechStack } = await import('../config/instance-sizes')
    const workspaceId = projectRecord?.workspaceId
    let sizeOverrides: ReturnType<typeof buildProjectResourceOverrides> | null = null
    if (workspaceId) {
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { instanceSize: true },
      })
      if (workspace) {
        // Expo / RN stacks are too heavy for `micro`. Bump to the mobile
        // floor (currently `small`) regardless of the workspace tier so
        // users on the free tier can actually run their app.
        const effectiveSize = applyTechStackFloor(
          workspace.instanceSize as InstanceSizeName,
          projectTechStackId,
        )
        sizeOverrides = buildProjectResourceOverrides(workspaceId, effectiveSize)
        if (isMobileTechStack(projectTechStackId)) {
          sizeOverrides = {
            ...sizeOverrides,
            diskSizeLimit: getMobileDiskSizeLimit(effectiveSize),
          }
        }
      }
    }

    const resourceSpec = {
      requests: sizeOverrides?.requests ?? { memory: "768Mi", cpu: "100m" },
      limits: sizeOverrides?.limits ?? { memory: this.memoryLimit, cpu: this.cpuLimit },
    }

    const diskSizeLimit = sizeOverrides?.diskSizeLimit ?? "2Gi"
    // Default min-scale=1 keeps a warm replica for the entire idle-retention
    // window so back-to-back chats don't cold-start (the 116s tar extract
    // during S3 deps restore otherwise blocks Bun's event loop, /ready
    // probes start failing, and the activator's hardcoded 5-minute request
    // timeout cuts the in-flight chat with `eof-without-turn-complete`).
    // Callers that explicitly want scale-to-zero (e.g. eval workers) can
    // pass `minScale: 0` via sizeOverrides.
    const minScale = sizeOverrides?.minScale ?? 1

    // Build containers array
    const containers: any[] = [
      {
        name: RUNTIME_CONFIG.containerName,
        image: runtimeImage,
        imagePullPolicy: "Always",
        ports: [{ containerPort: 8080, name: "http1" }],
        env,
        resources: resourceSpec,
        volumeMounts: [{ name: "project-data", mountPath: workDir }],
        readinessProbe: {
          httpGet: {
            path: "/ready",
            port: 8080,
          },
          initialDelaySeconds: 3,
          periodSeconds: 3,
          timeoutSeconds: 3,
          successThreshold: 1,
          failureThreshold: 60,
        },
        livenessProbe: {
          httpGet: {
            path: "/health",
            port: 8080,
          },
          initialDelaySeconds: 15,
          periodSeconds: 15,
          timeoutSeconds: 5,
          successThreshold: 1,
          failureThreshold: 5,
        },
      },
    ]

    // NOTE: PostgreSQL sidecar removed. Projects now use shared CloudNativePG cluster.

    const volumes: any[] = [
      {
        name: "project-data",
        emptyDir: { sizeLimit: diskSizeLimit },
      },
    ]

    const podSpec: any = {
      // 3600s headroom for very long agent turns (heavy multi-tool runs,
      // browser_use loops, large file edits). Requires the cluster-level
      // `max-revision-timeout-seconds` in `knative-serving/config-defaults`
      // to be at least this value — `.github/workflows/deploy.yml` patches
      // it on every deploy.
      timeoutSeconds: 3600,
      responseStartTimeoutSeconds: 600,
      securityContext: { fsGroup: 999 },
      containers,
      volumes,
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
          "shogo.io/component": runtimeComponent,
        },
      },
      spec: {
        template: {
          metadata: {
            annotations: {
              "autoscaling.knative.dev/min-scale": String(minScale),
              "autoscaling.knative.dev/max-scale": "1",
              "autoscaling.knative.dev/scale-to-zero-pod-retention-period": `${this.idleTimeoutSeconds}s`,
              "autoscaling.knative.dev/target": "10",
              // Take the activator out of the request path once a replica is
              // ready. With `0`, requests bypass the activator's hardcoded
              // 5-minute `defaultRequestTimeout` (handler/timeout.go) which
              // was cutting in-flight chat streams mid-turn and surfacing as
              // `eof-without-turn-complete` in the API logs.
              "autoscaling.knative.dev/target-burst-capacity": "0",
            },
          },
          spec: podSpec,
        },
      },
    }
  }

  /**
   * Patch resource requests/limits, disk size, and min-scale on a running
   * project's Knative service. Used when a workspace upgrades/downgrades
   * instance size. Creating a new revision causes Knative to roll out a new pod.
   */
  async patchProjectResources(projectId: string, overrides: {
    requests?: Record<string, string>
    limits?: Record<string, string>
    diskSizeLimit?: string
    minScale?: number
  }): Promise<void> {
    const api = getCustomApi()
    const serviceName = `project-${projectId}`

    let existing: any
    try {
      existing = await api.getNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: KNATIVE_VERSION,
        namespace: this.namespace,
        plural: 'services',
        name: serviceName,
      })
    } catch (err: any) {
      if (err?.response?.statusCode === 404 || err?.body?.code === 404) {
        return
      }
      throw err
    }

    const template = (existing as any)?.spec?.template
    const spec = template?.spec
    if (!spec?.containers?.[0]) return

    const container = spec.containers[0]
    container.resources = {
      requests: overrides.requests || { memory: '768Mi', cpu: '100m' },
      limits: overrides.limits || { memory: this.memoryLimit, cpu: this.cpuLimit },
    }

    if (overrides.diskSizeLimit && spec.volumes) {
      const projectVol = spec.volumes.find((v: any) => v.name === 'project-data')
      if (projectVol?.emptyDir) {
        projectVol.emptyDir.sizeLimit = overrides.diskSizeLimit
      }
    }

    if (overrides.minScale !== undefined && template?.metadata?.annotations) {
      template.metadata.annotations['autoscaling.knative.dev/min-scale'] = String(overrides.minScale)
    }

    // Clean up any legacy dedicated-node scheduling from previous architecture
    delete spec.nodeSelector
    delete spec.tolerations

    try {
      await api.replaceNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: KNATIVE_VERSION,
        namespace: this.namespace,
        plural: 'services',
        name: serviceName,
        body: existing,
      })
      console.log(`[KnativeProjectManager] Patched resources for ${serviceName} (minScale=${overrides.minScale})`)
    } catch (err: any) {
      console.error(`[KnativeProjectManager] Failed to patch ${serviceName}:`, err.message)
      throw err
    }
  }

  /**
   * Create a static-serving Knative Service for a published app.
   * Uses nginx:alpine to serve pre-built dist files from an emptyDir volume.
   * An init container syncs files from S3 on pod startup.
   * No database sidecar -- published apps are static sites.
   */
  async createPublishedService(projectId: string, subdomain: string): Promise<string> {
    const serviceName = `published-${projectId}`
    const api = getCustomApi()
    const publishBucket = process.env.PUBLISH_BUCKET || 'shogo-published-apps-staging'

    const nginxConf = [
      'server {',
      '  listen 8080;',
      '  root /usr/share/nginx/html;',
      '  index index.html;',
      '  location / {',
      '    try_files $uri $uri/ /index.html;',
      '  }',
      '  location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|map)$ {',
      '    expires 1y;',
      '    add_header Cache-Control "public, immutable";',
      '  }',
      '}',
    ].join('\\n')

    const s3SyncEnv: any[] = [
      { name: "AWS_DEFAULT_REGION", value: this.s3Region },
    ]

    if (this.s3Endpoint) {
      s3SyncEnv.push({ name: "AWS_ENDPOINT_URL", value: this.s3Endpoint })
    }

    // AWS credentials from K8s secrets
    s3SyncEnv.push({
      name: "AWS_ACCESS_KEY_ID",
      valueFrom: { secretKeyRef: { name: "s3-credentials", key: "access-key", optional: true } },
    })
    s3SyncEnv.push({
      name: "AWS_SECRET_ACCESS_KEY",
      valueFrom: { secretKeyRef: { name: "s3-credentials", key: "secret-key", optional: true } },
    })

    const service = {
      apiVersion: `${KNATIVE_GROUP}/${KNATIVE_VERSION}`,
      kind: "Service",
      metadata: {
        name: serviceName,
        namespace: this.namespace,
        labels: {
          "app.kubernetes.io/part-of": "shogo",
          "shogo.io/project": projectId,
          "shogo.io/component": "published-app",
        },
      },
      spec: {
        template: {
          metadata: {
            annotations: {
              "autoscaling.knative.dev/min-scale": "0",
              "autoscaling.knative.dev/max-scale": "1",
              "autoscaling.knative.dev/scale-to-zero-pod-retention-period": "1800s",
              "autoscaling.knative.dev/target": "100",
              "shogo.io/deploy-timestamp": new Date().toISOString(),
            },
          },
          spec: {
            timeoutSeconds: 120,
            initContainers: [
              {
                name: "s3-sync",
                image: "amazon/aws-cli:latest",
                command: ["sh", "-c", `aws s3 sync s3://${publishBucket}/${subdomain}/ /data/`],
                env: s3SyncEnv,
                volumeMounts: [{ name: "site-data", mountPath: "/data" }],
                resources: {
                  requests: { memory: "64Mi", cpu: "50m" },
                  limits: { memory: "256Mi", cpu: "250m" },
                },
              },
            ],
            containers: [
              {
                name: "nginx",
                image: "nginx:alpine",
                command: ["sh", "-c", `printf '${nginxConf}' > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'`],
                ports: [{ containerPort: 8080, name: "http1" }],
                resources: {
                  requests: { memory: "32Mi", cpu: "10m" },
                  limits: { memory: "128Mi", cpu: "100m" },
                },
                volumeMounts: [{ name: "site-data", mountPath: "/usr/share/nginx/html" }],
                readinessProbe: {
                  httpGet: { path: "/", port: 8080 },
                  initialDelaySeconds: 1,
                  periodSeconds: 3,
                  timeoutSeconds: 2,
                  failureThreshold: 10,
                },
                livenessProbe: {
                  httpGet: { path: "/", port: 8080 },
                  initialDelaySeconds: 5,
                  periodSeconds: 15,
                  timeoutSeconds: 2,
                  failureThreshold: 3,
                },
              },
            ],
            volumes: [
              { name: "site-data", emptyDir: { sizeLimit: "512Mi" } },
            ],
          },
        },
      },
    }

    try {
      await api.createNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: KNATIVE_VERSION,
        namespace: this.namespace,
        plural: "services",
        body: service,
      })
      console.log(`[KnativeProjectManager] Created published service ${serviceName}`)
    } catch (err: any) {
      const statusCode = err?.response?.statusCode || err?.statusCode || err?.body?.code
      if (statusCode === 409 || err?.body?.reason === 'AlreadyExists') {
        await api.replaceNamespacedCustomObject({
          group: KNATIVE_GROUP,
          version: KNATIVE_VERSION,
          namespace: this.namespace,
          plural: "services",
          name: serviceName,
          body: service,
        })
        console.log(`[KnativeProjectManager] Updated published service ${serviceName}`)
      } else {
        throw err
      }
    }

    return `http://${serviceName}.${this.namespace}.svc.cluster.local`
  }

  /**
   * Force a new Knative revision for a published service.
   * Updates the deploy-timestamp annotation, causing the init container
   * to re-sync from S3 with fresh content.
   */
  async forcePublishedRevision(projectId: string): Promise<void> {
    const serviceName = `published-${projectId}`
    await mergePatchKnativeService(this.namespace, serviceName, {
      spec: {
        template: {
          metadata: {
            annotations: {
              "shogo.io/deploy-timestamp": new Date().toISOString(),
            },
          },
        },
      },
    })
    console.log(`[KnativeProjectManager] Forced new revision for published service ${serviceName}`)
  }

  /**
   * Create a DomainMapping for a published app's subdomain.
   * Maps {subdomain}.shogo.one -> published-{projectId}
   */
  async createPublishedDomainMapping(subdomain: string, projectId: string): Promise<void> {
    const publishDomain = process.env.PUBLISH_DOMAIN || 'shogo.one'
    const domainName = `${subdomain}.${publishDomain}`
    const serviceName = `published-${projectId}`

    console.log(`[KnativeProjectManager] Creating published DomainMapping: ${domainName} -> ${serviceName}`)

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
          "shogo.io/component": "published-domain",
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
      console.log(`[KnativeProjectManager] Created published DomainMapping: ${domainName}`)
    } catch (error: any) {
      const statusCode = error?.response?.statusCode || error?.statusCode || error?.body?.code
      if (statusCode === 409 || error?.message?.includes('already exists') || error?.body?.reason === 'AlreadyExists') {
        console.log(`[KnativeProjectManager] Published DomainMapping ${domainName} already exists`)
      } else {
        console.error(`[KnativeProjectManager] Failed to create published DomainMapping ${domainName}:`, error)
        throw error
      }
    }
  }

  /**
   * Delete a published app's DomainMapping.
   */
  async deletePublishedDomainMapping(subdomain: string): Promise<void> {
    const publishDomain = process.env.PUBLISH_DOMAIN || 'shogo.one'
    const domainName = `${subdomain}.${publishDomain}`
    const api = getCustomApi()

    try {
      await api.deleteNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: "v1beta1",
        namespace: this.namespace,
        plural: "domainmappings",
        name: domainName,
      })
      console.log(`[KnativeProjectManager] Deleted published DomainMapping: ${domainName}`)
    } catch (error: any) {
      if (error?.code !== 404 && error?.response?.statusCode !== 404) {
        console.error(`[KnativeProjectManager] Failed to delete published DomainMapping ${domainName}:`, error)
        throw error
      }
    }
  }

  /**
   * Delete a published service (no PVC cleanup needed -- uses emptyDir).
   */
  async deletePublishedService(projectId: string): Promise<void> {
    const serviceName = `published-${projectId}`
    const api = getCustomApi()

    try {
      await api.deleteNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: KNATIVE_VERSION,
        namespace: this.namespace,
        plural: "services",
        name: serviceName,
      })
      console.log(`[KnativeProjectManager] Deleted published service ${serviceName}`)
    } catch (err: any) {
      if (err?.response?.statusCode !== 404 && err?.code !== 404) throw err
    }

    // Clean up legacy PVC from older deployments that used postgres sidecar
    try {
      const coreApi = getCoreApi()
      await coreApi.deleteNamespacedPersistentVolumeClaim({
        name: `pvc-postgres-${projectId}`,
        namespace: this.namespace,
      })
      console.log(`[KnativeProjectManager] Deleted legacy PVC pvc-postgres-${projectId}`)
    } catch (err: any) {
      if (err?.response?.statusCode !== 404 && err?.code !== 404) throw err
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
  
  const workPromise = (async (): Promise<string> => {
    return knativeTracer.startActiveSpan('knative.get_pod_url', {
      attributes: { 'project.id': projectId },
    }, async (span) => {
    try {
      const manager = getKnativeProjectManager()

      // 1. Check in-memory warm pool assigned map (covers active session)
      const { getWarmPoolController } = await import('./warm-pool-controller')
      const warmPool = getWarmPoolController()
      const assignedPod = warmPool.getAssignedPod(projectId)
      if (assignedPod) {
        const warmUrl = assignedPod.url
        const assignmentAgeMs = assignedPod.assignedAt ? Date.now() - assignedPod.assignedAt : Infinity
        const ASSIGNMENT_GRACE_MS = 90_000

        if (assignmentAgeMs < ASSIGNMENT_GRACE_MS) {
          // Pod was recently assigned — skip health probe to avoid evicting
          // pods that are still processing /pool/assign (S3 sync, gateway init).
          span.setAttribute('resolve.method', 'warm_pool_assigned_grace')
          span.setAttribute('resolve.duration_ms', Date.now() - totalStartTime)
          span.setStatus({ code: SpanStatusCode.OK })
          console.log(`[KnativeProjectManager] Project ${projectId} served by warm pool (grace period, assigned ${Math.round(assignmentAgeMs / 1000)}s ago, elapsed: ${Date.now() - totalStartTime}ms)`)
          return warmUrl
        }

        // Pod assigned >90s ago — health probe to verify it's still alive.
        try {
          const probe = await fetch(`${warmUrl}/health`, {
            method: 'GET',
            signal: AbortSignal.timeout(8000),
          })
          if (probe.ok) {
            span.setAttribute('resolve.method', 'warm_pool_assigned')
            span.setAttribute('resolve.duration_ms', Date.now() - totalStartTime)
            span.setStatus({ code: SpanStatusCode.OK })
            console.log(`[KnativeProjectManager] Project ${projectId} served by warm pool (elapsed: ${Date.now() - totalStartTime}ms)`)
            return warmUrl
          }
          console.warn(`[KnativeProjectManager] Warm pool pod for ${projectId} unhealthy (status ${probe.status}) — evicting and re-resolving`)
        } catch (probeErr: any) {
          console.warn(`[KnativeProjectManager] Warm pool pod for ${projectId} unreachable (${probeErr.code || probeErr.message}) — evicting and re-resolving`)
        }
        // Pod is dead/unreachable — evict so we don't keep hitting a stale entry
        warmPool.evictProject(projectId).catch((err: any) => {
          console.error(`[KnativeProjectManager] Failed to evict stale warm pod for ${projectId}:`, err.message)
        })
      }

      // 2. Check database for a saved knativeServiceName (promoted warm pod)
      const { prisma } = await import('./prisma')
      const projectRecord = await prisma.project.findUnique({
        where: { id: projectId },
        select: { knativeServiceName: true },
      })
      if (projectRecord?.knativeServiceName) {
        // Validate the mapped service still exists (it won't survive API redeployments
        // because warm pool services are ephemeral)
        const svcStatus = await manager.getServiceStatus(
          projectRecord.knativeServiceName,
          projectId,
        ).catch(() => ({ exists: false, ready: false, url: null, replicas: 0 }) as ProjectPodStatus)

        if (svcStatus.exists) {
          const dbUrl = `http://${projectRecord.knativeServiceName}.${NAMESPACE}.svc.cluster.local`
          span.setAttribute('resolve.method', 'db_mapping')
          span.setAttribute('resolve.duration_ms', Date.now() - totalStartTime)
          span.setStatus({ code: SpanStatusCode.OK })
          console.log(`[KnativeProjectManager] Project ${projectId} resolved via DB mapping to ${projectRecord.knativeServiceName} (elapsed: ${Date.now() - totalStartTime}ms)`)
          return dbUrl
        }

        // Stale mapping — service no longer exists. Clear it so we don't keep checking.
        console.warn(`[KnativeProjectManager] Stale DB mapping for ${projectId}: ${projectRecord.knativeServiceName} no longer exists — clearing and re-assigning`)
        await prisma.project.update({
          where: { id: projectId },
          data: { knativeServiceName: null },
        }).catch((err: any) => {
          console.error(`[KnativeProjectManager] Failed to clear stale mapping for ${projectId}:`, err.message)
        })
      }

      // 3. Check if a legacy project-{id} Knative Service exists
      const status = await manager.getStatus(projectId)

      if (!status.exists) {
        // 4. No service found — try claiming a warm pod
        const warmPodUrl = await tryClaimWarmPod(projectId, manager)
        if (warmPodUrl) {
          const totalDuration = Date.now() - totalStartTime
          span.setAttribute('resolve.method', 'warm_pool_claimed')
          span.setAttribute('resolve.duration_ms', totalDuration)
          span.setStatus({ code: SpanStatusCode.OK })
          console.log(`[KnativeProjectManager] getProjectPodUrl completed for ${projectId} via warm pool in ${totalDuration}ms`)
          return warmPodUrl
        }

        // 5. Cold start fallback
        span.setAttribute('resolve.method', 'cold_start')
        console.log(`[KnativeProjectManager] Project ${projectId} does not exist, creating (cold start)... (elapsed: ${Date.now() - totalStartTime}ms)`)
        await manager.createProject(projectId)
        console.log(`[KnativeProjectManager] Waiting for project ${projectId} to be ready... (elapsed: ${Date.now() - totalStartTime}ms)`)
        await manager.waitForReady(projectId, 180000)
      } else if (!status.ready) {
        span.setAttribute('resolve.method', 'scale_from_zero')
        console.log(`[KnativeProjectManager] Project ${projectId} exists but not ready (cold start), waiting... (elapsed: ${Date.now() - totalStartTime}ms)`)
        await manager.waitForReady(projectId, 120000)
      } else {
        span.setAttribute('resolve.method', 'already_running')
        console.log(`[KnativeProjectManager] Project ${projectId} already running (warm hit) (elapsed: ${Date.now() - totalStartTime}ms)`)
      }

      const totalDuration = Date.now() - totalStartTime
      span.setAttribute('resolve.duration_ms', totalDuration)
      span.setStatus({ code: SpanStatusCode.OK })
      console.log(`[KnativeProjectManager] getProjectPodUrl completed for ${projectId} in ${totalDuration}ms`)
      return manager.getProjectPodUrl(projectId)
    } catch (err: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
      span.recordException(err)
      throw err
    } finally {
      span.end()
      pendingPodRequests.delete(projectId)
    }
    })
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
 * Retries with different pods from the pool if the first claim fails.
 *
 * Uses a DB-level row lock (SELECT ... FOR UPDATE) on the project row
 * to prevent multiple API replicas from claiming different pods for the
 * same project simultaneously. The second replica will see the
 * knativeServiceName written by the first and reuse it.
 */
async function tryClaimWarmPod(
  projectId: string,
  manager: KnativeProjectManager
): Promise<string | null> {
  const t0 = Date.now()
  const MAX_ATTEMPTS = 6

  try {
    const { getWarmPoolController } = await import('./warm-pool-controller')
    const warmPool = getWarmPoolController()
    const poolStatus = warmPool.getStatus()
    if (!poolStatus.enabled) {
      console.log(`[KnativeProjectManager] Warm pool not enabled for ${projectId} (started=${poolStatus.enabled})`)
      return null
    }

    // Acquire a PostgreSQL advisory lock keyed on the project ID to prevent
    // multiple API replicas from claiming different warm pods for the same
    // project simultaneously. Advisory locks are session-scoped and don't
    // require holding a transaction open during the long /pool/assign call.
    const { prisma } = await import('./prisma')
    const lockKey = hashProjectIdToLockKey(projectId)

    // pg_try_advisory_lock returns true if we acquired it, false if another
    // session already holds it. If contended, re-check the DB — the winning
    // replica may have already written knativeServiceName.
    const [{ acquired }] = await prisma.$queryRawUnsafe<{ acquired: boolean }[]>(
      `SELECT pg_try_advisory_lock($1) AS acquired`, lockKey,
    )

    if (!acquired) {
      // Another replica is actively claiming for this project. Wait briefly
      // for it to finish, then check if it wrote a service name.
      console.log(`[KnativeProjectManager] Warm pool claim lock contended for ${projectId} — waiting for other replica`)
      await new Promise((r) => setTimeout(r, 5000))

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { knativeServiceName: true },
      })
      if (project?.knativeServiceName) {
        const url = `http://${project.knativeServiceName}.${NAMESPACE}.svc.cluster.local`
        console.log(
          `[KnativeProjectManager] Warm pool claim for ${projectId} resolved by another replica: ${project.knativeServiceName} (elapsed: ${Date.now() - t0}ms)`
        )
        return url
      }

      // Other replica may have failed — proceed with our own claim.
      // Try to acquire the lock now (blocking).
      await prisma.$queryRawUnsafe(`SELECT pg_advisory_lock($1)`, lockKey)
      console.log(`[KnativeProjectManager] Acquired warm pool claim lock for ${projectId} after contention`)

      // Re-check after acquiring — other replica may have finished between our wait and lock
      const recheck = await prisma.project.findUnique({
        where: { id: projectId },
        select: { knativeServiceName: true },
      })
      if (recheck?.knativeServiceName) {
        await prisma.$queryRawUnsafe(`SELECT pg_advisory_unlock($1)`, lockKey)
        const url = `http://${recheck.knativeServiceName}.${NAMESPACE}.svc.cluster.local`
        console.log(
          `[KnativeProjectManager] Warm pool claim for ${projectId} resolved after lock acquisition: ${recheck.knativeServiceName} (elapsed: ${Date.now() - t0}ms)`
        )
        return url
      }
    }

    // We hold the advisory lock — proceed with claim. Release in finally block.
    try {
      const envVars = await warmPool.buildProjectEnv(projectId)
      const envTime = Date.now()
      console.log(`[KnativeProjectManager] buildProjectEnv for ${projectId}: ${envTime - t0}ms`)

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const pod = warmPool.claim()
        if (!pod) {
          console.log(`[KnativeProjectManager] No warm pod available for ${projectId} (attempt ${attempt}/${MAX_ATTEMPTS})`)
          break
        }

        console.log(`[KnativeProjectManager] Claimed warm pod ${pod.serviceName} for ${projectId} (attempt ${attempt}/${MAX_ATTEMPTS})`)

        try {
          const assignStart = Date.now()
          await warmPool.assign(pod, projectId, envVars)
          const assignEnd = Date.now()
          console.log(`[KnativeProjectManager] assign for ${projectId}: ${assignEnd - assignStart}ms (total warm pipeline: ${assignEnd - t0}ms)`)

          manager.createPreviewDomainMapping(projectId, pod.serviceName).catch((err: any) => {
            console.error(`[KnativeProjectManager] Failed to create preview DomainMapping for warm pod ${pod.serviceName}:`, err.message)
          })

          return pod.url
        } catch (assignErr: any) {
          console.warn(`[KnativeProjectManager] Warm pod ${pod.serviceName} unreachable for ${projectId} (attempt ${attempt}/${MAX_ATTEMPTS}): ${assignErr.message}`)
        }
      }

      console.log(`[KnativeProjectManager] All warm pool attempts exhausted for ${projectId} after ${Date.now() - t0}ms — falling back to cold start`)
      return null
    } finally {
      // Always release the advisory lock
      await prisma.$queryRawUnsafe(`SELECT pg_advisory_unlock($1)`, lockKey).catch(() => {})
    }
  } catch (err: any) {
    const elapsed = Date.now() - t0
    console.error(`[KnativeProjectManager] Warm pool claim failed for ${projectId} after ${elapsed}ms:`, err.message)
    return null
  }
}
