/**
 * Studio Registry Integration Tests
 * Task: task-w2-registry-integration
 *
 * Tests for visualization primitive renderer registrations in studioRegistry.
 * Validates that ProgressBar, DataCard, GraphNode, and StatusIndicator are
 * registered at priority 200 and discoverable via x-renderer schema extension.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { createStudioRegistry } from "./studioRegistry"
import type { PropertyMetadata } from "./types"

describe("studioRegistry visualization renderer integration", () => {
  let registry: ReturnType<typeof createStudioRegistry>

  beforeEach(() => {
    registry = createStudioRegistry()
  })

  describe("progress-bar renderer", () => {
    test("is registered with id 'progress-bar'", () => {
      const entries = registry.entries()
      const progressBarEntry = entries.find((e) => e.id === "progress-bar")

      expect(progressBarEntry).toBeDefined()
      expect(progressBarEntry!.id).toBe("progress-bar")
    })

    test("uses priority 200", () => {
      const entries = registry.entries()
      const progressBarEntry = entries.find((e) => e.id === "progress-bar")

      expect(progressBarEntry).toBeDefined()
      expect(progressBarEntry!.priority).toBe(200)
    })

    test("matches when xRenderer is 'progress-bar'", () => {
      const entries = registry.entries()
      const progressBarEntry = entries.find((e) => e.id === "progress-bar")

      const metadata: PropertyMetadata = {
        name: "progress",
        type: "number",
        xRenderer: "progress-bar",
      }

      expect(progressBarEntry!.matches(metadata)).toBe(true)
    })

    test("resolves ProgressBar component for x-renderer metadata", () => {
      const metadata: PropertyMetadata = {
        name: "progress",
        type: "number",
        xRenderer: "progress-bar",
      }

      const component = registry.resolve(metadata)
      // Verify the component matches the registered entry
      const entries = registry.entries()
      const progressBarEntry = entries.find((e) => e.id === "progress-bar")
      expect(component).toBe(progressBarEntry!.component)
    })
  })

  describe("data-card renderer", () => {
    test("is registered with id 'data-card'", () => {
      const entries = registry.entries()
      const dataCardEntry = entries.find((e) => e.id === "data-card")

      expect(dataCardEntry).toBeDefined()
      expect(dataCardEntry!.id).toBe("data-card")
    })

    test("uses priority 200", () => {
      const entries = registry.entries()
      const dataCardEntry = entries.find((e) => e.id === "data-card")

      expect(dataCardEntry).toBeDefined()
      expect(dataCardEntry!.priority).toBe(200)
    })

    test("matches when xRenderer is 'data-card'", () => {
      const entries = registry.entries()
      const dataCardEntry = entries.find((e) => e.id === "data-card")

      const metadata: PropertyMetadata = {
        name: "finding",
        type: "object",
        xRenderer: "data-card",
      }

      expect(dataCardEntry!.matches(metadata)).toBe(true)
    })

    test("resolves DataCard component for x-renderer metadata", () => {
      const metadata: PropertyMetadata = {
        name: "finding",
        type: "object",
        xRenderer: "data-card",
      }

      const component = registry.resolve(metadata)
      // Verify the component matches the registered entry
      const entries = registry.entries()
      const dataCardEntry = entries.find((e) => e.id === "data-card")
      expect(component).toBe(dataCardEntry!.component)
    })
  })

  describe("graph-node renderer", () => {
    test("is registered with id 'graph-node'", () => {
      const entries = registry.entries()
      const graphNodeEntry = entries.find((e) => e.id === "graph-node")

      expect(graphNodeEntry).toBeDefined()
      expect(graphNodeEntry!.id).toBe("graph-node")
    })

    test("uses priority 200", () => {
      const entries = registry.entries()
      const graphNodeEntry = entries.find((e) => e.id === "graph-node")

      expect(graphNodeEntry).toBeDefined()
      expect(graphNodeEntry!.priority).toBe(200)
    })

    test("matches when xRenderer is 'graph-node'", () => {
      const entries = registry.entries()
      const graphNodeEntry = entries.find((e) => e.id === "graph-node")

      const metadata: PropertyMetadata = {
        name: "node",
        type: "object",
        xRenderer: "graph-node",
      }

      expect(graphNodeEntry!.matches(metadata)).toBe(true)
    })

    test("resolves GraphNode component for x-renderer metadata", () => {
      const metadata: PropertyMetadata = {
        name: "node",
        type: "object",
        xRenderer: "graph-node",
      }

      const component = registry.resolve(metadata)
      // Verify the component matches the registered entry
      const entries = registry.entries()
      const graphNodeEntry = entries.find((e) => e.id === "graph-node")
      expect(component).toBe(graphNodeEntry!.component)
    })
  })

  describe("status-indicator renderer", () => {
    test("is registered with id 'status-indicator'", () => {
      const entries = registry.entries()
      const statusIndicatorEntry = entries.find(
        (e) => e.id === "status-indicator"
      )

      expect(statusIndicatorEntry).toBeDefined()
      expect(statusIndicatorEntry!.id).toBe("status-indicator")
    })

    test("uses priority 200", () => {
      const entries = registry.entries()
      const statusIndicatorEntry = entries.find(
        (e) => e.id === "status-indicator"
      )

      expect(statusIndicatorEntry).toBeDefined()
      expect(statusIndicatorEntry!.priority).toBe(200)
    })

    test("matches when xRenderer is 'status-indicator'", () => {
      const entries = registry.entries()
      const statusIndicatorEntry = entries.find(
        (e) => e.id === "status-indicator"
      )

      const metadata: PropertyMetadata = {
        name: "status",
        type: "object",
        xRenderer: "status-indicator",
      }

      expect(statusIndicatorEntry!.matches(metadata)).toBe(true)
    })

    test("resolves StatusIndicator component for x-renderer metadata", () => {
      const metadata: PropertyMetadata = {
        name: "status",
        type: "object",
        xRenderer: "status-indicator",
      }

      const component = registry.resolve(metadata)
      // Verify the component matches the registered entry
      const entries = registry.entries()
      const statusIndicatorEntry = entries.find(
        (e) => e.id === "status-indicator"
      )
      expect(component).toBe(statusIndicatorEntry!.component)
    })
  })

  describe("x-renderer resolution precedence", () => {
    test("visualization renderers take precedence over enum badge (priority 200 > 50)", () => {
      const metadata: PropertyMetadata = {
        name: "progress",
        type: "number",
        enum: ["low", "medium", "high"],
        xRenderer: "progress-bar",
      }

      // Should resolve to ProgressBar, not EnumBadge
      const entries = registry.entries()
      const resolved = registry.resolve(metadata)

      // EnumBadge priority is 50, progress-bar is 200
      const progressBarEntry = entries.find((e) => e.id === "progress-bar")
      expect(resolved).toBe(progressBarEntry!.component)
    })

    test("visualization renderers take precedence over type-based displays (priority 200 > 10)", () => {
      const metadata: PropertyMetadata = {
        name: "node",
        type: "object",
        xRenderer: "graph-node",
      }

      // Should resolve to GraphNode, not ObjectDisplay
      const entries = registry.entries()
      const resolved = registry.resolve(metadata)

      const graphNodeEntry = entries.find((e) => e.id === "graph-node")
      expect(resolved).toBe(graphNodeEntry!.component)
    })
  })
})
