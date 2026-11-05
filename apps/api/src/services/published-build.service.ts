// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * One image per commit (SHO-308 §2).
 *
 * Publishing a server app used to boot a pod that hydrated its source and then
 * ran `bun install`, `prisma generate` and a Vite build before it could answer
 * a request. That is why a published app could not autoscale: every replica —
 * and every cold start after scale-to-zero — paid the same ~30 s. So the build
 * moves to publish time, once per commit, as an in-cluster BuildKit Job:
 *
 *   artifact tarball (from the editing runtime) → S3 → Job → OCIR → digest
 *
 * The digest is what the deployment row records and the ksvc runs, so
 * `rollback`/`promote` are traffic switches and the same commit never builds
 * twice (`reused: true`).
 *
 * Everything that needs a cluster is behind {@link PublishedBuildDeps}, so the
 * decision logic — reuse, gating, digest, failure tail — is testable without
 * one. The failure modes are explicit codes rather than thrown strings because
 * they land in the environment's `publishStatus`/`publishError` and in the
 * Deployment tab.
 */

import { existsSync, readFileSync } from 'fs'
import {
  digestOfImageRef,
  publishedImageDigestRef,
  publishedImageRepository,
  publishedImageTagRef,
} from '@shogo/shared-runtime/published-image-ref'
import { prisma } from '../lib/prisma'
import {
  publishedBuildPollIntervalMs,
  publishedBuildSetup,
  publishedBuildTimeoutMs,
  type PublishedBuildConfig,
} from '../lib/published-build-config'
import {
  buildJobName,
  buildLogTail,
  buildPublishedImageJob,
  digestFromTerminationMessage,
  type BuildKitJobObject,
} from '../lib/published-build-job'
import { PUBLISHED_DOCKERFILE_NAME, publishedDockerfile } from '../lib/published-dockerfile'

export type PublishedBuildFailureCode =
  | 'build_not_configured'
  | 'artifact_missing'
  | 'build_failed'
  | 'build_timeout'
  | 'build_digest_missing'

export interface PublishedImageReady {
  ok: true
  /** Digest-pinned ref — what the ksvc runs and the deployment row records. */
  imageRef: string
  imageDigest: string
  repository: string
  /** True when the commit's image already existed (no Job was run). */
  reused: boolean
}

export interface PublishedImageFailure {
  ok: false
  code: PublishedBuildFailureCode
  message: string
  /** Last lines of the build log, for `publishError` and the Deployment tab. */
  logTail?: string
}

export type EnsurePublishedImageResult = PublishedImageReady | PublishedImageFailure

export interface EnsurePublishedImageInput {
  projectId: string
  environmentId: string
  /** Used for the artifact key, matching the rest of the publish bucket layout. */
  subdomain: string
  commitSha: string
  createdBy?: string | null
  /** Test seam: skip the poll delay. */
  pollIntervalMs?: number
  timeoutMs?: number
}

/**
 * What the service needs from the outside world. Defaulted in
 * {@link defaultDeps}; tests pass fakes so the decision logic can be exercised
 * without a cluster, S3 or a live runtime.
 */
export interface PublishedBuildDeps {
  config: () => { ok: boolean; config: PublishedBuildConfig | null; missing: string[] }
  findReusableImage: (input: { projectId: string; commitSha: string }) => Promise<{ imageRef: string; imageDigest: string } | null>
  uploadArtifact: (input: { projectId: string; subdomain: string; commitSha: string }) => Promise<{ url: string } | { error: string }>
  createJob: (job: BuildKitJobObject) => Promise<void>
  readJob: (name: string, namespace: string) => Promise<{
    status: 'running' | 'succeeded' | 'failed'
    message?: string | null
    logTail?: string | null
  }>
  deleteJob: (name: string, namespace: string) => Promise<void>
  sleep: (ms: number) => Promise<void>
  log: (message: string) => void
}

/**
 * Ensure the commit has an image, building it if needed.
 *
 * Never throws for an expected failure: a publish that cannot build must be
 * refused with a code the agent can act on (`build_failed` with a log tail),
 * not a 500.
 */
