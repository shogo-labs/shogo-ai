// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Knative Workspace Manager
 *
 * The workspace-scoped sibling of `knative-project-manager.ts`. Where the
 * project manager creates one Knative Service per project, this creates a
 * single merged-root runtime Service per *workspace* that mounts several
 * attached projects as subfolders under one `WORKSPACE_DIR`.
 *
 * Service naming:           workspace-{workspaceId}
 * Internal cluster URL:     http://workspace-{id}.{namespace}.svc.cluster.local
 * Merged-root contract:     env carries WORKSPACE_RUNTIME=true, WORKSPACE_ID,
 *                           WORKSPACE_PROJECT_IDS, WORKSPACE_PROJECTS (see
 *                           build-workspace-env.ts + workspace-runtime-mode.ts).
 *
 * The pure spec builder `buildKnativeWorkspaceService()` is exported and
 * unit-tested directly. `getWorkspacePodUrl()` is the default `_k8sResolver`
 * wired into `resolve-workspace-runtime-url.ts`: it short-circuits on an
 * existing ready Service (so the cross-replica spawn lease's losers re-resolve
 * cheaply) and otherwise creates + waits.
 */

import * as k8s from "@kubernetes/client-node"
import * as fs from "fs"
import { RUNTIME_CONFIG } from "@shogo/shared-runtime"
import type { InstanceSizeName } from "../config/instance-sizes"
import { buildWorkspaceEnv } from "./runtime/build-workspace-env"

// =============================================================================
// Configuration
// =============================================================================

const NAMESPACE = process.env.PROJECT_NAMESPACE || "shogo-workspaces"
const KNATIVE_GROUP = "serving.knative.dev"
const KNATIVE_VERSION = "v1"

const isKubernetes = () => !!process.env.KUBERNETES_SERVICE_HOST

/**
 * Stable Knative Service name for a workspace runtime.
 *
 * Project-anchored runtimes (the universal "open a project → it runs on a
 * merged workspace runtime" path) are keyed by the ANCHOR project id, so two
 * different anchors in the same workspace (different attachment sets) get
 * distinct Services — mirroring the host `ws:proj:<anchor>` runtimes-map key.
 * Workspace-session runtimes (no single anchor) stay keyed by workspaceId.
 *
 * Both forms are DNS-1035 safe: ids are lowercase UUIDs, and
 * `workspace-proj-<uuid>` is 51 chars (< 63 limit).
 */
export function workspaceServiceName(workspaceId: string, anchorProjectId?: string): string {
  return anchorProjectId ? `workspace-proj-${anchorProjectId}` : `workspace-${workspaceId}`
}

// =============================================================================
// Kubernetes Client Setup (mirrors knative-project-manager.ts)
// =============================================================================

let k8sCustomApi: k8s.CustomObjectsApi | null = null

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
  } else {
    kc.loadFromDefault()
  }
  return kc
}

function getCustomApi(): k8s.CustomObjectsApi {
  if (!k8sCustomApi) {
    k8sCustomApi = getKubeConfig().makeApiClient(k8s.CustomObjectsApi)
  }
  return k8sCustomApi
}

// =============================================================================
// Types
// =============================================================================

export interface WorkspacePodStatus {
  exists: boolean
  ready: boolean
  url: string | null
  replicas: number
  message?: string
  createdAt?: string
}

export interface BuildKnativeWorkspaceServiceOpts {
  workspaceId: string
  attachedProjectIds: string[]
  /**
   * Anchor project id for project-anchored runtimes. Determines the Service
   * name (`workspace-proj-<anchor>`) and a label; the env map is expected to
   * already carry `WORKSPACE_ANCHOR_PROJECT_ID` (set by `buildWorkspaceEnv`).
   */
  anchorProjectId?: string
  /** Env map from `buildWorkspaceEnv` (string→string). */
  env: Record<string, string>
  namespace: string
  image: string
  workDir: string
  componentLabel: string
  containerName: string
  resourceSpec: { requests: Record<string, string>; limits: Record<string, string> }
  diskSizeLimit: string
  minScale: number
  idleTimeoutSeconds: number
  /** When set, AWS credentials are sourced from the `s3-credentials` secret. */
  s3Bucket?: string | null
  /** When set, OTEL endpoint + SIGNOZ ingestion secret are injected. */
  otelEndpoint?: string | null
}

