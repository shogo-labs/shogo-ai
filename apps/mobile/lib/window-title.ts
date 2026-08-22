// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

function cleanTitlePart(value?: string | null): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function workspaceBasename(workspacePath?: string | null): string {
  const cleanPath = cleanTitlePart(workspacePath)
  if (!cleanPath) return ''
  const parts = cleanPath.split(/[\\/]+/).filter(Boolean)
  return cleanTitlePart(parts.at(-1))
}

export function resolveProjectWindowName(args: {
  projectName?: string | null
  workspacePath?: string | null
  preferWorkspaceName?: boolean
}): string {
  const folderName = workspaceBasename(args.workspacePath)
  const projectName = cleanTitlePart(args.projectName)

  if (args.preferWorkspaceName && folderName) return folderName
  return projectName || folderName
}

export function getProjectDocumentTitle(args: {
  projectName?: string | null
  workspacePath?: string | null
  preferWorkspaceName?: boolean
}): string {
  const windowName = resolveProjectWindowName(args)
  return windowName ? `${windowName} — Shogo` : 'Shogo'
}