export async function ensurePublishedImage(
  input: EnsurePublishedImageInput,
  overrides: Partial<PublishedBuildDeps> = {},
): Promise<EnsurePublishedImageResult> {
  const deps: PublishedBuildDeps = { ...defaultDeps(), ...overrides }
  const commitSha = input.commitSha.trim()
  if (!commitSha) {
    return { ok: false, code: 'build_failed', message: 'Publish has no commit sha to build' }
  }

  const setup = deps.config()
  if (!setup.ok || !setup.config) {
    return {
      ok: false,
      code: 'build_not_configured',
      message: `Per-commit image builds are not configured for this region (missing ${setup.missing.join(', ')})`,
    }
  }
  const config = setup.config

  // The image does not depend on the environment — only env vars differ — so a
  // commit built for staging is the same image production runs.
  const reusable = await deps.findReusableImage({ projectId: input.projectId, commitSha })
  if (reusable?.imageDigest) {
    deps.log(`[PublishedBuild] Reusing ${reusable.imageDigest} for ${input.projectId}@${commitSha.slice(0, 8)}`)
    return {
      ok: true,
      imageRef: reusable.imageRef,
      imageDigest: reusable.imageDigest,
      repository: publishedImageRepository({ ...config, projectId: input.projectId }),
      reused: true,
    }
  }

  const artifact = await deps.uploadArtifact({
    projectId: input.projectId,
    subdomain: input.subdomain,
    commitSha,
  })
  if ('error' in artifact) {
    return {
      ok: false,
      code: 'artifact_missing',
      message: `Could not read the publish artifact from the editing runtime: ${artifact.error}`,
    }
  }

  const imageRef = publishedImageTagRef({ ...config, projectId: input.projectId, commitSha })
  const jobName = buildJobName(input.projectId, commitSha)
  const job = buildPublishedImageJob({
    projectId: input.projectId,
    commitSha,
    imageRef,
    artifactUrl: artifact.url,
    namespace: config.k8sNamespace,
    registrySecret: config.registrySecret,
    builderImage: config.builderImage,
    dockerfile: publishedDockerfile(),
    dockerfileName: PUBLISHED_DOCKERFILE_NAME,
    activeDeadlineSeconds: Math.ceil((input.timeoutMs ?? publishedBuildTimeoutMs()) / 1000),
  })

  // A Job name that already exists is either a previous attempt that timed out
  // (its pod may still be running) or a crash-looping one. Recreate it rather
  // than joining it: the API's wait is what decides success, and a stale Job
  // that "succeeds" would report an older digest.
  await deps.deleteJob(jobName, config.k8sNamespace).catch(() => undefined)
  try {
    await deps.createJob(job)
  } catch (err: any) {
    return {
      ok: false,
      code: 'build_failed',
      message: `Could not start the image build: ${err?.message ?? String(err)}`,
    }
  }

  const timeoutMs = input.timeoutMs ?? publishedBuildTimeoutMs()
  const pollMs = input.pollIntervalMs ?? publishedBuildPollIntervalMs()
  const deadline = Date.now() + timeoutMs
  let last: Awaited<ReturnType<PublishedBuildDeps['readJob']>> | null = null

  while (Date.now() < deadline) {
    await deps.sleep(pollMs)
    try {
      last = await deps.readJob(jobName, config.k8sNamespace)
    } catch (err: any) {
      // A transient read failure is not a build failure — keep waiting.
      deps.log(`[PublishedBuild] read of ${jobName} failed: ${err?.message ?? err}`)
      continue
    }
    if (last.status === 'succeeded') break
    if (last.status === 'failed') {
      await deps.deleteJob(jobName, config.k8sNamespace).catch(() => undefined)
      return {
        ok: false,
        code: 'build_failed',
        message: last.message ? `Image build failed: ${last.message}` : 'Image build failed',
        logTail: buildLogTail(last.logTail),
      }
    }
  }

  if (last?.status !== 'succeeded') {
    await deps.deleteJob(jobName, config.k8sNamespace).catch(() => undefined)
    return {
      ok: false,
      code: 'build_timeout',
      message: `Image build did not finish in ${Math.round(timeoutMs / 1000)}s`,
      logTail: buildLogTail(last?.logTail),
    }
  }

  const digest = digestFromTerminationMessage(last.message) ?? digestOfImageRef(last.message)
  if (!digest) {
    return {
      ok: false,
      code: 'build_digest_missing',
      message: 'The image build finished but reported no digest — refusing to publish an unpinned image',
      logTail: buildLogTail(last.message),
    }
  }

  const repository = publishedImageRepository({ ...config, projectId: input.projectId })
  const pinned = publishedImageDigestRef(repository, digest)
  deps.log(`[PublishedBuild] Built ${pinned} for ${input.projectId}@${commitSha.slice(0, 8)}`)
  return { ok: true, imageRef: pinned, imageDigest: digest, repository, reused: false }
}

