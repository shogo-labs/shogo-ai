/**
 * CSS Animations and Tokens Test
 * Task: task-chat-001
 *
 * Tests that the required CSS animations, color tokens, and utility classes
 * are defined in index.css for the chat panel UX redesign.
 */

import { describe, test, expect, beforeAll } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

describe("task-chat-001: CSS Animations and Tokens", () => {
  let cssContent: string

  beforeAll(() => {
    const cssPath = join(__dirname, "../index.css")
    cssContent = readFileSync(cssPath, "utf-8")
  })

  describe("Keyframe Animations", () => {
    test("fade-in-chunk keyframe animation is defined with correct timing", () => {
      // @keyframes fade-in-chunk should exist
      expect(cssContent).toContain("@keyframes fade-in-chunk")
      // Animation should transition opacity from 0.3 to 1
      expect(cssContent).toMatch(/fade-in-chunk[\s\S]*?from[\s\S]*?opacity:\s*0\.3/)
      expect(cssContent).toMatch(/fade-in-chunk[\s\S]*?to[\s\S]*?opacity:\s*1/)
    })

    test("cursor-blink keyframe animation is defined with correct cycle", () => {
      // @keyframes cursor-blink should exist
      expect(cssContent).toContain("@keyframes cursor-blink")
      // Animation should cycle opacity for blinking effect
      expect(cssContent).toMatch(/cursor-blink[\s\S]*?opacity/)
    })

    test("panel-slide keyframe animation is defined for panel transitions", () => {
      // @keyframes panel-slide or equivalent transition should exist
      // We may use CSS transitions instead, so check for either
      const hasPanelSlide = cssContent.includes("@keyframes panel-slide")
      const hasPanelTransition = cssContent.includes(".panel-transition") ||
                                  cssContent.includes("transition") && cssContent.includes("300ms")
      expect(hasPanelSlide || hasPanelTransition).toBe(true)
    })
  })

  describe("Tool Category Color Tokens", () => {
    test("--tool-mcp is defined with purple color", () => {
      expect(cssContent).toMatch(/--tool-mcp:\s*#8B5CF6/i)
    })

    test("--tool-file is defined with emerald color", () => {
      expect(cssContent).toMatch(/--tool-file:\s*#10B981/i)
    })

    test("--tool-skill is defined with amber color", () => {
      expect(cssContent).toMatch(/--tool-skill:\s*#F59E0B/i)
    })

    test("--tool-bash is defined with gray color", () => {
      expect(cssContent).toMatch(/--tool-bash:\s*#6B7280/i)
    })
  })

  describe("Execution State Color Tokens", () => {
    test("--exec-streaming is defined with blue color", () => {
      expect(cssContent).toMatch(/--exec-streaming:\s*#3B82F6/i)
    })

    test("--exec-success is defined with green color", () => {
      expect(cssContent).toMatch(/--exec-success:\s*#22C55E/i)
    })

    test("--exec-error is defined with red color", () => {
      expect(cssContent).toMatch(/--exec-error:\s*#EF4444/i)
    })
  })

  describe("Utility Classes", () => {
    test(".animate-fade-in-chunk class applies fade-in-chunk animation", () => {
      expect(cssContent).toMatch(/\.animate-fade-in-chunk[\s\S]*?animation[\s\S]*?fade-in-chunk/)
    })

    test(".cursor-blink class applies cursor-blink animation", () => {
      expect(cssContent).toMatch(/\.cursor-blink[\s\S]*?animation[\s\S]*?cursor-blink/)
    })
  })

  describe("Reduced Motion Support", () => {
    test("@media (prefers-reduced-motion: reduce) disables animations", () => {
      expect(cssContent).toContain("@media (prefers-reduced-motion: reduce)")
      // Check that new animations are disabled in reduced motion
      expect(cssContent).toMatch(/prefers-reduced-motion: reduce[\s\S]*?animation:\s*none/i)
    })
  })
})
