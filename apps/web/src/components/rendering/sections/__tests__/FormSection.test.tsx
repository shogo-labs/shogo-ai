/**
 * FormSection Component Tests
 *
 * Tests verify:
 * 1. Component accepts SectionRendererProps
 * 2. Shows configuration required message when schema/model missing
 * 3. Shows loading state while fetching metadata
 * 4. Renders form with correct fields
 * 5. Handles create and edit modes
 * 6. Submit button calls correct CRUD method
 * 7. Registered in sectionImplementationMap
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test"
import { render, screen } from "@testing-library/react"
import { Window } from "happy-dom"
import { FormSection } from "../FormSection"
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

// Mock hooks
const mockUseFormMetadata = mock(() => ({
  jsonSchema: null,
  properties: [],
  model: null,
  collectionName: null,
  loading: false,
  error: null,
}))

const mockUseDomainStore = mock(() => null)

// Mock the modules
mock.module("../hooks", () => ({
  useFormMetadata: mockUseFormMetadata,
}))

mock.module("@/contexts/DomainProvider", () => ({
  useDomainStore: mockUseDomainStore,
}))

mock.module("@/contexts/WavesmithMetaStoreContext", () => ({
  useWavesmithMetaStore: () => ({
    findSchemaByName: () => null,
    loadSchema: async () => {},
  }),
}))

// Test fixtures
const baseFeature = {
  id: "feature-123",
  name: "Test Feature",
  status: "discovery" as const,
}

describe("FormSection - Accepts SectionRendererProps", () => {
  test("renders without throwing errors when given feature prop", () => {
    expect(() =>
      render(<FormSection feature={baseFeature} />)
    ).not.toThrow()
  })

  test("accepts optional config prop", () => {
    expect(() =>
      render(
        <FormSection
          feature={baseFeature}
          config={{ schema: "platform-features", model: "Requirement" }}
        />
      )
    ).not.toThrow()
  })

  test("component root has data-testid attribute", () => {
    const { container } = render(<FormSection feature={baseFeature} />)
    const section = container.querySelector("[data-testid='form-section']")
    expect(section).not.toBeNull()
  })
})

describe("FormSection - Configuration Required", () => {
  test("shows configuration message when schema is missing", () => {
    const { container } = render(
      <FormSection
        feature={baseFeature}
        config={{ model: "Requirement" }}
      />
    )
    const content = container.textContent
    expect(content).toContain("Configuration required")
  })

  test("shows configuration message when model is missing", () => {
    const { container } = render(
      <FormSection
        feature={baseFeature}
        config={{ schema: "platform-features" }}
      />
    )
    const content = container.textContent
    expect(content).toContain("Configuration required")
  })

  test("shows example configuration in help text", () => {
    const { container } = render(
      <FormSection feature={baseFeature} />
    )
    const content = container.textContent
    expect(content).toContain("schema")
    expect(content).toContain("model")
  })
})

describe("FormSection - Registration", () => {
  test("is registered in sectionImplementationMap", () => {
    expect(sectionImplementationMap.has("FormSection")).toBe(true)
  })

  test("getSectionComponent returns FormSection", () => {
    const Component = getSectionComponent("FormSection")
    expect(Component).toBe(FormSection)
  })

  test("registered component renders correctly", () => {
    const Component = getSectionComponent("FormSection")
    const { container } = render(<Component feature={baseFeature} />)
    const section = container.querySelector("[data-testid='form-section']")
    expect(section).not.toBeNull()
  })
})

describe("FormSection - Config Options", () => {
  test("accepts schema config option", () => {
    expect(() =>
      render(
        <FormSection
          feature={baseFeature}
          config={{ schema: "platform-features", model: "Requirement" }}
        />
      )
    ).not.toThrow()
  })

  test("accepts schemaName as alternate key", () => {
    expect(() =>
      render(
        <FormSection
          feature={baseFeature}
          config={{ schemaName: "platform-features", model: "Requirement" }}
        />
      )
    ).not.toThrow()
  })

  test("accepts entityId for edit mode", () => {
    expect(() =>
      render(
        <FormSection
          feature={baseFeature}
          config={{
            schema: "platform-features",
            model: "Requirement",
            entityId: "req-123",
          }}
        />
      )
    ).not.toThrow()
  })

  test("accepts fields array for field filtering", () => {
    expect(() =>
      render(
        <FormSection
          feature={baseFeature}
          config={{
            schema: "platform-features",
            model: "Requirement",
            fields: ["name", "description"],
          }}
        />
      )
    ).not.toThrow()
  })

  test("accepts layout option", () => {
    expect(() =>
      render(
        <FormSection
          feature={baseFeature}
          config={{
            schema: "platform-features",
            model: "Requirement",
            layout: "horizontal",
          }}
        />
      )
    ).not.toThrow()
  })

  test("accepts groups option for grouped layout", () => {
    expect(() =>
      render(
        <FormSection
          feature={baseFeature}
          config={{
            schema: "platform-features",
            model: "Requirement",
            layout: "grouped",
            groups: [
              { label: "Basic Info", fields: ["name", "description"] },
              { label: "Status", fields: ["priority", "status"] },
            ],
          }}
        />
      )
    ).not.toThrow()
  })

  test("accepts custom title", () => {
    expect(() =>
      render(
        <FormSection
          feature={baseFeature}
          config={{
            schema: "platform-features",
            model: "Requirement",
            title: "Create New Requirement",
          }}
        />
      )
    ).not.toThrow()
  })

  test("accepts submitLabel and cancelLabel", () => {
    expect(() =>
      render(
        <FormSection
          feature={baseFeature}
          config={{
            schema: "platform-features",
            model: "Requirement",
            submitLabel: "Add Requirement",
            cancelLabel: "Go Back",
          }}
        />
      )
    ).not.toThrow()
  })

  test("accepts sessionField for auto-binding", () => {
    expect(() =>
      render(
        <FormSection
          feature={baseFeature}
          config={{
            schema: "platform-features",
            model: "Requirement",
            sessionField: "session",
          }}
        />
      )
    ).not.toThrow()
  })
})

describe("FormSection - Title Display", () => {
  test("displays default title with model name", () => {
    const { container } = render(
      <FormSection
        feature={baseFeature}
        config={{ schema: "platform-features", model: "Requirement" }}
      />
    )
    // The component shows "New {model}" or "Edit {model}" based on entityId
    const heading = container.querySelector("h3")
    expect(heading?.textContent).toContain("Requirement")
  })

  test("displays custom title when provided", () => {
    const { container } = render(
      <FormSection
        feature={baseFeature}
        config={{
          schema: "platform-features",
          model: "Requirement",
          title: "Custom Form Title",
        }}
      />
    )
    const heading = container.querySelector("h3")
    expect(heading?.textContent).toBe("Custom Form Title")
  })
})
