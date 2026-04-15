// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * K8s-native worker pool for eval runners.
 *
 * Creates Kubernetes pods as eval workers instead of Docker containers.
 * Used automatically when running inside a K8s cluster (staging/production)
 * where Docker is not available. The eval harness talks to worker pods
 * over HTTP via pod IPs, just like Docker/local/VM modes.
 */

import * as k8s from '@kubernetes/client-node'
import * as fs from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'
import { type DockerWorker } from './docker-worker'
import { encodeSecurityPolicy } from '../permission-engine'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface K8sWorkerConfig {
  containerPrefix: string
  baseHostPort: number // unused for networking but kept for interface parity
  model: string
  verbose: boolean
  image: string
  namespace: string
  envOverrides?: Record<string, string>
  runId?: string
}

// ---------------------------------------------------------------------------
// K8s client setup (reuses the same in-cluster pattern as eval-job-manager)
// ---------------------------------------------------------------------------

let coreApi: k8s.CoreV1Api | null = null

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
      clusters: [{ name: 'in-cluster', server: host, caData: Buffer.from(ca).toString('base64') }],
      users: [{ name: 'in-cluster', token }],
      contexts: [{ name: 'in-cluster', cluster: 'in-cluster', user: 'in-cluster' }],
      currentContext: 'in-cluster',
    })
  } else {
    kc.loadFromDefault()
  }

  return kc
}

function getCoreApi(): k8s.CoreV1Api {
  if (!coreApi) {
    const kc = getKubeConfig()
    coreApi = kc.makeApiClient(k8s.CoreV1Api)
  }
  return coreApi
}

// ---------------------------------------------------------------------------
// Pod IP tracking
// ---------------------------------------------------------------------------

const _podIPs = new Map<string, string>()

export function getK8sWorkerUrl(worker: DockerWorker): string {
  const ip = _podIPs.get(worker.containerName)
  if (!ip) throw new Error(`No pod IP for worker ${worker.containerName}`)
  return `http://${ip}:8080`
}

// ---------------------------------------------------------------------------
// Env passthrough (mirrors docker-worker ENV_PREFIXES)
// ---------------------------------------------------------------------------

const ENV_PREFIXES = [
  'ANTHROPIC_', 'AI_PROXY_', 'OPENAI_', 'GOOGLE_API_KEY',
  'AWS_', 'COMPOSIO_', 'SERPER_', 'WEB_CACHE_',
]

