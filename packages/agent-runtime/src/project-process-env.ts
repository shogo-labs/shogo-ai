// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one rule for the env of any process that runs project or third-party
 * code: the API sidecar, builds, watchers, Expo, Prisma, an agent `exec`
 * shell, an MCP server.
 *
 * A workspace runtime's own `RUNTIME_AUTH_SECRET` is the **workspace** token
 * (`wrt_v1_…`), accepted for every project in the workspace. User code must
 * never hold it — the API only takes it on the Git LFS routes, so an app
 * server that inherits it 401s on every SDK call (LLM, voice/music, tools).
 * Such a process gets its own project's `rt_v1_…` token instead, or no token
 * at all.
 *
 * `resolveProjectProcessEnv` is the single implementation of that swap;
 * {@link resolveProjectCredentialEnv} and {@link resolveProjectChildEnv} wrap
 * it with the cwd → project lookup the spawn sites need. Nothing else should
 * re-derive it.
 */

import { isAbsolute, relative, resolve, sep } from 'path'
import { fetchAppRuntimeToken } from './app-runtime-token'
import { isWorkspaceRuntimeMode, parseWorkspaceMounts } from './workspace-runtime-mode'

/**
 * Env for any process that runs project code: the API sidecar, builds,
 * watchers, Expo and Prisma. The `@shogo-ai/sdk` in that process reads
 * RUNTIME_AUTH_SECRET, PROJECT_ID and RUNTIME_PORT from it.
 *
 * In a workspace runtime the inherited workspace token is replaced by the
 * project's own token, or removed when there is none, and PROJECT_ID names
 * the project rather than the workspace.
 */
export function resolveProjectProcessEnv(input: {
  parentEnv: NodeJS.ProcessEnv
  projectId?: string
  appRuntimeToken?: string | null
}): Record<string, string> {
  const { parentEnv, projectId, appRuntimeToken } = input
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parentEnv)) {
    if (typeof v === 'string') out[k] = v
  }
  // parentEnv.PORT is the runtime's own port. The SDK tools client uses it
  // to reach the runtime over 127.0.0.1; the sidecar overwrites PORT with
  // its bind port afterwards.
  out.RUNTIME_PORT = parentEnv.PORT ?? '8080'
  // The merged map is a workspace transport detail — project code must not
  // see a sibling project's connection string.
  delete out.WORKSPACE_DATABASE_URLS
  if (parentEnv.WORKSPACE_RUNTIME === 'true') {
    if (projectId) out.PROJECT_ID = projectId
    if (projectId && appRuntimeToken) out.RUNTIME_AUTH_SECRET = appRuntimeToken
    else delete out.RUNTIME_AUTH_SECRET
  }
  if (parentEnv.SHOGO_LOCAL_MODE === 'true' && !parentEnv.SHOGO_API_URL) {
    out.SHOGO_API_URL = 'http://localhost:8002'
  }
  return out
}

/**
 * The project that owns `targetPath` on a workspace runtime, or null.
 *
 * A merged-root workspace runtime holds one top-level mount per attached
 * project (`parseWorkspaceMounts`), so the first path segment under the
 * workspace root names the project — including folder-linked projects and
 * extra host folders, which belong to their linking project. At the root, or
 * outside it, there is no project and therefore no project token.
 */
export function workspaceProjectForPath(
  workspaceDir: string,
  targetPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isWorkspaceRuntimeMode(env)) return null
  const rel = relative(resolve(workspaceDir), resolve(targetPath))
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  const first = rel.split(sep)[0]
  if (!first) return null
  const mount = parseWorkspaceMounts(env).find((m) => m.mount === first || m.projectId === first)
  return mount?.projectId ?? null
}

export interface ProjectCredentialEnv {
  /** The project whose credentials these are; null outside a workspace runtime or with no project. */
  projectId: string | null
  /** Vars to overlay on the child's env. Empty when no project token could be resolved. */
  env: Record<string, string>
  /** Vars the child must NOT inherit, applied before {@link env} is overlaid. */
  unset: string[]
}

/**
 * Credentials for a child process running code from `cwd`: the project's
 * `rt_v1_` token plus `PROJECT_ID` on a workspace runtime, and never the
 * workspace token. A single-project runtime is left alone — its inherited
 * token already belongs to that project.
 */
export async function resolveProjectCredentialEnv(input: {
  workspaceDir: string
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Test seam; defaults to the cached {@link fetchAppRuntimeToken}. */
  fetchToken?: (projectId: string) => Promise<string | null>
}): Promise<ProjectCredentialEnv> {
  const env = input.env ?? process.env
  if (!isWorkspaceRuntimeMode(env)) return { projectId: null, env: {}, unset: [] }
  const projectId = workspaceProjectForPath(input.workspaceDir, input.cwd, env)
  const unset = ['RUNTIME_AUTH_SECRET']
  if (!projectId) return { projectId: null, env: {}, unset }
  const token = await (input.fetchToken ?? fetchAppRuntimeToken)(projectId)
  return {
    projectId,
    env: token ? { PROJECT_ID: projectId, RUNTIME_AUTH_SECRET: token } : { PROJECT_ID: projectId },
    unset,
  }
}

/**
 * The full env for a child process running project code from `cwd` (canvas
 * builds, typechecks): {@link resolveProjectProcessEnv} with the cwd project's
 * token, so user bundler/config code sees the same credentials as the preview
 * sidecar.
 */
export async function resolveProjectChildEnv(input: {
  cwd: string
  workspaceDir?: string
  parentEnv?: NodeJS.ProcessEnv
  fetchToken?: (projectId: string) => Promise<string | null>
}): Promise<Record<string, string>> {
  const parentEnv = input.parentEnv ?? process.env
  const workspaceDir = input.workspaceDir ?? input.cwd
  const projectId = workspaceProjectForPath(workspaceDir, input.cwd, parentEnv) ?? undefined
  const appRuntimeToken = projectId
    ? await (input.fetchToken ?? fetchAppRuntimeToken)(projectId)
    : null
  return resolveProjectProcessEnv({ parentEnv, projectId, appRuntimeToken })
}

/**
 * Third-party code (MCP servers) gets no runtime token at all on a workspace
 * runtime: the token it would inherit is the workspace one.
 */
export function withoutWorkspaceRuntimeToken<T extends NodeJS.ProcessEnv>(
  env: T,
  parentEnv: NodeJS.ProcessEnv = process.env,
): T {
  if (isWorkspaceRuntimeMode(parentEnv)) delete env.RUNTIME_AUTH_SECRET
  return env
}
