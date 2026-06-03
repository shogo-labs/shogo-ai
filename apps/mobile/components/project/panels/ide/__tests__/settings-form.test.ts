// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-SETTINGS-UI — unit tests for the pure settings-form generator.
 *
 * Pure module, no React / DOM / file IO — runs under `bun test`.
 * Pins: control inference; key humanisation incl. acronyms; form build
 * (effective value, options, bounds, ordering, grouping, modified flag,
 * deprecation, title override); validation/coercion across types + enum +
 * bounds; and the diff-against-defaults persistence payload.
 */
import { describe, expect, test } from "bun:test"
import {
  buildSettingsForm,
  diffSettings,
  humanizeKey,
  inferControl,
  settingValuesEqual,
  settingsCategories,
  validateSettingValue,
  type ConfigSchema,
} from "../settings-form"

const schema: ConfigSchema = {
  properties: {
    "editor.fontSize": { type: "number", default: 14, minimum: 6, maximum: 100, description: "Controls the font size in pixels.", order: 1 },
    "editor.tabSize": { type: "integer", default: 4, minimum: 1 },
    "editor.minimap.enabled": { type: "boolean", default: true },
    "editor.cursorStyle": { type: "string", enum: ["line", "block", "underline"], enumDescriptions: ["A vertical bar.", "A filled box.", "A horizontal bar."], default: "line" },
    "files.autoSave": { type: "string", enum: ["off", "afterDelay", "onFocusChange"], default: "off", title: "Auto Save" },
    "editor.rulers": { type: "array", default: [] },
    "workbench.colorTheme": { type: "string", default: "Shogo Dark" },
    "editor.legacyOption": { type: "boolean", default: false, deprecationMessage: "Use editor.newOption instead." },
  },
}

describe("inferControl", () => {
  test("maps types to controls", () => {
    expect(inferControl({ type: "boolean" })).toBe("checkbox")
    expect(inferControl({ type: "number" })).toBe("number")
    expect(inferControl({ type: "integer" })).toBe("number")
    expect(inferControl({ type: "string" })).toBe("text")
    expect(inferControl({ type: "array" })).toBe("json")
    expect(inferControl({ type: "object" })).toBe("json")
  })
  test("enum wins over base type → select", () => {
    expect(inferControl({ type: "string", enum: ["a", "b"] })).toBe("select")
  })
  test("infers from default when type absent", () => {
    expect(inferControl({ default: true })).toBe("checkbox")
    expect(inferControl({ default: 3 })).toBe("number")
    expect(inferControl({ default: "x" })).toBe("text")
    expect(inferControl({})).toBe("json")
  })
  test("type array prefers the non-null member", () => {
    expect(inferControl({ type: ["string", "null"] })).toBe("text")
  })
})

describe("humanizeKey", () => {
  test("splits category + camelCase label", () => {
    expect(humanizeKey("editor.fontSize")).toEqual({ category: "Editor", label: "Font Size" })
  })
  test("nested keys flatten into the label", () => {
    expect(humanizeKey("editor.minimap.enabled")).toEqual({ category: "Editor", label: "Minimap Enabled" })
  })
  test("no dot → General category", () => {
    expect(humanizeKey("telemetry")).toEqual({ category: "General", label: "Telemetry" })
  })
  test("acronyms are upper-cased", () => {
    expect(humanizeKey("http.proxyUrl").label).toBe("Proxy URL")
    expect(humanizeKey("editor.jsonFormat").label).toBe("Json Format".replace("Json", "JSON"))
  })
  test("non-string key does not throw", () => {
    expect(() => humanizeKey(undefined as unknown as string)).not.toThrow()
  })
})

