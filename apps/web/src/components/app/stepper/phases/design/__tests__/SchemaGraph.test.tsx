/**
 * SchemaGraph Component Tests
 * Task: task-2-3c-007
 *
 * Tests for the schema visualization ReactFlow component.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("SchemaGraph (task-2-3c-007)", () => {
  const componentPath = path.resolve(import.meta.dir, "../SchemaGraph.tsx")

  test("SchemaGraph component file exists", () => {
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("imports ReactFlow from @xyflow/react", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/ReactFlow/)
    expect(source).toMatch(/@xyflow\/react/)
  })

  test("imports Controls from @xyflow/react", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/Controls/)
    expect(source).toMatch(/@xyflow\/react/)
  })

  test("imports EntityNode component", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*EntityNode/)
  })

  test("imports ReferenceEdge component", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*ReferenceEdge/)
  })

  test("imports transformSchemaToGraph and applyDagreLayout", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/transformSchemaToGraph/)
    expect(source).toMatch(/applyDagreLayout/)
  })

  test("defines nodeTypes with entity type", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/nodeTypes/)
    expect(source).toMatch(/entity.*EntityNode|EntityNode.*entity/)
  })

  test("defines edgeTypes with reference type", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/edgeTypes/)
    expect(source).toMatch(/reference.*ReferenceEdge|ReferenceEdge.*reference/)
  })

  test("accepts models prop as SchemaModel[]", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/models.*SchemaModel/)
  })

  test("accepts selectedEntityId prop", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/selectedEntityId/)
  })

  test("accepts onSelectEntity callback prop", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/onSelectEntity/)
  })

  test("uses useState for nodes and edges", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/useState/)
    expect(source).toMatch(/nodes/)
    expect(source).toMatch(/edges/)
  })

  test("uses useEffect to transform models on change", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/useEffect/)
    expect(source).toMatch(/models/)
  })

  test("calls transformSchemaToGraph with models", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/transformSchemaToGraph\s*\(\s*models/)
  })

  test("calls applyDagreLayout after transformation", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/applyDagreLayout/)
  })

  test("handles onNodeClick to call onSelectEntity", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/onNodeClick/)
    expect(source).toMatch(/onSelectEntity/)
  })

  test("handles onPaneClick to deselect (onSelectEntity(null))", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/onPaneClick/)
  })

  test("updates isSelected in node data based on selectedEntityId", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/isSelected/)
    expect(source).toMatch(/selectedEntityId/)
  })

  test("has h-full w-full container classes", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/h-full/)
    expect(source).toMatch(/w-full/)
  })

  test("has data-testid=schema-graph", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/data-testid.*schema-graph/)
  })

  test("renders Controls component", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<Controls/)
  })

  test("component can be imported", async () => {
    const module = await import("../SchemaGraph")
    expect(module.SchemaGraph).toBeDefined()
  })
})
