// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FEAT-NOTEBOOKS — output rendering model.
 *
 * Turns a code cell's normalised outputs (from `notebook-model.ts`) into a
 * flat list of render-ready display items the notebook UI can map straight
 * to components. Pure and side-effect-free: no React, no DOM, no kernel.
 *
 * Mirrors how VS Code / Jupyter pick a representation: a single
 * execute_result / display_data carries a MIME bundle (e.g. both
 * text/html and text/plain); we pick the richest renderable MIME by a
 * priority order. Streams become text items (stderr flagged), errors
 * become an error item with an ANSI-stripped traceback.
 *
 * Deliberately NOT here: React, DOM, kernel comms.
 */
import type { MimeBundle, NotebookCell, NotebookOutput } from "./notebook-model"

export type DisplayItemKind = "text" | "html" | "markdown" | "image" | "svg" | "json" | "error"

export interface DisplayItem {
  kind: DisplayItemKind
  /** The MIME type this item was rendered from (absent for stream/error). */
  mime?: string
  /** Text payload for text/html/markdown/svg/json (and data-URI for image). */
  text?: string
  /** True for a stderr stream. */
  isStderr?: boolean
  /** Error fields (kind === "error"). */
  ename?: string
  evalue?: string
  traceback?: string[]
}

/**
 * MIME priority — richest first. The first present MIME in a bundle wins,
 * matching Jupyter's display preference (rich media over plain text).
 */
export const MIME_PRIORITY: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/svg+xml",
  "text/html",
  "text/markdown",
  "application/json",
  "text/latex",
  "text/plain",
]

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif"])

/** Strip ANSI escape sequences (colours/cursor moves) from a string. */
export function stripAnsi(input: string): string {
  if (typeof input !== "string" || input.indexOf("\u001b") === -1) return input
  // CSI sequences: ESC [ ... final-byte
  return input.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
}

/** Pick the highest-priority MIME present in a bundle (or undefined). */
export function pickRichMime(data: MimeBundle): string | undefined {
  for (const mime of MIME_PRIORITY) {
    if (Object.prototype.hasOwnProperty.call(data, mime)) return mime
  }
  // Fall back to any present key (deterministic: first sorted).
  const keys = Object.keys(data).sort()
  return keys.length > 0 ? keys[0] : undefined
}

function kindForMime(mime: string): DisplayItemKind {
  if (IMAGE_MIMES.has(mime)) return "image"
  if (mime === "image/svg+xml") return "svg"
  if (mime === "text/html") return "html"
  if (mime === "text/markdown") return "markdown"
  if (mime === "application/json") return "json"
  return "text"
}

function dataItemFromBundle(data: MimeBundle): DisplayItem | null {
  const mime = pickRichMime(data)
  if (!mime) return null
  const value = data[mime]
  const kind = kindForMime(mime)
  if (kind === "image") {
    // image data is base64; expose a ready-to-use data URI.
    const trimmed = (value ?? "").replace(/\s+/g, "")
    return { kind, mime, text: `data:${mime};base64,${trimmed}` }
  }
  return { kind, mime, text: value ?? "" }
}

/** Convert one output into zero or more display items. */
export function outputToDisplayItems(output: NotebookOutput): DisplayItem[] {
  if (!output || typeof output !== "object") return []
  switch (output.output_type) {
    case "stream":
      return [{ kind: "text", text: output.text, isStderr: output.name === "stderr" }]
    case "execute_result":
    case "display_data": {
      const item = dataItemFromBundle(output.data)
      return item ? [item] : []
    }
    case "error":
      return [{
        kind: "error",
        ename: output.ename,
        evalue: output.evalue,
        traceback: output.traceback.map(stripAnsi),
      }]
    default:
      return []
  }
}

/** Flatten all of a cell's outputs into display items. */
export function cellDisplayItems(cell: NotebookCell): DisplayItem[] {
  if (!cell || cell.cell_type !== "code" || !Array.isArray(cell.outputs)) return []
  const items: DisplayItem[] = []
  for (const o of cell.outputs) items.push(...outputToDisplayItems(o))
  return items
}

/** True if a code cell produced any error output. */
export function cellHasError(cell: NotebookCell): boolean {
  return cell?.cell_type === "code" && Array.isArray(cell.outputs) && cell.outputs.some((o) => o.output_type === "error")
}
