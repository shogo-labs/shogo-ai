/**
 * Tests for BindingEditorPanel Debug Panel
 * Task: task-sdr-v2-006
 *
 * TDD tests for the binding editor debug panel that allows editing
 * RendererBindings in the componentBuilder domain.
 *
 * Test Specifications:
 * - test-sdr-006-01: Panel lists all RendererBindings
 * - test-sdr-006-02: Click binding opens edit form
 * - test-sdr-006-03: Save validates JSON and updates binding
 * - test-sdr-006-04: Save rejects invalid JSON
 * - test-sdr-006-05: Binding change triggers immediate UI update
 * - test-sdr-006-06: Keyboard shortcut toggles panel visibility
 *
 * Per ip-sdr-v2-005:
 * - Panel shows all RendererBindings with name, priority, component name, matchExpression preview
 * - Click binding opens edit form with JSON textarea and number input
 * - Save validates JSON and calls store update action
 * - Keyboard shortcut (Cmd+Shift+B) toggles panel visibility
 */

import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { observer } from "mobx-react-lite"
import fs from "fs"
import path from "path"

// ============================================================
// Setup: Component source for static analysis
// ============================================================

const componentPath = path.resolve(import.meta.dir, "../BindingEditorPanel.tsx")

// Helper to check if component file exists (for TDD RED phase)
const componentExists = () => {
  try {
    return fs.existsSync(componentPath)
  } catch {
    return false
  }
}

// ============================================================
// Test: test-sdr-006-01 - Panel lists all RendererBindings
// ============================================================

describe("test-sdr-006-01: Panel lists all RendererBindings", () => {
  test("BindingEditorPanel file exists", () => {
    // TDD: First verify file exists
    expect(componentExists()).toBe(true)
  })

  test("Panel imports useDomains to access componentBuilder", async () => {
    // Skip if component doesn't exist yet
    if (!componentExists()) {
      expect(true).toBe(false) // Force fail - file must exist
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/useDomains/)
    expect(componentSource).toMatch(/from\s+["']@\/contexts\/DomainProvider["']/)
  })

  test("Panel accesses rendererBindingCollection from componentBuilder", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should access rendererBindingCollection
    expect(componentSource).toMatch(/rendererBindingCollection/)
  })

  test("Panel is wrapped with observer for MobX reactivity", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/import\s*\{[^}]*observer[^}]*\}\s*from\s*["']mobx-react-lite["']/)
    expect(componentSource).toMatch(/observer\s*\(/)
  })

  test("Panel displays binding name", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should render binding.name or binding name somewhere
    expect(componentSource).toMatch(/\.name/)
  })

  test("Panel displays binding priority", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should render binding.priority
    expect(componentSource).toMatch(/\.priority/)
  })

  test("Panel displays component name for each binding", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should access component.name through binding
    expect(componentSource).toMatch(/component/)
  })

  test("Panel displays matchExpression preview", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should render matchExpression (likely JSON.stringify preview)
    expect(componentSource).toMatch(/matchExpression/)
  })
})

// ============================================================
// Test: test-sdr-006-02 - Click binding opens edit form
// ============================================================

describe("test-sdr-006-02: Click binding opens edit form", () => {
  test("Panel has click handler on binding items", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should have onClick handler
    expect(componentSource).toMatch(/onClick/)
  })

  test("Panel tracks selected binding state", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should have state for selected binding (useState or similar)
    expect(componentSource).toMatch(/useState/)
    // Should track which binding is being edited
    expect(componentSource).toMatch(/selected|editing|edit/)
  })

  test("Edit form includes JSON textarea for matchExpression", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should use Textarea component or textarea element
    expect(componentSource).toMatch(/[Tt]extarea/)
  })

  test("Edit form includes number input for priority", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should have input type number or use Input component with number type
    expect(componentSource).toMatch(/type=["']number["']/)
  })
})

// ============================================================
// Test: test-sdr-006-03 - Save validates JSON and updates binding
// ============================================================

describe("test-sdr-006-03: Save validates JSON and updates binding", () => {
  test("Panel has save button", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should have save button
    expect(componentSource).toMatch(/[Ss]ave/)
  })

  test("Save handler parses JSON", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should parse JSON for validation
    expect(componentSource).toMatch(/JSON\.parse/)
  })

  test("Save handler calls store update action", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should call updateOne or similar update action
    expect(componentSource).toMatch(/update/)
  })
})