function buildWorkerEnvVars(config: K8sWorkerConfig): k8s.V1EnvVar[] {
  const vars: k8s.V1EnvVar[] = [
    { name: 'NODE_ENV', value: 'development' },
    { name: 'PROJECT_ID', value: `eval-worker-${config.containerPrefix}` },
    { name: 'PORT', value: '8080' },
    { name: 'WORKSPACE_DIR', value: '/app/workspace' },
    { name: 'AGENT_DIR', value: '/app/workspace' },
    { name: 'PROJECT_DIR', value: '/app/workspace' },
    { name: 'AGENT_MODEL', value: config.model },
    { name: 'SECURITY_POLICY', value: encodeSecurityPolicy({ mode: 'full_autonomy' }) },
  ]

  for (const [key, val] of Object.entries(process.env)) {
    if (!val) continue
    if (ENV_PREFIXES.some(p => key.startsWith(p) || key === p)) {
      vars.push({ name: key, value: val })
    }
  }

  if (config.envOverrides) {
    for (const [key, val] of Object.entries(config.envOverrides)) {
      vars.push({ name: key, value: val })
    }
  }

  return vars
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

export async function startK8sWorker(
  id: number,
  config: K8sWorkerConfig,
): Promise<DockerWorker> {
  const api = getCoreApi()
  const podName = `${config.containerPrefix}-${id}-${Date.now().toString(36)}`
  const dir = resolve(tmpdir(), `${config.containerPrefix}-${id}`)

  console.log(`  Starting K8s worker ${id} (${podName})...`)

  const labels: Record<string, string> = {
    'app.kubernetes.io/component': 'eval-worker',
    'shogo.ai/worker-id': String(id),
  }
  if (config.runId) {
    labels['shogo.ai/eval-run-id'] = config.runId
  }

  const pod: k8s.V1Pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      namespace: config.namespace,
      labels,
    },
    spec: {
      restartPolicy: 'Never',
      serviceAccountName: 'api-service-account',
      containers: [
        {
          name: 'eval-worker',
          image: config.image,
          env: buildWorkerEnvVars(config),
          ports: [{ containerPort: 8080 }],
          resources: {
            requests: { cpu: '1', memory: '2Gi' },
            limits: { cpu: '4', memory: '8Gi' },
          },
        },
      ],
    },
  }

  await api.createNamespacedPod({ namespace: config.namespace, body: pod })

  // Wait for pod to get an IP and become ready
  const maxWait = 180_000
  const start = Date.now()
  let delay = 1_000
  let podIP: string | undefined

  while (Date.now() - start < maxWait) {
    try {
      const readPod = await api.readNamespacedPod({ name: podName, namespace: config.namespace })
      const phase = readPod.status?.phase

      if (phase === 'Failed' || phase === 'Unknown') {
        throw new Error(`Worker pod ${podName} entered phase ${phase}`)
      }

      podIP = readPod.status?.podIP
      if (podIP && phase === 'Running') {
        break
      }
    } catch (err: any) {
      if (err.message?.includes('entered phase')) throw err
    }

    await Bun.sleep(delay)
    delay = Math.min(delay * 1.5, 3_000)
  }

  if (!podIP) {
    try { await api.deleteNamespacedPod({ name: podName, namespace: config.namespace }) } catch {}
    throw new Error(`Worker pod ${podName} did not get an IP within ${maxWait}ms`)
  }

  _podIPs.set(podName, podIP)

  // Poll /health until gateway.running === true
  const healthUrl = `http://${podIP}:8080/health`
  delay = 1_000

  while (Date.now() - start < maxWait) {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 3_000)
      const res = await fetch(healthUrl, { signal: ctl.signal })
      clearTimeout(t)
      if (res.ok) {
        const body = await res.json().catch(() => null) as any
        if (body?.gateway?.running === true) {
          console.log(`  K8s worker ${id} ready at ${podIP}:8080 (${Date.now() - start}ms)`)
          return { id, port: 8080, dir, containerName: podName }
        }
        if (config.verbose && Date.now() - start > 5_000) {
          console.log(`  K8s worker ${id} HTTP ok but gateway not ready yet (${Date.now() - start}ms)`)
        }
      }
    } catch {
      // Pod may still be starting
    }
    await Bun.sleep(delay)
    delay = Math.min(delay * 1.2, 2_000)
  }

  try { await api.deleteNamespacedPod({ name: podName, namespace: config.namespace }) } catch {}
  _podIPs.delete(podName)
  throw new Error(`K8s worker ${id} failed health check within ${maxWait}ms`)
}

export async function stopK8sWorker(worker: DockerWorker): Promise<void> {
  _podIPs.delete(worker.containerName)
  try {
    const api = getCoreApi()
    const namespace = process.env.SYSTEM_NAMESPACE || 'shogo-staging-system'
    await api.deleteNamespacedPod({
      name: worker.containerName,
      namespace,
      body: { gracePeriodSeconds: 5 },
    })
  } catch {}
}

export function stopK8sWorkerSync(worker: DockerWorker): void {
  _podIPs.delete(worker.containerName)
  // Best-effort async delete; cleanup handlers may not be able to await
  stopK8sWorker(worker).catch(() => {})
}

export async function isK8sWorkerHealthy(worker: DockerWorker): Promise<boolean> {
  const ip = _podIPs.get(worker.containerName)
  if (!ip) return false
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 3_000)
    const res = await fetch(`http://${ip}:8080/health`, { signal: ctl.signal })
    clearTimeout(t)
    if (!res.ok) return false
    const body = await res.json().catch(() => null) as any
    return body?.gateway?.running === true
  } catch {
    return false
  }
}
