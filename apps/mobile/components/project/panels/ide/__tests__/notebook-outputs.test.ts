// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FEAT-NOTEBOOKS — unit tests for the pure output-rendering model.
 *
 * Pure module, no DOM / kernel — runs under `bun test`.
 * Pins: ANSI stripping; MIME priority selection; per-output → display item
 * conversion (stream incl. stderr, execute_result/display_data rich pick,
 * image data-URI, error traceback strip); and cell flattening.
 */
import { describe, expect, test } from "bun:test"
import {
  MIME_PRIORITY,
  cellDisplayItems,
  cellHasError,
  outputToDisplayItems,
  pickRichMime,
  stripAnsi,
} from "../notebook-outputs"
import { parseNotebook, type NotebookCell, type NotebookOutput } from "../notebook-model"

describe("stripAnsi", () => {
  test("removes colour codes, keeps text", () => {
    expect(stripAnsi("\u001b[31mError\u001b[0m: boom")).toBe("Error: boom")
  })
  test("no escape → same reference (fast path)", () => {
    const s = "plain"
    expect(stripAnsi(s)).toBe(s)
  })
  test("strips a realistic traceback frame", () => {
    expect(stripAnsi("\u001b[0;32m----> 1\u001b[0m foo()")).toBe("----> 1 foo()")
  })
})

describe("pickRichMime", () => {
  test("prefers richer media over plain text", () => {
    expect(pickRichMime({ "text/plain": "x", "text/html": "<b>x</b>" })).toBe("text/html")
    expect(pickRichMime({ "text/plain": "x", "image/png": "..." })).toBe("image/png")
    expect(pickRichMime({ "text/html": "h", "image/svg+xml": "<svg/>" })).toBe("image/svg+xml")
  })
  test("plain text when it's the only option", () => {
    expect(pickRichMime({ "text/plain": "x" })).toBe("text/plain")
  })
  test("unknown mime falls back to first sorted key", () => {
    expect(pickRichMime({ "application/x-foo": "a", "application/x-bar": "b" })).toBe("application/x-bar")
  })
  test("empty bundle → undefined", () => {
    expect(pickRichMime({})).toBeUndefined()
  })
  test("priority list is richest-first", () => {
    expect(MIME_PRIORITY[0]).toBe("image/png")
    expect(MIME_PRIORITY[MIME_PRIORITY.length - 1]).toBe("text/plain")
  })
})

describe("outputToDisplayItems", () => {
  test("stdout stream → text item", () => {
    expect(outputToDisplayItems({ output_type: "stream", name: "stdout", text: "hello\n" }))
      .toEqual([{ kind: "text", text: "hello\n", isStderr: false }])
  })
  test("stderr stream flagged", () => {
    expect(outputToDisplayItems({ output_type: "stream", name: "stderr", text: "warn" })[0].isStderr).toBe(true)
  })
  test("execute_result picks rich html", () => {
    const out: NotebookOutput = { output_type: "execute_result", execution_count: 1, data: { "text/plain": "<df>", "text/html": "<table></table>" } }
    expect(outputToDisplayItems(out)).toEqual([{ kind: "html", mime: "text/html", text: "<table></table>" }])
  })
  test("display_data plain text", () => {
    expect(outputToDisplayItems({ output_type: "display_data", data: { "text/plain": "hi" } }))
      .toEqual([{ kind: "text", mime: "text/plain", text: "hi" }])
  })
  test("image output → data URI (whitespace stripped)", () => {
    const out: NotebookOutput = { output_type: "display_data", data: { "image/png": "iVBOR w0K\nGgo=" } }
    expect(outputToDisplayItems(out)).toEqual([{ kind: "image", mime: "image/png", text: "data:image/png;base64,iVBORw0KGgo=" }])
  })
  test("svg + json + markdown kinds", () => {
    expect(outputToDisplayItems({ output_type: "display_data", data: { "image/svg+xml": "<svg/>" } })[0].kind).toBe("svg")
    expect(outputToDisplayItems({ output_type: "display_data", data: { "application/json": "{}" } })[0].kind).toBe("json")
    expect(outputToDisplayItems({ output_type: "display_data", data: { "text/markdown": "# h" } })[0].kind).toBe("markdown")
  })
  test("error → error item with ANSI-stripped traceback", () => {
    const out: NotebookOutput = { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["\u001b[31mTrace 1\u001b[0m", "Trace 2"] }
    expect(outputToDisplayItems(out)).toEqual([{ kind: "error", ename: "ValueError", evalue: "bad", traceback: ["Trace 1", "Trace 2"] }])
  })
  test("empty data bundle → no items", () => {
    expect(outputToDisplayItems({ output_type: "display_data", data: {} })).toEqual([])
  })
})

describe("cellDisplayItems / cellHasError", () => {
  const cell = (outputs: NotebookOutput[], cell_type = "code"): NotebookCell =>
    parseNotebook({ cells: [{ id: "x", cell_type, source: "", outputs, execution_count: 1 }] }).cells[0]

  test("flattens all outputs in order", () => {
    const items = cellDisplayItems(cell([
      { output_type: "stream", name: "stdout", text: "a" },
      { output_type: "execute_result", execution_count: 1, data: { "text/plain": "b" } },
    ]))
    expect(items.map((i) => i.kind)).toEqual(["text", "text"])
    expect(items[1].text).toBe("b")
  })
  test("markdown cell → no display items", () => {
    expect(cellDisplayItems(cell([], "markdown"))).toEqual([])
  })
  test("cellHasError true only when an error output is present", () => {
    expect(cellHasError(cell([{ output_type: "error", ename: "E", evalue: "v", traceback: [] }]))).toBe(true)
    expect(cellHasError(cell([{ output_type: "stream", name: "stdout", text: "x" }]))).toBe(false)
  })
})
