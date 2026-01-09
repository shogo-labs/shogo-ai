/**
 * Config Cascade Utility Tests
 *
 * TDD: RED phase - Tests written before implementation
 * Tests for mergeRendererConfig utility that handles config cascade.
 */

import { describe, test, expect } from "bun:test"
import { mergeRendererConfig } from "../config-utils"
import type { XRendererConfig } from "../types"

describe("mergeRendererConfig", () => {
  test("returns empty object when no configs provided", () => {
    const result = mergeRendererConfig()
    expect(result).toEqual({})
  })

  test("returns component defaults when only defaults provided", () => {
    const componentDefaults: XRendererConfig = { size: "md", truncate: 200 }
    const result = mergeRendererConfig(componentDefaults)
    expect(result).toEqual({ size: "md", truncate: 200 })
  })

  test("binding config overrides component defaults", () => {
    const componentDefaults: XRendererConfig = { size: "md", truncate: 200 }
    const bindingConfig: XRendererConfig = { size: "lg" }
    const result = mergeRendererConfig(componentDefaults, bindingConfig)
    expect(result).toEqual({ size: "lg", truncate: 200 })
  })

  test("schema config has highest priority", () => {
    const componentDefaults: XRendererConfig = { size: "md", variant: "default" }
    const bindingConfig: XRendererConfig = { size: "lg", variant: "muted" }
    const schemaConfig: XRendererConfig = { variant: "emphasized" }
    const result = mergeRendererConfig(componentDefaults, bindingConfig, schemaConfig)
    expect(result).toEqual({ size: "lg", variant: "emphasized" })
  })

  test("customProps merge deeply", () => {
    const bindingConfig: XRendererConfig = { customProps: { a: 1, b: 2 } }
    const schemaConfig: XRendererConfig = { customProps: { b: 3, c: 4 } }
    const result = mergeRendererConfig(undefined, bindingConfig, schemaConfig)
    expect(result.customProps).toEqual({ a: 1, b: 3, c: 4 })
  })

  test("handles undefined configs gracefully", () => {
    const result = mergeRendererConfig(undefined, { size: "lg" }, undefined)
    expect(result).toEqual({ size: "lg" })
  })

  test("preserves all standard config keys", () => {
    const full: XRendererConfig = {
      variant: "success",
      size: "xl",
      layout: "block",
      truncate: 100,
      expandable: true,
      clickable: true
    }
    const result = mergeRendererConfig(full)
    expect(result).toEqual(full)
  })

  test("later config completely replaces earlier value for same key", () => {
    const first: XRendererConfig = { truncate: 100 }
    const second: XRendererConfig = { truncate: false }
    const result = mergeRendererConfig(first, second)
    expect(result.truncate).toBe(false)
  })

  test("preserves boolean false values", () => {
    const config: XRendererConfig = {
      expandable: false,
      clickable: false,
      truncate: false
    }
    const result = mergeRendererConfig(config)
    expect(result.expandable).toBe(false)
    expect(result.clickable).toBe(false)
    expect(result.truncate).toBe(false)
  })

  test("handles all undefined gracefully", () => {
    const result = mergeRendererConfig(undefined, undefined, undefined)
    expect(result).toEqual({})
  })
})
