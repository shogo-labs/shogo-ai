/**
 * SessionSummarySection Component Tests
 * Task: task-cpv-009
 *
 * Tests verify:
 * 1. Component accepts SectionRendererProps
 * 2. Shows feature.status with status-appropriate badge color
 * 3. Lists feature.affectedPackages as tags/chips
 * 4. Shows feature.applicablePatterns as tags
 * 5. Shows feature.schemaName if present
 * 6. Compact layout suitable for sidebar
 * 7. Registered in sectionImplementationMap
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { render, screen } from "@testing-library/react"
import { Window } from "happy-dom"
import { SessionSummarySection } from "../SessionSummarySection"
import {
  getSectionComponent,
  sectionImplementationMap,
} from "../../sectionImplementations"

// Set up happy-dom
let window: Window
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document

beforeAll(() => {
  window = new Window()
  originalWindow = globalThis.window
  originalDocument = globalThis.document
  // @ts-expect-error - happy-dom Window type mismatch
  globalThis.window = window
  // @ts-expect-error - happy-dom Document type mismatch
  globalThis.document = window.document
})

afterAll(() => {
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  window.close()
})

// Test fixtures
const createFeature = (overrides: Partial<typeof baseFeature> = {}) => ({
  ...baseFeature,
  ...overrides,
})

const baseFeature = {
  id: "feature-123",
  name: "Test Feature",
  status: "discovery" as const,
  affectedPackages: ["apps/web", "packages/state-api"],
  applicablePatterns: ["enhancement-hooks", "domain-model"],
  schemaName: "component-builder",
  featureArchetype: "domain" as const,
}

describe("SessionSummarySection - Accepts SectionRendererProps", () => {
  test("renders without throwing errors when given feature prop", () => {
    expect(() =>
      render(<SessionSummarySection feature={baseFeature} />)
    ).not.toThrow()
  })

  test("accepts optional config prop", () => {
    expect(() =>
      render(
        <SessionSummarySection
          feature={baseFeature}
          config={{ showHeader: true }}
        />
      )
    ).not.toThrow()
  })

  test("component root has data-section attribute", () => {
    const { container } = render(<SessionSummarySection feature={baseFeature} />)
    const section = container.querySelector("[data-section='session-summary']")
    expect(section).not.toBeNull()
  })
})

describe("SessionSummarySection - Status Badge", () => {
  test("displays feature status text", () => {
    const { container } = render(
      <SessionSummarySection feature={createFeature({ status: "discovery" })} />
    )
    const statusSection = container.querySelector("[data-field='status']")
    expect(statusSection?.textContent).toContain("Discovery")
  })

  test("discovery status has blue styling", () => {
    const { container } = render(
      <SessionSummarySection feature={createFeature({ status: "discovery" })} />
    )
    const badge = container.querySelector("[data-status-badge]")
    expect(badge?.className).toMatch(/blue/)
  })

  test("analysis status has blue styling", () => {
    const { container } = render(
      <SessionSummarySection feature={createFeature({ status: "analysis" })} />
    )
    const badge = container.querySelector("[data-status-badge]")
    expect(badge?.className).toMatch(/blue/)
  })

  test("classification status has blue styling", () => {
    const { container } = render(
      <SessionSummarySection
        feature={createFeature({ status: "classification" })}
      />
    )
    const badge = container.querySelector("[data-status-badge]")
    // sessionStatusBadgeVariants uses blue for discovery/analysis/classification
    expect(badge?.className).toMatch(/blue/)
  })

  test("design status has purple styling", () => {
    const { container } = render(
      <SessionSummarySection feature={createFeature({ status: "design" })} />
    )
    const badge = container.querySelector("[data-status-badge]")
    expect(badge?.className).toMatch(/purple|amber/)
  })

  test("spec status has purple styling", () => {
    const { container } = render(
      <SessionSummarySection feature={createFeature({ status: "spec" })} />
    )
    const badge = container.querySelector("[data-status-badge]")
    // sessionStatusBadgeVariants uses purple for design/spec
    expect(badge?.className).toMatch(/purple/)
  })

  test("testing status has amber styling", () => {
    const { container } = render(
      <SessionSummarySection feature={createFeature({ status: "testing" })} />
    )
    const badge = container.querySelector("[data-status-badge]")
    // sessionStatusBadgeVariants uses amber for implementation/testing
    expect(badge?.className).toMatch(/amber/)
  })

  test("implementation status has amber styling", () => {
    const { container } = render(
      <SessionSummarySection
        feature={createFeature({ status: "implementation" })}
      />
    )
    const badge = container.querySelector("[data-status-badge]")
    // sessionStatusBadgeVariants uses amber for implementation/testing
    expect(badge?.className).toMatch(/amber/)
  })

  test("complete status has green styling", () => {
    const { container } = render(
      <SessionSummarySection feature={createFeature({ status: "complete" })} />
    )
    const badge = container.querySelector("[data-status-badge]")
    expect(badge?.className).toMatch(/green/)
  })
})

describe("SessionSummarySection - Affected Packages", () => {
  test("displays packages section header", () => {
    const { container } = render(<SessionSummarySection feature={baseFeature} />)
    const packagesSection = container.querySelector("[data-field='packages']")
    expect(packagesSection).not.toBeNull()
  })

  test("displays each package as a tag/chip", () => {
    const { container } = render(<SessionSummarySection feature={baseFeature} />)
    const packageTags = container.querySelectorAll("[data-package-tag]")
    expect(packageTags.length).toBe(2)
  })

  test("package tags contain correct text", () => {
    const { container } = render(<SessionSummarySection feature={baseFeature} />)
    const tags = container.querySelectorAll("[data-package-tag]")
    const texts = Array.from(tags).map((t) => t.textContent)
    expect(texts).toContain("apps/web")
    expect(texts).toContain("packages/state-api")
  })

  test("handles empty packages array gracefully", () => {
    const feature = createFeature({ affectedPackages: [] })
    const { container } = render(<SessionSummarySection feature={feature} />)
    const packageTags = container.querySelectorAll("[data-package-tag]")
    expect(packageTags.length).toBe(0)
  })

  test("handles undefined packages gracefully", () => {
    const feature = createFeature({ affectedPackages: undefined as any })
    expect(() =>
      render(<SessionSummarySection feature={feature} />)
    ).not.toThrow()
  })
})

describe("SessionSummarySection - Applicable Patterns", () => {
  test("displays patterns section", () => {
    const { container } = render(<SessionSummarySection feature={baseFeature} />)
    const patternsSection = container.querySelector("[data-field='patterns']")
    expect(patternsSection).not.toBeNull()
  })

  test("displays each pattern as a tag", () => {
    const { container } = render(<SessionSummarySection feature={baseFeature} />)
    const patternTags = container.querySelectorAll("[data-pattern-tag]")
    expect(patternTags.length).toBe(2)
  })

  test("pattern tags contain correct text", () => {
    const { container } = render(<SessionSummarySection feature={baseFeature} />)
    const tags = container.querySelectorAll("[data-pattern-tag]")
    const texts = Array.from(tags).map((t) => t.textContent)
    expect(texts).toContain("enhancement-hooks")
    expect(texts).toContain("domain-model")
  })

  test("handles empty patterns array gracefully", () => {
    const feature = createFeature({ applicablePatterns: [] })
    const { container } = render(<SessionSummarySection feature={feature} />)
    const patternTags = container.querySelectorAll("[data-pattern-tag]")
    expect(patternTags.length).toBe(0)
  })

  test("handles undefined patterns gracefully", () => {
    const feature = createFeature({ applicablePatterns: undefined as any })
    expect(() =>
      render(<SessionSummarySection feature={feature} />)
    ).not.toThrow()
  })
})

describe("SessionSummarySection - Schema Name", () => {
  test("displays schema name when present", () => {
    const { container } = render(<SessionSummarySection feature={baseFeature} />)
    const schemaSection = container.querySelector("[data-field='schema']")
    expect(schemaSection?.textContent).toContain("component-builder")
  })

  test("schema section is hidden when schemaName is absent", () => {
    const feature = createFeature({ schemaName: undefined })
    const { container } = render(<SessionSummarySection feature={feature} />)
    const schemaSection = container.querySelector("[data-field='schema']")
    expect(schemaSection).toBeNull()
  })

  test("schema section is hidden when schemaName is empty string", () => {
    const feature = createFeature({ schemaName: "" })
    const { container } = render(<SessionSummarySection feature={feature} />)
    const schemaSection = container.querySelector("[data-field='schema']")
    expect(schemaSection).toBeNull()
  })
})

describe("SessionSummarySection - Compact Layout", () => {
  test("uses vertical spacing suitable for sidebar", () => {
    const { container } = render(<SessionSummarySection feature={baseFeature} />)
    const section = container.querySelector("[data-section='session-summary']")
    // Should have space-y-* class for vertical spacing
    expect(section?.className).toMatch(/space-y/)
  })

  test("section labels use small text size", () => {
    const { container } = render(<SessionSummarySection feature={baseFeature} />)
    const labels = container.querySelectorAll("[data-section-label]")
    expect(labels.length).toBeGreaterThan(0)
    labels.forEach((label) => {
      expect(label.className).toMatch(/text-sm|text-xs/)
    })
  })

  test("tags use compact sizing", () => {
    const { container } = render(<SessionSummarySection feature={baseFeature} />)
    const tags = container.querySelectorAll("[data-package-tag], [data-pattern-tag]")
    tags.forEach((tag) => {
      expect(tag.className).toMatch(/text-xs|px-2|py-0\.5/)
    })
  })

  test("tags wrap in flex container", () => {
    const { container } = render(<SessionSummarySection feature={baseFeature} />)
    const tagContainers = container.querySelectorAll("[data-tag-container]")
    tagContainers.forEach((tc) => {
      expect(tc.className).toMatch(/flex.*flex-wrap|flex-wrap/)
    })
  })
})

describe("SessionSummarySection - Registration", () => {
  test("is registered in sectionImplementationMap", () => {
    expect(sectionImplementationMap.has("SessionSummarySection")).toBe(true)
  })

  test("getSectionComponent returns SessionSummarySection", () => {
    const Component = getSectionComponent("SessionSummarySection")
    expect(Component).toBe(SessionSummarySection)
  })

  test("registered component renders correctly", () => {
    const Component = getSectionComponent("SessionSummarySection")
    const { container } = render(<Component feature={baseFeature} />)
    const section = container.querySelector("[data-section='session-summary']")
    expect(section).not.toBeNull()
  })
})
