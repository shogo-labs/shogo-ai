/**
 * DesignDecisionCard Component Tests
 * Task: task-2-3c-009
 *
 * Tests for the design decision card component.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("DesignDecisionCard (task-2-3c-009)", () => {
  const componentPath = path.resolve(import.meta.dir, "../DesignDecisionCard.tsx")

  test("DesignDecisionCard component file exists", () => {
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("exports DesignDecision type with required fields", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Type should have id, name, question, decision, rationale
    expect(componentSource).toMatch(/interface\s+DesignDecision/)
    expect(componentSource).toMatch(/id:\s*string/)
    expect(componentSource).toMatch(/name:\s*string/)
    expect(componentSource).toMatch(/question:\s*string/)
    expect(componentSource).toMatch(/decision:\s*string/)
    expect(componentSource).toMatch(/rationale:\s*string/)
  })

  test("uses shadcn Card with CardHeader and CardContent", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/import.*Card.*CardHeader.*CardContent.*from.*@\/components\/ui\/card/)
    expect(componentSource).toMatch(/<Card/)
    expect(componentSource).toMatch(/<CardHeader/)
    expect(componentSource).toMatch(/<CardContent/)
  })

  test("CardHeader shows decision.name as title", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/decision\.name/)
    expect(componentSource).toMatch(/<CardTitle/)
  })

  test("shows decision.question in text-muted-foreground italic", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/decision\.question/)
    expect(componentSource).toMatch(/text-muted-foreground/)
    expect(componentSource).toMatch(/italic/)
  })

  test("shows decision.decision as main content", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should render decision.decision text
    expect(componentSource).toMatch(/decision\.decision/)
  })

  test("shows decision.rationale in smaller text", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/decision\.rationale/)
    expect(componentSource).toMatch(/text-sm/)
  })

  test("has correct data-testid attribute", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/data-testid=.*design-decision-card-/)
  })

  test("component can be imported", async () => {
    const module = await import("../DesignDecisionCard")
    expect(module.DesignDecisionCard).toBeDefined()
    expect(typeof module.DesignDecisionCard).toBe("function")
  })
})
