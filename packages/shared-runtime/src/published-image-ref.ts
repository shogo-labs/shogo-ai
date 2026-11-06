// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Where a published app's per-commit image lives, and how it is pinned.
 *
 * One image per (project, commit), pushed by the in-cluster BuildKit Job and
 * run by the environment's ksvc (SHO-308 §2). Three callers need the same
 * answer — the API that creates the build, the ksvc that runs the result and
 * the `PublishedDeployment` row that rollback/promote switch between — so the
 * scheme lives in one place. If they disagree, rollback serves something
 * nobody built.
 *
 * Refs are `<registry>/<namespace>/shogo/published/<projectId>:<commit>`.
 * A **digest** pin (`<repo>@sha256:…`) is what a running pod should carry: a
 * tag can be moved, a digest cannot, so "the same commit reuses its image"
 * only holds for real when the deployment row remembers the digest.
 */

/** The last path segment of a ref, without the registry or the tag. */
export function publishedImageRepository(input: {
  registry: string
  namespace: string
  projectId: string
}): string {
  const registry = trimSlashes(input.registry)
  const namespace = trimSlashes(input.namespace)
  if (!registry) throw new Error('published image registry is not configured')
  const projectId = input.projectId.trim()
  if (!projectId) throw new Error('published image needs a project id')
  // A commit tag can only hold tag-safe characters; the project id is a uuid,
  // but a locally created project id can be anything, so sanitize once here
  // rather than at three call sites.
  return `${registry}/${namespace ? `${namespace}/` : ''}shogo/published/${sanitizeSegment(projectId)}`
}

/** The tag a given commit is pushed under inside its project's repository. */
export function publishedImageTag(commitSha: string): string {
  const sha = commitSha.trim().toLowerCase()
  if (!sha) throw new Error('published image needs a commit sha')
  // Docker tags are `[A-Za-z0-9_][A-Za-z0-9._-]{0,127}`.
  return sanitizeSegment(sha)
}

/** `<repo>:<commit>` — what the BuildKit Job pushes to. */
export function publishedImageTagRef(input: {
  registry: string
  namespace: string
  projectId: string
  commitSha: string
}): string {
  return `${publishedImageRepository(input)}:${publishedImageTag(input.commitSha)}`
}

/**
 * `<repo>@sha256:…` — what a pod runs and what a deployment row records.
 * Accepts a digest with or without the `sha256:` prefix and never double
 * prefixes it.
 */
export function publishedImageDigestRef(repository: string, digest: string | null | undefined): string {
  const value = (digest ?? '').trim()
  if (!value) return repository
  const normalized = value.startsWith('sha256:') ? value : `sha256:${value}`
  return `${repository.split('@')[0]}@${normalized}`
}

/**
 * The repository inside a ref, so a digest-pinned ref can be re-pinned to a
 * different digest without string surgery at the call site.
 */
export function publishedImageRepositoryOf(ref: string): string {
  const at = ref.indexOf('@')
  if (at >= 0) return ref.slice(0, at)
  const lastSlash = ref.lastIndexOf('/')
  const lastColon = ref.lastIndexOf(':')
  // A colon before the last slash belongs to a registry host:port, not a tag.
  return lastColon > lastSlash ? ref.slice(0, lastColon) : ref
}

/** True when the ref is digest-pinned (`repo@sha256:…`). */
export function isDigestPinnedImageRef(ref: string | null | undefined): boolean {
  return !!ref && /@sha256:[a-f0-9]{64}$/.test(ref.trim())
}

/** `sha256:…` from a digest-pinned ref, else null. */
export function digestOfImageRef(ref: string | null | undefined): string | null {
  if (!ref) return null
  const match = /@(sha256:[a-f0-9]{64})$/.exec(ref.trim())
  return match ? match[1] : null
}

function sanitizeSegment(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  return cleaned.replace(/^[-.]+/, '').slice(0, 128) || 'project'
}

function trimSlashes(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/^\/+/, '')
}