// =============================================================================
// Pure spec builder
// =============================================================================

/**
 * Build the Knative Service spec for a workspace runtime. Pure — takes a
 * fully-resolved env map and structured sizing, returns the K8s object. The
 * env map should come from `buildWorkspaceEnv`; this layers in the few
 * k8s-only env entries that can't be expressed as plain strings (secret
 * refs) plus the merged-root mount markers.
 */
export function buildKnativeWorkspaceService(opts: BuildKnativeWorkspaceServiceOpts): any {
  const {
    workspaceId,
    anchorProjectId,
    env: envMap,
    namespace,
    image,
    workDir,
    componentLabel,
    containerName,
    resourceSpec,
    diskSizeLimit,
    minScale,
    idleTimeoutSeconds,
  } = opts

  // Plain string env from buildWorkspaceEnv → K8s env array. WORKSPACE_DIR is
  // set here (not in buildWorkspaceEnv) because it's tied to the volume mount
  // path, which is a deployment-target concern.
  const env: any[] = [
    { name: "WORKSPACE_DIR", value: workDir },
    { name: "SCHEMAS_PATH", value: "/app/.schemas" },
  ]
  for (const [name, value] of Object.entries(envMap)) {
    // Don't let WORKSPACE_DIR from the map (if ever added) double up.
    if (name === "WORKSPACE_DIR") continue
    env.push({ name, value })
  }
  for (const [name, value] of Object.entries(RUNTIME_CONFIG.extraEnv)) {
    env.push({ name, value })
  }

  // S3 credentials come from the cluster secret, not the plain env map.
  if (opts.s3Bucket) {
    env.push({
      name: "AWS_ACCESS_KEY_ID",
      valueFrom: { secretKeyRef: { name: "s3-credentials", key: "access-key", optional: true } },
    })
    env.push({
      name: "AWS_SECRET_ACCESS_KEY",
      valueFrom: { secretKeyRef: { name: "s3-credentials", key: "secret-key", optional: true } },
    })
  }

  if (opts.otelEndpoint) {
    env.push({ name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: opts.otelEndpoint })
    env.push({ name: "OTEL_SERVICE_NAME", value: `shogo-${componentLabel}` })
    env.push({
      name: "SIGNOZ_INGESTION_KEY",
      valueFrom: { secretKeyRef: { name: "signoz-credentials", key: "SIGNOZ_INGESTION_KEY", optional: true } },
    })
  }

  const containers: any[] = [
    {
      name: containerName,
      image,
      imagePullPolicy: "Always",
      ports: [{ containerPort: 8080, name: "http1" }],
      env,
      resources: resourceSpec,
      volumeMounts: [{ name: "workspace-data", mountPath: workDir }],
      readinessProbe: {
        httpGet: { path: "/ready", port: 8080 },
        initialDelaySeconds: 3,
        periodSeconds: 3,
        timeoutSeconds: 3,
        successThreshold: 1,
        failureThreshold: 60,
      },
      livenessProbe: {
        httpGet: { path: "/health", port: 8080 },
        initialDelaySeconds: 15,
        periodSeconds: 15,
        timeoutSeconds: 5,
        successThreshold: 1,
        failureThreshold: 5,
      },
    },
  ]

  const volumes: any[] = [{ name: "workspace-data", emptyDir: { sizeLimit: diskSizeLimit } }]

  const podSpec: any = {
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
      name: workspaceServiceName(workspaceId, anchorProjectId),
      namespace,
      labels: {
        "app.kubernetes.io/part-of": "shogo",
        "shogo.io/workspace": workspaceId,
        "shogo.io/component": componentLabel,
        ...(anchorProjectId ? { "shogo.io/anchor-project": anchorProjectId } : {}),
      },
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            "autoscaling.knative.dev/min-scale": String(minScale),
            "autoscaling.knative.dev/max-scale": "1",
            "autoscaling.knative.dev/scale-to-zero-pod-retention-period": `${idleTimeoutSeconds}s`,
            "autoscaling.knative.dev/target": "10",
            "autoscaling.knative.dev/target-burst-capacity": "0",
          },
        },
        spec: podSpec,
      },
    },
  }
}

