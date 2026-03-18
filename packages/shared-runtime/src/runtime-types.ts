// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runtime Type Registry
 *
 * Single unified runtime configuration. All projects use the same
 * runtime image with mode switching (canvas / app / none).
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

export const RUNTIME_CONFIG: RuntimeTypeConfig = {
  image: () => process.env.RUNTIME_IMAGE || (() => {
    console.error('[RuntimeTypes] RUNTIME_IMAGE env var not set — falling back to ghcr.io default which will likely fail in EKS.')
    return 'ghcr.io/shogo-ai/runtime:latest'
  })(),
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
