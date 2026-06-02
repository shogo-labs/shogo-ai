// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-SETTINGS-UI — render Settings as a form generated from schema.json.
 *
 * Shogo only ever showed the raw settings JSON in a text editor. VS Code
 * renders a proper form (checkboxes, dropdowns, number inputs, …) built
 * FROM the configuration schema, with an "Edit in settings.json" escape
 * hatch. The schema already exists in Shogo — this module is the pure,
 * side-effect-free engine that turns that schema + the current values
 * into a list of form-field descriptors, validates/coerces edits back,
 * and diffs against defaults so only CHANGED settings are persisted (VS
 * Code never writes defaults).
 *
 * Same extraction pattern as the other UX-* modules (quick-open-
 * disambiguate / diff-view-mode / minimap-settings / problems-navigation /
 * tab-context-menu / peek-actions): no React, no DOM, no file IO. The
 * React form renders the descriptors dumbly and calls back the validators.
 *
 * What lives here:
 *   • A minimal JSON-Schema-ish ConfigSchema (the subset VS Code uses for
 *     configuration contributions: type, default, enum, enumDescriptions,
 *     minimum/maximum, description, markdownDescription, order,
 *     deprecationMessage, …).
 *   • `inferControl` — schema property → UI control kind.
 *   • `humanizeKey` — "editor.fontSize" → category "Editor", label
 *     "Font Size".
 *   • `buildSettingsForm` — produce ordered, grouped SettingField[] with
 *     the effective value (current ?? default), options, and bounds.
 *   • `validateSettingValue` — coerce + validate an edited value, with a
 *     human error message; returns the value to store.
 *   • `diffSettings` — the persistence payload: only keys whose value
 *     differs from the schema default.
 *
 * Deliberately NOT here: React, DOM, file IO, a JSON editor.
 */

export type ConfigType = "boolean" | "string" | "number" | "integer" | "array" | "object" | "null"

export interface ConfigProperty {
  type?: ConfigType | ConfigType[]
  default?: unknown
  enum?: unknown[]
  enumDescriptions?: string[]
  description?: string
  markdownDescription?: string
  title?: string
  minimum?: number
  maximum?: number
  /** Free-form; surfaced as a hint on string fields. */
  format?: string
  /**
   * For `type: "array"` — describes the element type. When `items.enum`
   * is present the property renders as a multi-select (checkbox list),
   * matching VS Code's rendering of a `string[]` enum setting.
   */
  items?: { type?: ConfigType; enum?: unknown[]; enumDescriptions?: string[] }
  /** When set, the setting is deprecated; the form shows a warning. */
  deprecationMessage?: string
  /** Lower number sorts earlier within a category. */
  order?: number
}

export interface ConfigSchema {
  properties: Record<string, ConfigProperty>
}

export type SettingControl =
  | "checkbox"
  | "text"
  | "number"
  | "select"
  | "multiselect"
  | "json"

export interface SettingOption {
  value: unknown
  label: string
  description?: string
}

export interface SettingField {
  key: string
  category: string
  label: string
  description?: string
  control: SettingControl
  value: unknown
  default: unknown
  options?: SettingOption[]
  min?: number
  max?: number
  deprecated?: boolean
  deprecationMessage?: string
  /** True when the current value differs from the schema default. */
  modified: boolean
}

export interface ValidationResult {
  valid: boolean
  /** The coerced value to store (present even when invalid, best-effort). */
  value: unknown
  error?: string
}

function firstType(t: ConfigProperty["type"]): ConfigType | undefined {
  if (Array.isArray(t)) return t.find((x) => x !== "null") ?? t[0]
  return t
}

/** Infer the UI control for a property. */
export function inferControl(prop: ConfigProperty): SettingControl {
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return "select"
  const t = firstType(prop.type)
  switch (t) {
    case "boolean":
      return "checkbox"
    case "number":
    case "integer":
      return "number"
    case "string":
      return "text"
    case "array":
      // A string[] with an enumerated item set → multi-select; else JSON.
      if (Array.isArray(prop.items?.enum) && prop.items!.enum!.length > 0) return "multiselect"
      return "json"
    case "object":
    case "null":
      return "json"
    default:
      // Infer from default when type is absent.
      if (typeof prop.default === "boolean") return "checkbox"
      if (typeof prop.default === "number") return "number"
      if (typeof prop.default === "string") return "text"
      return "json"
  }
}

