/**
 * Unit Tests: template.ts
 *
 * Tests the template engine utilities:
 * - createTemplateEnvironment() - Nunjucks environment creation
 * - renderTemplate() - Template rendering with error handling
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { createTemplateEnvironment, renderTemplate } from "../template"
import { mkdir, writeFile, rm } from "fs/promises"
import { existsSync } from "fs"

describe("Template Utilities", () => {
  const TEST_TEMPLATES_DIR = ".test-templates"

  beforeAll(async () => {
    // Create test templates directory
    if (!existsSync(TEST_TEMPLATES_DIR)) {
      await mkdir(TEST_TEMPLATES_DIR, { recursive: true })
    }

    // Create test templates
    await writeFile(
      `${TEST_TEMPLATES_DIR}/simple.njk`,
      "Hello, {{ name }}!",
      "utf-8"
    )

    await writeFile(
      `${TEST_TEMPLATES_DIR}/with-html.njk`,
      "<h1>{{ title }}</h1><p>{{ content }}</p>",
      "utf-8"
    )

    await writeFile(
      `${TEST_TEMPLATES_DIR}/with-loop.njk`,
      "{% for item in items %}- {{ item }}\n{% endfor %}",
      "utf-8"
    )

    await writeFile(
      `${TEST_TEMPLATES_DIR}/malformed.njk`,
      "{% for item in items %} Missing endfor",
      "utf-8"
    )

    await writeFile(
      `${TEST_TEMPLATES_DIR}/with-xss.njk`,
      "Output: {{ userInput }}",
      "utf-8"
    )
  })

  afterAll(async () => {
    // Clean up test templates
    if (existsSync(TEST_TEMPLATES_DIR)) {
      await rm(TEST_TEMPLATES_DIR, { recursive: true })
    }
  })

  describe("createTemplateEnvironment()", () => {
    test("Creates environment with specified templates path", () => {
      const env = createTemplateEnvironment({ templatesPath: TEST_TEMPLATES_DIR })
      expect(env).toBeDefined()
    })

    test("Auto-escape is enabled by default", () => {
      const env = createTemplateEnvironment({ templatesPath: TEST_TEMPLATES_DIR })
      const result = renderTemplate(env, "with-xss.njk", {
        userInput: "<script>alert('xss')</script>"
      })
      expect(result).toContain("&lt;script&gt;")
      expect(result).not.toContain("<script>")
    })

    test("Auto-escape can be disabled", () => {
      const env = createTemplateEnvironment({
        templatesPath: TEST_TEMPLATES_DIR,
        autoescape: false
      })
      const result = renderTemplate(env, "with-xss.njk", {
        userInput: "<script>alert('xss')</script>"
      })
      expect(result).toContain("<script>")
    })

    test("Auto-escape can be explicitly enabled", () => {
      const env = createTemplateEnvironment({
        templatesPath: TEST_TEMPLATES_DIR,
        autoescape: true
      })
      const result = renderTemplate(env, "with-xss.njk", {
        userInput: "<b>bold</b>"
      })
      expect(result).toContain("&lt;b&gt;")
    })
  })

  describe("renderTemplate()", () => {
    let env: any

    beforeAll(() => {
      env = createTemplateEnvironment({ templatesPath: TEST_TEMPLATES_DIR })
    })

    test("Renders simple template with context", () => {
      const result = renderTemplate(env, "simple.njk", { name: "World" })
      expect(result).toBe("Hello, World!")
    })

    test("Renders template with HTML content", () => {
      const result = renderTemplate(env, "with-html.njk", {
        title: "Test Title",
        content: "Test content"
      })
      expect(result).toBe("<h1>Test Title</h1><p>Test content</p>")
    })

    test("Renders template with loop", () => {
      const result = renderTemplate(env, "with-loop.njk", {
        items: ["Apple", "Banana", "Cherry"]
      })
      expect(result).toBe("- Apple\n- Banana\n- Cherry\n")
    })

    test("Handles empty context", () => {
      const result = renderTemplate(env, "simple.njk", {})
      expect(result).toBe("Hello, !")
    })

    test("Error: Template not found wraps error message", () => {
      expect(() => {
        renderTemplate(env, "nonexistent.njk", {})
      }).toThrow(/Template rendering failed.*template not found/)
    })

    test("Error: Malformed template syntax wraps error message", () => {
      expect(() => {
        renderTemplate(env, "malformed.njk", { items: [1, 2, 3] })
      }).toThrow(/Template rendering failed/)
    })

    test("Error wrapping preserves error type for inspection", () => {
      try {
        renderTemplate(env, "nonexistent.njk", {})
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain("Template rendering failed")
      }
    })
  })

  describe("Template Environment Isolation", () => {
    test("Different environments use different template paths", async () => {
      const TEST_DIR_A = ".test-templates-a"
      const TEST_DIR_B = ".test-templates-b"

      try {
        await mkdir(TEST_DIR_A, { recursive: true })
        await mkdir(TEST_DIR_B, { recursive: true })

        await writeFile(`${TEST_DIR_A}/test.njk`, "From A", "utf-8")
        await writeFile(`${TEST_DIR_B}/test.njk`, "From B", "utf-8")

        const envA = createTemplateEnvironment({ templatesPath: TEST_DIR_A })
        const envB = createTemplateEnvironment({ templatesPath: TEST_DIR_B })

        const resultA = renderTemplate(envA, "test.njk", {})
        const resultB = renderTemplate(envB, "test.njk", {})

        expect(resultA).toBe("From A")
        expect(resultB).toBe("From B")
      } finally {
        if (existsSync(TEST_DIR_A)) await rm(TEST_DIR_A, { recursive: true })
        if (existsSync(TEST_DIR_B)) await rm(TEST_DIR_B, { recursive: true })
      }
    })
  })

  describe("Edge Cases", () => {
    let env: any

    beforeAll(() => {
      env = createTemplateEnvironment({ templatesPath: TEST_TEMPLATES_DIR })
    })

    test("Handles undefined values in context", () => {
      const result = renderTemplate(env, "simple.njk", { name: undefined })
      expect(result).toBe("Hello, !")
    })

    test("Handles null values in context", () => {
      const result = renderTemplate(env, "simple.njk", { name: null })
      expect(result).toBe("Hello, !")
    })

    test("Handles numeric values in context", () => {
      const result = renderTemplate(env, "simple.njk", { name: 42 })
      expect(result).toBe("Hello, 42!")
    })

    test("Handles boolean values in context", () => {
      const result = renderTemplate(env, "simple.njk", { name: true })
      expect(result).toBe("Hello, true!")
    })

    test("Handles empty array in loop", () => {
      const result = renderTemplate(env, "with-loop.njk", { items: [] })
      expect(result).toBe("")
    })
  })
})
