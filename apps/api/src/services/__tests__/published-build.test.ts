// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-308 §2 — one image per commit.
//
// The interesting behaviour is not "does the Job run" (that needs a cluster)
// but the decisions around it, which is why they take their cluster, S3 and
// runtime work as injected deps: reuse a commit's existing digest, refuse a
// publish that cannot build instead of shipping an unpinned image, and carry
// the build's failure tail back to the Deployment tab.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// `published-build.service` imports the shared prisma client at module load;
// nothing here reads it (the default dep is always overridden).
mock.module('../../lib/prisma', () => ({ prisma: {} }))

const { ensurePublishedImage, fetchPublishedArtifact, jobPodsVerdict } = await import('../published-build.service')
const { buildPublishedImageJob, buildJobName, buildLogTail, digestFromTerminationMessage } = await import(
  '../../lib/published-build-job'
)
const { publishedBuildSetup, shouldBuildPublishedImage } = await import('../../lib/published-build-config')

const BUILD_ENV = {
  PUBLISH_BUILD_REGISTRY: 'us-ashburn-1.ocir.io',
  PUBLISH_BUILD_NAMESPACE: 'ax9example',
  PUBLISH_BUILD_IMAGE: 'moby/buildkit:v0.16-rootless',
}

const originalEnv = { ...process.env }

beforeEach(() => {
  process.env = { ...originalEnv, ...BUILD_ENV }
})

afterEach(() => {
  process.env = { ...originalEnv }
})

const input = {
  projectId: 'proj-1',
  environmentId: 'env-prod',
  subdomain: 'acme',
  commitSha: 'abc123def4567890',
}

/** Every dep overridden, so a test states only what it cares about. */
function deps(overrides: Record<string, any> = {}) {
  return {
    findReusableImage: async () => null,
    uploadArtifact: async () => ({ url: 'https://s3.internal/acme/artifacts/abc.tar.gz' }),
    createJob: async () => {},
    readJob: async () => ({ status: 'succeeded' as const, message: '{"containerimage.digest":"sha256:' + 'a'.repeat(64) + '"}' }),
    deleteJob: async () => {},
    sleep: async () => {},
    log: () => {},
    ...overrides,
  }
}

describe('publishedBuildSetup', () => {
  it('is disabled, not an error, when the build vars are absent', () => {
    delete process.env.PUBLISH_BUILD_REGISTRY
    delete process.env.PUBLISH_BUILD_NAMESPACE
    delete process.env.PUBLISH_BUILD_IMAGE
    const setup = publishedBuildSetup()
    expect(setup.ok).toBe(false)
    expect(setup.missing).toEqual(
      expect.arrayContaining(['PUBLISH_BUILD_REGISTRY', 'PUBLISH_BUILD_NAMESPACE', 'PUBLISH_BUILD_IMAGE']),
    )
    expect(shouldBuildPublishedImage('knative')).toBe(false)
  })

  it('never builds on the metal substrate, which boots a VM image', () => {
    expect(shouldBuildPublishedImage('metal')).toBe(false)
  })

  it('honours PUBLISH_BUILD_IMAGES=off even when fully configured', () => {
    process.env.PUBLISH_BUILD_IMAGES = 'off'
    expect(shouldBuildPublishedImage('knative')).toBe(false)
  })
})

