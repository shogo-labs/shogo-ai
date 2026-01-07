/**
 * EntityNode Component Tests
 * Task: task-2-3c-005
 *
 * Tests for the custom ReactFlow entity node component.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("EntityNode (task-2-3c-005)", () => {
  const componentPath = path.resolve(import.meta.dir, "../EntityNode.tsx")

  test("EntityNode component file exists", () => {
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("accepts NodeProps<EntityNodeData> from @xyflow/react", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/@xyflow\/react/)
    expect(source).toMatch(/NodeProps/)
    expect(source).toMatch(/EntityNodeData/)
  })

  test("EntityNodeData type has name, propertyCount, referenceCount, isSelected", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Check import from schemaTransform or local definition
    expect(source).toMatch(/name/)
    expect(source).toMatch(/propertyCount/)
    expect(source).toMatch(/referenceCount/)
    expect(source).toMatch(/isSelected/)
  })

  test("uses CVA for variants with default and selected states", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/cva|class-variance-authority/)
  })

  test("default variant has border styling and bg-card", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Redesigned uses amber-500 for borders (blueprint aesthetic)
    expect(source).toMatch(/border-amber|border-border|bg-card/)
    expect(source).toMatch(/bg-card/)
  })

  test("selected variant has highlight and shadow styling", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Redesigned uses amber-500 for selected state (blueprint aesthetic)
    expect(source).toMatch(/border-amber|border-primary/)
    expect(source).toMatch(/shadow-lg|shadow-amber/)
  })

  test("shows entity name in font-medium text-sm", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/font-medium/)
    expect(source).toMatch(/text-sm/)
    expect(source).toMatch(/data\.name/)
  })

  test("shows property and reference counts in text-xs text-muted-foreground", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/text-xs/)
    expect(source).toMatch(/text-muted-foreground/)
    // Redesigned uses "props" and "refs" labels
    expect(source).toMatch(/props|properties/)
    expect(source).toMatch(/refs/)
  })

  test("renders Handle type=target at Position.Top", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/Handle/)
    expect(source).toMatch(/type.*target|type="target"/)
    expect(source).toMatch(/Position\.Top/)
  })

  test("renders Handle type=source at Position.Bottom", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/type.*source|type="source"/)
    expect(source).toMatch(/Position\.Bottom/)
  })

  test("has min-w-[180px] and px-4 py-3 classes", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/min-w-\[180px\]/)
    expect(source).toMatch(/px-4/)
    expect(source).toMatch(/py-3/)
  })

  test("has data-testid=entity-node-{name}", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/data-testid.*entity-node/)
  })

  test("component can be imported", async () => {
    const module = await import("../EntityNode")
    expect(module.EntityNode).toBeDefined()
  })
})