const ACRONYMS: Record<string, string> = { id: "ID", url: "URL", json: "JSON", ui: "UI", css: "CSS" }

function titleCaseToken(token: string): string {
  if (!token) return token
  const lower = token.toLowerCase()
  if (ACRONYMS[lower]) return ACRONYMS[lower]
  // camelCase → spaced
  const spaced = token.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  return spaced
    .split(/[\s_-]+/)
    .map((w) => (ACRONYMS[w.toLowerCase()] ?? (w.charAt(0).toUpperCase() + w.slice(1))))
    .join(" ")
}

/** "editor.fontSize" → { category: "Editor", label: "Font Size" }. */
export function humanizeKey(key: string): { category: string; label: string } {
  const safe = typeof key === "string" ? key : ""
  const dot = safe.indexOf(".")
  if (dot === -1) {
    return { category: "General", label: titleCaseToken(safe) || "General" }
  }
  const category = titleCaseToken(safe.slice(0, dot))
  const label = titleCaseToken(safe.slice(dot + 1).replace(/\./g, " "))
  return { category, label }
}

/** Are two setting values equal (deep-ish, JSON-comparable)? */
export function settingValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }
  return false
}

function buildOptions(prop: ConfigProperty): SettingOption[] | undefined {
  // Top-level enum → single-select options.
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    const desc = Array.isArray(prop.enumDescriptions) ? prop.enumDescriptions : []
    return prop.enum.map((value, i) => ({
      value,
      label: typeof value === "string" ? value : String(value),
      description: desc[i],
    }))
  }
  // Array items enum → multi-select options.
  const itemEnum = prop.items?.enum
  if (Array.isArray(itemEnum) && itemEnum.length > 0) {
    const desc = Array.isArray(prop.items?.enumDescriptions) ? prop.items!.enumDescriptions! : []
    return itemEnum.map((value, i) => ({
      value,
      label: typeof value === "string" ? value : String(value),
      description: desc[i],
    }))
  }
  return undefined
}

/**
 * Build the ordered, category-grouped form model from a schema + the
 * current values. The effective `value` is the current value when present,
 * else the schema default. Fields are sorted by (category, order, label).
 * Unknown/empty schema → empty array (never throws).
 */
export function buildSettingsForm(
  schema: ConfigSchema | null | undefined,
  values: Record<string, unknown> = {},
): SettingField[] {
  const props = schema && schema.properties && typeof schema.properties === "object" ? schema.properties : null
  if (!props) return []
  const vals = values && typeof values === "object" ? values : {}

  const fields: (SettingField & { _order: number })[] = []
  for (const key of Object.keys(props)) {
    const prop = props[key] ?? {}
    const { category, label } = humanizeKey(key)
    const hasValue = Object.prototype.hasOwnProperty.call(vals, key)
    const value = hasValue ? vals[key] : prop.default
    fields.push({
      key,
      category,
      label: prop.title ? titleCaseToken(prop.title) : label,
      description: prop.markdownDescription ?? prop.description,
      control: inferControl(prop),
      value,
      default: prop.default,
      options: buildOptions(prop),
      min: typeof prop.minimum === "number" ? prop.minimum : undefined,
      max: typeof prop.maximum === "number" ? prop.maximum : undefined,
      deprecated: typeof prop.deprecationMessage === "string" && prop.deprecationMessage.length > 0,
      deprecationMessage: prop.deprecationMessage,
      modified: hasValue && !settingValuesEqual(value, prop.default),
      _order: typeof prop.order === "number" ? prop.order : Number.MAX_SAFE_INTEGER,
    })
  }

  fields.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category)
    if (a._order !== b._order) return a._order - b._order
    return a.label.localeCompare(b.label)
  })
  return fields.map(({ _order, ...f }) => f)
}

