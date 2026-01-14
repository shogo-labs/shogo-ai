/**
 * Clean Break Verification Tests for task-2-2-001 and task-2-2-002
 *
 * Per design decision design-2-2-clean-break:
 * ALL Studio App components must be fresh in /components/app/
 * with ZERO imports from /components/Studio/
 *
 * This ensures the Session 2.2 workspace navigation is completely
 * independent of the legacy Studio components.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

/**
 * Helper to recursively get all TypeScript files in a directory
 */
function getTypeScriptFiles(dir: string, files: string[] = []): string[] {
  if (!fs.existsSync(dir)) return files

  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      getTypeScriptFiles(fullPath, files)
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(fullPath)
    }
  }
  return files
}

// ============================================================
// Test: App.tsx has no Studio imports (test-2-2-001-004)
// ============================================================

describe("test-2-2-001-004: Clean break - no Studio imports", () => {
  test("App.tsx has zero imports from '/components/Studio/'", async () => {
    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Check for any import from /components/Studio/
    const studioImportPattern = /from\s+['"][^'"]*\/components\/Studio\/[^'"]*['"]/g
    const matches = appSource.match(studioImportPattern)

    expect(matches).toBeNull()
  })

  test("App.tsx has zero imports from '@/components/Studio'", async () => {
    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Check for aliased imports from @/components/Studio
    const studioAliasPattern = /from\s+['"]@\/components\/Studio[^'"]*['"]/g
    const matches = appSource.match(studioAliasPattern)

    expect(matches).toBeNull()
  })

  test("App.tsx imports app components from @/components/app", async () => {
    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Should import AuthGate and AppShell from @/components/app
    expect(appSource).toMatch(/from\s+['"]@\/components\/app['"]/)
  })

  test("No /components/Studio references appear in component hierarchy", async () => {
    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Search for any reference to Studio components (not just imports)
    // After demo cleanup, there should be zero Studio references
    const studioReferences = appSource.match(/Studio[A-Z][a-zA-Z]*(?=\s*[</>])/g)

    expect(studioReferences).toBeNull()
  })
})

// ============================================================
// Additional verification: File does not import from Studio
// ============================================================

describe("Clean break file verification", () => {
  test("App.tsx file exists and is readable", () => {
    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const exists = fs.existsSync(appPath)
    expect(exists).toBe(true)
  })

  test("Import statements can be parsed from App.tsx", () => {
    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Extract all import statements
    const importPattern = /^import\s+.+\s+from\s+['"][^'"]+['"]/gm
    const imports = appSource.match(importPattern)

    expect(imports).not.toBeNull()
    expect(imports!.length).toBeGreaterThan(0)
  })
})

// ============================================================
// Test: Workspace hooks clean break (test-2-2-002-007)
// ============================================================

describe("test-2-2-002-007: Clean break - hooks created in /components/app/workspace/hooks/", () => {
  test("useWorkspaceNavigation.ts exists in /components/app/workspace/hooks/", () => {
    const hookPath = path.resolve(
      import.meta.dir,
      "../components/app/workspace/hooks/useWorkspaceNavigation.ts"
    )
    const exists = fs.existsSync(hookPath)
    expect(exists).toBe(true)
  })

  test("useWorkspaceData.ts exists in /components/app/workspace/hooks/", () => {
    const hookPath = path.resolve(
      import.meta.dir,
      "../components/app/workspace/hooks/useWorkspaceData.ts"
    )
    const exists = fs.existsSync(hookPath)
    expect(exists).toBe(true)
  })

  test("useWorkspaceNavigation.ts has zero imports from /components/Studio/", () => {
    const hookPath = path.resolve(
      import.meta.dir,
      "../components/app/workspace/hooks/useWorkspaceNavigation.ts"
    )
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Check for any import from /components/Studio/
    const studioImportPattern = /from\s+['"][^'"]*\/components\/Studio\/[^'"]*['"]/g
    const matches = hookSource.match(studioImportPattern)

    expect(matches).toBeNull()
  })

  test("useWorkspaceNavigation.ts has zero imports from '@/components/Studio'", () => {
    const hookPath = path.resolve(
      import.meta.dir,
      "../components/app/workspace/hooks/useWorkspaceNavigation.ts"
    )
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Check for aliased imports from @/components/Studio
    const studioAliasPattern = /from\s+['"]@\/components\/Studio[^'"]*['"]/g
    const matches = hookSource.match(studioAliasPattern)

    expect(matches).toBeNull()
  })

  test("useWorkspaceData.ts has zero imports from /components/Studio/", () => {
    const hookPath = path.resolve(
      import.meta.dir,
      "../components/app/workspace/hooks/useWorkspaceData.ts"
    )
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Check for any import from /components/Studio/
    const studioImportPattern = /from\s+['"][^'"]*\/components\/Studio\/[^'"]*['"]/g
    const matches = hookSource.match(studioImportPattern)

    expect(matches).toBeNull()
  })

  test("useWorkspaceData.ts has zero imports from '@/components/Studio'", () => {
    const hookPath = path.resolve(
      import.meta.dir,
      "../components/app/workspace/hooks/useWorkspaceData.ts"
    )
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Check for aliased imports from @/components/Studio
    const studioAliasPattern = /from\s+['"]@\/components\/Studio[^'"]*['"]/g
    const matches = hookSource.match(studioAliasPattern)

    expect(matches).toBeNull()
  })

  test("useWorkspaceData.ts uses useDomains() not custom context", () => {
    const hookPath = path.resolve(
      import.meta.dir,
      "../components/app/workspace/hooks/useWorkspaceData.ts"
    )
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Should use useDomains from DomainProvider
    expect(hookSource).toMatch(/useDomains/)
    expect(hookSource).toMatch(/from\s+['"].*DomainProvider['"]/)
  })

  test("All files in /components/app/workspace/ have zero Studio imports", () => {
    const workspaceDir = path.resolve(import.meta.dir, "../components/app/workspace")

    // Check if workspace directory exists
    if (!fs.existsSync(workspaceDir)) {
      // Workspace doesn't exist yet, pass test
      expect(true).toBe(true)
      return
    }

    // Get all TypeScript files in workspace directory
    const files = getTypeScriptFiles(workspaceDir)

    for (const file of files) {
      // Skip test files
      if (file.includes("__tests__")) continue

      const source = fs.readFileSync(file, "utf-8")

      // Check for any import from /components/Studio/
      const studioImportPattern = /from\s+['"][^'"]*\/components\/Studio\/[^'"]*['"]/g
      const directMatches = source.match(studioImportPattern)

      // Check for aliased imports from @/components/Studio
      const studioAliasPattern = /from\s+['"]@\/components\/Studio[^'"]*['"]/g
      const aliasMatches = source.match(studioAliasPattern)

      const relativePath = path.relative(workspaceDir, file)
      expect(directMatches).toBeNull()
      expect(aliasMatches).toBeNull()
    }
  })
})

// ============================================================
// Test: Barrel exports clean break (test-2-2-008-008)
// ============================================================

describe("test-2-2-008-008: Clean break - barrel only exports /app components", () => {
  test("workspace/index.ts has zero re-exports from /components/Studio/", () => {
    const barrelPath = path.resolve(
      import.meta.dir,
      "../components/app/workspace/index.ts"
    )
    const barrelSource = fs.readFileSync(barrelPath, "utf-8")

    // Check for any re-export from /components/Studio/
    const studioReexportPattern = /export\s+.*\s+from\s+['"][^'"]*\/components\/Studio\/[^'"]*['"]/g
    const directMatches = barrelSource.match(studioReexportPattern)

    // Check for aliased re-exports from @/components/Studio
    const studioAliasPattern = /export\s+.*\s+from\s+['"]@\/components\/Studio[^'"]*['"]/g
    const aliasMatches = barrelSource.match(studioAliasPattern)

    expect(directMatches).toBeNull()
    expect(aliasMatches).toBeNull()
  })

  test("app/index.ts has zero re-exports from /components/Studio/", () => {
    const barrelPath = path.resolve(
      import.meta.dir,
      "../components/app/index.ts"
    )
    const barrelSource = fs.readFileSync(barrelPath, "utf-8")

    // Check for any re-export from /components/Studio/
    const studioReexportPattern = /export\s+.*\s+from\s+['"][^'"]*\/components\/Studio\/[^'"]*['"]/g
    const directMatches = barrelSource.match(studioReexportPattern)

    // Check for aliased re-exports from @/components/Studio
    const studioAliasPattern = /export\s+.*\s+from\s+['"]@\/components\/Studio[^'"]*['"]/g
    const aliasMatches = barrelSource.match(studioAliasPattern)

    expect(directMatches).toBeNull()
    expect(aliasMatches).toBeNull()
  })

  test("workspace/index.ts only exports from /components/app/ subdirectories", () => {
    const barrelPath = path.resolve(
      import.meta.dir,
      "../components/app/workspace/index.ts"
    )
    const barrelSource = fs.readFileSync(barrelPath, "utf-8")

    // All exports should be from relative paths within workspace (./something)
    const exportLines = barrelSource
      .split("\n")
      .filter((line) => line.trim().startsWith("export"))

    for (const line of exportLines) {
      // Skip type-only exports without 'from'
      if (!line.includes("from")) continue

      // Extract the 'from' path
      const fromMatch = line.match(/from\s+["']([^"']+)["']/)
      if (fromMatch) {
        const importPath = fromMatch[1]

        // All imports should be relative (start with ./)
        expect(importPath.startsWith("./")).toBe(true)

        // Should not reference Studio anywhere
        expect(importPath.includes("Studio")).toBe(false)
      }
    }
  })

  test("sidebar/index.ts has zero re-exports from /components/Studio/", () => {
    const barrelPath = path.resolve(
      import.meta.dir,
      "../components/app/workspace/sidebar/index.ts"
    )
    const barrelSource = fs.readFileSync(barrelPath, "utf-8")

    // Check for actual imports/exports from Studio, not comments
    const studioImportPattern = /from\s+['"][^'"]*Studio[^'"]*['"]/g
    const matches = barrelSource.match(studioImportPattern)

    expect(matches).toBeNull()
  })

  test("dashboard/index.ts has zero re-exports from /components/Studio/", () => {
    const barrelPath = path.resolve(
      import.meta.dir,
      "../components/app/workspace/dashboard/index.ts"
    )
    const barrelSource = fs.readFileSync(barrelPath, "utf-8")

    // Check for actual imports/exports from Studio, not comments
    const studioImportPattern = /from\s+['"][^'"]*Studio[^'"]*['"]/g
    const matches = barrelSource.match(studioImportPattern)

    expect(matches).toBeNull()
  })

  test("hooks/index.ts has zero re-exports from /components/Studio/", () => {
    const barrelPath = path.resolve(
      import.meta.dir,
      "../components/app/workspace/hooks/index.ts"
    )
    const barrelSource = fs.readFileSync(barrelPath, "utf-8")

    // Check for actual imports/exports from Studio, not comments
    const studioImportPattern = /from\s+['"][^'"]*Studio[^'"]*['"]/g
    const matches = barrelSource.match(studioImportPattern)

    expect(matches).toBeNull()
  })
})
