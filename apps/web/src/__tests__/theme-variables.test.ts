/**
 * Generated from TestSpecifications for task-2-1-002
 * Tests: CSS theme variables for light and dark modes
 */

import { describe, test, expect } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"

// Read the CSS file content for testing
const indexCssPath = resolve(__dirname, "../index.css")
const cssContent = readFileSync(indexCssPath, "utf-8")

describe("CSS theme variables", () => {
  describe("light theme variables (:root)", () => {
    test("index.css contains :root block with light theme variables", () => {
      // Check for :root block - looking for CSS custom properties pattern
      expect(cssContent).toMatch(/:root\s*\{/)
    })

    test(":root contains --background variable", () => {
      // Match :root block and check for --background
      const rootBlockMatch = cssContent.match(/:root\s*\{[^}]+\}/)
      expect(rootBlockMatch).not.toBeNull()
      expect(rootBlockMatch![0]).toMatch(/--background\s*:/)
    })

    test(":root contains --foreground variable", () => {
      const rootBlockMatch = cssContent.match(/:root\s*\{[^}]+\}/)
      expect(rootBlockMatch).not.toBeNull()
      expect(rootBlockMatch![0]).toMatch(/--foreground\s*:/)
    })

    test(":root contains --primary variable", () => {
      const rootBlockMatch = cssContent.match(/:root\s*\{[^}]+\}/)
      expect(rootBlockMatch).not.toBeNull()
      expect(rootBlockMatch![0]).toMatch(/--primary\s*:/)
    })

    test(":root contains --muted variable", () => {
      const rootBlockMatch = cssContent.match(/:root\s*\{[^}]+\}/)
      expect(rootBlockMatch).not.toBeNull()
      expect(rootBlockMatch![0]).toMatch(/--muted\s*:/)
    })

    test(":root contains --card variable", () => {
      const rootBlockMatch = cssContent.match(/:root\s*\{[^}]+\}/)
      expect(rootBlockMatch).not.toBeNull()
      expect(rootBlockMatch![0]).toMatch(/--card\s*:/)
    })

    test(":root contains --secondary variable", () => {
      const rootBlockMatch = cssContent.match(/:root\s*\{[^}]+\}/)
      expect(rootBlockMatch).not.toBeNull()
      expect(rootBlockMatch![0]).toMatch(/--secondary\s*:/)
    })

    test(":root contains --border variable", () => {
      const rootBlockMatch = cssContent.match(/:root\s*\{[^}]+\}/)
      expect(rootBlockMatch).not.toBeNull()
      expect(rootBlockMatch![0]).toMatch(/--border\s*:/)
    })

    test(":root contains --ring variable", () => {
      const rootBlockMatch = cssContent.match(/:root\s*\{[^}]+\}/)
      expect(rootBlockMatch).not.toBeNull()
      expect(rootBlockMatch![0]).toMatch(/--ring\s*:/)
    })
  })

  describe("dark theme variables (.dark)", () => {
    test("index.css contains .dark block with dark theme variables", () => {
      // Check for .dark block
      expect(cssContent).toMatch(/\.dark\s*\{/)
    })

    test(".dark contains --background variable with dark value", () => {
      const darkBlockMatch = cssContent.match(/\.dark\s*\{[^}]+\}/)
      expect(darkBlockMatch).not.toBeNull()
      expect(darkBlockMatch![0]).toMatch(/--background\s*:/)
    })

    test(".dark contains --foreground variable with dark value", () => {
      const darkBlockMatch = cssContent.match(/\.dark\s*\{[^}]+\}/)
      expect(darkBlockMatch).not.toBeNull()
      expect(darkBlockMatch![0]).toMatch(/--foreground\s*:/)
    })

    test(".dark block overrides :root values", () => {
      // Both blocks should exist with same variable names but different values
      const rootBlockMatch = cssContent.match(/:root\s*\{[^}]+\}/)
      const darkBlockMatch = cssContent.match(/\.dark\s*\{[^}]+\}/)

      expect(rootBlockMatch).not.toBeNull()
      expect(darkBlockMatch).not.toBeNull()

      // Both should have --background
      expect(rootBlockMatch![0]).toMatch(/--background\s*:/)
      expect(darkBlockMatch![0]).toMatch(/--background\s*:/)

      // Extract background values - they should be different
      const rootBg = rootBlockMatch![0].match(/--background\s*:\s*([^;]+)/)
      const darkBg = darkBlockMatch![0].match(/--background\s*:\s*([^;]+)/)

      expect(rootBg).not.toBeNull()
      expect(darkBg).not.toBeNull()
      expect(rootBg![1].trim()).not.toBe(darkBg![1].trim())
    })
  })

  describe("shadcn variable naming convention", () => {
    test("uses shadcn naming pattern without --color- prefix in :root and .dark blocks", () => {
      // Standard shadcn uses --background, not --color-background in the :root/.dark blocks
      const rootBlockMatch = cssContent.match(/:root\s*\{[^}]+\}/)
      expect(rootBlockMatch).not.toBeNull()

      // Should have --background, --foreground etc. (shadcn pattern)
      expect(rootBlockMatch![0]).toMatch(/--background\s*:/)
      expect(rootBlockMatch![0]).toMatch(/--foreground\s*:/)
      expect(rootBlockMatch![0]).toMatch(/--primary\s*:/)
      expect(rootBlockMatch![0]).toMatch(/--muted\s*:/)
    })
  })
})
