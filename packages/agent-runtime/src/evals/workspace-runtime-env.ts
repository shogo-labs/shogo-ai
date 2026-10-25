// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace-runtime env for an eval worker (SHO-195).
 *
 * Every eval used to boot its worker as a single-project runtime: `PROJECT_ID`
 * plus `PROJECT_DIR`, no `WORKSPACE_RUNTIME`. That means the agent ran with a
 * project's prompt and tool set, so no case could reproduce a workspace
 * session — the shape a workspace chat runs in, where the root holds sibling
 * project folders and "build me an app" has to become `project_create` +
 * `project_call` (SHO-194).
 *
 * This module is the one place that decides the workspace env a worker boots
 * with, so `--local` and Docker behave identically. It is pure: no env reads,
 * no process mutation, so the env key can be unit-tested and used to detect
 * when a reused worker has to be restarted.
 *
 * The **unset** half matters as much as the set half. A developer running
 * evals from inside their own workspace pod (the usual case: an agent project
 * IS a workspace runtime) has `WORKSPACE_RUNTIME` / `WORKSPACE_ID` /
 * `WORKSPACE_MOUNTS` in `process.env`, and `startLocalWorker` passes
 * `process.env` through. Without stripping those, every single-project eval
 * silently boots as a workspace runtime belonging to the developer's own
 * workspace.
 */

import type { EvalWorkspaceRuntime } from './types'

/** Stable id for eval workspaces — fixtures are not real workspaces. */
export const EVAL_WORKSPACE_ID = 'eval-workspace'

/**
 * Env keys that decide whether a process is a workspace runtime, which
 * workspace it serves, and what it can see of that workspace. Never inherited
 * from the parent process: the worker's identity is the eval's, not the
 * developer's.
 */
export const RUNTIME_IDENTITY_ENV_KEYS = [
  'WORKSPACE_RUNTIME',
  'WORKSPACE_ID',
  'WORKSPACE_KIND',
  'WORKSPACE_PROJECT_IDS',
  'WORKSPACE_PROJECTS',
  'WORKSPACE_AVAILABLE_PROJECTS',
  'WORKSPACE_ANCHOR_PROJECT_ID',
  'WORKSPACE_MOUNTS',
  'WORKSPACE_PREVIEW_URLS',
  'WORKSPACE_READONLY_PROJECT_IDS',
  'WORKSPACE_TECH_STACKS',
  'WORKSPACE_DATABASE_URLS',
  'WORKSPACE_METAL_PROJECTS',
  'LINKED_FOLDERS',
  'READONLY_ROOTS',
  'RUNTIME_ENABLED',
  'RUNTIME_AUTH_SECRET',
  'SHOGO_RUNTIME_SUBSTRATE',
  'SHOGO_RUNTIME_CLASS',
  'SHOGO_EXPOSED_PORTS',
  'WORKING_MODE',
  'PROJECT_ID',
] as const

/** Env deltas a worker needs for one eval. */
export interface EvalWorkerEnv {
  /** Variables to set on the worker process/container. */
  set: Record<string, string>
  /** Variables to delete from the inherited environment before setting the above. */
  unset: string[]
}

/**
 * Build the workspace env for one eval.
 *
 * `workspaceRuntime` unset → a plain single-project runtime: nothing is set,
 * and every identity/workspace key is stripped from the inherited env.
 *
 * `workspaceRuntime` set → the worker boots as a workspace runtime with no
 * anchor (`PROJECT_ID` is the `ws:<id>` registry key production uses for a
 * workspace session). Mounted projects are the ones the runtime mounts under
 * `<id>/`, so they drive `WORKSPACE_PROJECT_IDS` / `WORKSPACE_PROJECTS`;
 * unmounted ones only appear in the `WORKSPACE_AVAILABLE_PROJECTS` catalog.
 */
export function evalWorkspaceEnv(
  workspaceRuntime: EvalWorkspaceRuntime | undefined,
  opts: { workspaceId?: string } = {},
): EvalWorkerEnv {
  const unset = [...RUNTIME_IDENTITY_ENV_KEYS]

  if (!workspaceRuntime) return { set: {}, unset }

  const workspaceId = opts.workspaceId ?? EVAL_WORKSPACE_ID
  const projects = workspaceRuntime.projects ?? []
  const mounted = projects.filter((p) => p.mounted !== false)

  const set: Record<string, string> = {
    WORKSPACE_RUNTIME: 'true',
    WORKSPACE_ID: workspaceId,
    WORKSPACE_KIND: workspaceRuntime.kind,
    WORKSPACE_PROJECT_IDS: mounted.map((p) => p.id).join(','),
    WORKSPACE_PROJECTS: JSON.stringify(mounted.map((p) => ({ id: p.id, name: p.name }))),
    WORKSPACE_AVAILABLE_PROJECTS: JSON.stringify(
      projects.map((p) => ({ id: p.id, name: p.name, description: null })),
    ),
    // A workspace session (no anchor) is keyed `ws:<workspaceId>` in the
    // runtime registry, and that key is what production hands it as
    // PROJECT_ID. Internal per-runtime calls (`projectId: process.env.PROJECT_ID`)
    // rely on it being non-empty.
    PROJECT_ID: `ws:${workspaceId}`,
  }
  if (workspaceRuntime.metal) {
    set.SHOGO_RUNTIME_SUBSTRATE = 'metal'
  }
  return { set, unset }
}

/**
 * Equality key for a worker's workspace env. A worker is only reusable while
 * this matches — anything else needs a restart with the new env, because env
 * is read once at process/container start.
 */
export function evalWorkspaceEnvKey(env: EvalWorkerEnv): string {
  const set = Object.keys(env.set)
    .sort()
    .map((k) => `${k}=${env.set[k]}`)
  return JSON.stringify({ set, unset: [...env.unset].sort() })
}

/** Apply an env delta to a record: delete `unset`, then assign `set`. */
export function applyEvalWorkerEnv(
  env: Record<string, string | undefined>,
  delta: EvalWorkerEnv,
): Record<string, string | undefined> {
  for (const key of delta.unset) delete env[key]
  Object.assign(env, delta.set)
  return env
}
