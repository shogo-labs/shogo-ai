// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FEAT-NOTEBOOKS — .ipynb document model.
 *
 * Shogo had no notebook editor. VS Code renders rich .ipynb documents (a
 * sequence of code / markdown / raw cells with execution counts and
 * outputs), an interactive window, and a kernel picker. This module is the
 * pure, side-effect-free DOCUMENT model behind that — a sibling of the
 * other ide/ helpers (tasks-config, settings-form, …): no React, no fs, no
 * kernel/zmq. It parses the nbformat-v4 JSON into a normalised model,
 * serialises it back (round-trippable), and exposes immutable cell
 * operations the editor dispatches. Output RENDERING lives in the sibling
 * `notebook-outputs.ts`.
 *
 * Normalisation choices (so the editor never deals with format quirks):
 *   • `source` is always a single string in the model; nbformat's
 *     line-array form is joined on parse and re-split on serialise, so
 *     parse∘serialise round-trips exactly.
 *   • outputs are kept only on code cells; switching a cell away from code
 *     drops its outputs + execution_count (VS Code behaviour).
 *   • unknown cell types degrade to "raw" rather than throwing.
 *
 * Deliberately NOT here: kernel execution, fs, React, DOM.
 */

export type CellType = "code" | "markdown" | "raw"

/** mime → already-joined string payload. */
export type MimeBundle = Record<string, string>

export type NotebookOutput =
  | { output_type: "stream"; name: "stdout" | "stderr"; text: string }
  | { output_type: "execute_result"; execution_count: number | null; data: MimeBundle }
  | { output_type: "display_data"; data: MimeBundle }
  | { output_type: "error"; ename: string; evalue: string; traceback: string[] }

export interface NotebookCell {
  id: string
  cell_type: CellType
  source: string
  outputs: NotebookOutput[]
  execution_count: number | null
  metadata: Record<string, unknown>
}

export interface KernelSpec {
  name: string
  display_name: string
  language: string
}

export interface LanguageInfo {
  name: string
  version?: string
  file_extension?: string
}

export interface Notebook {
  cells: NotebookCell[]
  metadata: { kernelspec?: KernelSpec; language_info?: LanguageInfo; [k: string]: unknown }
  nbformat: number
  nbformat_minor: number
}

// ── source line <-> string ──────────────────────────────────────────────

/** Join nbformat source (string or string[]) into one string. */
export function joinSource(src: unknown): string {
  if (typeof src === "string") return src
  if (Array.isArray(src)) return src.filter((s) => typeof s === "string").join("")
  return ""
}

/** Split a source string into the nbformat line array (trailing \n kept per line). */
export function splitSource(src: string): string[] {
  if (typeof src !== "string" || src === "") return []
  const parts = src.split("\n")
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1
    if (isLast) {
      if (parts[i] !== "") out.push(parts[i])
    } else {
      out.push(parts[i] + "\n")
    }
  }
  return out
}

