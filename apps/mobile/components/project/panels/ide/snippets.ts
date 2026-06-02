// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FEAT-SNIPPETS — user / project / extension snippet model.
 *
 * Shogo only had the built-in (LSP-provided) language snippets. VS Code
 * additionally loads user snippets from JSON: per-language files
 * (`javascript.json`) and global `*.code-snippets` files with a `scope`,
 * plus extension-contributed snippets — all sharing the same shape:
 *
 *     { "For Loop": { "prefix": "for", "body": ["for (...) {", "\t$0", "}"],
 *                     "description": "...", "scope": "javascript,typescript" } }
 *
 * This module is the pure, side-effect-free snippet engine: parse those
 * JSON(C) files into definitions, merge sources by precedence, filter by
 * language, match by typed prefix, and tokenise/resolve snippet bodies
 * (tabstops `$1`, placeholders `${1:foo}`, choices `${1|a,b|}`, variables
 * `$TM_FILENAME`). Mirrors the other ide/ helpers — no React, no fs, no
 * Monaco. The completion provider maps the result into Monaco items;
 * Monaco itself expands the tabstops at insert time.
 *
 * Deliberately NOT here: fs, Monaco, React, DOM.
 */

export type SnippetSourceKind = "user" | "project" | "extension" | "builtin"

export interface SnippetDefinition {
  /** The snippet's display name (the JSON key). */
  name: string
  /** Trigger prefixes (VS Code allows a string or an array). */
  prefixes: string[]
  /** Body with lines joined by "\n". */
  body: string
  description: string
  /** Language ids this applies to, or null = all languages. */
  scopes: string[] | null
  source: SnippetSourceKind
}

export interface ParseSnippetsOptions {
  /** Per-language file (e.g. "javascript.json") → default scope for entries without one. */
  language?: string
  source?: SnippetSourceKind
}

// ── JSONC ────────────────────────────────────────────────────────────────

function stripJsonComments(text: string): string {
  let out = ""
  let inString = false, inLine = false, inBlock = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1]
    if (inLine) { if (c === "\n") { inLine = false; out += c } continue }
    if (inBlock) { if (c === "*" && next === "/") { inBlock = false; i++ } continue }
    if (inString) { out += c; if (c === "\\") { out += next ?? ""; i++ } else if (c === '"') inString = false; continue }
    if (c === '"') { inString = true; out += c; continue }
    if (c === "/" && next === "/") { inLine = true; i++; continue }
    if (c === "/" && next === "*") { inBlock = true; i++; continue }
    out += c
  }
  return out
}

function asObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(stripJsonComments(raw))
      return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null
    } catch { return null }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
}

function coerceStringArray(v: unknown): string[] {
  if (typeof v === "string") return v === "" ? [] : [v]
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x !== "")
  return []
}

function parseScopes(v: unknown, fallbackLanguage?: string): string[] | null {
  if (typeof v === "string" && v.trim() !== "") {
    return v.split(",").map((s) => s.trim()).filter(Boolean)
  }
  if (Array.isArray(v)) {
    const arr = v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((s) => s.trim())
    return arr.length ? arr : fallbackLanguage ? [fallbackLanguage] : null
  }
  return fallbackLanguage ? [fallbackLanguage] : null
}

/**
 * Parse one snippets JSON(C) file into definitions. For a per-language
 * file pass `{ language }` so entries without an explicit `scope` default
 * to that language; global `.code-snippets` files omit it (entries without
 * scope apply to all languages). Invalid entries are dropped; never throws.
 */
export function parseSnippetsFile(raw: unknown, options: ParseSnippetsOptions = {}): SnippetDefinition[] {
  const root = asObject(raw)
  if (!root) return []
  const source = options.source ?? "user"
  const out: SnippetDefinition[] = []
  for (const [name, value] of Object.entries(root)) {
    const o = value && typeof value === "object" ? (value as Record<string, unknown>) : null
    if (!o) continue
    const prefixes = coerceStringArray(o.prefix)
    const body = Array.isArray(o.body) ? o.body.filter((s) => typeof s === "string").join("\n") : typeof o.body === "string" ? o.body : ""
    if (prefixes.length === 0 || body === "") continue
    out.push({
      name,
      prefixes,
      body,
      description: typeof o.description === "string" ? o.description : "",
      scopes: parseScopes(o.scope, options.language),
      source,
    })
  }
  return out
}

// ── registry: merge + filter + match ───────────────────────────────────────

const SOURCE_PRIORITY: Record<SnippetSourceKind, number> = { user: 0, project: 1, extension: 2, builtin: 3 }

/**
 * Merge several snippet lists into one, ordered by source precedence
 * (user > project > extension > builtin), stable within a source.
 */
export function mergeSnippets(...lists: SnippetDefinition[][]): SnippetDefinition[] {
  const all = lists.flat()
  return all
    .map((d, i) => ({ d, i }))
    .sort((a, b) => (SOURCE_PRIORITY[a.d.source] - SOURCE_PRIORITY[b.d.source]) || a.i - b.i)
    .map((w) => w.d)
}