describe("settingValuesEqual", () => {
  test("primitives + deep objects/arrays", () => {
    expect(settingValuesEqual(1, 1)).toBe(true)
    expect(settingValuesEqual([], [])).toBe(true)
    expect(settingValuesEqual([1, 2], [1, 2])).toBe(true)
    expect(settingValuesEqual({ a: 1 }, { a: 1 })).toBe(true)
    expect(settingValuesEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(settingValuesEqual(1, "1")).toBe(false)
  })
})

describe("buildSettingsForm", () => {
  test("empty / null schema → []", () => {
    expect(buildSettingsForm(null)).toEqual([])
    expect(buildSettingsForm({ properties: {} })).toEqual([])
  })

  test("uses current value when present, else default; sets modified flag", () => {
    const fields = buildSettingsForm(schema, { "editor.fontSize": 18 })
    const fontSize = fields.find((f) => f.key === "editor.fontSize")!
    expect(fontSize.value).toBe(18)
    expect(fontSize.default).toBe(14)
    expect(fontSize.modified).toBe(true)
    const tabSize = fields.find((f) => f.key === "editor.tabSize")!
    expect(tabSize.value).toBe(4) // default
    expect(tabSize.modified).toBe(false)
  })

  test("current value EQUAL to default is not 'modified'", () => {
    const fields = buildSettingsForm(schema, { "editor.fontSize": 14 })
    expect(fields.find((f) => f.key === "editor.fontSize")!.modified).toBe(false)
  })

  test("builds enum options with descriptions", () => {
    const f = buildSettingsForm(schema).find((x) => x.key === "editor.cursorStyle")!
    expect(f.control).toBe("select")
    expect(f.options).toEqual([
      { value: "line", label: "line", description: "A vertical bar." },
      { value: "block", label: "block", description: "A filled box." },
      { value: "underline", label: "underline", description: "A horizontal bar." },
    ])
  })

  test("carries numeric bounds", () => {
    const f = buildSettingsForm(schema).find((x) => x.key === "editor.fontSize")!
    expect(f.min).toBe(6)
    expect(f.max).toBe(100)
  })

  test("title overrides the humanised label", () => {
    expect(buildSettingsForm(schema).find((x) => x.key === "files.autoSave")!.label).toBe("Auto Save")
  })

  test("deprecation surfaces", () => {
    const f = buildSettingsForm(schema).find((x) => x.key === "editor.legacyOption")!
    expect(f.deprecated).toBe(true)
    expect(f.deprecationMessage).toContain("newOption")
  })

  test("sorted by category, then order, then label", () => {
    const fields = buildSettingsForm(schema)
    // Editor comes before Files before Workbench
    const cats = settingsCategories(fields)
    expect(cats).toEqual(["Editor", "Files", "Workbench"])
    // Within Editor, fontSize has order:1 so it leads the group
    const editorKeys = fields.filter((f) => f.category === "Editor").map((f) => f.key)
    expect(editorKeys[0]).toBe("editor.fontSize")
  })

  test("handles non-object values arg defensively", () => {
    expect(() => buildSettingsForm(schema, null as unknown as Record<string, unknown>)).not.toThrow()
  })
})

describe("validateSettingValue", () => {
  test("boolean coercion from strings", () => {
    expect(validateSettingValue({ type: "boolean" }, "true")).toEqual({ valid: true, value: true })
    expect(validateSettingValue({ type: "boolean" }, false)).toEqual({ valid: true, value: false })
    expect(validateSettingValue({ type: "boolean" }, "nope").valid).toBe(false)
  })
  test("number coercion + bounds", () => {
    expect(validateSettingValue({ type: "number", minimum: 6, maximum: 100 }, "18")).toEqual({ valid: true, value: 18 })
    expect(validateSettingValue({ type: "number", minimum: 6 }, 3)).toMatchObject({ valid: false })
    expect(validateSettingValue({ type: "number", maximum: 100 }, 200)).toMatchObject({ valid: false })
    expect(validateSettingValue({ type: "number" }, "abc")).toMatchObject({ valid: false })
  })
  test("integer rejects fractionals", () => {
    expect(validateSettingValue({ type: "integer" }, 2.5)).toMatchObject({ valid: false })
    expect(validateSettingValue({ type: "integer" }, 2)).toEqual({ valid: true, value: 2 })
  })
  test("enum membership with string fallback", () => {
    expect(validateSettingValue({ enum: ["line", "block"] }, "block")).toEqual({ valid: true, value: "block" })
    expect(validateSettingValue({ enum: [1, 2, 3] }, "2")).toEqual({ valid: true, value: 2 })
    expect(validateSettingValue({ enum: ["a", "b"] }, "z")).toMatchObject({ valid: false })
  })
  test("string coercion + null → empty string", () => {
    expect(validateSettingValue({ type: "string" }, "hi")).toEqual({ valid: true, value: "hi" })
    expect(validateSettingValue({ type: "string" }, null)).toEqual({ valid: true, value: "" })
    expect(validateSettingValue({ type: "string" }, 5)).toEqual({ valid: true, value: "5" })
  })
  test("array/object/unknown accepted as-is", () => {
    expect(validateSettingValue({ type: "array" }, [1, 2])).toEqual({ valid: true, value: [1, 2] })
    expect(validateSettingValue({}, { a: 1 })).toEqual({ valid: true, value: { a: 1 } })
  })
})

describe("multiselect (array with items.enum) — VS Code string[] enum parity", () => {
  const msSchema: ConfigSchema = {
    properties: {
      "files.watcherExclude": {
        type: "array",
        default: ["**/.git"],
        items: { type: "string", enum: ["**/.git", "**/node_modules", "**/dist", "**/.DS_Store"], enumDescriptions: ["Git internals", "Dependencies", "Build output", "macOS metadata"] },
      },
      "editor.plainArray": { type: "array", default: [] },
    },
  }
  const prop = msSchema.properties["files.watcherExclude"]

  test("inferControl: array + items.enum → multiselect; plain array → json", () => {
    expect(inferControl(prop)).toBe("multiselect")
    expect(inferControl(msSchema.properties["editor.plainArray"])).toBe("json")
  })
  test("buildSettingsForm builds multiselect options from items.enum (+ descriptions)", () => {
    const f = buildSettingsForm(msSchema).find((x) => x.key === "files.watcherExclude")!
    expect(f.control).toBe("multiselect")
    expect(f.options).toEqual([
      { value: "**/.git", label: "**/.git", description: "Git internals" },
      { value: "**/node_modules", label: "**/node_modules", description: "Dependencies" },
      { value: "**/dist", label: "**/dist", description: "Build output" },
      { value: "**/.DS_Store", label: "**/.DS_Store", description: "macOS metadata" },
    ])
  })
  test("plain array field has no options", () => {
    expect(buildSettingsForm(msSchema).find((x) => x.key === "editor.plainArray")!.options).toBeUndefined()
  })
  test("validate: a valid subset is accepted", () => {
    expect(validateSettingValue(prop, ["**/.git", "**/dist"])).toEqual({ valid: true, value: ["**/.git", "**/dist"] })
  })
  test("validate: a lone value is coerced to a single-element array", () => {
    expect(validateSettingValue(prop, "**/node_modules")).toEqual({ valid: true, value: ["**/node_modules"] })
  })
  test("validate: empty / null / '' → empty array", () => {
    expect(validateSettingValue(prop, [])).toEqual({ valid: true, value: [] })
    expect(validateSettingValue(prop, null)).toEqual({ valid: true, value: [] })
    expect(validateSettingValue(prop, "")).toEqual({ valid: true, value: [] })
  })
  test("validate: duplicates are deduped", () => {
    expect(validateSettingValue(prop, ["**/.git", "**/.git", "**/dist"])).toEqual({ valid: true, value: ["**/.git", "**/dist"] })
  })
  test("validate: a value outside the allowed set is rejected", () => {
    const r = validateSettingValue(prop, ["**/.git", "**/secret"])
    expect(r.valid).toBe(false)
    expect(r.error).toContain("Allowed values")
  })
  test("validate: array without items.enum passes through untouched", () => {
    expect(validateSettingValue(msSchema.properties["editor.plainArray"], [1, 2, 3])).toEqual({ valid: true, value: [1, 2, 3] })
  })
})

describe("diffSettings (persist only non-defaults)", () => {
  test("drops values equal to the schema default", () => {
    const out = diffSettings({ "editor.fontSize": 14, "editor.tabSize": 2 }, schema)
    expect(out).toEqual({ "editor.tabSize": 2 })
  })
  test("keeps changed values incl. deep arrays", () => {
    expect(diffSettings({ "editor.rulers": [80, 120] }, schema)).toEqual({ "editor.rulers": [80, 120] })
    expect(diffSettings({ "editor.rulers": [] }, schema)).toEqual({})
  })
  test("passes through keys not in the schema (user-defined)", () => {
    expect(diffSettings({ "my.custom": 1 }, schema)).toEqual({ "my.custom": 1 })
  })
  test("null/empty inputs → {}", () => {
    expect(diffSettings(null, schema)).toEqual({})
    expect(diffSettings({ "editor.fontSize": 99 }, null)).toEqual({ "editor.fontSize": 99 })
  })
})
