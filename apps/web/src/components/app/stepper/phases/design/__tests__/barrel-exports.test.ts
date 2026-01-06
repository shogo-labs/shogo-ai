/**
 * Design Phase Barrel Export Tests
 * Task: task-2-3c-015
 *
 * Tests for design/index.ts barrel exports.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("Design phase barrel exports (task-2-3c-015)", () => {
  const barrelPath = path.resolve(import.meta.dir, "../index.ts")

  test("design/index.ts barrel file exists", () => {
    const exists = fs.existsSync(barrelPath)
    expect(exists).toBe(true)
  })

  test("exports DesignView component", () => {
    const source = fs.readFileSync(barrelPath, "utf-8")
    expect(source).toMatch(/export.*DesignView/)
  })

  test("exports SchemaGraph component", () => {
    const source = fs.readFileSync(barrelPath, "utf-8")
    expect(source).toMatch(/export.*SchemaGraph/)
  })

  test("exports EntityNode component", () => {
    const source = fs.readFileSync(barrelPath, "utf-8")
    expect(source).toMatch(/export.*EntityNode/)
  })

  test("exports ReferenceEdge component", () => {
    const source = fs.readFileSync(barrelPath, "utf-8")
    expect(source).toMatch(/export.*ReferenceEdge/)
  })

  test("exports EntityDetailsPanel component", () => {
    const source = fs.readFileSync(barrelPath, "utf-8")
    expect(source).toMatch(/export.*EntityDetailsPanel/)
  })

  test("exports DesignDecisionCard component", () => {
    const source = fs.readFileSync(barrelPath, "utf-8")
    expect(source).toMatch(/export.*DesignDecisionCard/)
  })

  test("exports DesignDecisionsList component", () => {
    const source = fs.readFileSync(barrelPath, "utf-8")
    expect(source).toMatch(/export.*DesignDecisionsList/)
  })

  test("exports EnhancementHooksPlan component", () => {
    const source = fs.readFileSync(barrelPath, "utf-8")
    expect(source).toMatch(/export.*EnhancementHooksPlan/)
  })

  test("exports SchemaEmptyState component", () => {
    const source = fs.readFileSync(barrelPath, "utf-8")
    expect(source).toMatch(/export.*SchemaEmptyState/)
  })

  test("exports SchemaLoadingSkeleton component", () => {
    const source = fs.readFileSync(barrelPath, "utf-8")
    expect(source).toMatch(/export.*SchemaLoadingSkeleton/)
  })

  test("exports useSchemaData hook", () => {
    const source = fs.readFileSync(barrelPath, "utf-8")
    expect(source).toMatch(/export.*useSchemaData/)
  })

  test("exports EntityNodeData type", () => {
    const source = fs.readFileSync(barrelPath, "utf-8")
    expect(source).toMatch(/EntityNodeData/)
  })

  test("exports ReferenceEdgeData type", () => {
    const source = fs.readFileSync(barrelPath, "utf-8")
    expect(source).toMatch(/ReferenceEdgeData/)
  })

  test("exports SchemaModel type", () => {
    const source = fs.readFileSync(barrelPath, "utf-8")
    expect(source).toMatch(/SchemaModel/)
  })

  test("DesignView can be imported", async () => {
    const module = await import("../index")
    expect(module.DesignView).toBeDefined()
  })

  test("SchemaGraph can be imported", async () => {
    const module = await import("../index")
    expect(module.SchemaGraph).toBeDefined()
  })

  test("useSchemaData can be imported", async () => {
    const module = await import("../index")
    expect(module.useSchemaData).toBeDefined()
  })
})