// ============================================================================
// Default (cluster-backed) dependencies
// ============================================================================

function defaultDeps(): PublishedBuildDeps {
  return {
    config: () => publishedBuildSetup(),
    findReusableImage: findReusableImage,
    uploadArtifact: uploadPublishedArtifact,
    createJob: async (job) => {
      const api = await batchApi()
      await api.createNamespacedJob({ namespace: job.metadata.namespace, body: job as any })
    },
    readJob: async (name, namespace) => readJobStatus(name, namespace),
    deleteJob: async (name, namespace) => {
      const api = await batchApi()
      await api.deleteNamespacedJob({
        name,
        namespace,
        propagationPolicy: 'Background',
      })
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => console.log(message),
  }
}

/**
 * The commit's image if this project (in any environment) already has one.
 * `imageDigest` is what makes reuse safe: a tag can be moved, a digest cannot.
 */
async function findReusableImage(input: {
  projectId: string
  commitSha: string
}): Promise<{ imageRef: string; imageDigest: string } | null> {
  const row = await (prisma as any).publishedDeployment.findFirst({
    where: {
      commitSha: input.commitSha,
      imageDigest: { not: null },
      status: 'ready',
      environment: { projectId: input.projectId },
    },
    orderBy: { createdAt: 'desc' },
  })
  if (!row?.imageDigest) return null
  return { imageRef: row.imageRef as string, imageDigest: row.imageDigest as string }
}

/**
 * Pull the commit's build context from the editing runtime and put it in the
 * publish bucket, then hand the Job a presigned GET.
 *
 * The runtime produces the archive (`/agent/publish-artifact`) because it owns
 * both halves: the source, and the root-based `dist/` its own publish build
 * just emitted. Building the context here instead would mean re-implementing
 * the Vite/Expo publish build in the API.
 *
 * The artifact is a build input, not a served asset, so it lives under
 * `artifacts/` and is only ever read by the Job.
 */
async function uploadPublishedArtifact(input: {
  projectId: string
  subdomain: string
  commitSha: string
}): Promise<{ url: string } | { error: string }> {
  try {
    const { triggerBuildWithRetry } = await import('../routes/publish')
    const built = await triggerBuildWithRetry(input.projectId)
    if (!built.success) return { error: built.error ?? 'the publish build failed' }

    const { getProjectPodUrl } = await import('../lib/knative-project-manager')
    const { deriveProjectRuntimeToken } = await import('../lib/project-runtime-token')
    const podUrl = await getProjectPodUrl(input.projectId)
    const res = await fetch(`${podUrl}/agent/publish-artifact?projectId=${encodeURIComponent(input.projectId)}`, {
      headers: { 'x-runtime-token': await deriveProjectRuntimeToken(input.projectId) },
      signal: AbortSignal.timeout(180_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { error: `artifact request failed: ${res.status} ${body.slice(0, 200)}` }
    }
    const body = (await res.json()) as { archive?: string; message?: string }
    if (!body.archive) return { error: body.message ?? 'the runtime returned no archive' }
    const bytes = Buffer.from(body.archive, 'base64')
    if (bytes.length === 0) return { error: 'artifact tarball was empty' }

    const bucket = (process.env.PUBLISH_BUCKET || '').trim()
    if (!bucket) return { error: 'PUBLISH_BUCKET is not configured' }
    const key = `${input.subdomain}/artifacts/${input.commitSha}.tar.gz`
    const { getS3Client } = await import('../lib/s3')
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    await getS3Client().send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: 'application/gzip' }),
    )

    // Presign with the *internal* client: the Job runs inside the cluster and
    // must reach the internal endpoint, not the public one.
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')
    const { GetObjectCommand } = await import('@aws-sdk/client-s3')
    const url = await getSignedUrl(getS3Client(), new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: 3600,
    })
    return { url }
  } catch (err: any) {
    return { error: err?.message ?? String(err) }
  }
}

