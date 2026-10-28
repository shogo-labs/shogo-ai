// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One resolver behind both halves of a desktop shared-file link: the internal
 * mint route that signs `path`, and the download route that reads it back.
 *
 * They used to resolve independently, so a link minted from a workspace
 * runtime (whose `path` is workspace-relative) for a project-scoped download
 * was looked up under the project root — `<project>/<projectId>/…` — and
 * 404'd (SHO-67). Having the mint route sign the path this resolves, and
 * returning `file_not_found` when nothing resolves, keeps a dead URL from
 * being handed out at all.
 */

import { realpath } from 'fs/promises'
import { join, resolve, sep } from 'path'
import { prisma } from './prisma'

export interface LocalSharedFileTargetInput {
  /** Project scope for the link; omitted for a workspace-scoped link. */
  projectId?: string
  workspaceId: string
  path: string
  workspacesDir: string
}

export interface LocalSharedFileTarget {
  /** Real absolute path of the file to serve. */
  target: string
  /** Path to sign: the shape `path` has to take to resolve to `target`. */
  normalizedPath: string
}

function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
}

async function projectRoot(projectId: string, workspacesDir: string): Promise<{
  root: string
  workspaceId: string
} | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      workspaceId: true,
      workingMode: true,
      projectFolders: {
        where: { isPrimary: true },
        select: { path: true },
        take: 1,
      },
    },
  })
  if (!project) return null

  const externalRoot = project.workingMode === 'external' ? project.projectFolders[0]?.path : undefined
  return {
    root: externalRoot || join(workspacesDir, projectId),
    workspaceId: project.workspaceId,
  }
}

/** Real path of a project file under its project root, or null when the path leaves it. */
async function projectFileTarget(root: string, path: string): Promise<string | null> {
  try {
    const realRoot = await realpath(root)
    const candidate = resolve(realRoot, path)
    if (!isWithinRoot(realRoot, candidate)) return null
    const target = await realpath(candidate)
    return isWithinRoot(realRoot, target) ? target : null
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }
}

/**
 * Real path of a file under a merged root in `.workspace-roots/<rootName>`,
 * or null when the path leaves it. A workspace runtime's root
 * (`<workspaceId>`) and a project runtime's root (`proj-<projectId>`) have the
 * same shape: member projects mounted as `<projectId>` symlinks, so a file
 * inside one is allowed only when that project belongs to the same workspace.
 */
async function workspaceFileTarget(
  rootName: string,
  workspaceId: string,
  path: string,
  workspacesDir: string,
): Promise<string | null> {
  let root: string
  try {
    root = await realpath(join(workspacesDir, '.workspace-roots', rootName))
  } catch (error: any) {
    // A runtime that never started has no merged root yet. That is a missing
    // file, not a failure: the caller answers "not found".
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }
  const candidate = resolve(root, path)
  if (!isWithinRoot(root, candidate)) return null
  const target = await realpath(candidate)
  if (isWithinRoot(root, target)) return target

  const memberId = path.split('/')[0]
  const member = memberId ? await projectRoot(memberId, workspacesDir) : null
  if (!member || member.workspaceId !== workspaceId) return null
  const memberRoot = await realpath(member.root)
  return isWithinRoot(memberRoot, target) ? target : null
}

/**
 * Resolve the file a shared-file link names, plus the path to sign for it.
 * Project-scoped links resolve against the project root; a redundant
 * `<projectId>/` prefix is stripped so links already minted for a workspace
 * runtime keep working, and a file that only exists in the project runtime's
 * merged root (`.workspace-roots/proj-<projectId>`) is found there — cloud
 * already reads an unscoped path from that root. Returns null when no path
 * resolves, so the caller can answer "not found" instead of 500.
 */
export async function resolveLocalSharedFileTarget(
  input: LocalSharedFileTargetInput,
): Promise<LocalSharedFileTarget | null> {
  try {
    if (input.projectId) {
      const project = await projectRoot(input.projectId, input.workspacesDir)
      if (!project || project.workspaceId !== input.workspaceId) return null

      const direct = await projectFileTarget(project.root, input.path)
      if (direct) return { target: direct, normalizedPath: input.path }

      if (input.path.startsWith(`${input.projectId}/`)) {
        const stripped = input.path.slice(input.projectId.length + 1)
        if (!stripped) return null
        const retried = await projectFileTarget(project.root, stripped)
        if (retried) return { target: retried, normalizedPath: stripped }
      }

      // A project agent's working folder is the merged root, so a file it
      // writes at the root (`plans/`, `memory/`, `research/`) lives only
      // there — never in the project directory (SHO-242).
      const merged = await workspaceFileTarget(
        `proj-${input.projectId}`,
        project.workspaceId,
        input.path,
        input.workspacesDir,
      )
      return merged ? { target: merged, normalizedPath: input.path } : null
    }

    const target = await workspaceFileTarget(
      input.workspaceId,
      input.workspaceId,
      input.path,
      input.workspacesDir,
    )
    return target ? { target, normalizedPath: input.path } : null
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }
}
