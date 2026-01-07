/**
 * Design Tokens CSS Test
 * Task: task-w1-design-tokens
 *
 * Tests verify:
 * 1. Phase color tokens exist for all 8 phases
 * 2. Semantic status color tokens exist
 * 3. Dark mode variants are defined
 * 4. Tokens are imported in main styles entry point
 */

import { describe, test, expect } from "bun:test"
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"

// Read the CSS file content for testing
const indexCssPath = resolve(__dirname, "../index.css")
const cssContent = readFileSync(indexCssPath, "utf-8")

describe("Design Tokens - Phase Colors", () => {
  describe("Phase color tokens in :root", () => {
    test("index.css contains --phase-discovery CSS custom property", () => {
      expect(cssContent).toMatch(/--phase-discovery\s*:/)
    })

    test("index.css contains --phase-analysis CSS custom property", () => {
      expect(cssContent).toMatch(/--phase-analysis\s*:/)
    })

    test("index.css contains --phase-classification CSS custom property", () => {
      expect(cssContent).toMatch(/--phase-classification\s*:/)
    })

    test("index.css contains --phase-design CSS custom property", () => {
      expect(cssContent).toMatch(/--phase-design\s*:/)
    })

    test("index.css contains --phase-spec CSS custom property", () => {
      expect(cssContent).toMatch(/--phase-spec\s*:/)
    })

    test("index.css contains --phase-testing CSS custom property", () => {
      expect(cssContent).toMatch(/--phase-testing\s*:/)
    })

    test("index.css contains --phase-implementation CSS custom property", () => {
      expect(cssContent).toMatch(/--phase-implementation\s*:/)
    })

    test("index.css contains --phase-complete CSS custom property", () => {
      expect(cssContent).toMatch(/--phase-complete\s*:/)
    })
  })
})

describe("Design Tokens - Semantic Status Colors", () => {
  test("index.css contains --status-pending CSS custom property", () => {
    expect(cssContent).toMatch(/--status-pending\s*:/)
  })

  test("index.css contains --status-active CSS custom property", () => {
    expect(cssContent).toMatch(/--status-active\s*:/)
  })

  test("index.css contains --status-success CSS custom property", () => {
    expect(cssContent).toMatch(/--status-success\s*:/)
  })

  test("index.css contains --status-error CSS custom property", () => {
    expect(cssContent).toMatch(/--status-error\s*:/)
  })

  test("index.css contains --status-warning CSS custom property", () => {
    expect(cssContent).toMatch(/--status-warning\s*:/)
  })
})

describe("Design Tokens - Dark Mode Variants", () => {
  test(".dark block contains phase color overrides", () => {
    const darkBlockMatch = cssContent.match(/\.dark\s*\{[\s\S]*?\n\}/)
    expect(darkBlockMatch).not.toBeNull()
    // Dark mode should have phase color overrides
    expect(darkBlockMatch![0]).toMatch(/--phase-discovery\s*:/)
  })

  test(".dark block contains status color overrides", () => {
    const darkBlockMatch = cssContent.match(/\.dark\s*\{[\s\S]*?\n\}/)
    expect(darkBlockMatch).not.toBeNull()
    // Dark mode should have status color overrides
    expect(darkBlockMatch![0]).toMatch(/--status-success\s*:/)
  })

  test("dark mode phase colors differ from light mode", () => {
    // Extract :root phase-discovery value
    const rootMatch = cssContent.match(/:root\s*\{[\s\S]*?\n\}/)
    const darkMatch = cssContent.match(/\.dark\s*\{[\s\S]*?\n\}/)

    expect(rootMatch).not.toBeNull()
    expect(darkMatch).not.toBeNull()

    const rootDiscovery = rootMatch![0].match(/--phase-discovery\s*:\s*([^;]+)/)
    const darkDiscovery = darkMatch![0].match(/--phase-discovery\s*:\s*([^;]+)/)

    expect(rootDiscovery).not.toBeNull()
    expect(darkDiscovery).not.toBeNull()
    // Values should be different for dark mode
    expect(rootDiscovery![1].trim()).not.toBe(darkDiscovery![1].trim())
  })
})

describe("Design Tokens - Tailwind Theme Integration", () => {
  test("@theme block maps phase colors to Tailwind utilities", () => {
    const themeBlockMatch = cssContent.match(/@theme\s*\{[\s\S]*?\n\}/)
    expect(themeBlockMatch).not.toBeNull()
    // Should map --color-phase-discovery to var(--phase-discovery)
    expect(themeBlockMatch![0]).toMatch(/--color-phase-discovery\s*:\s*var\(--phase-discovery\)/)
  })

  test("@theme block maps status colors to Tailwind utilities", () => {
    const themeBlockMatch = cssContent.match(/@theme\s*\{[\s\S]*?\n\}/)
    expect(themeBlockMatch).not.toBeNull()
    // Should map --color-status-success to var(--status-success)
    expect(themeBlockMatch![0]).toMatch(/--color-status-success\s*:\s*var\(--status-success\)/)
  })
})
