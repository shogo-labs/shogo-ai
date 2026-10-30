// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which project a turn's file tools ran in.
 *
 * A tool call carrying `project: "<other project>"` answers with that
 * project's own relative path, so the reply says `plans/x.md` — a path that
 * exists only inside the other project's runtime. This maps the path the agent
 * wrote to the project it wrote it in, so the chat can rewrite it to
 * `<projectId>/<path>` before it looks for the file or opens it (SHO-247).
 */
import type { MessagePart } from "./turns/types"
import { resolveChatFilePath } from "./file-links"

/** Tools whose `path` argument names a file the reply may mention. */
const FILE_PATH_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
])

/** Resolves a project id or name the agent passed as `project`, or null. */
export type ProjectRefResolver = (ref: string) => string | null

/** The spelling a path is compared in: no `./`, no backslashes. */
function pathKey(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "")
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value
  }
  return null
}

function projectIdOf(value: unknown): string | null {
  const id = (value as { id?: unknown } | null | undefined)?.id
  return typeof id === "string" && id.trim() ? id : null
}

/**
 * Path → project id for one assistant turn.
 *
 * The runtime's result is authoritative (`project.id`); a message recorded
 * before it existed only names the project, so the name is resolved through
 * the workspace's project list.
 */
export function remoteProjectPathMap(
  parts: readonly MessagePart[],
  resolveProjectRef?: ProjectRefResolver | null,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const part of parts) {
    if (part.type !== "tool") continue
    const tool = part.tool
    if (!FILE_PATH_TOOLS.has(tool.toolName) || tool.state === "error") continue
    const args = tool.args as Record<string, unknown> | undefined
    const result = tool.result as Record<string, unknown> | undefined
    const chatPath =
      typeof result?.chatPath === "string" ? resolveChatFilePath(result.chatPath, null) : null
    const path = firstString(args?.path, args?.filepath, args?.file_path) ?? chatPath?.relPath
    if (!path) continue
    const projectRef = args?.project
    const projectId =
      projectIdOf(result?.project) ??
      (typeof projectRef === "string" ? resolveProjectRef?.(projectRef) ?? null : null) ??
      chatPath?.projectId ??
      null
    if (projectId) map.set(pathKey(path), projectId)
  }
  return map
}

/**
 * The path to look for and to open: a bare path that this turn wrote in
 * another project becomes `<projectId>/<path>`; anything else is unchanged.
 */
export function resolveTurnFilePath(
  path: string,
  map: ReadonlyMap<string, string>,
): string {
  if (map.size === 0) return path
  if (resolveChatFilePath(path, null)) return path
  const key = pathKey(path)
  const projectId = map.get(key)
  return projectId ? `${projectId}/${key}` : path
}

/**
 * What a file pane needs to open a path the assistant mentioned: the project
 * that owns it (when the path names one) and the path relative to that
 * project's root. A bare path is the workspace root's own.
 */
export function filePaneTarget(path: string): {
  path: string
  projectId: string | null
} {
  const resolved = resolveChatFilePath(path, null)
  return resolved
    ? { path: resolved.relPath, projectId: resolved.projectId }
    : { path, projectId: null }
}
