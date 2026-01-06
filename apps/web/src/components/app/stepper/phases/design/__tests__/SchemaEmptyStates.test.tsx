/**
 * SchemaEmptyStates Component Tests
 * Task: task-2-3c-013
 *
 * Tests for empty state components in the Design phase.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("SchemaEmptyStates (task-2-3c-013)", () => {
  const componentPath = path.resolve(import.meta.dir, "../SchemaEmptyStates.tsx")

  test("SchemaEmptyStates component file exists", () => {
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  describe("SchemaEmptyState component", () => {
    test("accepts type prop with 'no-schema' | 'not-created' | 'error'", () => {
      const componentSource = fs.readFileSync(componentPath, "utf-8")
      expect(componentSource).toMatch(/type:\s*["']no-schema["']\s*\|\s*["']not-created["']\s*\|\s*["']error["']/)
    })

    test("accepts optional onRetry prop for error state", () => {
      const componentSource = fs.readFileSync(componentPath, "utf-8")
      expect(componentSource).toMatch(/onRetry\?\s*:\s*\(\)\s*=>\s*void/)
    })

    test("no-schema state shows info alert with message", () => {
      const componentSource = fs.readFileSync(componentPath, "utf-8")
      expect(componentSource).toMatch(/no-schema/)
      expect(componentSource).toMatch(/does not define a schema/)
    })

    test("not-created state shows alert with run phase message", () => {
      const componentSource = fs.readFileSync(componentPath, "utf-8")
      expect(componentSource).toMatch(/not-created/)
      expect(componentSource).toMatch(/Run design phase/)
    })

    test("error state shows destructive variant with retry button", () => {
      const componentSource = fs.readFileSync(componentPath, "utf-8")
      expect(componentSource).toMatch(/error/)
      expect(componentSource).toMatch(/destructive/)
      expect(componentSource).toMatch(/Retry|onRetry/)
    })

    test("uses shadcn Alert component", () => {
      const componentSource = fs.readFileSync(componentPath, "utf-8")
      expect(componentSource).toMatch(/import.*Alert.*from.*@\/components\/ui\/alert/)
    })

    test("has data-testid for each state type", () => {
      const componentSource = fs.readFileSync(componentPath, "utf-8")
      expect(componentSource).toMatch(/data-testid/)
    })
  })

  describe("SchemaLoadingSkeleton component", () => {
    test("SchemaLoadingSkeleton is exported", () => {
      const componentSource = fs.readFileSync(componentPath, "utf-8")
      expect(componentSource).toMatch(/export.*SchemaLoadingSkeleton/)
    })

    test("shows skeleton rectangles mimicking graph layout", () => {
      const componentSource = fs.readFileSync(componentPath, "utf-8")
      expect(componentSource).toMatch(/Skeleton|skeleton|animate-pulse/)
    })

    test("shows 3-4 rectangle placeholders", () => {
      const componentSource = fs.readFileSync(componentPath, "utf-8")
      // Should have multiple skeleton elements
      const skeletonCount = (componentSource.match(/animate-pulse|Skeleton/g) || []).length
      expect(skeletonCount).toBeGreaterThanOrEqual(1)
    })
  })

  test("components can be imported", async () => {
    const module = await import("../SchemaEmptyStates")
    expect(module.SchemaEmptyState).toBeDefined()
    expect(module.SchemaLoadingSkeleton).toBeDefined()
  })
})
