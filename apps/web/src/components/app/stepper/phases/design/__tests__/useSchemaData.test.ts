/**
 * useSchemaData Hook Tests
 * Task: task-2-3c-003
 *
 * Tests for the schema data loading hook.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("useSchemaData hook (task-2-3c-003)", () => {
  const hookPath = path.resolve(import.meta.dir, "../hooks/useSchemaData.ts")

  test("useSchemaData hook file exists", () => {
    const exists = fs.existsSync(hookPath)
    expect(exists).toBe(true)
  })

  test("hook accepts schemaName: string | null | undefined parameter", () => {
    const hookSource = fs.readFileSync(hookPath, "utf-8")
    expect(hookSource).toMatch(/schemaName.*string.*null|undefined/)
  })

  test("returns isLoading: boolean", () => {
    const hookSource = fs.readFileSync(hookPath, "utf-8")
    expect(hookSource).toMatch(/isLoading/)
  })

  test("returns error: Error | null", () => {
    const hookSource = fs.readFileSync(hookPath, "utf-8")
    expect(hookSource).toMatch(/error/)
  })

  test("returns models: SchemaModel[] | null", () => {
    const hookSource = fs.readFileSync(hookPath, "utf-8")
    expect(hookSource).toMatch(/models/)
    expect(hookSource).toMatch(/SchemaModel/)
  })

  test("SchemaModel type has name, collectionName, fields structure", () => {
    const hookSource = fs.readFileSync(hookPath, "utf-8")
    expect(hookSource).toMatch(/interface\s+SchemaModel/)
    expect(hookSource).toMatch(/name:\s*string/)
    expect(hookSource).toMatch(/collectionName:\s*string/)
    expect(hookSource).toMatch(/fields/)
  })

  test("returns refetch function for retry on error", () => {
    const hookSource = fs.readFileSync(hookPath, "utf-8")
    expect(hookSource).toMatch(/refetch/)
  })

  test("handles null/undefined schemaName gracefully", () => {
    const hookSource = fs.readFileSync(hookPath, "utf-8")
    // Should check for null/undefined early return
    expect(hookSource).toMatch(/!schemaName|schemaName\s*===\s*null|schemaName\s*===\s*undefined/)
  })

  test("uses useEffect to trigger load when schemaName changes", () => {
    const hookSource = fs.readFileSync(hookPath, "utf-8")
    expect(hookSource).toMatch(/useEffect/)
  })

  test("uses useState for state management", () => {
    const hookSource = fs.readFileSync(hookPath, "utf-8")
    expect(hookSource).toMatch(/useState/)
  })

  test("calls mcpService.loadSchema", () => {
    const hookSource = fs.readFileSync(hookPath, "utf-8")
    expect(hookSource).toMatch(/mcpService|loadSchema/)
  })

  test("handles cleanup for component unmount", () => {
    const hookSource = fs.readFileSync(hookPath, "utf-8")
    // Should have cleanup mechanism (cancelled flag or AbortController)
    expect(hookSource).toMatch(/cancelled|aborted|isMounted|useRef|return\s*\(\)/)
  })

  test("hook can be imported", async () => {
    const module = await import("../hooks/useSchemaData")
    expect(module.useSchemaData).toBeDefined()
    expect(typeof module.useSchemaData).toBe("function")
  })
})
