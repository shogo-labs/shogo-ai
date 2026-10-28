// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which scope a `share_file` link is minted under, and the path the serving
 * side has to resolve it against.
 *
 * `share_file` validates `path` against the workspace root, but a
 * project-scoped link is served from the *project* root. In a workspace
 * runtime each project is mounted at `<workspaceDir>/<projectId>`, so signing
 * the workspace-relative path under the project scope made the download route
 * look for `<project>/<projectId>/…` and answer 404 (SHO-67).
 *
 * The file's real location decides the owner here: a file inside a mounted
 * project mints a project link relative to that project, a file the agent
 * wrote at a project-anchored runtime's working folder (which *is* the merged
 * root) mints a project link for the anchor relative to the merged root, and a
 * file anywhere else in the merged root mints a workspace link. Mint and serve
 * therefore cannot disagree about what `path` is relative to.
 */

import { lstatSync, realpathSync } from 'fs'
import { isAbsolute, join, relative as relativePath, sep } from 'path'

export interface ResolveShareFileLinkTargetInput {
  workspaceDir: string
  /** Absolute path already validated as inside `workspaceDir`. */
  resolvedPath: string
  /** The workspace-relative path the caller passed, used when nothing resolves. */
  path: string
  /** Project the caller or the runtime default selected, if any. */
  requestedProjectId?: string
  /** Mount names of attached projects — each is `<workspaceDir>/<id>`. */
  mountedProjectIds?: readonly string[]
  /**
   * Project this runtime is anchored to (`WORKSPACE_ANCHOR_PROJECT_ID`). Its
   * working folder is the merged root itself, so files at that root belong to
   * it and live nowhere else (SHO-242).
   */
  anchorProjectId?: string
  /** True for a merged-root workspace runtime; false for a single project. */
  workspaceRuntime: boolean
  realpath?: (target: string) => string
}

export interface ShareFileLinkTarget {
  /** Owning project, or undefined for a workspace-scoped link. */
  projectId?: string
  /** Path to sign: relative to the owning root, with `/` separators. */
  linkPath: string
  /** A `project_id` that was overridden because the file lives elsewhere. */
  ignoredProjectId?: string
}

function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function toPosix(target: string): string {
  return sep === '/' ? target : target.split(sep).join('/')
}

/** A mount name has to be a single, safe path segment. */
function isSafeMountName(id: string): boolean {
  return id.length > 0 && id !== '.' && id !== '..' && !id.includes('/') && !id.includes('\\')
}

/** A signed path must stay below its root and be a relative posix path. */
function isServableLinkPath(target: string): boolean {
  return !!target && !isAbsolute(target) && target !== '..' && !target.startsWith(`..${sep}`)
}

/**
 * True when the file sits inside an entry the runtime mounted into its root —
 * a project or a linked local folder, both symlinks. Everything else under the
 * root is content the agent wrote there itself.
 */
function isInsideMount(workspaceDir: string, realFile: string): boolean {
  const rel = relativePath(workspaceDir, realFile)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return true
  const first = rel.split(sep)[0]
  // A file at the root itself is not inside any mount.
  if (!first || first === rel) return false
  try {
    return lstatSync(join(workspaceDir, first)).isSymbolicLink()
  } catch {
    return false
  }
}

export function resolveShareFileLinkTarget(input: ResolveShareFileLinkTargetInput): ShareFileLinkTarget {
  const realpath = input.realpath ?? realpathSync

  // A single-project runtime's workspace dir *is* the project root, so the
  // path already resolves where the serving side looks.
  if (!input.workspaceRuntime) {
    return { projectId: input.requestedProjectId, linkPath: input.path }
  }

  let realWorkspace: string
  let realFile: string
  try {
    realWorkspace = realpath(input.workspaceDir)
    realFile = realpath(input.resolvedPath)
  } catch {
    // The file vanished between the stat and here: hand back the caller's
    // path and let the mint route report it rather than signing a guess.
    return { projectId: input.requestedProjectId, linkPath: input.path }
  }

  for (const projectId of input.mountedProjectIds ?? []) {
    if (!isSafeMountName(projectId)) continue
    let realMount: string
    try {
      realMount = realpath(join(input.workspaceDir, projectId))
    } catch {
      // Not mounted in this runtime.
      continue
    }
    if (!isWithinRoot(realMount, realFile)) continue
    const linkPath = toPosix(relativePath(realMount, realFile))
    if (!isServableLinkPath(linkPath)) continue
    return {
      projectId,
      linkPath,
      ...(input.requestedProjectId && input.requestedProjectId !== projectId
        ? { ignoredProjectId: input.requestedProjectId }
        : {}),
    }
  }

  // A project-anchored runtime's working folder *is* the merged root, so a file
  // the agent wrote at it (`plans/`, `memory/`, `research/`) lives only there —
  // never in `workspaces/<anchor>`. Signing it as a workspace link sent the
  // download to a root that does not hold it, so the mint answered
  // `file_not_found` (SHO-242). The anchor's runtime serves that root, so the
  // link is minted for the anchor with the merged-root-relative path.
  const anchorId = input.anchorProjectId
  if (
    anchorId &&
    isSafeMountName(anchorId) &&
    (input.mountedProjectIds ?? []).includes(anchorId) &&
    !isInsideMount(realWorkspace, realFile)
  ) {
    const anchorPath = toPosix(relativePath(realWorkspace, realFile))
    if (isServableLinkPath(anchorPath)) {
      return {
        projectId: anchorId,
        linkPath: anchorPath,
        ...(input.requestedProjectId && input.requestedProjectId !== anchorId
          ? { ignoredProjectId: input.requestedProjectId }
          : {}),
      }
    }
  }

  const workspacePath = toPosix(relativePath(realWorkspace, realFile))
  return {
    linkPath: isServableLinkPath(workspacePath) ? workspacePath : input.path,
    ...(input.requestedProjectId ? { ignoredProjectId: input.requestedProjectId } : {}),
  }
}
