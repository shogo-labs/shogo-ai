// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Eval Job Manager
 *
 * Creates, monitors, and deletes Kubernetes batch/v1 Jobs for eval runs.
 * Used when running in a K8s cluster (staging/production) instead of local
 * child_process.spawn.
 */

import * as k8s from '@kubernetes/client-node'
import * as fs from 'fs'

const NAMESPACE = process.env.SYSTEM_NAMESPACE || 'shogo-staging-system'
const RUNTIME_IMAGE = process.env.RUNTIME_IMAGE || 'shogo-runtime:eval'

let batchApi: k8s.BatchV1Api | null = null

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

function getBatchApi(): k8s.BatchV1Api {
  if (!batchApi) {
    const kc = getKubeConfig()
    batchApi = kc.makeApiClient(k8s.BatchV1Api)
  }
  return batchApi
}

export async function createEvalJob(opts: {
  runId: string
  track: string
  model: string
  workers: number
  callbackUrl: string
  callbackSecret: string
}): Promise<string> {
  const api = getBatchApi()
  const jobName = `eval-${opts.runId.slice(0, 8)}-${Date.now().toString(36)}`

  const job: k8s.V1Job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: NAMESPACE,
      labels: {
        'app.kubernetes.io/component': 'eval-runner',
        'shogo.ai/eval-run-id': opts.runId,
      },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 7200,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/component': 'eval-runner',
            'shogo.ai/eval-run-id': opts.runId,
          },
        },
        spec: {
          restartPolicy: 'Never',
          serviceAccountName: 'api-service-account',
          containers: [
            {
              name: 'eval-runner',
              image: RUNTIME_IMAGE,
              imagePullPolicy: 'Always',
              workingDir: '/app/packages/agent-runtime',
              command: [
                'bun', 'run', 'src/evals/run-eval.ts',
                '--track', opts.track,
                '--model', opts.model,
                '--workers', String(opts.workers),
                '--run-id', opts.runId,
                '--callback-url', opts.callbackUrl,
              ],
              env: [
                { name: 'EVAL_CALLBACK_SECRET', value: opts.callbackSecret },
                { name: 'RUNTIME_IMAGE', value: RUNTIME_IMAGE },
                { name: 'SYSTEM_NAMESPACE', value: NAMESPACE },
                { name: 'NODE_EXTRA_CA_CERTS', value: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt' },
                {
                  name: 'ANTHROPIC_API_KEY',
                  valueFrom: { secretKeyRef: { name: 'api-secrets', key: 'ANTHROPIC_API_KEY' } },
                },
                {
                  name: 'OPENAI_API_KEY',
                  valueFrom: { secretKeyRef: { name: 'api-secrets', key: 'OPENAI_API_KEY', optional: true } },
                },
                {
                  name: 'GOOGLE_API_KEY',
                  valueFrom: { secretKeyRef: { name: 'api-secrets', key: 'GOOGLE_API_KEY', optional: true } },
                },
                {
                  name: 'WEB_CACHE_REDIS_URL',
                  value: `redis://redis-master.${NAMESPACE}:6379`,
                },
              ],
              resources: {
                requests: { cpu: '2', memory: '4Gi' },
                limits: { cpu: '8', memory: '16Gi' },
              },
            },
          ],
        },
      },
    },
  }

  const response = await api.createNamespacedJob({ namespace: NAMESPACE, body: job })
  console.log(`[EvalJobManager] Created Job ${jobName} in ${NAMESPACE}`)
  return response.metadata?.name ?? jobName
}

export async function getEvalJobStatus(jobName: string): Promise<'running' | 'succeeded' | 'failed' | 'unknown'> {
  try {
    const api = getBatchApi()
    const job = await api.readNamespacedJob({ name: jobName, namespace: NAMESPACE })
    const status = job.status
    if (!status) return 'unknown'
    if (status.succeeded && status.succeeded > 0) return 'succeeded'
    if (status.failed && status.failed > 0) return 'failed'
    if (status.active && status.active > 0) return 'running'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export async function deleteEvalJob(jobName: string): Promise<void> {
  try {
    const api = getBatchApi()
    await api.deleteNamespacedJob({
      name: jobName,
      namespace: NAMESPACE,
      body: { propagationPolicy: 'Background' },
    })
    console.log(`[EvalJobManager] Deleted Job ${jobName}`)
  } catch (err: any) {
    console.warn(`[EvalJobManager] Failed to delete Job ${jobName}: ${err.message}`)
  }
}
