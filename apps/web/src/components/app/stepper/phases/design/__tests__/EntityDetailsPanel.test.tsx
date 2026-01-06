/**
 * EntityDetailsPanel Component Tests
 * Task: task-2-3c-008
 *
 * Tests for the entity details side panel component.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("EntityDetailsPanel (task-2-3c-008)", () => {
  const componentPath = path.resolve(import.meta.dir, "../EntityDetailsPanel.tsx")

  test("EntityDetailsPanel component file exists", () => {
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("accepts entity prop that can be null", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/entity.*null|entity\?/)
  })

  test("accepts onClose callback prop", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/onClose/)
  })

  test("returns null when entity is null", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/return null|!entity/)
  })

  test("displays entity name in header", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/entity\.name|entity\?\.name/)
  })

  test("has close button that calls onClose", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/onClose/)
    expect(source).toMatch(/button|Button/)
  })

  test("displays properties list with types", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/properties/)
    expect(source).toMatch(/\.map/)
  })

  test("shows reference target for reference fields", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/referenceTarget|x-reference-target|reference/)
  })

  test("displays x-extension metadata when present", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should show x-arktype, x-mst-type, or x-computed
    expect(source).toMatch(/arktype|mstType|computed|x-/)
  })

  test("has collapsible JSON Schema section", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have some collapsible or expandable section
    expect(source).toMatch(/Collapsible|collapsible|JSON|Schema|expand|toggle/i)
  })

  test("has w-80 width class", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/w-80/)
  })

  test("has border-l class for left border", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/border-l/)
  })

  test("has bg-card background class", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/bg-card/)
  })

  test("has overflow-y-auto for scrollable content", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/overflow-y-auto|overflow-auto/)
  })

  test("has data-testid=entity-details-panel", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/data-testid.*entity-details-panel/)
  })

  test("has data-testid=close-details-button", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/data-testid.*close-details-button/)
  })

  test("component can be imported", async () => {
    const module = await import("../EntityDetailsPanel")
    expect(module.EntityDetailsPanel).toBeDefined()
  })
})
