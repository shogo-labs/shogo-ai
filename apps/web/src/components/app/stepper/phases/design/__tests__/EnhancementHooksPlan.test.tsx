/**
 * EnhancementHooksPlan Component Tests
 * Task: task-2-3c-011
 *
 * Tests for the enhancement hooks plan display component.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("EnhancementHooksPlan (task-2-3c-011)", () => {
  const componentPath = path.resolve(import.meta.dir, "../EnhancementHooksPlan.tsx")

  test("EnhancementHooksPlan component file exists", () => {
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("accepts featureId prop", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/featureId.*string/)
  })

  test("wrapped with observer() from mobx-react-lite", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*observer.*from.*mobx-react-lite/)
    expect(source).toMatch(/observer\(/)
  })

  test("uses useDomains() to access platformFeatures store", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/useDomains/)
    expect(source).toMatch(/platformFeatures/)
  })

  test("queries designDecisionCollection", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/designDecisionCollection/)
  })

  test("filters for name === enhancement-hooks-plan", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/enhancement-hooks-plan/)
  })

  test("filters by session === featureId", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/session/)
    expect(source).toMatch(/featureId/)
  })

  test("displays decision.decision field as main content", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should reference decision.decision for main content
    expect(source).toMatch(/decision\.decision|hooksPlan\.decision/)
  })

  test("displays decision.rationale field as explanation", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should reference rationale for explanation
    expect(source).toMatch(/rationale/)
  })

  test("shows empty state when not found", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/No enhancement hooks plan|no enhancement|not defined/)
  })

  test("uses shadcn Card component", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/Card/)
    expect(source).toMatch(/@\/components\/ui\/card/)
  })

  test("has data-testid=enhancement-hooks-plan", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/data-testid.*enhancement-hooks-plan/)
  })

  test("component can be imported", async () => {
    const module = await import("../EnhancementHooksPlan")
    expect(module.EnhancementHooksPlan).toBeDefined()
  })
})
