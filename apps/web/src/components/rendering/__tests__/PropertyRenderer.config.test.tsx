/**
 * PropertyRenderer Config Integration Tests
 *
 * TDD: RED phase - Tests written before implementation
 * Tests for config cascade integration in PropertyRenderer.
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeEach, beforeAll, afterAll, afterEach } from "bun:test"
import { render, cleanup } from "@testing-library/react"
import { Window } from "happy-dom"
import React from "react"
import { PropertyRenderer } from "../PropertyRenderer"
import { ComponentRegistryProvider } from "../ComponentRegistryContext"
import { ComponentRegistry } from "../ComponentRegistry"
import type { PropertyMetadata } from "../types"
import type { RenderableComponentProps } from "@shogo/state-api"

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

// Mock component that captures received config
let capturedConfig: any = null
let capturedProps: any = null
const ConfigCapture = (props: RenderableComponentProps) => {
  capturedConfig = props.config
  capturedProps = props
  return <span data-testid="capture">{JSON.stringify(props.config)}</span>
}

// Fallback component
const FallbackComponent = () => <span>Fallback</span>

describe("PropertyRenderer config integration", () => {
  let registry: ComponentRegistry

  beforeEach(() => {
    capturedConfig = null
    capturedProps = null
    registry = new ComponentRegistry(FallbackComponent)
    registry.register({
      id: "config-capture",
      priority: 100,
      matches: () => true,
      component: ConfigCapture,
      defaultConfig: { size: "md", truncate: 200 }
    })
  })

  test("passes binding defaultConfig to component", () => {
    const property: PropertyMetadata = { name: "test", type: "string" }

    render(
      <ComponentRegistryProvider registry={registry}>
        <PropertyRenderer property={property} value="hello" />
      </ComponentRegistryProvider>
    )

    expect(capturedConfig).toEqual({ size: "md", truncate: 200 })
  })

  test("schema xRendererConfig overrides binding defaults", () => {
    const property: PropertyMetadata = {
      name: "test",
      type: "string",
      xRendererConfig: { size: "lg", variant: "emphasized" }
    }

    render(
      <ComponentRegistryProvider registry={registry}>
        <PropertyRenderer property={property} value="hello" />
      </ComponentRegistryProvider>
    )

    expect(capturedConfig).toEqual({
      size: "lg",        // schema override
      truncate: 200,     // binding default
      variant: "emphasized"  // schema addition
    })
  })

  test("passes empty config when no config defined", () => {
    const emptyRegistry = new ComponentRegistry(FallbackComponent)
    emptyRegistry.register({
      id: "no-config",
      priority: 100,
      matches: () => true,
      component: ConfigCapture
      // No defaultConfig
    })

    const property: PropertyMetadata = { name: "test" }

    render(
      <ComponentRegistryProvider registry={emptyRegistry}>
        <PropertyRenderer property={property} value="hello" />
      </ComponentRegistryProvider>
    )

    expect(capturedConfig).toEqual({})
  })

  test("passes other props alongside config", () => {
    const property: PropertyMetadata = { name: "test", type: "string" }
    const entity = { id: "123", name: "Test" }

    render(
      <ComponentRegistryProvider registry={registry}>
        <PropertyRenderer property={property} value="hello" entity={entity} depth={1} />
      </ComponentRegistryProvider>
    )

    expect(capturedProps.property).toEqual(property)
    expect(capturedProps.value).toBe("hello")
    expect(capturedProps.entity).toEqual(entity)
    expect(capturedProps.depth).toBe(1)
  })

  test("handles schema config only (no binding defaultConfig)", () => {
    const noDefaultRegistry = new ComponentRegistry(FallbackComponent)
    noDefaultRegistry.register({
      id: "no-default",
      priority: 100,
      matches: () => true,
      component: ConfigCapture
      // No defaultConfig
    })

    const property: PropertyMetadata = {
      name: "test",
      xRendererConfig: { variant: "muted" }
    }

    render(
      <ComponentRegistryProvider registry={noDefaultRegistry}>
        <PropertyRenderer property={property} value="test" />
      </ComponentRegistryProvider>
    )

    expect(capturedConfig).toEqual({ variant: "muted" })
  })
})
