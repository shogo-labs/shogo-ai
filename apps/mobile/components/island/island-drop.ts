// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { IslandAttachment } from "./types"

export type IslandDropAction = "new-chat" | "attach" | "add-to-project"

const TEXT_MIME_PREFIXES = ["text/"]
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/x-sh",
  "application/sql",
  "image/svg+xml",
])
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "mdx", "json", "jsonc", "yaml", "yml", "toml", "xml", "csv", "tsv",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "zsh", "bash", "sql", "html", "css",
  "scss", "less", "svg", "env", "ini", "conf", "gitignore", "dockerfile", "prisma", "graphql",
])

function extension(name: string): string {
  const base = name.toLowerCase().split("/").pop() ?? ""
  const dot = base.lastIndexOf(".")
  return dot >= 0 ? base.slice(dot + 1) : base
}

export function isTextFile(file: { name: string; type: string }): boolean {
  const type = file.type.toLowerCase()
  if (TEXT_MIME_PREFIXES.some((prefix) => type.startsWith(prefix))) return true
  if (TEXT_MIME_TYPES.has(type)) return true
  return TEXT_EXTENSIONS.has(extension(file.name))
}

/** Project-relative path for a dropped file: its base name, stripped of
 * anything the file routes' path validation would reject. */
export function projectPathForDrop(name: string): string | null {
  const base = name.split(/[\\/]/).pop()?.trim() ?? ""
  const safe = base.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "")
  return safe ? safe : null
}

export interface AddToProjectPlan {
  writes: Array<{ path: string; content: string }>
  /** Files the file API can't store (it only accepts UTF-8 text); the agent
   * is asked to save these instead. */
  attach: IslandAttachment[]
}

function decodeDataUrlText(dataUrl: string): string | null {
  const comma = dataUrl.indexOf(",")
  if (comma < 0) return null
  const meta = dataUrl.slice(0, comma)
  const payload = dataUrl.slice(comma + 1)
  try {
    if (!meta.endsWith(";base64")) return decodeURIComponent(payload)
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export function planAddToProject(files: readonly IslandAttachment[]): AddToProjectPlan {
  const plan: AddToProjectPlan = { writes: [], attach: [] }
  for (const file of files) {
    const path = projectPathForDrop(file.name)
    const content = path && isTextFile(file) ? decodeDataUrlText(file.dataUrl) : null
    if (path && content !== null) plan.writes.push({ path, content })
    else plan.attach.push(file)
  }
  return plan
}

export function saveAttachmentsPrompt(files: readonly { name: string }[]): string {
  const names = files.map((file) => file.name).join(", ")
  return files.length === 1
    ? `Save the attached file (${names}) to the project root, keeping its name.`
    : `Save the attached files (${names}) to the project root, keeping their names.`
}
