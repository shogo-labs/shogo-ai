/**
 * Generated from TestSpecifications for task-2-1-002
 * Tests: Theme initialization in main.tsx before React render
 */

import { describe, test, expect } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"

// Read the main.tsx file content for testing
const mainTsxPath = resolve(__dirname, "../main.tsx")
const mainTsxContent = readFileSync(mainTsxPath, "utf-8")

describe("Theme initialization in main.tsx", () => {
  test("main.tsx contains theme initialization code", () => {
    // Should have some form of theme initialization
    expect(mainTsxContent).toMatch(/theme/i)
  })

  test("theme initialization runs before ReactDOM.createRoot", () => {
    // Find the position of theme-related code and createRoot call (not import)
    const themeInitMatch = mainTsxContent.match(/localStorage.*theme|theme.*localStorage/i)
    // Match createRoot( which is the actual call, not the import
    const createRootCallIndex = mainTsxContent.indexOf("createRoot(document")

    expect(themeInitMatch).not.toBeNull()
    expect(createRootCallIndex).toBeGreaterThan(-1)

    // Theme init should come before createRoot call in the file
    const themeInitIndex = mainTsxContent.indexOf(themeInitMatch![0])

    expect(themeInitIndex).toBeLessThan(createRootCallIndex)
  })

  test("reads theme from localStorage", () => {
    expect(mainTsxContent).toMatch(/localStorage\.getItem\s*\(\s*['"]theme['"]\s*\)/)
  })

  test("defaults to dark when no localStorage value exists", () => {
    // Should have fallback to 'dark' theme
    expect(mainTsxContent).toMatch(/['"]dark['"]/)
    // Should check for null/undefined and default to dark
    expect(mainTsxContent).toMatch(/\|\|\s*['"]dark['"]|\?\?\s*['"]dark['"]|===\s*['"]dark['"]/)
  })

  test("applies dark class to document.documentElement", () => {
    expect(mainTsxContent).toMatch(/document\.documentElement/)
    expect(mainTsxContent).toMatch(/classList/)
    expect(mainTsxContent).toMatch(/dark/)
  })

  test("theme initialization is synchronous (not in useEffect or async)", () => {
    // Theme init code should NOT be inside useEffect
    // It should be at the top level before React renders
    const lines = mainTsxContent.split("\n")
    let foundThemeInit = false
    let insideUseEffect = false
    let useEffectDepth = 0

    for (const line of lines) {
      if (line.includes("useEffect")) {
        insideUseEffect = true
        useEffectDepth = 1
      }
      if (insideUseEffect) {
        useEffectDepth += (line.match(/\{/g) || []).length
        useEffectDepth -= (line.match(/\}/g) || []).length
        if (useEffectDepth <= 0) {
          insideUseEffect = false
        }
      }

      // Check if theme init is outside useEffect
      if (
        line.includes("localStorage") &&
        line.includes("theme") &&
        !insideUseEffect
      ) {
        foundThemeInit = true
        break
      }
    }

    expect(foundThemeInit).toBe(true)
  })
})

describe("No flash of wrong theme", () => {
  test("theme class is applied synchronously before React mounts", () => {
    // The pattern should be:
    // 1. Read theme from localStorage
    // 2. Apply class to document.documentElement
    // 3. THEN call createRoot and render

    // Check the order of operations
    const content = mainTsxContent

    // Should have this pattern before createRoot call (not import)
    const documentElementIndex = content.indexOf("documentElement")
    const createRootCallIndex = content.indexOf("createRoot(document")

    expect(documentElementIndex).toBeGreaterThan(-1)
    expect(createRootCallIndex).toBeGreaterThan(-1)
    expect(documentElementIndex).toBeLessThan(createRootCallIndex)
  })
})
