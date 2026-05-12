// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runtime Type Registry
 *
 * Single unified runtime configuration. All projects use the same
 * runtime image with mode switching (canvas / app / none).
 *
 * The base image pre-warms Bun's tarball cache with the Expo + RN
 * dependency tree (see Dockerfile.base), so mobile projects no longer
 * need a separate image variant. Per-stack pod sizing is still
 * orthogonal — see `apps/api/src/config/instance-sizes.ts`.
 */

export interface RuntimeTypeConfig {
  /** Returns the container image for this runtime type */
  image: () => string
  /** Workspace directory inside the container */
  workDir: string
  /** Extra env vars to set on pods of this type */
  extraEnv: Record<string, string>
  /** K8s label value for shogo.io/component */
  componentLabel: string
  /** Container name in the Knative service spec */
  containerName: string
}

// Track whether we've already warned about an unpinned image. We log once
// per process to avoid filling the API logs every reconcile cycle.
let _warnedAboutUnpinnedImage = false

function resolveRuntimeImage(): string {
  const img = process.env.RUNTIME_IMAGE
  if (!img) {
    console.error(
      '[RuntimeTypes] RUNTIME_IMAGE env var not set — falling back to ghcr.io default which will likely fail in OKE/EKS.'
    )
    return 'ghcr.io/shogo-ai/runtime:latest'
  }
  // Production safety: warn if the image is referenced by a mutable tag like
  // `:staging-latest` instead of an immutable `@sha256:…` digest or
  // monotonic SHA tag. Mutable tags caused the staging incident on
  // 2026-05-04: warm-pool revisions pinned to digests that the OCIR
  // cleanup later pruned because the tag had moved to a newer push.
  // Immutable references the cleanup workflow's cross-reference can detect
  // and protect: digest (`@sha256:…`) or `:<env>-<git-sha>` (40 hex chars).
  const isPinned = /@sha256:[a-f0-9]{64}$/.test(img) || /:[a-z0-9-]*[0-9a-f]{40}$/.test(img)
  if (!isPinned && !_warnedAboutUnpinnedImage) {
    _warnedAboutUnpinnedImage = true
    console.warn(
      `[RuntimeTypes] RUNTIME_IMAGE="${img}" uses a mutable tag. Knative will resolve it to a digest at admission time, ` +
        'and that digest may be pruned by the OCIR cleanup workflow when the tag moves. Prefer ":<env>-<git-sha>" or ' +
        '"@sha256:<digest>" so the cleanup cross-reference can protect it.'
    )
  }
  return img
}

export const RUNTIME_CONFIG: RuntimeTypeConfig = {
  image: resolveRuntimeImage,
  workDir: '/app/workspace',
  extraEnv: {},
  componentLabel: 'runtime',
  containerName: 'runtime',
}

/**
 * Build the base environment variables for a runtime pod.
 * Returns an array in the K8s env format: [{ name, value }].
 */
export function buildRuntimeEnv(
  projectId: string,
  extra?: Record<string, string>
): Array<{ name: string; value: string }> {
  const map = new Map<string, string>([
    ['PROJECT_ID', projectId],
    ['WORKSPACE_DIR', RUNTIME_CONFIG.workDir],
  ])

  for (const [key, value] of Object.entries(RUNTIME_CONFIG.extraEnv)) {
    map.set(key, value)
  }

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      map.set(key, value)
    }
  }

  return Array.from(map, ([name, value]) => ({ name, value }))
}