async function batchApi(): Promise<any> {
  const k8s = await import('@kubernetes/client-node')
  return kubeConfig(k8s).makeApiClient(k8s.BatchV1Api)
}

/**
 * In-cluster config when this API runs as a pod, local kubeconfig otherwise.
 * Same rule as `eval-job-manager` / `knative-project-manager`, kept local
 * because the module-level helpers there are not exported.
 */
function kubeConfig(k8s: typeof import('@kubernetes/client-node')): any {
  const kc = new k8s.KubeConfig()
  const dir = '/var/run/secrets/kubernetes.io/serviceaccount'
  const caPath = `${dir}/ca.crt`
  const tokenPath = `${dir}/token`
  if (existsSync(caPath) && existsSync(tokenPath)) {
    kc.loadFromOptions({
      clusters: [
        {
          name: 'in-cluster',
          server: `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`,
          caData: Buffer.from(readFileSync(caPath, 'utf8')).toString('base64'),
        },
      ],
      users: [{ name: 'in-cluster', token: readFileSync(tokenPath, 'utf8') }],
      contexts: [{ name: 'in-cluster', cluster: 'in-cluster', user: 'in-cluster' }],
      currentContext: 'in-cluster',
    })
  } else {
    kc.loadFromDefault()
  }
  return kc
}

/**
 * Read one build's progress, with the two things a failure needs: which step
 * failed and the tail of its log.
 */
async function readJobStatus(
  name: string,
  namespace: string,
): Promise<{ status: 'running' | 'succeeded' | 'failed'; message?: string | null; logTail?: string | null }> {
  const k8s = await import('@kubernetes/client-node')
  const kc = kubeConfig(k8s)
  const batch = kc.makeApiClient(k8s.BatchV1Api)
  const core = kc.makeApiClient(k8s.CoreV1Api)

  const job = await batch.readNamespacedJob({ name, namespace })
  const status = (job as any)?.status ?? {}
  if (status.succeeded && status.succeeded > 0) return { status: 'succeeded' }
  if ((status.failed ?? 0) > 0) {
    return { status: 'failed', message: failureReason(job), logTail: await podLogTail(core, namespace, name) }
  }

  // A pod that is gone (evicted) while the Job reports nothing is a failure:
  // without it the API would wait out the whole timeout for a build that
  // cannot finish.
  const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${name}` })
  const items = (pods as any)?.items ?? []
  if (items.length === 0) return { status: 'running' }
  const terminated = items.some((pod: any) =>
    (pod.status?.containerStatuses ?? []).some((c: any) => c.state?.terminated),
  )
  if (terminated) {
    return { status: 'failed', message: failureReason(job), logTail: await podLogTail(core, namespace, name) }
  }
  return { status: 'running' }
}

function failureReason(job: any): string | null {
  const conditions = job?.status?.conditions ?? []
  const failed = conditions.find((c: any) => c.type === 'Failed')
  if (failed?.message) return failed.message
  const deadline = conditions.find((c: any) => c.reason === 'DeadlineExceeded')
  if (deadline) return 'the build exceeded its deadline'
  return null
}

async function podLogTail(core: any, namespace: string, jobName: string): Promise<string | null> {
  try {
    const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${jobName}` })
    const pod = (pods as any)?.items?.[0]
    if (!pod?.metadata?.name) return null
    const log = await core.readNamespacedPodLog({
      name: pod.metadata.name,
      namespace,
      container: 'buildkit',
      tailLines: 40,
    })
    return typeof log === 'string' ? log : String(log ?? '')
  } catch {
    return null
  }
}