// =============================================================================
// KnativeWorkspaceManager
// =============================================================================

export interface KnativeWorkspaceManagerConfig {
  namespace?: string
  image?: string
  idleTimeoutSeconds?: number
  memoryLimit?: string
  cpuLimit?: string
}

export class KnativeWorkspaceManager {
  private namespace: string
  private image: string
  private idleTimeoutSeconds: number
  private memoryLimit: string
  private cpuLimit: string

  constructor(config: KnativeWorkspaceManagerConfig = {}) {
    this.namespace = config.namespace || NAMESPACE
    this.image = config.image || RUNTIME_CONFIG.image()
    this.idleTimeoutSeconds =
      config.idleTimeoutSeconds || parseInt(process.env.PROJECT_IDLE_TIMEOUT || "1800", 10)
    this.memoryLimit = config.memoryLimit || "2Gi"
    this.cpuLimit = config.cpuLimit || "1000m"
  }

  getWorkspacePodUrl(workspaceId: string, anchorProjectId?: string): string {
    if (!isKubernetes()) {
      throw new Error("KnativeWorkspaceManager requires Kubernetes environment")
    }
    return `http://${workspaceServiceName(workspaceId, anchorProjectId)}.${this.namespace}.svc.cluster.local`
  }

  async getStatus(workspaceId: string, anchorProjectId?: string): Promise<WorkspacePodStatus> {
    const serviceName = workspaceServiceName(workspaceId, anchorProjectId)
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
      const status = service.status || {}
      const conditions = status.conditions || []
      const readyCondition = conditions.find((c: any) => c.type === "Ready")
      return {
        exists: true,
        ready: readyCondition?.status === "True",
        url: status.url || this.getWorkspacePodUrl(workspaceId, anchorProjectId),
        replicas: status.actualReplicas || 0,
        message: readyCondition?.message,
        createdAt: service.metadata?.creationTimestamp,
      }
    } catch (error: any) {
      if (error?.code === 404 || error?.response?.statusCode === 404) {
        return { exists: false, ready: false, url: null, replicas: 0 }
      }
      throw error
    }
  }

  /** Resolve resource sizing for the workspace from its instance size. */
  private async resolveResources(workspaceId: string): Promise<{
    resourceSpec: { requests: Record<string, string>; limits: Record<string, string> }
    diskSizeLimit: string
    minScale: number
  }> {
    let overrides: { requests: Record<string, string>; limits: Record<string, string>; diskSizeLimit: string; minScale: number } | null = null
    try {
      const { prisma } = await import("./prisma")
      const { buildProjectResourceOverrides } = await import("../services/instance.service")
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { instanceSize: true },
      })
      if (workspace) {
        overrides = buildProjectResourceOverrides(workspaceId, workspace.instanceSize as InstanceSizeName)
      }
    } catch (err: any) {
      console.error(`[KnativeWorkspaceManager] Failed to resolve resources for ${workspaceId}:`, err?.message)
    }
    return {
      resourceSpec: {
        requests: overrides?.requests ?? { memory: "768Mi", cpu: "100m" },
        limits: overrides?.limits ?? { memory: this.memoryLimit, cpu: this.cpuLimit },
      },
      diskSizeLimit: overrides?.diskSizeLimit ?? "2Gi",
      minScale: overrides?.minScale ?? 1,
    }
  }

  async createWorkspace(
    workspaceId: string,
    attachedProjectIds: string[],
    opts: { anchorProjectId?: string; readonlyProjectIds?: string[] } = {},
  ): Promise<string> {
    const { anchorProjectId } = opts
    const status = await this.getStatus(workspaceId, anchorProjectId)
    if (status.exists) {
      return this.getWorkspacePodUrl(workspaceId, anchorProjectId)
    }

    const env = await buildWorkspaceEnv(workspaceId, attachedProjectIds, {
      logPrefix: "KnativeWorkspaceManager",
      anchorProjectId,
      readonlyProjectIds: opts.readonlyProjectIds,
    })
    const { resourceSpec, diskSizeLimit, minScale } = await this.resolveResources(workspaceId)

    const service = buildKnativeWorkspaceService({
      workspaceId,
      anchorProjectId,
      attachedProjectIds,
      env,
      namespace: this.namespace,
      image: this.image,
      workDir: RUNTIME_CONFIG.workDir,
      componentLabel: RUNTIME_CONFIG.componentLabel,
      containerName: RUNTIME_CONFIG.containerName,
      resourceSpec,
      diskSizeLimit,
      minScale,
      idleTimeoutSeconds: this.idleTimeoutSeconds,
      s3Bucket: process.env.S3_WORKSPACES_BUCKET || null,
      otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || null,
    })

    const api = getCustomApi()
    try {
      await api.createNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: KNATIVE_VERSION,
        namespace: this.namespace,
        plural: "services",
        body: service,
      })
      console.log(`[KnativeWorkspaceManager] Created Knative Service: ${workspaceServiceName(workspaceId, anchorProjectId)}`)
    } catch (error: any) {
      const statusCode = error?.response?.statusCode || error?.statusCode || error?.body?.code
      if (statusCode === 409 || error?.body?.reason === "AlreadyExists" || error?.message?.includes("already exists")) {
        console.log(`[KnativeWorkspaceManager] Workspace ${workspaceId} already exists (race handled)`)
      } else {
        throw error
      }
    }

    return this.getWorkspacePodUrl(workspaceId, anchorProjectId)
  }

  async waitForReady(workspaceId: string, timeoutMs = 180000, anchorProjectId?: string): Promise<void> {
    const startTime = Date.now()
    while (Date.now() - startTime < timeoutMs) {
      const status = await this.getStatus(workspaceId, anchorProjectId)
      if (status.ready && (await this.healthCheck(workspaceId, anchorProjectId))) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error(`Workspace ${workspaceId} did not become ready within ${timeoutMs}ms`)
  }

  async healthCheck(workspaceId: string, anchorProjectId?: string): Promise<boolean> {
    try {
      const url = this.getWorkspacePodUrl(workspaceId, anchorProjectId)
      const response = await fetch(`${url}/ready`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      })
      return response.ok
    } catch {
      return false
    }
  }

  async deleteWorkspace(workspaceId: string, anchorProjectId?: string): Promise<void> {
    const api = getCustomApi()
    try {
      await api.deleteNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: KNATIVE_VERSION,
        namespace: this.namespace,
        plural: "services",
        name: workspaceServiceName(workspaceId, anchorProjectId),
      })
      console.log(`[KnativeWorkspaceManager] Deleted Knative Service: ${workspaceServiceName(workspaceId, anchorProjectId)}`)
    } catch (error: any) {
      if (error?.code !== 404 && error?.response?.statusCode !== 404) throw error
    }
  }
}

