// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The per-commit build, as a Kubernetes Job (SHO-308 §2).
 *
 * Publish must not build on start: a published pod that runs `bun install` and
 * `vite build` takes ~30 s to answer its first request and can't autoscale,
 * because every new replica would pay the same cost. Instead, one rootless
 * BuildKit Job per (project, commit) builds a fixed `Dockerfile` from the
 * commit's artifact tarball, pushes it to OCIR, and reports the image digest.
 *
 * This module is deliberately pure — it builds the Job object and reads a
 * digest out of a terminated container. Everything that needs a cluster
 * (creating the Job, polling it, reading logs) lives in
 * `services/published-build.service.ts`, so the shape of what we ask the
 * cluster to run is testable without one.
 *
 * The digest comes back through the container's termination message
 * (`--metadata-file /dev/termination-log`), which Kubernetes records in
 * `containerStatuses[].state.terminated.message`. That avoids handing the Job
 * an API token just to write one string back.
 */

/** Everything the Job needs that is not a cluster default. */
export interface BuildKitJobSpecInput {
  projectId: string
  commitSha: string
  /** Full tag ref the build pushes to, e.g. `<registry>/<ns>/shogo/published/<id>:<sha>`. */
  imageRef: string
  /** Where the build fetches the commit's artifact tarball from. */
  artifactUrl: string
  namespace: string
  /** Name of the k8s Secret holding OCIR push credentials (`.dockerconfigjson`). */
  registrySecret?: string
  /** BuildKit image, pinned by digest in production (`config/build-image.ts`). */
  builderImage: string
  /**
   * The Dockerfile the build uses, written into the context by the fetch step.
   * It is platform infrastructure, so it travels with the Job rather than
   * living in the app's repo where a project could change how it is built.
   */
  dockerfile: string
  /** Filename the Dockerfile is written as, inside the context. */
  dockerfileName?: string
  jobName?: string
  serviceAccountName?: string
  /** Wall clock cap for the build; the Job is deleted after the API gives up. */
  activeDeadlineSeconds?: number
  ttlSecondsAfterFinished?: number
}

export interface BuildKitJobObject {
  apiVersion: 'batch/v1'
  kind: 'Job'
  metadata: {
    name: string
    namespace: string
    labels: Record<string, string>
  }
  spec: Record<string, unknown>
}

/** `published-build-<project>-<sha8>`; DNS-1123, and stable per commit. */
export function buildJobName(projectId: string, commitSha: string): string {
  const project = projectId.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 24)
  const sha = commitSha.trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10)
  return `published-build-${project}-${sha}`.replace(/-+/g, '-').replace(/-$/, '')
}

/**
 * The Job that takes a commit's artifact tarball to an image.
 *
 * One container is enough: BuildKit's rootless entrypoint takes the tarball
 * URL, builds the pinned Dockerfile and pushes with `--output type=image`.
 * `--metadata-file /dev/termination-log` is how the digest comes back.
 */
