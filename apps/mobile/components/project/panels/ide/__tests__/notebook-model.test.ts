// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FEAT-NOTEBOOKS — unit tests for the pure .ipynb document model.
 *
 * Pure module, no fs / kernel / DOM — runs under `bun test`.
 * Pins: source line<->string round-trip; defensive parse + normalisation
 * (string/array source, unknown cell type, code-only outputs); parse∘
 * serialise round-trip; and the immutable cell operations + kernel/stats.
 */
import { describe, expect, test } from "bun:test"
import {
  appendCell,
  cellIndex,
  changeCellType,
  clearAllOutputs,
  clearCellOutputs,
  countCells,
  deleteCell,
  findCell,
  insertCell,
  joinSource,
  moveCell,
  moveCellBy,
  notebookLanguage,
  parseNotebook,
  selectKernel,
  serializeNotebook,
  setCellOutputs,
  setExecutionCount,
  splitSource,
  updateCellSource,
  type Notebook,
  type NotebookOutput,
} from "../notebook-model"

describe("source line <-> string", () => {
  test("joinSource handles string, array, junk", () => {
    expect(joinSource("a\nb")).toBe("a\nb")
    expect(joinSource(["a\n", "b"])).toBe("a\nb")
    expect(joinSource([1, "x", null])).toBe("x")
    expect(joinSource(null)).toBe("")
  })
  test("splitSource keeps trailing newline per line, drops final empty", () => {
    expect(splitSource("a\nb\n")).toEqual(["a\n", "b\n"])
    expect(splitSource("a\nb")).toEqual(["a\n", "b"])
    expect(splitSource("")).toEqual([])
    expect(splitSource("\n")).toEqual(["\n"])
  })
  test("joinSource ∘ splitSource is identity", () => {
    for (const s of ["a\nb\n", "a\nb", "", "\n", "one line", "x\n\ny\n"]) {
      expect(joinSource(splitSource(s))).toBe(s)
    }
  })
})

const sampleIpynb = {
  cells: [
    { cell_type: "markdown", source: ["# Title\n", "intro"], metadata: {} },
    {
      cell_type: "code",
      source: "print('hi')",
      execution_count: 2,
      metadata: {},
      outputs: [{ output_type: "stream", name: "stdout", text: ["hi\n"] }],
    },
  ],
  metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" }, language_info: { name: "python", version: "3.11" } },
  nbformat: 4,
  nbformat_minor: 5,
}

describe("parseNotebook", () => {
  test("junk → empty notebook with defaults", () => {
    expect(parseNotebook(null)).toEqual({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 })
    expect(parseNotebook("not json")).toEqual({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 })
  })
  test("normalises source to string, joins arrays", () => {
    const nb = parseNotebook(sampleIpynb)
    expect(nb.cells[0].source).toBe("# Title\nintro")
    expect(nb.cells[1].source).toBe("print('hi')")
  })
  test("parses from a JSON string too", () => {
    const nb = parseNotebook(JSON.stringify(sampleIpynb))
    expect(nb.cells).toHaveLength(2)
  })
  test("code cell keeps outputs + execution_count; markdown gets neither", () => {
    const nb = parseNotebook(sampleIpynb)
    expect(nb.cells[1].execution_count).toBe(2)
    expect(nb.cells[1].outputs).toEqual([{ output_type: "stream", name: "stdout", text: "hi\n" }])
    expect(nb.cells[0].execution_count).toBeNull()
    expect(nb.cells[0].outputs).toEqual([])
  })
  test("markdown cell with stray outputs/execution_count → stripped", () => {
    const nb = parseNotebook({ cells: [{ cell_type: "markdown", source: "x", outputs: [{ output_type: "stream", name: "stdout", text: "y" }], execution_count: 9 }] })
    expect(nb.cells[0].outputs).toEqual([])
    expect(nb.cells[0].execution_count).toBeNull()
  })
  test("unknown cell type degrades to raw", () => {
    expect(parseNotebook({ cells: [{ cell_type: "weird", source: "x" }] }).cells[0].cell_type).toBe("raw")
  })
  test("missing id → deterministic per-index id", () => {
    expect(parseNotebook({ cells: [{ cell_type: "raw", source: "" }] }).cells[0].id).toBe("cell-0")
  })
  test("invalid kernelspec dropped; valid kept", () => {
    expect(parseNotebook({ cells: [], metadata: { kernelspec: { display_name: "x" } } }).metadata.kernelspec).toBeUndefined()
    expect(parseNotebook(sampleIpynb).metadata.kernelspec).toEqual({ name: "python3", display_name: "Python 3", language: "python" })
  })
  test("error + execute_result outputs normalise (data joined)", () => {
    const nb = parseNotebook({ cells: [{ cell_type: "code", source: "x", outputs: [
      { output_type: "execute_result", execution_count: 1, data: { "text/plain": ["42"] } },
      { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["line1", "line2"] },
    ] }] })
    expect(nb.cells[0].outputs[0]).toEqual({ output_type: "execute_result", execution_count: 1, data: { "text/plain": "42" } })
    expect(nb.cells[0].outputs[1]).toEqual({ output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["line1", "line2"] })
  })
  test("unknown output_type dropped", () => {
    const nb = parseNotebook({ cells: [{ cell_type: "code", source: "x", outputs: [{ output_type: "mystery" }, { output_type: "stream", name: "stdout", text: "ok" }] }] })
    expect(nb.cells[0].outputs).toHaveLength(1)
  })
})