/** Snippets that apply to a language (scope null = all). */
export function snippetsForLanguage(defs: SnippetDefinition[], languageId: string): SnippetDefinition[] {
  return defs.filter((d) => d.scopes === null || d.scopes.includes(languageId))
}

/**
 * Match snippets for the language whose prefix begins with the typed word
 * (case-insensitive). An empty word matches all in-language snippets.
 * Results are ordered: exact prefix match first, then by prefix length,
 * then by source precedence, then name.
 */
export function matchSnippets(defs: SnippetDefinition[], word: string, languageId: string): SnippetDefinition[] {
  const inLang = snippetsForLanguage(defs, languageId)
  const w = (word ?? "").toLowerCase()
  const scored: { d: SnippetDefinition; prefix: string; exact: boolean }[] = []
  for (const d of inLang) {
    let best: { prefix: string; exact: boolean } | null = null
    for (const p of d.prefixes) {
      const pl = p.toLowerCase()
      if (w === "" || pl.startsWith(w)) {
        const exact = pl === w
        if (!best || (exact && !best.exact) || (!best.exact && p.length < best.prefix.length)) {
          best = { prefix: p, exact }
        }
      }
    }
    if (best) scored.push({ d, prefix: best.prefix, exact: best.exact })
  }
  return scored
    .sort((a, b) =>
      (Number(b.exact) - Number(a.exact)) ||
      (a.prefix.length - b.prefix.length) ||
      (SOURCE_PRIORITY[a.d.source] - SOURCE_PRIORITY[b.d.source]) ||
      a.d.name.localeCompare(b.d.name),
    )
    .map((s) => s.d)
}

// ── body tokeniser ──────────────────────────────────────────────────────────

export type SnippetToken =
  | { type: "text"; value: string }
  | { type: "tabstop"; index: number }
  | { type: "placeholder"; index: number; value: string }
  | { type: "choice"; index: number; choices: string[] }
  | { type: "variable"; name: string; default?: string }
  | { type: "transform"; index: number; raw: string }

/** Find the index of the matching close brace for an open brace at `open`. */
function matchBrace(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue }
    if (s[i] === "{") depth++
    else if (s[i] === "}") { depth--; if (depth === 0) return i }
  }
  return -1
}

/**
 * Tokenise a snippet body into text / tabstop / placeholder / choice /
 * variable / transform tokens. Handles `\$`, `\}`, `\\` escapes, `$1`,
 * `${1}`, `${1:default}` (with nested tabstops inside the default),
 * `${1|a,b,c|}`, `$VAR`, `${VAR}`, `${VAR:default}`, and detects (but does
 * not execute) `${1/regex/replace/flags}` transforms.
 */
export function parseSnippetBody(body: string): SnippetToken[] {
  const tokens: SnippetToken[] = []
  let text = ""
  const flush = () => { if (text !== "") { tokens.push({ type: "text", value: text }); text = "" } }

  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === "\\") {
      const n = body[i + 1]
      if (n === "$" || n === "}" || n === "\\") { text += n; i++; continue }
      text += c
      continue
    }
    if (c !== "$") { text += c; continue }

    const next = body[i + 1]
    // $1 / $VAR
    if (next !== undefined && next !== "{") {
      const numMatch = /^[0-9]+/.exec(body.slice(i + 1))
      if (numMatch) {
        flush()
        tokens.push({ type: "tabstop", index: Number(numMatch[0]) })
        i += numMatch[0].length
        continue
      }
      const varMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(i + 1))
      if (varMatch) {
        flush()
        tokens.push({ type: "variable", name: varMatch[0] })
        i += varMatch[0].length
        continue
      }
      text += c
      continue
    }
    // ${ ... }
    if (next === "{") {
      const close = matchBrace(body, i + 1)
      if (close === -1) { text += c; continue }
      const inner = body.slice(i + 2, close)
      flush()
      tokens.push(parseBraced(inner))
      i = close
      continue
    }
    text += c
  }
  flush()
  return tokens
}

function parseBraced(inner: string): SnippetToken {
  // numeric tabstop forms
  const num = /^([0-9]+)/.exec(inner)
  if (num) {
    const index = Number(num[1])
    const rest = inner.slice(num[1].length)
    if (rest === "") return { type: "tabstop", index }
    if (rest.startsWith(":")) return { type: "placeholder", index, value: rest.slice(1) }
    if (rest.startsWith("|") && rest.endsWith("|")) {
      return { type: "choice", index, choices: rest.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean) }
    }
    if (rest.startsWith("/")) return { type: "transform", index, raw: inner }
    return { type: "placeholder", index, value: rest }
  }
  // variable forms: ${VAR} / ${VAR:default}
  const v = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(inner)
  if (v) {
    const rest = inner.slice(v[1].length)
    if (rest.startsWith(":")) return { type: "variable", name: v[1], default: rest.slice(1) }
    return { type: "variable", name: v[1] }
  }
  // unrecognised → treat as literal text
  return { type: "text", value: "${" + inner + "}" }
}