export function buildPublishedImageJob(input: BuildKitJobSpecInput): BuildKitJobObject {
  const name = input.jobName?.trim() || buildJobName(input.projectId, input.commitSha)
  const serviceAccount = input.serviceAccountName?.trim() || 'shogo-builds'
  const secretName = input.registrySecret?.trim() || 'ocir-push'
  const deadline = Math.max(60, Math.floor(input.activeDeadlineSeconds ?? 900))
  const ttl = Math.max(0, Math.floor(input.ttlSecondsAfterFinished ?? 3600))

  const buildkitArgs = [
    'build',
    '--addr',
    'unix:///run/user/1000/buildkit/buildkitd.sock',
    '--frontend',
    'dockerfile.v0',
    '--local',
    'context=/src',
    '--local',
    'dockerfile=/src',
    '--opt',
    `filename=${input.dockerfileName?.trim() || 'Dockerfile.published'}`,
    '--output',
    `type=image,name=${input.imageRef},push=true`,
    '--metadata-file',
    '/dev/termination-log',
  ]

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace: input.namespace,
      labels: {
        'app.kubernetes.io/name': 'shogo-published-build',
        'app.kubernetes.io/managed-by': 'shogo-api',
        'shogo.io/project-id': input.projectId,
        'shogo.io/commit': input.commitSha,
      },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: deadline,
      ttlSecondsAfterFinished: ttl,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'shogo-published-build',
            'shogo.io/project-id': input.projectId,
          },
        },
        spec: {
          restartPolicy: 'Never',
          serviceAccountName: serviceAccount,
          enableServiceLinks: false,
          initContainers: [
            {
              name: 'fetch-source',
              image: 'curlimages/curl:8.11.0',
              command: [
                'sh',
                '-c',
                // Refuse an empty download: a 200 with no body would otherwise
                // reach BuildKit as an unreadable tarball.
                'set -eu; curl -fsSL "$ARTIFACT_URL" -o /src/source.tar.gz; ' +
                  '[ -s /src/source.tar.gz ] || { echo "artifact is empty" >&2; exit 1; }; ' +
                  'tar -xzf /src/source.tar.gz -C /src --exclude=source.tar.gz; ' +
                  'rm -f /src/source.tar.gz; ' +
                  'printf \'%s\' "$DOCKERFILE" > "/src/$DOCKERFILE_NAME"',
              ],
              env: [
                { name: 'ARTIFACT_URL', value: input.artifactUrl },
                { name: 'DOCKERFILE', value: input.dockerfile },
                { name: 'DOCKERFILE_NAME', value: input.dockerfileName?.trim() || 'Dockerfile.published' },
              ],
              volumeMounts: [{ name: 'src', mountPath: '/src' }],
              resources: {
                requests: { cpu: '50m', memory: '64Mi' },
                limits: { cpu: '500m', memory: '512Mi' },
              },
            },
          ],
          containers: [
            {
              name: 'buildkit',
              image: input.builderImage,
              args: buildkitArgs,
              env: [
                { name: 'BUILDKITD_FLAGS', value: '--oci-worker-no-process-sandbox' },
                { name: 'HOME', value: '/home/user' },
              ],
              // Rootless BuildKit needs its own user namespace to mount the
              // worker; anything narrower fails at startup, not at build time.
              securityContext: {
                runAsUser: 1000,
                runAsGroup: 1000,
                seccompProfile: { type: 'Unconfined' },
              },
              volumeMounts: [
                { name: 'src', mountPath: '/src' },
                { name: 'docker-config', mountPath: '/home/user/.docker', readOnly: true },
              ],
              resources: {
                requests: { cpu: '500m', memory: '1Gi' },
                limits: { cpu: '2', memory: '4Gi' },
              },
            },
          ],
          volumes: [
            { name: 'src', emptyDir: { sizeLimit: '2Gi' } },
            {
              name: 'docker-config',
              secret: {
                secretName: secretName,
                items: [{ key: '.dockerconfigjson', path: 'config.json' }],
              },
            },
          ],
        },
      },
    },
  }
}

/**
 * Read the pushed image's digest out of a terminated build container.
 *
 * BuildKit's metadata file looks like
 * `{"containerimage.digest":"sha256:…","buildx.build.ref":"…"}` — but the
 * termination message is truncated at 4 KiB by the kubelet and may not be JSON
 * at all (a crash prints a stack trace). So: try JSON, then fall back to the
 * first `sha256:<64 hex>` in the text, and answer `null` rather than throwing
 * when neither is there — the caller turns that into `build_digest_missing`.
 */
export function digestFromTerminationMessage(message: string | null | undefined): string | null {
  const text = (message ?? '').trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const candidate = parsed['containerimage.digest'] ?? parsed['containerimage.config.digest']
    if (typeof candidate === 'string') {
      const match = /sha256:[a-f0-9]{64}/.exec(candidate)
      if (match) return match[0]
    }
  } catch {
    /* not JSON — fall through to the regex */
  }
  const match = /sha256:[a-f0-9]{64}/.exec(text)
  return match ? match[0] : null
}

/**
 * A short tail of a failed build's log for `publishError`.
 *
 * The whole log is usually hundreds of lines of npm noise; the last lines are
 * the ones that say what broke. Kept small because it lands in a DB column and
 * in the Deployment tab.
 */
export function buildLogTail(log: string | null | undefined, maxLines = 12, maxChars = 2000): string {
  const text = (log ?? '').trim()
  if (!text) return ''
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  const tail = lines.slice(-maxLines).join('\n')
  return tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail
}