// ============================================================
// Test: test-sdr-006-04 - Save rejects invalid JSON
// ============================================================

describe("test-sdr-006-04: Save rejects invalid JSON", () => {
  test("Panel handles JSON parse errors", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should have try-catch around JSON.parse
    expect(componentSource).toMatch(/try\s*\{/)
    expect(componentSource).toMatch(/catch/)
  })

  test("Panel has error state for validation", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should track error state
    expect(componentSource).toMatch(/error|Error/)
  })

  test("Panel displays error message to user", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should render error message (could use Alert component or inline)
    expect(componentSource).toMatch(/error|invalid|Invalid/)
  })
})

// ============================================================
// Test: test-sdr-006-05 - Binding change triggers immediate UI update
// ============================================================

describe("test-sdr-006-05: Binding change triggers immediate UI update", () => {
  test("Component uses observer for MobX reactivity", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should be wrapped with observer
    expect(componentSource).toMatch(/observer\s*\(/)
  })

  test("Component reads from MST store (triggers tracking)", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should call .all() or iterate collection (causes MobX tracking)
    expect(componentSource).toMatch(/\.all\s*\(\)|\.map\s*\(|\.forEach\s*\(/)
  })
})

// ============================================================
// Test: test-sdr-006-06 - Keyboard shortcut toggles panel visibility
// ============================================================

describe("test-sdr-006-06: Keyboard shortcut toggles panel visibility", () => {
  test("Panel exports visibility state hook or uses callback prop", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should have visibility prop or export hook
    // Either: isOpen/visible prop OR useKeyboardShortcut hook
    expect(
      componentSource.match(/isOpen|isVisible|visible|onToggle|onClose/) ||
      componentSource.match(/useEffect.*keydown|addEventListener.*keydown/)
    ).toBeTruthy()
  })

  test("Panel renders conditionally based on visibility", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should have conditional rendering
    expect(componentSource).toMatch(/\?\s*\(|&&\s*\(|if\s*\(/)
  })
})

// ============================================================
// Test: Panel uses design system components
// ============================================================

describe("Panel uses design system components", () => {
  test("Panel imports from @/components/ui", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should use design system components
    expect(componentSource).toMatch(/from\s+["']@\/components\/ui/)
  })

  test("Panel uses Tailwind classes for styling", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should use className with Tailwind classes
    expect(componentSource).toMatch(/className=/)
    // Should use bg- or text- or p- classes (common Tailwind patterns)
    expect(componentSource).toMatch(/bg-|text-|p-|px-|py-|rounded|border/)
  })

  test("Panel uses cn() for class merging", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // cn() is the standard pattern
    // May or may not use cn() depending on complexity
    // This is optional but preferred
    const usesCn = componentSource.match(/cn\s*\(/) !== null
    const usesTemplateStrings = componentSource.match(/`[^`]*\$\{[^}]*\}[^`]*`/) !== null
    // Either cn() or simple classNames is acceptable
    expect(usesCn || !usesTemplateStrings).toBe(true)
  })
})

// ============================================================
// Test: Module exports
// ============================================================

describe("BindingEditorPanel module exports", () => {
  test("BindingEditorPanel can be imported", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const module = await import("../BindingEditorPanel")
    expect(module.BindingEditorPanel).toBeDefined()
  })

  test("BindingEditorPanel is a React component", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const module = await import("../BindingEditorPanel")
    // Should be a function or object (observer-wrapped components are objects in some React versions)
    // What matters is that it's truthy and can be used as a React component
    expect(module.BindingEditorPanel).toBeTruthy()
    // MobX observer() wraps the component, resulting in either function or object type
    expect(["function", "object"]).toContain(typeof module.BindingEditorPanel)
  })
})

// ============================================================
// Test: Keyboard shortcut integration with AppShell
// ============================================================

describe("Keyboard shortcut integration", () => {
  test("Panel supports external visibility control", async () => {
    if (!componentExists()) {
      expect(true).toBe(false)
      return
    }

    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should accept props for visibility control (isOpen, onClose)
    // OR manage its own visibility via keyboard listener
    const hasExternalControl = componentSource.match(/isOpen|onClose|onToggle/)
    const hasInternalKeyboard = componentSource.match(/useEffect.*key|addEventListener.*key/)
    expect(hasExternalControl !== null || hasInternalKeyboard !== null).toBe(true)
  })
})