describe("parse ∘ serialize round-trip", () => {
  test("model survives a serialize→parse cycle unchanged", () => {
    const nb = parseNotebook(sampleIpynb)
    expect(parseNotebook(serializeNotebook(nb))).toEqual(nb)
  })
  test("serialized code cell has outputs+execution_count; markdown omits them", () => {
    const nb = parseNotebook(sampleIpynb)
    const ser = serializeNotebook(nb) as { cells: Record<string, unknown>[] }
    expect("outputs" in ser.cells[0]).toBe(false) // markdown
    expect("execution_count" in ser.cells[0]).toBe(false)
    expect("outputs" in ser.cells[1]).toBe(true) // code
    expect(ser.cells[1].source).toEqual(["print('hi')"])
  })
})

const nb3 = (): Notebook => parseNotebook({ cells: [
  { id: "a", cell_type: "code", source: "1", execution_count: 1, outputs: [{ output_type: "stream", name: "stdout", text: "x" }] },
  { id: "b", cell_type: "markdown", source: "## h" },
  { id: "c", cell_type: "code", source: "3", execution_count: 3, outputs: [{ output_type: "stream", name: "stdout", text: "z" }] },
] })

describe("insert / append / delete", () => {
  test("insert at index, clamps out-of-range", () => {
    const nb = insertCell(nb3(), 1, "code", "new", "n1")
    expect(nb.cells.map((c) => c.id)).toEqual(["a", "n1", "b", "c"])
    expect(insertCell(nb3(), 99, "raw", "", "z9").cells.map((c) => c.id)).toEqual(["a", "b", "c", "z9"])
    expect(insertCell(nb3(), -5, "raw", "", "z0").cells[0].id).toBe("z0")
  })
  test("append goes to the end", () => {
    expect(appendCell(nb3(), "code", "", "end").cells.at(-1)!.id).toBe("end")
  })
  test("delete removes; absent → same reference", () => {
    expect(deleteCell(nb3(), "b").cells.map((c) => c.id)).toEqual(["a", "c"])
    const n = nb3()
    expect(deleteCell(n, "zzz")).toBe(n)
  })
  test("does not mutate input", () => {
    const n = nb3()
    insertCell(n, 0, "code", "x", "q")
    expect(n.cells).toHaveLength(3)
  })
})

