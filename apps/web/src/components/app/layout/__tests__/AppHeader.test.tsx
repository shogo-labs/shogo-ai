/**
 * Tests for AppHeader Integration
 * Task: task-2-2-003
 *
 * TDD tests for integrating OrgSwitcher and ProjectSelector into AppHeader.
 *
 * Test Specifications:
 * - test-2-2-003-006: AppHeader integrates OrgSwitcher and ProjectSelector
 *
 * Per ip-2-2-002:
 * - Replace flex-1 spacer div (line 35-36) with OrgSwitcher and ProjectSelector
 * - New structure: <div className='flex items-center gap-4 flex-1'><OrgSwitcher /><ProjectSelector /></div>
 * - Import both from '../workspace'
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test: AppHeader integrates OrgSwitcher and ProjectSelector
// (test-2-2-003-006)
// ============================================================

describe("test-2-2-003-006: AppHeader integrates OrgSwitcher and ProjectSelector", () => {
  test("AppHeader imports OrgSwitcher from workspace", () => {
    const componentPath = path.resolve(import.meta.dir, "../AppHeader.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import OrgSwitcher
    expect(componentSource).toMatch(/OrgSwitcher/)
    expect(componentSource).toMatch(/from\s+["']\.\.\/workspace["']/)
  })

  test("AppHeader imports ProjectSelector from workspace", () => {
    const componentPath = path.resolve(import.meta.dir, "../AppHeader.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import ProjectSelector
    expect(componentSource).toMatch(/ProjectSelector/)
  })

  test("AppHeader renders OrgSwitcher component", () => {
    const componentPath = path.resolve(import.meta.dir, "../AppHeader.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use OrgSwitcher component
    expect(componentSource).toMatch(/<OrgSwitcher/)
  })

  test("AppHeader renders ProjectSelector component", () => {
    const componentPath = path.resolve(import.meta.dir, "../AppHeader.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use ProjectSelector component
    expect(componentSource).toMatch(/<ProjectSelector/)
  })

  test("AppHeader replaces flex-1 spacer with selectors container", () => {
    const componentPath = path.resolve(import.meta.dir, "../AppHeader.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have a container div with flex items-center gap-4 flex-1
    expect(componentSource).toMatch(/flex\s+items-center\s+gap-4\s+flex-1/)
  })

  test("AppHeader uses useWorkspaceData hook", () => {
    const componentPath = path.resolve(import.meta.dir, "../AppHeader.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import and use useWorkspaceData
    expect(componentSource).toMatch(/useWorkspaceData/)
  })

  test("AppHeader uses useWorkspaceNavigation hook", () => {
    const componentPath = path.resolve(import.meta.dir, "../AppHeader.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import and use useWorkspaceNavigation
    expect(componentSource).toMatch(/useWorkspaceNavigation/)
  })

  test("AppHeader passes orgs to OrgSwitcher", () => {
    const componentPath = path.resolve(import.meta.dir, "../AppHeader.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should pass orgs prop
    expect(componentSource).toMatch(/orgs=\{/)
  })

  test("AppHeader passes currentOrg to OrgSwitcher", () => {
    const componentPath = path.resolve(import.meta.dir, "../AppHeader.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should pass currentOrg prop
    expect(componentSource).toMatch(/currentOrg=\{/)
  })

  test("AppHeader passes projects to ProjectSelector", () => {
    const componentPath = path.resolve(import.meta.dir, "../AppHeader.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should pass projects prop
    expect(componentSource).toMatch(/projects=\{/)
  })

  test("AppHeader passes currentProject to ProjectSelector", () => {
    const componentPath = path.resolve(import.meta.dir, "../AppHeader.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should pass currentProject prop
    expect(componentSource).toMatch(/currentProject=\{/)
  })

  test("AppHeader passes onOrgChange callback to OrgSwitcher", () => {
    const componentPath = path.resolve(import.meta.dir, "../AppHeader.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should pass onOrgChange that uses setOrg
    expect(componentSource).toMatch(/onOrgChange=/)
  })

  test("AppHeader passes onProjectChange callback to ProjectSelector", () => {
    const componentPath = path.resolve(import.meta.dir, "../AppHeader.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should pass onProjectChange that uses setProjectId
    expect(componentSource).toMatch(/onProjectChange=/)
  })

  test("AppHeader disables ProjectSelector when no org selected", () => {
    const componentPath = path.resolve(import.meta.dir, "../AppHeader.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should pass disabled prop based on currentOrg
    expect(componentSource).toMatch(/disabled=/)
  })
})

// ============================================================
// Test: AppHeader module can still be imported
// ============================================================

describe("AppHeader module exports", () => {
  test("AppHeader can be imported", async () => {
    const module = await import("../AppHeader")
    expect(module.AppHeader).toBeDefined()
    expect(typeof module.AppHeader).toBe("function")
  })
})