/** Distinct tabstop indices used in a body, and whether it has a final $0. */
export function snippetTabstops(body: string): { indices: number[]; hasFinal: boolean } {
  const set = new Set<number>()
  for (const t of parseSnippetBody(body)) {
    if (t.type === "tabstop" || t.type === "placeholder" || t.type === "choice" || t.type === "transform") set.add(t.index)
  }
  return { indices: [...set].sort((a, b) => a - b), hasFinal: set.has(0) }
}

// ── variable resolution ─────────────────────────────────────────────────────

export interface SnippetVariableContext {
  fileName?: string // TM_FILENAME
  filePath?: string // TM_FILEPATH
  selectedText?: string // TM_SELECTED_TEXT
  currentLine?: string // TM_CURRENT_LINE
  lineIndex?: number // TM_LINE_INDEX (0-based)
  clipboard?: string // CLIPBOARD
  workspaceName?: string // WORKSPACE_NAME
  now?: Date
  pathSeparator?: string
}

function baseNoExt(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(0, dot) : name
}
function pad(n: number): string { return n < 10 ? "0" + n : String(n) }

/** Resolve a single known snippet variable to its value, or null if unknown. */
export function resolveSnippetVariable(name: string, ctx: SnippetVariableContext): string | null {
  const sep = ctx.pathSeparator || "/"
  const now = ctx.now ?? new Date()
  switch (name) {
    case "TM_FILENAME": return ctx.fileName ?? ""
    case "TM_FILENAME_BASE": return ctx.fileName ? baseNoExt(ctx.fileName) : ""
    case "TM_FILEPATH": return ctx.filePath ?? ""
    case "TM_DIRECTORY": {
      if (!ctx.filePath) return ""
      const idx = ctx.filePath.lastIndexOf(sep)
      return idx > 0 ? ctx.filePath.slice(0, idx) : ""
    }
    case "TM_SELECTED_TEXT": return ctx.selectedText ?? ""
    case "TM_CURRENT_LINE": return ctx.currentLine ?? ""
    case "TM_LINE_INDEX": return ctx.lineIndex != null ? String(ctx.lineIndex) : ""
    case "TM_LINE_NUMBER": return ctx.lineIndex != null ? String(ctx.lineIndex + 1) : ""
    case "CLIPBOARD": return ctx.clipboard ?? ""
    case "WORKSPACE_NAME": return ctx.workspaceName ?? ""
    case "CURRENT_YEAR": return String(now.getFullYear())
    case "CURRENT_MONTH": return pad(now.getMonth() + 1)
    case "CURRENT_DATE": return pad(now.getDate())
    case "CURRENT_HOUR": return pad(now.getHours())
    case "CURRENT_MINUTE": return pad(now.getMinutes())
    case "CURRENT_SECOND": return pad(now.getSeconds())
    default: return null
  }
}

/**
 * Resolve known editor variables in a body, leaving tabstops / placeholders
 * / choices intact for Monaco to expand. An unknown variable with a default
 * (`${VAR:foo}`) resolves to its default; an unknown bare variable resolves
 * to empty (VS Code behaviour). Escapes are preserved.
 */
export function resolveSnippetVariables(body: string, ctx: SnippetVariableContext = {}): string {
  const tokens = parseSnippetBody(body)
  let out = ""
  for (const t of tokens) {
    switch (t.type) {
      case "text": out += t.value; break
      case "tabstop": out += "$" + t.index; break
      case "placeholder": out += "${" + t.index + ":" + t.value + "}"; break
      case "choice": out += "${" + t.index + "|" + t.choices.join(",") + "|}"; break
      case "transform": out += "${" + t.raw + "}"; break
      case "variable": {
        const resolved = resolveSnippetVariable(t.name, ctx)
        if (resolved !== null) out += resolved
        else out += t.default ?? ""
        break
      }
    }
  }
  return out
}

// ── validation ──────────────────────────────────────────────────────────────

/** Lint a parsed snippet definition; returns human-readable problems ([] = ok). */
export function validateSnippet(def: SnippetDefinition): string[] {
  const problems: string[] = []
  if (def.prefixes.length === 0) problems.push("Snippet has no prefix.")
  if (def.body.trim() === "") problems.push("Snippet has an empty body.")
  // unbalanced ${ braces
  const tokens = parseSnippetBody(def.body)
  const reconstructedHasStrayBrace = /(^|[^\\])\$\{[^}]*$/.test(def.body)
  if (reconstructedHasStrayBrace) problems.push("Unbalanced '${' in body.")
  if (def.scopes !== null && def.scopes.length === 0) problems.push("Empty scope.")
  void tokens
  return problems
}