describe("move", () => {
  test("moveCell to absolute index", () => {
    expect(moveCell(nb3(), "c", 0).cells.map((c) => c.id)).toEqual(["c", "a", "b"])
    expect(moveCell(nb3(), "a", 99).cells.map((c) => c.id)).toEqual(["b", "c", "a"])
  })
  test("moveCellBy delta clamps at edges", () => {
    expect(moveCellBy(nb3(), "a", -1).cells.map((c) => c.id)).toEqual(["a", "b", "c"]) // already top
    expect(moveCellBy(nb3(), "a", 1).cells.map((c) => c.id)).toEqual(["b", "a", "c"])
    expect(moveCellBy(nb3(), "c", 5).cells.map((c) => c.id)).toEqual(["a", "b", "c"]) // already bottom
  })
  test("absent id → same reference", () => {
    const n = nb3()
    expect(moveCell(n, "zzz", 0)).toBe(n)
  })
})

describe("updateCellSource / changeCellType", () => {
  test("updates source", () => {
    expect(findCell(updateCellSource(nb3(), "b", "## new"), "b")!.source).toBe("## new")
  })
  test("code→markdown clears outputs + execution_count", () => {
    const nb = changeCellType(nb3(), "a", "markdown")
    const a = findCell(nb, "a")!
    expect(a.cell_type).toBe("markdown")
    expect(a.outputs).toEqual([])
    expect(a.execution_count).toBeNull()
  })
  test("markdown→code keeps empty outputs", () => {
    const nb = changeCellType(nb3(), "b", "code")
    expect(findCell(nb, "b")!.cell_type).toBe("code")
  })
  test("absent id → same reference", () => {
    const n = nb3()
    expect(changeCellType(n, "zzz", "raw")).toBe(n)
    expect(updateCellSource(n, "zzz", "x")).toBe(n)
  })
})

describe("execution count / outputs", () => {
  test("setExecutionCount on code cell; ignored on markdown", () => {
    expect(findCell(setExecutionCount(nb3(), "a", 7), "a")!.execution_count).toBe(7)
    expect(findCell(setExecutionCount(nb3(), "b", 7), "b")!.execution_count).toBeNull()
  })
  test("setCellOutputs only on code cells", () => {
    const out: NotebookOutput[] = [{ output_type: "stream", name: "stderr", text: "warn" }]
    expect(findCell(setCellOutputs(nb3(), "a", out), "a")!.outputs).toEqual(out)
    const n = nb3()
    expect(setCellOutputs(n, "b", out)).toBe(n) // markdown → no-op
  })
  test("clearCellOutputs clears one; no-op when already clean", () => {
    const cleared = clearCellOutputs(nb3(), "a")
    expect(findCell(cleared, "a")!.outputs).toEqual([])
    expect(findCell(cleared, "a")!.execution_count).toBeNull()
    expect(clearCellOutputs(cleared, "a")).toBe(cleared) // already clean → same ref
  })
  test("clearAllOutputs resets every code cell; no-op when nothing to clear", () => {
    const cleared = clearAllOutputs(nb3())
    expect(cleared.cells.filter((c) => c.cell_type === "code").every((c) => c.outputs.length === 0 && c.execution_count === null)).toBe(true)
    expect(clearAllOutputs(cleared)).toBe(cleared)
  })
})

describe("kernel + language + stats", () => {
  test("selectKernel sets kernelspec", () => {
    const nb = selectKernel(parseNotebook({ cells: [] }), { name: "deno", display_name: "Deno", language: "typescript" })
    expect(nb.metadata.kernelspec).toEqual({ name: "deno", display_name: "Deno", language: "typescript" })
  })
  test("notebookLanguage precedence: language_info → kernelspec → python", () => {
    expect(notebookLanguage(parseNotebook(sampleIpynb))).toBe("python")
    expect(notebookLanguage(parseNotebook({ cells: [], metadata: { kernelspec: { name: "n", display_name: "d", language: "rust" } } }))).toBe("rust")
    expect(notebookLanguage(parseNotebook({ cells: [] }))).toBe("python")
  })
  test("countCells", () => {
    expect(countCells(nb3())).toEqual({ code: 2, markdown: 1, raw: 0, total: 3 })
  })
})