describe('ensurePublishedImage', () => {
  it('refuses with build_not_configured rather than publishing an unpinned image', async () => {
    delete process.env.PUBLISH_BUILD_IMAGE
    const res = await ensurePublishedImage(input, deps())
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('build_not_configured')
    expect(res.message).toContain('PUBLISH_BUILD_IMAGE')
  })

  it("reuses a commit's existing digest without uploading or building", async () => {
    let created = 0
    let uploaded = 0
    const digest = `sha256:${'b'.repeat(64)}`
    const res = await ensurePublishedImage(
      input,
      deps({
        findReusableImage: async () => ({ imageRef: `repo@${digest}`, imageDigest: digest }),
        createJob: async () => {
          created++
        },
        uploadArtifact: async () => {
          uploaded++
          return { url: 'x' }
        },
      }),
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.reused).toBe(true)
    expect(res.imageDigest).toBe(digest)
    expect(created).toBe(0)
    expect(uploaded).toBe(0)
  })

  it('fails artifact_missing when the runtime cannot produce the context', async () => {
    const res = await ensurePublishedImage(
      input,
      deps({ uploadArtifact: async () => ({ error: 'no dist' }) }),
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('artifact_missing')
    expect(res.message).toContain('no dist')
  })

  it('tells the artifact upload the app build already ran', async () => {
    // The publish flow builds the app before it asks for an image; a second
    // build there is a full Vite/Expo run the publish has just done.
    const seen: Array<{ alreadyBuilt?: boolean }> = []
    const res = await ensurePublishedImage(
      { ...input, alreadyBuilt: true },
      deps({
        uploadArtifact: async (arg: { alreadyBuilt?: boolean }) => {
          seen.push(arg)
          return { url: 'https://s3.internal/acme/artifacts/abc.tar.gz' }
        },
      }),
    )
    expect(res.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0].alreadyBuilt).toBe(true)
  })

  it('defaults to building when the caller did not build', async () => {
    const seen: Array<{ alreadyBuilt?: boolean }> = []
    await ensurePublishedImage(
      input,
      deps({
        uploadArtifact: async (arg: { alreadyBuilt?: boolean }) => {
          seen.push(arg)
          return { url: 'https://s3.internal/acme/artifacts/abc.tar.gz' }
        },
      }),
    )
    expect(seen[0].alreadyBuilt).toBe(false)
  })

  // SHO-308, staging 2026-11-08: `/agent/dist-files?publish=true` deleted the
  // staging dir `/agent/publish-artifact` reads, so every server-backed publish
  // died with artifact_missing. The runtime is fixed, but a pod can still be
  // running the old handler (metal rootfs lags the API), so the one safe
  // fallback is a single rebuild and a single retry.
  describe('fetchPublishedArtifact', () => {
    const distNotFound = { ok: false as const, status: 404, body: '{"error":"dist_not_found"}' }

    it('rebuilds once and retries once when the runtime lost its build output', async () => {
      const calls: string[] = []
      let requests = 0
      const res = await fetchPublishedArtifact(
        { projectId: 'proj-1', alreadyBuilt: true },
        {
          requestArtifact: async () => {
            requests++
            calls.push(`artifact:${requests}`)
            return requests === 1 ? distNotFound : { ok: true as const, archive: 'Zm9v' }
          },
          rebuild: async () => {
            calls.push('rebuild')
            return { success: true }
          },
          log: () => {},
        },
      )
      expect(res).toEqual({ archive: 'Zm9v' })
      expect(calls).toEqual(['artifact:1', 'rebuild', 'artifact:2'])
    })

    it('does not rebuild when the caller had not built yet', async () => {
      let rebuilt = 0
      const res = await fetchPublishedArtifact(
        { projectId: 'proj-1', alreadyBuilt: false },
        {
          requestArtifact: async () => distNotFound,
          rebuild: async () => {
            rebuilt++
            return { success: true }
          },
          log: () => {},
        },
      )
      expect('error' in res).toBe(true)
      expect(rebuilt).toBe(0)
    })

    it('does not rebuild for a failure that is not a missing build output', async () => {
      let rebuilt = 0
      const res = await fetchPublishedArtifact(
        { projectId: 'proj-1', alreadyBuilt: true },
        {
          requestArtifact: async () => ({ ok: false as const, status: 500, body: 'artifact_failed' }),
          rebuild: async () => {
            rebuilt++
            return { success: true }
          },
          log: () => {},
        },
      )
      expect('error' in res).toBe(true)
      expect(rebuilt).toBe(0)
    })

    it('surfaces a failed rebuild instead of retrying into the same error', async () => {
      let requests = 0
      const res = await fetchPublishedArtifact(
        { projectId: 'proj-1', alreadyBuilt: true },
        {
          requestArtifact: async () => {
            requests++
            return distNotFound
          },
          rebuild: async () => ({ success: false, error: 'vite exited 1' }),
          log: () => {},
        },
      )
      expect('error' in res && res.error).toContain('vite exited 1')
      expect(requests).toBe(1)
    })
  })

  it('pins the built digest onto the repository', async () => {
    const digest = `sha256:${'c'.repeat(64)}`
    const res = await ensurePublishedImage(
      input,
      deps({ readJob: async () => ({ status: 'succeeded' as const, message: `sha256:${'c'.repeat(64)}` }) }),
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.reused).toBe(false)
    expect(res.imageDigest).toBe(digest)
    expect(res.imageRef).toBe(`${res.repository}@${digest}`)
    // The tag it pushed to and the digest it runs are the same repository.
    expect(res.imageRef.startsWith(res.repository)).toBe(true)
  })

  it('recovers the digest from the build log when the termination message is empty', async () => {
    const digest = `sha256:${'e'.repeat(64)}`
    const res = await ensurePublishedImage(
      input,
      deps({
        // A container that exits before the kubelet can read the message still
        // echoed the metadata to its log.
        readJob: async () => ({
          status: 'succeeded' as const,
          message: null,
          logTail: `#12 pushing layers...\n{"containerimage.digest":"${digest}"}\n`,
        }),
      }),
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.imageDigest).toBe(digest)
    expect(res.imageRef).toBe(`${res.repository}@${digest}`)
  })

  it('retries a create that races the terminating Job of a previous attempt', async () => {
    let attempts = 0
    const res = await ensurePublishedImage(
      input,
      deps({
        createJob: async () => {
          attempts++
          if (attempts < 3) {
            const conflict: any = new Error('jobs.batch "x" already exists')
            conflict.statusCode = 409
            throw conflict
          }
        },
      }),
    )
    expect(res.ok).toBe(true)
    expect(attempts).toBe(3)
  })

  it('fails fast on a create error that is not a conflict', async () => {
    let attempts = 0
    const res = await ensurePublishedImage(
      input,
      deps({
        createJob: async () => {
          attempts++
          throw new Error('forbidden: cannot create jobs')
        },
      }),
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('build_failed')
    expect(attempts).toBe(1)
  })

  it('reports a failed build with its log tail and cleans the Job up', async () => {
    const deleted: string[] = []
    const res = await ensurePublishedImage(
      input,
      deps({
        readJob: async () => ({
          status: 'failed' as const,
          message: 'BackoffLimitExceeded',
          logTail: 'error: failed to solve: bun install exited 1',
        }),
        deleteJob: async (name: string) => {
          deleted.push(name)
        },
      }),
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('build_failed')
    expect(res.logTail).toContain('bun install exited 1')
    expect(deleted.length).toBeGreaterThan(0)
  })

  it('times out instead of waiting forever on a stuck build', async () => {
    const res = await ensurePublishedImage(
      { ...input, timeoutMs: 0 },
      deps({ readJob: async () => ({ status: 'running' as const }) }),
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('build_timeout')
  })

  it('refuses a build that reports no digest', async () => {
    const res = await ensurePublishedImage(
      input,
      deps({ readJob: async () => ({ status: 'succeeded' as const, message: 'done' }) }),
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('build_digest_missing')
  })
})

describe('buildPublishedImageJob', () => {
  const job = buildPublishedImageJob({
    projectId: 'proj-1',
    commitSha: 'abc123def4567890',
    imageRef: 'us-ashburn-1.ocir.io/ax9example/shogo/published/proj-1:abc123de',
    artifactUrl: 'https://s3.internal/a.tar.gz',
    namespace: 'shogo-builds',
    builderImage: 'moby/buildkit:v0.16-rootless',
    dockerfile: 'FROM scratch',
    activeDeadlineSeconds: 900,
  })

  it('drives the dockerfile frontend, so the generated Dockerfile is what gets built', () => {
    const args = (job.spec as any).template.spec.containers[0].args as string[]
    const flag = (name: string) => args[args.indexOf(name) + 1]
    expect(flag('--frontend')).toBe('dockerfile.v0')
    // The Dockerfile and the context are separate locals; passing the file's
    // contents as a local (as the old argv did) builds nothing.
    expect(flag('--local')).toBe('context=/src')
    expect(args[args.indexOf('--local', args.indexOf('--local') + 1) + 1]).toBe('dockerfile=/src')
    expect(flag('--opt')).toBe('filename=Dockerfile.published')
  })

  it('writes the digest where the non-root build container can actually write it', () => {
    const container = (job.spec as any).template.spec.containers[0]
    const args = container.args as string[]
    const metadataPath = args[args.indexOf('--metadata-file') + 1]
    // buildctl writes a temp file next to the target and renames it over it:
    // uid 1000 cannot create files in /dev, and a rename onto the kubelet's
    // bind-mounted termination file is refused. Both broke real staging builds
    // after the push had already succeeded.
    expect(metadataPath).not.toBe('/dev/termination-log')
    expect(metadataPath).not.toBe(container.terminationMessagePath)
    expect(container.terminationMessagePath).toBe('/dev/termination-log')
    // The wrapper copies it into the termination message in place, and echoes
    // it to the log as a second way to read it back.
    expect(args[0]).toContain(`cat ${metadataPath} > /dev/termination-log`)
    expect(args[0]).toContain(`cat ${metadataPath} 2>/dev/null || true; exit $rc`)
    expect(container.command).toEqual(['/bin/sh', '-c'])
    expect((job.spec as any).template.spec.securityContext?.runAsUser).toBeUndefined()
    expect(container.securityContext.runAsUser).toBe(1000)
  })

  it('names the source-fetch image fully qualified, because CRI-O refuses short names', () => {
    const spec = (job.spec as any).template.spec
    for (const c of spec.initContainers) {
      expect(c.image.split('/')[0]).toMatch(/\./)
    }
  })

  it('runs the rootless worker the way its entrypoint expects', () => {
    const container = (job.spec as any).template.spec.containers[0]
    const env = Object.fromEntries(container.env.map((e: any) => [e.name, e.value]))
    expect(container.args[0]).toContain('buildctl-daemonless.sh "$@"')
    expect(env.BUILDKITD_FLAGS).toBe('--oci-worker-no-process-sandbox')
    // The mounted docker config is resolved through HOME.
    expect(env.HOME).toBe('/home/user')
    expect(container.securityContext.seccompProfile.type).toBe('Unconfined')
  })

  it('pushes to the image ref it was given, with push enabled', () => {
    const args = (job.spec as any).template.spec.containers[0].args as string[]
    const output = args[args.indexOf('--output') + 1]
    expect(output).toContain('push=true')
    expect(output).toContain('name=us-ashburn-1.ocir.io/ax9example/shogo/published/proj-1:abc123de')
  })

  it('delivers the Dockerfile with the Job so a project cannot change how it is built', () => {
    const fetch = (job.spec as any).template.spec.initContainers[0]
    const env = Object.fromEntries(fetch.env.map((e: any) => [e.name, e.value]))
    expect(env.DOCKERFILE).toBe('FROM scratch')
    expect(env.DOCKERFILE_NAME).toBe('Dockerfile.published')
  })

  it('carries the registry push credentials as a docker config secret', () => {
    const spec = (job.spec as any).template.spec
    const mount = spec.containers[0].volumeMounts.find((m: any) => m.mountPath === '/home/user/.docker')
    expect(mount).toBeTruthy()
    const volume = spec.volumes.find((v: any) => v.name === mount.name)
    expect(volume.secret.items[0].path).toBe('config.json')
  })

  it('never retries a failed build into a digest nobody asked for', () => {
    expect((job.spec as any).backoffLimit).toBe(0)
  })

  it('names the Job per commit so a re-publish joins rather than duplicates', () => {
    expect(buildJobName('proj-1', 'abc123def4567890')).toBe(buildJobName('proj-1', 'abc123def4567890'))
    // Kubernetes names must be DNS-1123.
    expect(buildJobName('Proj_1/x', 'ABCDEF12')).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/)
  })
})

describe('digestFromTerminationMessage', () => {
  const digest = `sha256:${'d'.repeat(64)}`

  it('reads the metadata file JSON', () => {
    expect(digestFromTerminationMessage(JSON.stringify({ 'containerimage.digest': digest }))).toBe(digest)
  })

  it('falls back to any digest in plain text', () => {
    expect(digestFromTerminationMessage(`pushed ${digest}`)).toBe(digest)
  })

  it('returns null for a truncated stack trace rather than throwing', () => {
    expect(digestFromTerminationMessage('panic: runtime error')).toBeNull()
    expect(digestFromTerminationMessage(null)).toBeNull()
  })
})

describe('buildLogTail', () => {
  it('keeps the last lines, where the failure is', () => {
    const log = ['noise 1', 'noise 2', 'error: the real problem'].join('\n')
    expect(buildLogTail(log)).toBe('noise 1\nnoise 2\nerror: the real problem')
  })

  it('is empty for an empty log rather than "undefined"', () => {
    expect(buildLogTail(null)).toBe('')
  })
})

// SHO-308, staging 2026-11-08: the build pushed its image and exited 0, but the
// API read the pod before the Job controller set `status.succeeded` and called
// the build failed. A terminated pod is only a failure when it exited non-zero.
describe('jobPodsVerdict', () => {
  const pod = (phase: string, containers: any[], init: any[] = []) => ({
    status: { phase, containerStatuses: containers, initContainerStatuses: init },
  })
  const exited = (exitCode: number) => ({ state: { terminated: { exitCode } } })

  it('keeps waiting when the build exited 0 but the Job has not caught up', () => {
    expect(jobPodsVerdict([pod('Succeeded', [exited(0)], [exited(0)])])).toBe('running')
  })

  it('keeps waiting while the build is still running or there is no pod yet', () => {
    expect(jobPodsVerdict([pod('Running', [{ state: { running: {} } }], [exited(0)])])).toBe('running')
    expect(jobPodsVerdict([])).toBe('running')
  })

  it('fails fast when the build container exited non-zero', () => {
    expect(jobPodsVerdict([pod('Running', [exited(1)])])).toBe('failed')
  })

  it('fails fast when the artifact download init container exited non-zero', () => {
    expect(jobPodsVerdict([pod('Pending', [{ state: { waiting: {} } }], [exited(22)])])).toBe('failed')
  })

  it('fails fast when the pod itself failed (evicted)', () => {
    expect(jobPodsVerdict([pod('Failed', [])])).toBe('failed')
  })
})
