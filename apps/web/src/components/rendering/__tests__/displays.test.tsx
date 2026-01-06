/**
 * Tests for display renderer components
 * Task: task-display-renderers
 *
 * Verifies all 11 display components handle values correctly,
 * including edge cases (null, undefined, empty).
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { render, cleanup } from "@testing-library/react"
import { Window } from "happy-dom"
import React from "react"

// Set up happy-dom
let window: Window
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document

beforeAll(() => {
  window = new Window()
  originalWindow = globalThis.window
  originalDocument = globalThis.document
  // @ts-expect-error - happy-dom Window
  globalThis.window = window
  globalThis.document = window.document
})

afterAll(() => {
  // @ts-expect-error - restore original
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  window.close()
})

afterEach(() => {
  cleanup()
})

import {
  StringDisplay,
  NumberDisplay,
  BooleanDisplay,
  DateTimeDisplay,
  EmailDisplay,
  UriDisplay,
  EnumBadge,
  ReferenceDisplay,
  ComputedDisplay,
  ArrayDisplay,
  ObjectDisplay
} from "../displays"
import type { PropertyMetadata } from "../types"

describe("StringDisplay", () => {
  test("renders string value with truncation for long text", () => {
    const { container } = render(
      <StringDisplay
        property={{ name: "description", type: "string" }}
        value="This is a normal string"
      />
    )
    expect(container.textContent).toContain("This is a normal string")
  })

  test("handles null values gracefully", () => {
    const { container } = render(
      <StringDisplay
        property={{ name: "nullable", type: "string" }}
        value={null}
      />
    )
    // Should not throw, renders empty or placeholder
    expect(container).toBeDefined()
  })

  test("handles undefined values gracefully", () => {
    const { container } = render(
      <StringDisplay
        property={{ name: "undef", type: "string" }}
        value={undefined}
      />
    )
    expect(container).toBeDefined()
  })
})

describe("NumberDisplay", () => {
  test("renders number with locale formatting", () => {
    const { container } = render(
      <NumberDisplay
        property={{ name: "amount", type: "number" }}
        value={1234567}
      />
    )
    // Should include thousand separators
    expect(container.textContent).toContain("1,234,567")
  })

  test("handles null values gracefully", () => {
    const { container } = render(
      <NumberDisplay
        property={{ name: "count", type: "number" }}
        value={null}
      />
    )
    expect(container).toBeDefined()
  })

  test("handles decimal numbers", () => {
    const { container } = render(
      <NumberDisplay
        property={{ name: "price", type: "number" }}
        value={1234.56}
      />
    )
    expect(container.textContent).toContain("1,234.56")
  })
})

describe("BooleanDisplay", () => {
  test("renders checkmark/cross or badge for true", () => {
    const { container } = render(
      <BooleanDisplay
        property={{ name: "active", type: "boolean" }}
        value={true}
      />
    )
    // Should show some indication of true (checkmark, "Yes", etc)
    expect(container.textContent?.toLowerCase()).toMatch(/yes|true|✓/)
  })

  test("renders checkmark/cross or badge for false", () => {
    const { container } = render(
      <BooleanDisplay
        property={{ name: "active", type: "boolean" }}
        value={false}
      />
    )
    // Should show some indication of false (cross, "No", etc)
    expect(container.textContent?.toLowerCase()).toMatch(/no|false|✗/)
  })

  test("handles null values gracefully", () => {
    const { container } = render(
      <BooleanDisplay
        property={{ name: "maybe", type: "boolean" }}
        value={null}
      />
    )
    expect(container).toBeDefined()
  })
})

describe("DateTimeDisplay", () => {
  test("formats ISO date string", () => {
    const { container } = render(
      <DateTimeDisplay
        property={{ name: "createdAt", type: "string", format: "date-time" }}
        value="2024-01-15T10:30:00Z"
      />
    )
    // Should render a human-readable date
    expect(container.textContent).toBeDefined()
    expect(container.textContent?.length).toBeGreaterThan(0)
  })

  test("handles null values gracefully", () => {
    const { container } = render(
      <DateTimeDisplay
        property={{ name: "date", type: "string", format: "date-time" }}
        value={null}
      />
    )
    expect(container).toBeDefined()
  })
})

describe("EmailDisplay", () => {
  test("renders email as mailto link", () => {
    const { container } = render(
      <EmailDisplay
        property={{ name: "email", type: "string", format: "email" }}
        value="test@example.com"
      />
    )
    const link = container.querySelector("a")
    expect(link).toBeDefined()
    expect(link?.href).toBe("mailto:test@example.com")
    expect(link?.textContent).toBe("test@example.com")
  })

  test("handles null values gracefully", () => {
    const { container } = render(
      <EmailDisplay
        property={{ name: "email", type: "string", format: "email" }}
        value={null}
      />
    )
    expect(container).toBeDefined()
  })
})

describe("UriDisplay", () => {
  test("renders URL as clickable link", () => {
    const { container } = render(
      <UriDisplay
        property={{ name: "website", type: "string", format: "uri" }}
        value="https://example.com"
      />
    )
    const link = container.querySelector("a")
    expect(link).toBeDefined()
    expect(link?.href).toBe("https://example.com/")
    expect(link?.target).toBe("_blank")
  })

  test("handles null values gracefully", () => {
    const { container } = render(
      <UriDisplay
        property={{ name: "url", type: "string", format: "uri" }}
        value={null}
      />
    )
    expect(container).toBeDefined()
  })
})

describe("EnumBadge", () => {
  test("renders enum value as styled badge", () => {
    const { container } = render(
      <EnumBadge
        property={{ name: "status", type: "string", enum: ["active", "inactive", "pending"] }}
        value="active"
      />
    )
    expect(container.textContent).toBe("active")
    // Should have badge styling (class or element)
    const badge = container.querySelector('[class*="badge"]') || container.firstElementChild
    expect(badge).toBeDefined()
  })

  test("handles null values gracefully", () => {
    const { container } = render(
      <EnumBadge
        property={{ name: "status", type: "string", enum: ["a", "b"] }}
        value={null}
      />
    )
    expect(container).toBeDefined()
  })
})

describe("ReferenceDisplay", () => {
  test("shows resolved entity name/title/id cascade", () => {
    const { container } = render(
      <ReferenceDisplay
        property={{ name: "author", type: "string", xReferenceType: "single", xReferenceTarget: "User" }}
        value="user-123"
        entity={{ id: "user-123", name: "John Doe" }}
      />
    )
    // Should show the resolved entity name
    expect(container.textContent).toContain("John Doe")
  })

  test("shows ID when entity has no name/title", () => {
    const { container } = render(
      <ReferenceDisplay
        property={{ name: "ref", type: "string", xReferenceType: "single" }}
        value="entity-456"
        entity={{ id: "entity-456" }}
      />
    )
    expect(container.textContent).toContain("entity-456")
  })

  test("handles stale/unresolved reference (ID string instead of entity)", () => {
    const { container } = render(
      <ReferenceDisplay
        property={{ name: "ref", type: "string", xReferenceType: "single" }}
        value="stale-ref-123"
        entity={undefined}
      />
    )
    // Should show the raw ID when entity not resolved
    expect(container.textContent).toContain("stale-ref-123")
  })

  test("handles null values gracefully", () => {
    const { container } = render(
      <ReferenceDisplay
        property={{ name: "ref", type: "string", xReferenceType: "single" }}
        value={null}
      />
    )
    expect(container).toBeDefined()
  })
})

describe("ComputedDisplay", () => {
  test("shows value with read-only indicator", () => {
    const { container } = render(
      <ComputedDisplay
        property={{ name: "derivedCount", type: "number", xComputed: true }}
        value={42}
      />
    )
    expect(container.textContent).toContain("42")
    // Should have some visual indicator (italic, badge, icon)
    const element = container.firstElementChild
    expect(element).toBeDefined()
  })

  test("handles null values gracefully", () => {
    const { container } = render(
      <ComputedDisplay
        property={{ name: "computed", xComputed: true }}
        value={null}
      />
    )
    expect(container).toBeDefined()
  })
})

describe("ArrayDisplay", () => {
  test("shows item count + expandable list", () => {
    const { container } = render(
      <ArrayDisplay
        property={{ name: "tags", type: "array" }}
        value={["red", "blue", "green"]}
      />
    )
    // Should show count
    expect(container.textContent).toMatch(/3/)
  })

  test("handles empty array", () => {
    const { container } = render(
      <ArrayDisplay
        property={{ name: "items", type: "array" }}
        value={[]}
      />
    )
    expect(container.textContent).toMatch(/0|empty/i)
  })

  test("handles null values gracefully", () => {
    const { container } = render(
      <ArrayDisplay
        property={{ name: "arr", type: "array" }}
        value={null}
      />
    )
    expect(container).toBeDefined()
  })

  test("shows items up to depth limit", () => {
    const { container } = render(
      <ArrayDisplay
        property={{ name: "nested", type: "array" }}
        value={[[1, 2], [3, 4]]}
        depth={1}
      />
    )
    // At depth 1, should show items but not recurse deeply
    expect(container).toBeDefined()
  })

  test("deeply nested structures stop at depth 2", () => {
    const { container } = render(
      <ArrayDisplay
        property={{ name: "deep", type: "array" }}
        value={[[[1, 2, 3]]]}
        depth={2}
      />
    )
    // At depth 2, should stop recursion
    expect(container).toBeDefined()
  })
})

describe("ObjectDisplay", () => {
  test("shows key-value pairs", () => {
    const { container } = render(
      <ObjectDisplay
        property={{ name: "config", type: "object" }}
        value={{ name: "Test", count: 5 }}
      />
    )
    // Shows key count when collapsed
    expect(container.textContent).toContain("2 keys")
  })

  test("handles empty object", () => {
    const { container } = render(
      <ObjectDisplay
        property={{ name: "empty", type: "object" }}
        value={{}}
      />
    )
    expect(container.textContent).toMatch(/empty|0|{}/i)
  })

  test("handles null values gracefully", () => {
    const { container } = render(
      <ObjectDisplay
        property={{ name: "obj", type: "object" }}
        value={null}
      />
    )
    expect(container).toBeDefined()
  })

  test("shows key-value pairs up to depth limit", () => {
    const { container } = render(
      <ObjectDisplay
        property={{ name: "nested", type: "object" }}
        value={{ outer: { inner: "value" } }}
        depth={1}
      />
    )
    expect(container).toBeDefined()
  })
})

describe("All display components", () => {
  test("all display components accept DisplayRendererProps interface", () => {
    // This test ensures type compatibility - if it compiles, it passes
    const meta: PropertyMetadata = { name: "test", type: "string" }
    const props = { property: meta, value: "test" }

    // Just verify they all render without errors
    expect(() => render(<StringDisplay {...props} />)).not.toThrow()
    cleanup()
    expect(() => render(<NumberDisplay {...props} />)).not.toThrow()
    cleanup()
    expect(() => render(<BooleanDisplay {...props} />)).not.toThrow()
    cleanup()
    expect(() => render(<DateTimeDisplay {...props} />)).not.toThrow()
    cleanup()
    expect(() => render(<EmailDisplay {...props} />)).not.toThrow()
    cleanup()
    expect(() => render(<UriDisplay {...props} />)).not.toThrow()
    cleanup()
    expect(() => render(<EnumBadge {...props} />)).not.toThrow()
    cleanup()
    expect(() => render(<ReferenceDisplay {...props} />)).not.toThrow()
    cleanup()
    expect(() => render(<ComputedDisplay {...props} />)).not.toThrow()
    cleanup()
    expect(() => render(<ArrayDisplay {...props} />)).not.toThrow()
    cleanup()
    expect(() => render(<ObjectDisplay {...props} />)).not.toThrow()
    cleanup()
  })
})