// =============================================================================
// Singleton + default resolver
// =============================================================================

let _manager: KnativeWorkspaceManager | null = null

export function getKnativeWorkspaceManager(): KnativeWorkspaceManager {
  if (!_manager) {
    _manager = new KnativeWorkspaceManager()
  }
  return _manager
}

/**
 * Default `_k8sResolver` for `resolveWorkspaceRuntimeUrl`. Short-circuits on an
 * existing ready Service so that, under the cross-replica spawn lease, the
 * losing replicas re-resolve cheaply rather than re-creating. Creates + waits
 * otherwise. Returns the internal cluster URL of the workspace runtime.
 */
export async function getWorkspacePodUrl(
  workspaceId: string,
  attachedProjectIds: string[],
  opts: { anchorProjectId?: string; readonlyProjectIds?: string[] } = {},
): Promise<string> {
  const { anchorProjectId } = opts
  const manager = getKnativeWorkspaceManager()
  const status = await manager.getStatus(workspaceId, anchorProjectId)
  if (status.exists) {
    if (!status.ready) {
      await manager.waitForReady(workspaceId, 120000, anchorProjectId)
    }
    return manager.getWorkspacePodUrl(workspaceId, anchorProjectId)
  }
  await manager.createWorkspace(workspaceId, attachedProjectIds, opts)
  await manager.waitForReady(workspaceId, 180000, anchorProjectId)
  return manager.getWorkspacePodUrl(workspaceId, anchorProjectId)
}
