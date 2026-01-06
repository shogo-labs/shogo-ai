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

  test("required references have solid stroke with stroke-primary", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/stroke-primary|stroke.*primary/)
  })

  test("optional references have dashed stroke with strokeDasharray=4", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/strokeDasharray/)
    expect(source).toMatch(/stroke-muted-foreground|stroke.*muted/)
  })

  test("has markerEnd with MarkerType.ArrowClosed", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/MarkerType/)
    expect(source).toMatch(/ArrowClosed/)
  })

  test("uses EdgeLabelRenderer for label display", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/EdgeLabelRenderer/)
  })

  test("label has bg-background px-1 rounded text-xs styling", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/bg-background/)
    expect(source).toMatch(/px-1/)
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
