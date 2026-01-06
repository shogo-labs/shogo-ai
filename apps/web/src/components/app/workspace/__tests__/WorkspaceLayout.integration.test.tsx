/**
 * WorkspaceLayout Integration Tests
 * Task: task-2-3a-009
 *
 * Tests for WorkspaceLayout integration with PhaseContentPanel.
 * Verifies stepper renders when feature is selected.
 *
 * Test Specifications:
 * - test-2-3a-009-01 through test-2-3a-009-08
 *
 * Uses source analysis pattern to verify integration.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("WorkspaceLayout integration with PhaseContentPanel", () => {
  const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")

  test("WorkspaceLayout file exists", () => {
    expect(fs.existsSync(componentPath)).toBe(true)
  })

  const getSource = () => fs.readFileSync(componentPath, "utf-8")

  // test-2-3a-009-06: WorkspaceLayout imports PhaseContentPanel from stepper
  describe("test-2-3a-009-06: imports PhaseContentPanel", () => {
    test("imports PhaseContentPanel from '../stepper'", () => {
      const source = getSource()
      expect(source).toContain("PhaseContentPanel")
      expect(source).toMatch(/from\s+['"]\.\.\/stepper['"]/)
    })
  })

  // test-2-3a-009-01: Renders ProjectDashboard when no feature selected
  describe("test-2-3a-009-01: renders ProjectDashboard when no feature", () => {
    test("still has project-dashboard testid for no feature case", () => {
      const source = getSource()
      expect(source).toContain('data-testid="project-dashboard"')
    })
  })

  // test-2-3a-009-02: Renders PhaseContentPanel when featureId is set
  describe("test-2-3a-009-02: renders PhaseContentPanel when featureId set", () => {
    test("renders PhaseContentPanel component", () => {
      const source = getSource()
      expect(source).toContain("<PhaseContentPanel")
    })

    test("conditionally renders based on featureId", () => {
      const source = getSource()
      // Should check featureId AND currentFeature
      expect(source).toMatch(/featureId.*currentFeature|currentFeature.*featureId/)
    })
  })

  // test-2-3a-009-03: Passes currentFeature to PhaseContentPanel
  describe("test-2-3a-009-03: passes currentFeature prop", () => {
    test("passes feature={currentFeature}", () => {
      const source = getSource()
      expect(source).toMatch(/feature=\{currentFeature\}/)
    })
  })

  // test-2-3a-009-04: Keeps Outlet as fallback
  describe("test-2-3a-009-04: keeps Outlet as fallback", () => {
    test("Outlet is still in component", () => {
      const source = getSource()
      expect(source).toContain("<Outlet")
    })
  })

  // test-2-3a-009-08: WorkspaceLayout remains smart component boundary
  describe("test-2-3a-009-08: remains smart component", () => {
    test("calls useWorkspaceData", () => {
      const source = getSource()
      expect(source).toContain("useWorkspaceData")
    })

    test("gets currentFeature from useWorkspaceData", () => {
      const source = getSource()
      expect(source).toContain("currentFeature")
    })
  })
})
