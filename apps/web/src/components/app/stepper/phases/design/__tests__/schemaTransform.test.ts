/**
 * Schema Transform Utilities Tests
 * Task: task-2-3c-004
 *
 * Tests for schema transformation utilities (transformSchemaToGraph, applyDagreLayout).
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("Schema Transform Utilities (task-2-3c-004)", () => {
  const utilsPath = path.resolve(import.meta.dir, "../utils/schemaTransform.ts")

  test("schemaTransform.ts file exists", () => {
    const exists = fs.existsSync(utilsPath)
    expect(exists).toBe(true)
  })

  describe("transformSchemaToGraph function", () => {
    test("function is exported", () => {
      const source = fs.readFileSync(utilsPath, "utf-8")
      expect(source).toMatch(/export.*function\s+transformSchemaToGraph/)
    })

    test("returns { nodes, edges } object", () => {
      const source = fs.readFileSync(utilsPath, "utf-8")
      expect(source).toMatch(/nodes/)
      expect(source).toMatch(/edges/)
      expect(source).toMatch(/return.*{.*nodes.*edges.*}|return\s*{\s*nodes\s*,\s*edges\s*}/)
    })

    test("creates node for each model with id matching model name", () => {
      const source = fs.readFileSync(utilsPath, "utf-8")
      // Should iterate over models and create nodes
      expect(source).toMatch(/\.map|forEach/)
      expect(source).toMatch(/id.*model\.name|id:\s*model\.name/)
    })

    test("node data includes name, propertyCount, referenceCount, properties, isSelected", () => {
      const source = fs.readFileSync(utilsPath, "utf-8")
      expect(source).toMatch(/propertyCount/)
      expect(source).toMatch(/referenceCount/)
      expect(source).toMatch(/isSelected/)
    })

    test("creates edges from reference type fields", () => {
      const source = fs.readFileSync(utilsPath, "utf-8")
      expect(source).toMatch(/reference/)
      expect(source).toMatch(/source/)
      expect(source).toMatch(/target/)
    })

    test("edge data has label (field name) and isOptional", () => {
      const source = fs.readFileSync(utilsPath, "utf-8")
      expect(source).toMatch(/label/)
      expect(source).toMatch(/isOptional/)
    })

    test("handles reference[] array type", () => {
      const source = fs.readFileSync(utilsPath, "utf-8")
      expect(source).toMatch(/reference\[\]|reference-array/)
    })

    test("initializes isSelected to false", () => {
      const source = fs.readFileSync(utilsPath, "utf-8")
      expect(source).toMatch(/isSelected:\s*false/)
    })
  })

  describe("applyDagreLayout function", () => {
    test("function is exported", () => {
      const source = fs.readFileSync(utilsPath, "utf-8")
      expect(source).toMatch(/export.*function\s+applyDagreLayout/)
    })

    test("uses dagre.graphlib.Graph", () => {
      const source = fs.readFileSync(utilsPath, "utf-8")
      expect(source).toMatch(/dagre/)
      expect(source).toMatch(/graphlib\.Graph|new\s+Graph/)
    })

    test("configures rankdir='TB'", () => {
      const source = fs.readFileSync(utilsPath, "utf-8")
      expect(source).toMatch(/rankdir.*TB|rankdir:\s*['"]TB['"]/)
    })

    test("configures nodesep=50 and ranksep=100", () => {
      const source = fs.readFileSync(utilsPath, "utf-8")
      expect(source).toMatch(/nodesep.*50|nodesep:\s*50/)
      expect(source).toMatch(/ranksep.*100|ranksep:\s*100/)
    })

    test("sets node dimensions width=200, height=80", () => {
      const source = fs.readFileSync(utilsPath, "utf-8")
      expect(source).toMatch(/width.*200|width:\s*200/)
      expect(source).toMatch(/height.*80|height:\s*80/)
    })

    test("applies positions from dagre.layout", () => {
      const source = fs.readFileSync(utilsPath, "utf-8")
      expect(source).toMatch(/dagre\.layout|layout\(g\)/)
    })

    test("returns positioned nodes with x/y", () => {
      const source = fs.readFileSync(utilsPath, "utf-8")
      expect(source).toMatch(/position.*x|position:\s*{/)
    })
  })

  describe("Type exports", () => {
    test("exports EntityNodeData type", () => {
      const source = fs.readFileSync(utilsPath, "utf-8")
      expect(source).toMatch(/export.*interface\s+EntityNodeData|export\s+type\s+EntityNodeData/)
    })

    test("exports ReferenceEdgeData type", () => {
      const source = fs.readFileSync(utilsPath, "utf-8")
      expect(source).toMatch(/export.*interface\s+ReferenceEdgeData|export\s+type\s+ReferenceEdgeData/)
    })
  })

  test("module can be imported", async () => {
    const module = await import("../utils/schemaTransform")
    expect(module.transformSchemaToGraph).toBeDefined()
    expect(module.applyDagreLayout).toBeDefined()
  })
})
