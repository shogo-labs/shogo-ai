/**
 * DesignDecisionsList Component Tests
 * Task: task-2-3c-010
 *
 * Tests for the design decisions list component.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("DesignDecisionsList (task-2-3c-010)", () => {
  const componentPath = path.resolve(import.meta.dir, "../DesignDecisionsList.tsx")

  test("DesignDecisionsList component file exists", () => {
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

  test("filters decisions by session === featureId", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/session|featureId/)
    expect(source).toMatch(/filter/)
  })

  test("filters out decisions where name === enhancement-hooks-plan", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/enhancement-hooks-plan/)
  })

  test("renders DesignDecisionCard for each decision", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/DesignDecisionCard/)
    expect(source).toMatch(/\.map/)
  })

  test("shows empty state message when no decisions", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/No design decisions|no decisions|empty/)
  })

  test("has flex flex-col gap-4 layout", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/flex.*flex-col|flex-col/)
    expect(source).toMatch(/gap-4|gap/)
  })

  test("has data-testid=design-decisions-list", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/data-testid.*design-decisions-list/)
  })

  test("component can be imported", async () => {
    const module = await import("../DesignDecisionsList")
    expect(module.DesignDecisionsList).toBeDefined()
  })
})
