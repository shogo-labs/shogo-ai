/**
 * Test: template.copy MCP Tool
 *
 * Verifies that the template.copy tool correctly copies templates
 * with various options including force mode for non-empty directories.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "fs"
import { join } from "path"
import { executeTemplateCopy } from "../template.copy"
import { loadTemplates } from "../template.list"

const TEST_DIR = join(import.meta.dir, ".test-template-copy")
const TEST_PROJECT_NAME = "test-project"

describe("template.copy", () => {
  beforeAll(() => {
    // Clean up any previous test artifacts
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterAll(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    // Clean up project dir before each test
    const projectDir = join(TEST_DIR, TEST_PROJECT_NAME)
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test("should list available templates", () => {
    const templates = loadTemplates()
    expect(templates.length).toBeGreaterThan(0)

    // Verify ai-chat template exists
    const aiChat = templates.find((t) => t.name === "ai-chat")
    expect(aiChat).toBeDefined()
    expect(aiChat?.complexity).toBe("advanced")
  })

  test("should copy template to empty directory", async () => {
    const projectDir = join(TEST_DIR, TEST_PROJECT_NAME)

    const result = await executeTemplateCopy({
      template: "todo-app",
      name: TEST_PROJECT_NAME,
      output: projectDir,
      skipInstall: true, // Skip for faster tests
    })

    expect(result.ok).toBe(true)
    expect(result.projectDir).toBe(projectDir)
    expect(result.template?.name).toBe("todo-app")

    // Verify files were copied
    expect(existsSync(projectDir)).toBe(true)
    expect(existsSync(join(projectDir, "package.json"))).toBe(true)
    expect(existsSync(join(projectDir, "src"))).toBe(true)
    expect(existsSync(join(projectDir, "prisma", "schema.prisma"))).toBe(true)

    // Verify package.json was updated with project name
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8"))
    expect(pkg.name).toBe(TEST_PROJECT_NAME)

    // Verify template.json was NOT copied (excluded)
    expect(existsSync(join(projectDir, "template.json"))).toBe(false)
  })

  test("should fail when copying to non-empty directory without force", async () => {
    const projectDir = join(TEST_DIR, TEST_PROJECT_NAME)

    // Create a non-empty directory
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, "existing-file.txt"), "existing content")

    const result = await executeTemplateCopy({
      template: "todo-app",
      name: TEST_PROJECT_NAME,
      output: projectDir,
      skipInstall: true,
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("DIR_EXISTS")
    expect(result.error?.message).toContain("force: true")
  })

  test("should copy template to non-empty directory with force", async () => {
    const projectDir = join(TEST_DIR, TEST_PROJECT_NAME)

    // Create a non-empty directory with old src
    mkdirSync(join(projectDir, "src"), { recursive: true })
    writeFileSync(join(projectDir, "src", "old-file.tsx"), "old content")
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "old-project" }))

    const result = await executeTemplateCopy({
      template: "todo-app",
      name: TEST_PROJECT_NAME,
      output: projectDir,
      skipInstall: true,
      force: true,
    })

    expect(result.ok).toBe(true)
    expect(result.projectDir).toBe(projectDir)

    // Verify template files were copied
    expect(existsSync(join(projectDir, "package.json"))).toBe(true)
    expect(existsSync(join(projectDir, "src"))).toBe(true)

    // Verify old src files were removed
    expect(existsSync(join(projectDir, "src", "old-file.tsx"))).toBe(false)

    // Verify package.json was updated
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8"))
    expect(pkg.name).toBe(TEST_PROJECT_NAME)
    expect(pkg.dependencies).toBeDefined() // From template, not old empty object
  })

  test("should work with ai-chat template and force", async () => {
    const projectDir = join(TEST_DIR, TEST_PROJECT_NAME)

    // Create existing project structure
    mkdirSync(join(projectDir, "src", "routes"), { recursive: true })
    writeFileSync(join(projectDir, "src", "main.tsx"), "old main")
    writeFileSync(join(projectDir, "index.html"), "<html>old</html>")

    const result = await executeTemplateCopy({
      template: "ai-chat",
      name: TEST_PROJECT_NAME,
      output: projectDir,
      skipInstall: true,
      force: true,
    })

    expect(result.ok).toBe(true)
    expect(result.template?.name).toBe("ai-chat")

    // Verify ai-chat specific files
    expect(existsSync(join(projectDir, "src", "client.tsx"))).toBe(true)
    expect(existsSync(join(projectDir, "src", "router.tsx"))).toBe(true)
    expect(existsSync(join(projectDir, "src", "routes", "index.tsx"))).toBe(true)
    expect(existsSync(join(projectDir, "src", "utils"))).toBe(true)

    // Verify old files were replaced
    expect(existsSync(join(projectDir, "src", "main.tsx"))).toBe(false)
  })

  test("should return preview in dry run mode", async () => {
    const projectDir = join(TEST_DIR, TEST_PROJECT_NAME)

    const result = await executeTemplateCopy({
      template: "todo-app",
      name: TEST_PROJECT_NAME,
      output: projectDir,
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    expect(result.projectDir).toBe(projectDir)
    expect(result.files).toBeDefined()
    expect(result.files!.length).toBeGreaterThan(0)

    // Verify nothing was actually created
    expect(existsSync(projectDir)).toBe(false)
  })

  test("should return error for non-existent template", async () => {
    const projectDir = join(TEST_DIR, TEST_PROJECT_NAME)

    const result = await executeTemplateCopy({
      template: "non-existent-template",
      name: TEST_PROJECT_NAME,
      output: projectDir,
      skipInstall: true,
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("TEMPLATE_NOT_FOUND")
    expect(result.error?.message).toContain("non-existent-template")
  })

  test("should exclude node_modules and dev.db from copy", async () => {
    const projectDir = join(TEST_DIR, TEST_PROJECT_NAME)

    const result = await executeTemplateCopy({
      template: "todo-app",
      name: TEST_PROJECT_NAME,
      output: projectDir,
      skipInstall: true,
    })

    expect(result.ok).toBe(true)

    // These should NOT be copied even if they exist in template
    expect(result.files).toBeDefined()
    const fileList = result.files!.join(",")
    expect(fileList).not.toContain("node_modules")
    expect(fileList).not.toContain("bun.lock")
    expect(fileList).not.toContain("dev.db")
    expect(fileList).not.toContain("template.json")
  })
})
