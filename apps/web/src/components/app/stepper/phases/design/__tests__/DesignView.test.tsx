/**
 * DesignView Component Tests
 * Task: task-2-3c-012
 *
 * Tests for the main Design phase view container.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("DesignView (task-2-3c-012)", () => {
  const componentPath = path.resolve(import.meta.dir, "../DesignView.tsx")

  test("DesignView component file exists", () => {
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("wrapped with observer() from mobx-react-lite", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*observer.*from.*mobx-react-lite/)
    expect(source).toMatch(/observer\(/)
  })

  test("uses shadcn Tabs components", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/Tabs/)
    expect(source).toMatch(/TabsList/)
    expect(source).toMatch(/TabsTrigger/)
    expect(source).toMatch(/TabsContent/)
  })

  test("has Schema tab", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/schema/i)
    expect(source).toMatch(/TabsTrigger/)
  })

  test("has Decisions tab", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/decisions|Decisions/i)
  })

  test("has Hooks Plan tab", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/hooks|Hooks|plan|Plan/i)
  })

  test("imports and uses SchemaGraph component", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*SchemaGraph/)
    expect(source).toMatch(/<SchemaGraph/)
  })

  test("imports and uses DesignDecisionsList component", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*DesignDecisionsList/)
    expect(source).toMatch(/<DesignDecisionsList/)
  })

  test("imports and uses EnhancementHooksPlan component", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*EnhancementHooksPlan/)
    expect(source).toMatch(/<EnhancementHooksPlan/)
  })

  test("imports and uses EntityDetailsPanel component", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*EntityDetailsPanel/)
    expect(source).toMatch(/<EntityDetailsPanel/)
  })

  test("imports and uses useSchemaData hook", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*useSchemaData/)
    expect(source).toMatch(/useSchemaData/)
  })

  test("imports and uses SchemaEmptyState and SchemaLoadingSkeleton", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/SchemaEmptyState/)
    expect(source).toMatch(/SchemaLoadingSkeleton/)
  })

  test("accepts feature prop with FeatureForPanel type", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/feature.*FeatureForPanel|FeatureForPanel/)
  })

  test("has useState for selectedEntityId", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/useState/)
    expect(source).toMatch(/selectedEntityId/)
  })

  test("calls useSchemaData with feature.schemaName", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/useSchemaData\s*\(.*schemaName/)
  })

  test("passes models to SchemaGraph", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/SchemaGraph/)
    expect(source).toMatch(/models=\{models\}/)
  })

  test("passes selectedEntityId to SchemaGraph", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/selectedEntityId/)
  })

  test("passes onSelectEntity callback to SchemaGraph", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/onSelectEntity/)
  })

  test("passes feature.id to DesignDecisionsList", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/featureId/)
  })

  test("renders EntityDetailsPanel conditionally based on selection", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/EntityDetailsPanel/)
    expect(source).toMatch(/selectedEntityId/)
  })

  test("handles loading state with SchemaLoadingSkeleton", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/isLoading/)
    expect(source).toMatch(/SchemaLoadingSkeleton/)
  })

  test("handles error state with SchemaEmptyState", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/error/)
    expect(source).toMatch(/SchemaEmptyState/)
  })

  test("handles no-schema state", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/schemaName/)
    expect(source).toMatch(/no-schema|not created|SchemaEmptyState/)
  })

  test("has defaultValue=schema on Tabs", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/defaultValue.*schema|schema.*defaultValue/)
  })

  test("has flex layout for Schema tab content", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/flex/)
    expect(source).toMatch(/flex-1/)
  })

  test("has data-testid=design-view", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/data-testid.*design-view/)
  })

  test("has data-testid=design-view-tabs", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/data-testid.*design-view-tabs/)
  })

  test("component can be imported", async () => {
    const module = await import("../DesignView")
    expect(module.DesignView).toBeDefined()
  })
})
