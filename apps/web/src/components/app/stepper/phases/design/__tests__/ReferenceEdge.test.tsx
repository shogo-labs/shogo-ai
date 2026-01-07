/**
 * ReferenceEdge Component Tests
 * Task: task-2-3c-006
 *
 * Tests for the custom ReactFlow edge component.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("ReferenceEdge (task-2-3c-006)", () => {
  const componentPath = path.resolve(import.meta.dir, "../ReferenceEdge.tsx")

  test("ReferenceEdge component file exists", () => {
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("accepts EdgeProps<ReferenceEdgeData> from @xyflow/react", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/@xyflow\/react/)
    expect(source).toMatch(/EdgeProps/)
    expect(source).toMatch(/ReferenceEdgeData/)
  })

  test("ReferenceEdgeData type has label and isOptional", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/label/)
    expect(source).toMatch(/isOptional/)
  })

  test("uses getSmoothStepPath for path calculation", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/getSmoothStepPath/)
  })

  test("required references have solid stroke styling", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Redesigned uses amber colors for design phase consistency
    expect(source).toMatch(/stroke-primary|stroke.*primary|amber|#f59e0b/)
  })

  test("optional references have dashed stroke with strokeDasharray", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/strokeDasharray/)
    // Redesigned uses amber-600 for dashed lines
    expect(source).toMatch(/stroke-muted-foreground|stroke.*muted|amber|#d97706/)
  })

  test("has markerEnd for arrows", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Uses markerEnd prop passed from ReactFlow
    expect(source).toMatch(/markerEnd/)
  })

  test("uses EdgeLabelRenderer for label display", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/EdgeLabelRenderer/)
  })

  test("label has background, padding, rounded and text-xs styling", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Redesigned uses px-2 padding
    expect(source).toMatch(/bg-background|bg-amber/)
    expect(source).toMatch(/px-1|px-2/)
    expect(source).toMatch(/rounded/)
    expect(source).toMatch(/text-xs/)
  })

  test("has data-testid=reference-edge-{source}-{target}", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/data-testid.*reference-edge/)
  })

  test("component can be imported", async () => {
    const module = await import("../ReferenceEdge")
    expect(module.ReferenceEdge).toBeDefined()
  })
})