let idCounter = 0
/** Generate a reasonably-unique cell id (nbformat 4.5 ids). */
export function newCellId(): string {
  idCounter = (idCounter + 1) % 1_000_000
  return `cell-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

// ── output normalisation ──────────────────────────────────────────────────

function normalizeMimeBundle(data: unknown): MimeBundle {
  if (!data || typeof data !== "object") return {}
  const out: MimeBundle = {}
  for (const [mime, val] of Object.entries(data as Record<string, unknown>)) {
    if (typeof val === "string") out[mime] = val
    else if (Array.isArray(val)) out[mime] = val.filter((s) => typeof s === "string").join("")
    else if (val != null) out[mime] = JSON.stringify(val)
  }
  return out
}

function normalizeOutput(raw: unknown): NotebookOutput | null {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null
  if (!o) return null
  switch (o.output_type) {
    case "stream":
      return { output_type: "stream", name: o.name === "stderr" ? "stderr" : "stdout", text: joinSource(o.text) }
    case "execute_result":
      return {
        output_type: "execute_result",
        execution_count: typeof o.execution_count === "number" ? o.execution_count : null,
        data: normalizeMimeBundle(o.data),
      }
    case "display_data":
      return { output_type: "display_data", data: normalizeMimeBundle(o.data) }
    case "error":
      return {
        output_type: "error",
        ename: typeof o.ename === "string" ? o.ename : "",
        evalue: typeof o.evalue === "string" ? o.evalue : "",
        traceback: Array.isArray(o.traceback) ? o.traceback.filter((s): s is string => typeof s === "string") : [],
      }
    default:
      return null
  }
}

function normalizeCellType(t: unknown): CellType {
  return t === "code" || t === "markdown" || t === "raw" ? t : "raw"
}

function normalizeCell(raw: unknown, index: number): NotebookCell {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const cell_type = normalizeCellType(o.cell_type)
  const isCode = cell_type === "code"
  return {
    id: typeof o.id === "string" && o.id !== "" ? o.id : `cell-${index}`,
    cell_type,
    source: joinSource(o.source),
    outputs: isCode && Array.isArray(o.outputs) ? o.outputs.map(normalizeOutput).filter((x): x is NotebookOutput => x !== null) : [],
    execution_count: isCode && typeof o.execution_count === "number" ? o.execution_count : null,
    metadata: o.metadata && typeof o.metadata === "object" ? (o.metadata as Record<string, unknown>) : {},
  }
}

function normalizeKernelSpec(raw: unknown): KernelSpec | undefined {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null
  if (!o) return undefined
  const name = typeof o.name === "string" ? o.name : ""
  if (!name) return undefined
  return {
    name,
    display_name: typeof o.display_name === "string" ? o.display_name : name,
    language: typeof o.language === "string" ? o.language : "python",
  }
}

// ── parse / serialize ─────────────────────────────────────────────────────

/** Parse a .ipynb (JSON string or object) into the normalised model. Never throws. */
export function parseNotebook(raw: unknown): Notebook {
  let root: Record<string, unknown> | null = null
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw)
      root = p && typeof p === "object" ? (p as Record<string, unknown>) : null
    } catch {
      root = null
    }
  } else if (raw && typeof raw === "object") {
    root = raw as Record<string, unknown>
  }

  const cellsRaw = root && Array.isArray(root.cells) ? root.cells : []
  const cells = cellsRaw.map((c, i) => normalizeCell(c, i))

  const md = root && root.metadata && typeof root.metadata === "object" ? { ...(root.metadata as Record<string, unknown>) } : {}
  const kernelspec = normalizeKernelSpec(md.kernelspec)
  if (kernelspec) md.kernelspec = kernelspec
  else delete md.kernelspec

  return {
    cells,
    metadata: md,
    nbformat: root && typeof root.nbformat === "number" ? root.nbformat : 4,
    nbformat_minor: root && typeof root.nbformat_minor === "number" ? root.nbformat_minor : 5,
  }
}

function serializeOutput(o: NotebookOutput): Record<string, unknown> {
  switch (o.output_type) {
    case "stream":
      return { output_type: "stream", name: o.name, text: splitSource(o.text) }
    case "execute_result":
      return {
        output_type: "execute_result",
        execution_count: o.execution_count,
        data: Object.fromEntries(Object.entries(o.data).map(([m, v]) => [m, splitSource(v)])),
        metadata: {},
      }
    case "display_data":
      return {
        output_type: "display_data",
        data: Object.fromEntries(Object.entries(o.data).map(([m, v]) => [m, splitSource(v)])),
        metadata: {},
      }
    case "error":
      return { output_type: "error", ename: o.ename, evalue: o.evalue, traceback: o.traceback }
  }
}

/** Serialise the model back to an nbformat-v4 object (round-trips with parseNotebook). */
export function serializeNotebook(nb: Notebook): Record<string, unknown> {
  return {
    cells: nb.cells.map((c) => {
      const base: Record<string, unknown> = {
        cell_type: c.cell_type,
        id: c.id,
        metadata: c.metadata,
        source: splitSource(c.source),
      }
      if (c.cell_type === "code") {
        base.execution_count = c.execution_count
        base.outputs = c.outputs.map(serializeOutput)
      }
      return base
    }),
    metadata: nb.metadata,
    nbformat: nb.nbformat,
    nbformat_minor: nb.nbformat_minor,
  }
}

// ── cell construction + lookups ────────────────────────────────────────────

export function newCell(cell_type: CellType, source = "", id?: string): NotebookCell {
  return {
    id: id ?? newCellId(),
    cell_type,
    source,
    outputs: [],
    execution_count: null,
    metadata: {},
  }
}

export function findCell(nb: Notebook, id: string): NotebookCell | undefined {
  return nb.cells.find((c) => c.id === id)
}

export function cellIndex(nb: Notebook, id: string): number {
  return nb.cells.findIndex((c) => c.id === id)
}

// ── immutable operations ───────────────────────────────────────────────────

function withCells(nb: Notebook, cells: NotebookCell[]): Notebook {
  return { ...nb, cells }
}

/** Clamp an insertion index into [0, len]. */
function clampInsert(index: number, len: number): number {
  if (!Number.isFinite(index) || index < 0) return 0
  if (index > len) return len
  return Math.floor(index)
}

/** Insert a new cell at `index` (clamped). Returns a new notebook. */
export function insertCell(nb: Notebook, index: number, cell_type: CellType, source = "", id?: string): Notebook {
  const cell = newCell(cell_type, source, id)
  const at = clampInsert(index, nb.cells.length)
  const cells = [...nb.cells.slice(0, at), cell, ...nb.cells.slice(at)]
  return withCells(nb, cells)
}

/** Append a cell to the end. */
export function appendCell(nb: Notebook, cell_type: CellType, source = "", id?: string): Notebook {
  return insertCell(nb, nb.cells.length, cell_type, source, id)
}

/** Delete a cell by id. No-op (same reference) if absent. */
export function deleteCell(nb: Notebook, id: string): Notebook {
  if (cellIndex(nb, id) === -1) return nb
  return withCells(nb, nb.cells.filter((c) => c.id !== id))
}

/** Move a cell to an absolute index (clamped). No-op if absent. */
export function moveCell(nb: Notebook, id: string, toIndex: number): Notebook {
  const from = cellIndex(nb, id)
  if (from === -1) return nb
  const without = nb.cells.filter((c) => c.id !== id)
  const at = clampInsert(toIndex, without.length)
  const cells = [...without.slice(0, at), nb.cells[from], ...without.slice(at)]
  return withCells(nb, cells)
}

/** Move a cell up (-1) or down (+1) by a delta. */
export function moveCellBy(nb: Notebook, id: string, delta: number): Notebook {
  const from = cellIndex(nb, id)
  if (from === -1) return nb
  return moveCell(nb, id, from + delta)
}

/** Replace a cell's source. No-op if absent. */
export function updateCellSource(nb: Notebook, id: string, source: string): Notebook {
  if (cellIndex(nb, id) === -1) return nb
  return withCells(nb, nb.cells.map((c) => (c.id === id ? { ...c, source } : c)))
}

/**
 * Change a cell's type. Switching AWAY from code clears its outputs and
 * execution_count (they're meaningless on markdown/raw), matching VS Code.
 */
export function changeCellType(nb: Notebook, id: string, cell_type: CellType): Notebook {
  if (cellIndex(nb, id) === -1) return nb
  return withCells(nb, nb.cells.map((c) => {
    if (c.id !== id) return c
    if (cell_type === "code") return { ...c, cell_type }
    return { ...c, cell_type, outputs: [], execution_count: null }
  }))
}

/** Set a code cell's execution count. No-op if absent. */
export function setExecutionCount(nb: Notebook, id: string, count: number | null): Notebook {
  if (cellIndex(nb, id) === -1) return nb
  return withCells(nb, nb.cells.map((c) => (c.id === id && c.cell_type === "code" ? { ...c, execution_count: count } : c)))
}

/** Replace a code cell's outputs. No-op if absent or not a code cell. */
export function setCellOutputs(nb: Notebook, id: string, outputs: NotebookOutput[]): Notebook {
  const cell = findCell(nb, id)
  if (!cell || cell.cell_type !== "code") return nb
  return withCells(nb, nb.cells.map((c) => (c.id === id ? { ...c, outputs } : c)))
}

/** Clear one cell's outputs + execution_count. No-op if absent. */
export function clearCellOutputs(nb: Notebook, id: string): Notebook {
  const cell = findCell(nb, id)
  if (!cell) return nb
  if (cell.outputs.length === 0 && cell.execution_count === null) return nb
  return withCells(nb, nb.cells.map((c) => (c.id === id ? { ...c, outputs: [], execution_count: null } : c)))
}

/** Clear outputs + execution_count on every code cell. */
export function clearAllOutputs(nb: Notebook): Notebook {
  let changed = false
  const cells = nb.cells.map((c) => {
    if (c.cell_type === "code" && (c.outputs.length > 0 || c.execution_count !== null)) {
      changed = true
      return { ...c, outputs: [], execution_count: null }
    }
    return c
  })
  return changed ? withCells(nb, cells) : nb
}

// ── kernel + stats ──────────────────────────────────────────────────────────

/** Set the notebook's kernelspec. */
export function selectKernel(nb: Notebook, kernel: KernelSpec): Notebook {
  return { ...nb, metadata: { ...nb.metadata, kernelspec: kernel } }
}

/** The notebook language: language_info.name → kernelspec.language → "python". */
export function notebookLanguage(nb: Notebook): string {
  return nb.metadata.language_info?.name || nb.metadata.kernelspec?.language || "python"
}

export interface CellCounts {
  code: number
  markdown: number
  raw: number
  total: number
}

export function countCells(nb: Notebook): CellCounts {
  const counts: CellCounts = { code: 0, markdown: 0, raw: 0, total: nb.cells.length }
  for (const c of nb.cells) counts[c.cell_type]++
  return counts
}
