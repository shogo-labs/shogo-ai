/**
 * XRendererConfig Type Definitions Tests
 *
 * TDD: RED phase - Tests written before implementation
 * These tests verify the XRendererConfig interface and related type updates.
 */

import { describe, test, expect } from "bun:test"
import type {
  XRendererConfig,
  PropertyMetadata,
  ComponentEntrySpec,
  RenderableComponentProps
} from "../types"

describe("XRendererConfig type definitions", () => {
  test("XRendererConfig accepts all valid config options", () => {
    const config: XRendererConfig = {
      variant: "emphasized",
      size: "lg",
      layout: "block",
      truncate: 100,
      expandable: true,
      clickable: false,
      customProps: { foo: "bar" }
    }
    expect(config.variant).toBe("emphasized")
    expect(config.size).toBe("lg")
    expect(config.layout).toBe("block")
    expect(config.truncate).toBe(100)
    expect(config.expandable).toBe(true)
    expect(config.clickable).toBe(false)
    expect(config.customProps).toEqual({ foo: "bar" })
  })

  test("XRendererConfig accepts partial config", () => {
    const minimal: XRendererConfig = { size: "sm" }
    expect(minimal.size).toBe("sm")
    expect(minimal.variant).toBeUndefined()
  })

  test("XRendererConfig truncate can be boolean", () => {
    const withBool: XRendererConfig = { truncate: true }
    expect(withBool.truncate).toBe(true)

    const withFalse: XRendererConfig = { truncate: false }
    expect(withFalse.truncate).toBe(false)
  })

  test("PropertyMetadata includes optional xRendererConfig", () => {
    const meta: PropertyMetadata = {
      name: "title",
      type: "string",
      xRendererConfig: { variant: "muted", size: "sm" }
    }
    expect(meta.xRendererConfig?.variant).toBe("muted")
    expect(meta.xRendererConfig?.size).toBe("sm")
  })

  test("PropertyMetadata without xRendererConfig is valid", () => {
    const meta: PropertyMetadata = {
      name: "title",
      type: "string"
    }
    expect(meta.xRendererConfig).toBeUndefined()
  })

  test("ComponentEntrySpec includes optional defaultConfig", () => {
    const spec: ComponentEntrySpec = {
      id: "test-spec",
      priority: 10,
      matcher: () => true,
      componentRef: "StringDisplay",
      defaultConfig: { size: "md", truncate: 200 }
    }
    expect(spec.defaultConfig?.size).toBe("md")
    expect(spec.defaultConfig?.truncate).toBe(200)
  })

  test("ComponentEntrySpec without defaultConfig is valid", () => {
    const spec: ComponentEntrySpec = {
      id: "test-spec",
      priority: 10,
      matcher: () => true,
      componentRef: "StringDisplay"
    }
    expect(spec.defaultConfig).toBeUndefined()
  })

  test("RenderableComponentProps includes optional config", () => {
    const props: RenderableComponentProps<string> = {
      property: { name: "test" },
      value: "hello",
      config: { variant: "success" }
    }
    expect(props.config?.variant).toBe("success")
  })

  test("RenderableComponentProps without config is valid", () => {
    const props: RenderableComponentProps<string> = {
      property: { name: "test" },
      value: "hello"
    }
    expect(props.config).toBeUndefined()
  })

  test("RenderableComponentProps supports generic value type", () => {
    const numberProps: RenderableComponentProps<number> = {
      property: { name: "count", type: "number" },
      value: 42,
      config: { size: "lg" }
    }
    expect(numberProps.value).toBe(42)

    const boolProps: RenderableComponentProps<boolean> = {
      property: { name: "active", type: "boolean" },
      value: true
    }
    expect(boolProps.value).toBe(true)
  })
})
