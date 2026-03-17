// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runtime Type Registry
 *
 * Centralizes configuration for agent and project runtime types.
 * Used by warm-pool-controller and knative-project-manager to avoid
 * hardcoded `isAgentProject ? X : Y` branching.
 */

export type RuntimeType = 'agent' | 'project'

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

export const RUNTIME_TYPES: Record<RuntimeType, RuntimeTypeConfig> = {
  agent: {
    image: () => process.env.AGENT_RUNTIME_IMAGE || (() => {
      console.error('[RuntimeTypes] AGENT_RUNTIME_IMAGE env var not set — falling back to ghcr.io default which will likely fail in EKS.')
      return 'ghcr.io/shogo-ai/agent-runtime:latest'
    })(),
    workDir: '/app/agent',
    extraEnv: { AGENT_DIR: '/app/agent' },
    componentLabel: 'agent-runtime',
    containerName: 'agent-runtime',
  },
  project: {
    image: () => process.env.PROJECT_RUNTIME_IMAGE || 'ghcr.io/shogo-ai/project-runtime:latest',
    workDir: '/app/project',
    extraEnv: {},
    componentLabel: 'project-runtime',
    containerName: 'project-runtime',
  },
}

/**
 * Map a Prisma ProjectType enum value to a RuntimeType.
 */
export function runtimeTypeFromProjectType(type: 'APP' | 'AGENT'): RuntimeType {
  return type === 'AGENT' ? 'agent' : 'project'
}

/**
 * Get the RuntimeTypeConfig for a given runtime type.
 */
export function getRuntimeConfig(type: RuntimeType): RuntimeTypeConfig {
  return RUNTIME_TYPES[type]
}

/**
 * Build the base environment variables for a pod of the given runtime type.
 * Returns an array in the K8s env format: [{ name, value }].
 */
export function buildRuntimeEnv(
  type: RuntimeType,
  projectId: string,
  extra?: Record<string, string>
): Array<{ name: string; value: string }> {
  const cfg = RUNTIME_TYPES[type]
  const env: Array<{ name: string; value: string }> = [
    { name: 'PROJECT_ID', value: projectId },
    { name: 'PROJECT_DIR', value: cfg.workDir },
  ]

  for (const [key, value] of Object.entries(cfg.extraEnv)) {
    env.push({ name: key, value })
  }

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      env.push({ name: key, value })
    }
  }

  return env
}