/** Distinct categories in form order. */
export function settingsCategories(fields: SettingField[]): string[] {
  const seen: string[] = []
  for (const f of fields) if (!seen.includes(f.category)) seen.push(f.category)
  return seen
}

/**
 * Validate + coerce an edited value for a property. Returns the value to
 * store plus a human error message when invalid. Coercion is forgiving
 * (numeric strings → numbers, "true"/"false" → booleans) so a form input
 * that hands back strings still produces correctly-typed settings.
 */
export function validateSettingValue(prop: ConfigProperty, raw: unknown): ValidationResult {
  const t = firstType(prop.type)

  // Enum: value must be one of the allowed options (after loose match).
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    if (prop.enum.some((e) => settingValuesEqual(e, raw))) return { valid: true, value: raw }
    // try string-equality fallback (form selects hand back strings)
    const match = prop.enum.find((e) => String(e) === String(raw))
    if (match !== undefined) return { valid: true, value: match }
    return { valid: false, value: raw, error: `Value must be one of: ${prop.enum.map(String).join(", ")}` }
  }

  if (t === "boolean") {
    if (typeof raw === "boolean") return { valid: true, value: raw }
    if (raw === "true") return { valid: true, value: true }
    if (raw === "false") return { valid: true, value: false }
    return { valid: false, value: raw, error: "Expected true or false" }
  }

  if (t === "number" || t === "integer") {
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN
    if (!Number.isFinite(n)) return { valid: false, value: raw, error: "Expected a number" }
    if (t === "integer" && !Number.isInteger(n)) {
      return { valid: false, value: n, error: "Expected a whole number" }
    }
    if (typeof prop.minimum === "number" && n < prop.minimum) {
      return { valid: false, value: n, error: `Must be ≥ ${prop.minimum}` }
    }
    if (typeof prop.maximum === "number" && n > prop.maximum) {
      return { valid: false, value: n, error: `Must be ≤ ${prop.maximum}` }
    }
    return { valid: true, value: n }
  }

  if (t === "string") {
    if (typeof raw === "string") return { valid: true, value: raw }
    if (raw == null) return { valid: true, value: "" }
    return { valid: true, value: String(raw) }
  }

  // Array with an enumerated item set → multi-select. Coerce a lone value
  // to a single-element array, dedupe, and require every member to be in
  // the allowed set.
  const itemEnum = prop.items?.enum
  if (t === "array" && Array.isArray(itemEnum) && itemEnum.length > 0) {
    const arr = Array.isArray(raw) ? raw : raw == null || raw === "" ? [] : [raw]
    const seen: unknown[] = []
    for (const el of arr) if (!seen.some((s) => settingValuesEqual(s, el))) seen.push(el)
    const invalid = seen.filter((el) => !itemEnum.some((e) => settingValuesEqual(e, el)))
    if (invalid.length > 0) {
      return { valid: false, value: seen, error: `Allowed values: ${itemEnum.map(String).join(", ")}` }
    }
    return { valid: true, value: seen }
  }

  // array/object/unknown → accept as-is (the JSON control governs it).
  return { valid: true, value: raw }
}

/**
 * The persistence payload: only the keys whose value differs from the
 * schema default. Mirrors VS Code, which never writes defaults to
 * settings.json. Keys absent from the schema are passed through (a
 * user-defined setting), since we have no default to compare against.
 */
export function diffSettings(
  values: Record<string, unknown> | null | undefined,
  schema: ConfigSchema | null | undefined,
): Record<string, unknown> {
  const vals = values && typeof values === "object" ? values : {}
  const props = schema && schema.properties && typeof schema.properties === "object" ? schema.properties : {}
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(vals)) {
    const prop = props[key]
    if (!prop) {
      out[key] = vals[key]
      continue
    }
    if (!settingValuesEqual(vals[key], prop.default)) out[key] = vals[key]
  }
  return out
}
