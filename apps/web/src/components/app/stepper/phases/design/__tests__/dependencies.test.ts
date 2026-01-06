/**
 * Package Dependencies Test
 * Task: task-2-3c-001
 *
 * Verifies that required packages for ReactFlow and dagre are installed.
 */

import { describe, test, expect } from "bun:test"
import pkg from "../../../../../../../package.json"
import dagre from "dagre"

describe("Package Dependencies (task-2-3c-001)", () => {
  describe("ReactFlow package", () => {
    test("@xyflow/react is present in dependencies", () => {
      expect(pkg.dependencies["@xyflow/react"]).toBeDefined()
    })

    test("version is v12 or higher", () => {
      const version = pkg.dependencies["@xyflow/react"]
      // Extract major version from semver (e.g., "^12.10.0" -> 12)
      const majorVersion = parseInt(version.replace(/^\^|~/, "").split(".")[0])
      expect(majorVersion).toBeGreaterThanOrEqual(12)
    })
  })

  describe("Dagre package", () => {
    test("dagre is present in dependencies", () => {
      expect(pkg.dependencies["dagre"]).toBeDefined()
    })

    test("@types/dagre is present in devDependencies", () => {
      expect(pkg.devDependencies["@types/dagre"]).toBeDefined()
    })
  })

  describe("TypeScript integration", () => {
    test("import dagre resolves without errors", () => {
      expect(dagre).toBeDefined()
    })

    test("TypeScript recognizes dagre.graphlib.Graph type", () => {
      const Graph = dagre.graphlib.Graph
      expect(Graph).toBeDefined()
      expect(typeof Graph).toBe("function")

      // Verify we can construct a graph
      const g = new Graph()
      expect(g).toBeDefined()
      expect(typeof g.setGraph).toBe("function")
    })
  })
})
