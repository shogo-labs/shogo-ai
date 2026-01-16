/**
 * Generated from TestSpecifications for task-2-2-008
 * Tests: barrel exports for workspace module
 *
 * Verifies that all Session 2.2 workspace components are properly exported from
 * the workspace barrel file at apps/web/src/components/app/workspace/index.ts
 *
 * Per design-2-2-clean-break:
 * - Only exports /app components
 * - Zero re-exports from /components/Studio/
 */

import { describe, test, expect } from "bun:test"

/**
 * Helper to check if an export is a valid React component.
 * MobX observer() wraps components in React.memo, resulting in an object
 * with $$typeof: Symbol(react.memo) and a type property with the actual component.
 */
function isValidComponent(component: unknown): boolean {
  if (typeof component === "function") {
    return true
  }
  if (typeof component === "object" && component !== null) {
    const obj = component as Record<string, unknown>
    // React.memo wrapped components have $$typeof and type
    if ("$$typeof" in obj && "type" in obj) {
      return true
    }
    // Class components have render method
    if ("render" in obj) {
      return true
    }
  }
  return false
}

describe("workspace barrel exports - workspace components", () => {
  test("WorkspaceSwitcher can be imported from workspace barrel", async () => {
    const { WorkspaceSwitcher } = await import("@/components/app/workspace")
    expect(WorkspaceSwitcher).toBeDefined()
    expect(isValidComponent(WorkspaceSwitcher)).toBe(true)
  })

  test("ProjectSelector can be imported from workspace barrel", async () => {
    const { ProjectSelector } = await import("@/components/app/workspace")
    expect(ProjectSelector).toBeDefined()
    expect(isValidComponent(ProjectSelector)).toBe(true)
  })

  test("WorkspaceLayout can be imported from workspace barrel", async () => {
    const { WorkspaceLayout } = await import("@/components/app/workspace")
    expect(WorkspaceLayout).toBeDefined()
    expect(isValidComponent(WorkspaceLayout)).toBe(true)
  })
})

describe("workspace barrel exports - sidebar components", () => {
  test("FeatureSidebar can be imported from workspace barrel", async () => {
    const { FeatureSidebar } = await import("@/components/app/workspace")
    expect(FeatureSidebar).toBeDefined()
    expect(isValidComponent(FeatureSidebar)).toBe(true)
  })

  test("FeatureGroup can be imported from workspace barrel", async () => {
    const { FeatureGroup } = await import("@/components/app/workspace")
    expect(FeatureGroup).toBeDefined()
    expect(isValidComponent(FeatureGroup)).toBe(true)
  })

  test("FeatureItem can be imported from workspace barrel", async () => {
    const { FeatureItem } = await import("@/components/app/workspace")
    expect(FeatureItem).toBeDefined()
    expect(isValidComponent(FeatureItem)).toBe(true)
  })

  test("SidebarSearch can be imported from workspace barrel", async () => {
    const { SidebarSearch } = await import("@/components/app/workspace")
    expect(SidebarSearch).toBeDefined()
    expect(isValidComponent(SidebarSearch)).toBe(true)
  })

  test("NewFeatureButton can be imported from workspace barrel", async () => {
    const { NewFeatureButton } = await import("@/components/app/workspace")
    expect(NewFeatureButton).toBeDefined()
    expect(isValidComponent(NewFeatureButton)).toBe(true)
  })
})

describe("workspace barrel exports - dashboard components", () => {
  test("ProjectDashboard can be imported from workspace barrel", async () => {
    const { ProjectDashboard } = await import("@/components/app/workspace")
    expect(ProjectDashboard).toBeDefined()
    expect(isValidComponent(ProjectDashboard)).toBe(true)
  })

  test("StatsCards can be imported from workspace barrel", async () => {
    const { StatsCards } = await import("@/components/app/workspace")
    expect(StatsCards).toBeDefined()
    expect(isValidComponent(StatsCards)).toBe(true)
  })
})

describe("workspace barrel exports - modal components", () => {
  test("NewFeatureModal can be imported from workspace barrel", async () => {
    const { NewFeatureModal } = await import("@/components/app/workspace")
    expect(NewFeatureModal).toBeDefined()
    expect(isValidComponent(NewFeatureModal)).toBe(true)
  })
})

describe("workspace barrel exports - hooks", () => {
  test("useWorkspaceNavigation can be imported from workspace barrel", async () => {
    const { useWorkspaceNavigation } = await import("@/components/app/workspace")
    expect(useWorkspaceNavigation).toBeDefined()
    expect(typeof useWorkspaceNavigation).toBe("function")
  })

  test("useWorkspaceData can be imported from workspace barrel", async () => {
    const { useWorkspaceData } = await import("@/components/app/workspace")
    expect(useWorkspaceData).toBeDefined()
    expect(typeof useWorkspaceData).toBe("function")
  })
})

describe("workspace barrel exports - all exports", () => {
  test("workspace barrel has no default export", async () => {
    const barrel = await import("@/components/app/workspace")
    expect((barrel as { default?: unknown }).default).toBeUndefined()
  })

  test("all expected components are exported from workspace barrel", async () => {
    const barrel = await import("@/components/app/workspace")
    const exportedNames = Object.keys(barrel)

    // Workspace components
    expect(exportedNames).toContain("WorkspaceSwitcher")
    expect(exportedNames).toContain("ProjectSelector")
    expect(exportedNames).toContain("WorkspaceLayout")

    // Sidebar components
    expect(exportedNames).toContain("FeatureSidebar")
    expect(exportedNames).toContain("FeatureGroup")
    expect(exportedNames).toContain("FeatureItem")
    expect(exportedNames).toContain("SidebarSearch")
    expect(exportedNames).toContain("NewFeatureButton")

    // Dashboard components
    expect(exportedNames).toContain("ProjectDashboard")
    expect(exportedNames).toContain("StatsCards")

    // Modal components
    expect(exportedNames).toContain("NewFeatureModal")

    // Hooks
    expect(exportedNames).toContain("useWorkspaceNavigation")
    expect(exportedNames).toContain("useWorkspaceData")
  })
})
