// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Human copy for workspace create/delete failures.
 *
 * The server answers with `{ error: { code, message } }` (`invalid_name`,
 * `personal_workspace_exists`, `last_workspace`, `personal_workspace_required`,
 * `kind_immutable`, `forbidden`, …). The SDK's HttpClient wraps that body in a
 * `ShogoError` whose `details` is the parsed payload, so the code and the
 * message are both available — always prefer the server's wording over a
 * generic "Failed to create workspace", which tells the user nothing.
 */

function serverError(value: unknown): { code?: string; message?: string } | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as any
  const inner = candidate.error ?? candidate.details?.error ?? candidate.details ?? null
  if (!inner || typeof inner !== 'object') return null
  const code = typeof inner.code === 'string' ? inner.code : undefined
  const message = typeof inner.message === 'string' ? inner.message : undefined
  return code || message ? { code, message } : null
}

export function workspaceErrorMessage(err: unknown, fallback = 'Could not create the workspace.'): string {
  const server = serverError(err)
  if (server?.message) return server.message
  const plain = (err as any)?.message
  if (typeof plain === 'string' && plain && !/^(Create|Update|Delete) failed$/.test(plain)) return plain
  return fallback
}

export function workspaceDeleteErrorMessage(
  err: unknown,
  fallback = 'Could not delete the workspace.',
): string {
  const server = serverError(err)
  if (server?.message) return server.message
  const plain = (err as any)?.message
  if (typeof plain === 'string' && plain && !/^(Create|Update|Delete) failed$/.test(plain)) return plain
  return fallback
}
