// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one reader for `RUNTIME_AUTH_SECRET` in the SDK and `@shogo-ai/voice`.
 *
 * A Shogo-managed pod injects its **project** token (`rt_v1_<projectId>_<hmac>`)
 * there, and every SDK surface (LLM gateway, voice/music, TTS, tools) uses it
 * as the credential for that one project.
 *
 * A **workspace** runtime is different: its own `RUNTIME_AUTH_SECRET` is the
 * workspace token (`wrt_v1_<workspaceId>_<hmac>`), which the API accepts on the
 * Git LFS routes only. Code that inherits it — an app server started from a
 * workspace shell, an MCP server, a build — used to send it and get a bare 401
 * from every SDK call. Say that plainly instead: the fix is to run the app
 * through the preview, which swaps in the project token.
 */

/** Thrown when app code picks up a workspace runtime token instead of its project's. */
export const WORKSPACE_RUNTIME_TOKEN_MESSAGE =
  'RUNTIME_AUTH_SECRET is the workspace runtime token; app code needs its project token (rt_v1_…). ' +
  'Start the app through the preview (server_sync / restart), not from a workspace shell.'

/**
 * `RUNTIME_AUTH_SECRET` from `env`, or undefined when unset. Throws when it is
 * a workspace token: no SDK call can succeed with one, so failing here beats a
 * 401 several layers down.
 */
export function readRuntimeAuthSecret(
  env: NodeJS.ProcessEnv | undefined = typeof process === 'undefined' ? undefined : process.env,
): string | undefined {
  const token = env?.RUNTIME_AUTH_SECRET
  if (!token) return undefined
  if (token.startsWith('wrt_v1_')) throw new Error(WORKSPACE_RUNTIME_TOKEN_MESSAGE)
  return token
}
