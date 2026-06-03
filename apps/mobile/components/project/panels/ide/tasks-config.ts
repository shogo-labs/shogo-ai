// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FEAT-TASKS — tasks.json / launch.json model.
 *
 * Shogo had no task runner. VS Code reads `.vscode/tasks.json` (custom
 * build/test tasks with presentation + problem matchers) and
 * `.vscode/launch.json` (debug/run configurations), substitutes
 * `${...}` variables, resolves the command line, and runs tasks honouring
 * `dependsOn` ordering. This module is the pure, side-effect-free model
 * behind all of that, mirroring the extraction pattern of the other ide/
 * helpers (fzf-scorer, keybindings, settings-form, …): no React, no child
 * process, no fs. The task UI renders what this computes and the runner
 * executes the resolved command line; problem-matching lives in the
 * sibling `problem-matcher.ts`.
 *
 * What lives here:
 *   • The VS Code-shaped task/launch types + defaults.
 *   • `parseTasksConfig` / `parseLaunchConfig` — defensive, normalising
 *     parsers (accept a JSON string or object; drop invalid entries;
 *     fill defaults) that never throw.
 *   • `resolveVariables` — `${workspaceFolder}`, `${file}` family,
 *     `${env:NAME}`, `${cwd}`, `${pathSeparator}`, … with unknown
 *     variables left untouched (VS Code behaviour).
 *   • `resolveTaskCommand` — substitute variables and build the executable
 *     form: a single POSIX-quoted shell string for `type:"shell"`, or a
 *     command + argv array for `type:"process"`.
 *   • Lookups: `findTask`, `tasksInGroup`, `defaultTaskForGroup`.
 *   • `resolveDependsOrder` — flatten a task's `dependsOn` graph into an
 *     execution order with cycle detection and a list of missing refs.
 *
 * Deliberately NOT here: process spawning, fs, React, DOM.
 */

export type TaskType = "shell" | "process"
export type TaskGroupKind = "build" | "test" | "none"
export type RevealKind = "always" | "silent" | "never"
export type PanelKind = "shared" | "dedicated" | "new"
export type DependsOrder = "parallel" | "sequence"

export interface PresentationOptions {
  reveal: RevealKind
  echo: boolean
  focus: boolean
  panel: PanelKind
  clear: boolean
  showReuseMessage: boolean
}

export interface TaskGroup {
  kind: TaskGroupKind
  isDefault: boolean
}

export interface TaskOptions {
  cwd?: string
  env?: Record<string, string>
}

export interface TaskDefinition {
  label: string
  type: TaskType
  command: string
  args: string[]
  group: TaskGroup
  presentation: PresentationOptions
  options?: TaskOptions
  /** Named matcher refs (e.g. "$tsc") and/or "$inline" for object matchers. */
  problemMatchers: string[]
  isBackground: boolean
  dependsOn: string[]
  dependsOrder: DependsOrder
}

export interface TasksConfig {
  version: string
  tasks: TaskDefinition[]
}

export const DEFAULT_TASK_TYPE: TaskType = "shell"

export const DEFAULT_PRESENTATION: Readonly<PresentationOptions> = Object.freeze({
  reveal: "always",
  echo: true,
  focus: false,
  panel: "shared",
  clear: false,
  showReuseMessage: true,
})

// ── small coercers ────────────────────────────────────────────────────────

function asObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(stripJsonComments(raw))
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null
}

/** Strip // line and /* *\/ block comments — tasks.json is JSONC. */
function stripJsonComments(text: string): string {
  let out = ""
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (inLine) {
      if (c === "\n") { inLine = false; out += c }
      continue
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i++ }
      continue
    }
    if (inString) {
      out += c
      if (c === "\\") { out += next ?? ""; i++ } else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; out += c; continue }
    if (c === "/" && next === "/") { inLine = true; i++; continue }
    if (c === "/" && next === "*") { inBlock = true; i++; continue }
    out += c
  }
  return out
}

function coerceBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v
  if (v === "true") return true
  if (v === "false") return false
  return fallback
}

function coerceStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string")
  if (typeof v === "string") return [v]
  return []
}

function coerceEnv(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val
    else if (typeof val === "number" || typeof val === "boolean") out[k] = String(val)
  }
  return out
}

function parsePresentation(v: unknown): PresentationOptions {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  const reveal = o.reveal === "silent" || o.reveal === "never" ? o.reveal : DEFAULT_PRESENTATION.reveal
  const panel = o.panel === "dedicated" || o.panel === "new" ? o.panel : DEFAULT_PRESENTATION.panel
  return {
    reveal,
    panel,
    echo: coerceBool(o.echo, DEFAULT_PRESENTATION.echo),
    focus: coerceBool(o.focus, DEFAULT_PRESENTATION.focus),
    clear: coerceBool(o.clear, DEFAULT_PRESENTATION.clear),
    showReuseMessage: coerceBool(o.showReuseMessage, DEFAULT_PRESENTATION.showReuseMessage),
  }
}

function parseGroup(v: unknown): TaskGroup {
  if (v === "build" || v === "test") return { kind: v, isDefault: false }
  if (v === "none") return { kind: "none", isDefault: false }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    const kind = o.kind === "build" || o.kind === "test" ? o.kind : "none"
    return { kind, isDefault: coerceBool(o.isDefault, false) }
  }
  return { kind: "none", isDefault: false }
}

function parseProblemMatchers(v: unknown): string[] {
  const items = Array.isArray(v) ? v : v == null ? [] : [v]
  const out: string[] = []
  for (const it of items) {
    if (typeof it === "string") out.push(it)
    else if (it && typeof it === "object") {
      const o = it as Record<string, unknown>
      // Reference an inline matcher by its base ("$tsc") or owner, else mark inline.
      if (typeof o.base === "string") out.push(o.base)
      else if (typeof o.owner === "string") out.push(o.owner)
      else out.push("$inline")
    }
  }
  return out
}

function parseTask(v: unknown): TaskDefinition | null {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : null
  if (!o) return null
  const command = typeof o.command === "string" ? o.command : ""
  const label = typeof o.label === "string" && o.label.trim() !== "" ? o.label : command
  // A task needs at least a label or a command to be runnable/addressable.
  if (!label && !command) return null
  const type: TaskType = o.type === "process" ? "process" : o.type === "shell" ? "shell" : DEFAULT_TASK_TYPE
  const options: TaskOptions | undefined = (() => {
    const oo = o.options && typeof o.options === "object" ? (o.options as Record<string, unknown>) : null
    if (!oo) return undefined
    const cwd = typeof oo.cwd === "string" ? oo.cwd : undefined
    const env = coerceEnv(oo.env)
    return cwd === undefined && env === undefined ? undefined : { cwd, env }
  })()
  return {
    label,
    type,
    command,
    args: coerceStringArray(o.args),
    group: parseGroup(o.group),
    presentation: parsePresentation(o.presentation),
    options,
    problemMatchers: parseProblemMatchers(o.problemMatcher),
    isBackground: coerceBool(o.isBackground, false),
    dependsOn: coerceStringArray(o.dependsOn),
    dependsOrder: o.dependsOrder === "sequence" ? "sequence" : "parallel",
  }
}

/** Parse + normalise a tasks.json (object or JSONC string). Never throws. */
export function parseTasksConfig(raw: unknown): TasksConfig {
  const root = asObject(raw)
  const version = root && typeof root.version === "string" ? root.version : "2.0.0"
  const rawTasks = root && Array.isArray(root.tasks) ? root.tasks : []
  const tasks: TaskDefinition[] = []
  for (const t of rawTasks) {
    const parsed = parseTask(t)
    if (parsed) tasks.push(parsed)
  }
  return { version, tasks }
}

// ── launch.json ─────────────────────────────────────────────────────────

export interface LaunchConfiguration {
  name: string
  type: string
  request: "launch" | "attach"
  program?: string
  args: string[]
  cwd?: string
  env: Record<string, string>
  preLaunchTask?: string
  postDebugTask?: string
}

export interface LaunchConfig {
  version: string
  configurations: LaunchConfiguration[]
}

function parseLaunchConfiguration(v: unknown): LaunchConfiguration | null {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : null
  if (!o) return null
  const name = typeof o.name === "string" && o.name.trim() !== "" ? o.name : null
  const type = typeof o.type === "string" ? o.type : null
  if (!name || !type) return null
  return {
    name,
    type,
    request: o.request === "attach" ? "attach" : "launch",
    program: typeof o.program === "string" ? o.program : undefined,
    args: coerceStringArray(o.args),
    cwd: typeof o.cwd === "string" ? o.cwd : undefined,
    env: coerceEnv(o.env) ?? {},
    preLaunchTask: typeof o.preLaunchTask === "string" ? o.preLaunchTask : undefined,
    postDebugTask: typeof o.postDebugTask === "string" ? o.postDebugTask : undefined,
  }
}

/** Parse + normalise a launch.json (object or JSONC string). Never throws. */
export function parseLaunchConfig(raw: unknown): LaunchConfig {
  const root = asObject(raw)
  const version = root && typeof root.version === "string" ? root.version : "0.2.0"
  const rawConfigs = root && Array.isArray(root.configurations) ? root.configurations : []
  const configurations: LaunchConfiguration[] = []
  for (const c of rawConfigs) {
    const parsed = parseLaunchConfiguration(c)
    if (parsed) configurations.push(parsed)
  }
  return { version, configurations }
}

export function findLaunchConfiguration(config: LaunchConfig, name: string): LaunchConfiguration | undefined {
  return config.configurations.find((c) => c.name === name)
}

// ── variable substitution ─────────────────────────────────────────────────

export interface VariableContext {
  workspaceFolder?: string
  /** Absolute path of the active file. */
  file?: string
  cwd?: string
  env?: Record<string, string>
  lineNumber?: number
  selectedText?: string
  pathSeparator?: string
}

function basename(p: string, sep: string): string {
  const parts = p.split(sep).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}
function dirname(p: string, sep: string): string {
  const idx = p.lastIndexOf(sep)
  return idx <= 0 ? "" : p.slice(0, idx)
}
function extname(p: string, sep: string): string {
  const base = basename(p, sep)
  const dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(dot) : ""
}

/**
 * Substitute VS Code `${...}` variables in a string. Unknown variables are
 * left verbatim (VS Code behaviour) so nothing is silently dropped.
 */
export function resolveVariables(input: string, context: VariableContext = {}): string {
  if (typeof input !== "string" || input.indexOf("${") === -1) return input
  const sep = context.pathSeparator || "/"
  const wf = context.workspaceFolder ?? ""
  const file = context.file ?? ""

  return input.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    if (name === "/" || name === "pathSeparator") return sep
    if (name.startsWith("env:")) {
      const key = name.slice(4)
      return context.env?.[key] ?? ""
    }
    switch (name) {
      case "workspaceFolder":
        return wf
      case "workspaceFolderBasename":
        return basename(wf, sep)
      case "cwd":
        return context.cwd ?? wf
      case "file":
        return file
      case "fileBasename":
        return basename(file, sep)
      case "fileBasenameNoExtension": {
        const b = basename(file, sep)
        const dot = b.lastIndexOf(".")
        return dot > 0 ? b.slice(0, dot) : b
      }
      case "fileDirname":
        return dirname(file, sep)
      case "fileExtname":
        return extname(file, sep)
      case "relativeFile":
        return wf && file.startsWith(wf + sep) ? file.slice(wf.length + sep.length) : file
      case "relativeFileDirname": {
        const rel = wf && file.startsWith(wf + sep) ? file.slice(wf.length + sep.length) : file
        return dirname(rel, sep)
      }
      case "lineNumber":
        return context.lineNumber != null ? String(context.lineNumber) : whole
      case "selectedText":
        return context.selectedText ?? ""
      default:
        return whole // unknown → leave untouched
    }
  })
}

// ── command resolution ─────────────────────────────────────────────────────

/** POSIX single-quote an argument if it contains whitespace or shell metachars. */
export function shellQuote(arg: string): string {
  if (arg === "") return "''"
  if (/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(arg)) return arg
  return "'" + arg.replace(/'/g, "'\\''") + "'"
}

export interface ResolvedCommand {
  /** The program to execute (resolved). */
  command: string
  /** The resolved argument vector. */
  args: string[]
  /** The full command line: a quoted shell string (shell) or program + args joined (process). */
  commandLine: string
  cwd?: string
  env?: Record<string, string>
  shell: boolean
}

/**
 * Resolve a task into an executable form: substitute variables in the
 * command, args, cwd and env, then build the command line — a single
 * POSIX-quoted shell string for `type:"shell"`, or program + raw argv for
 * `type:"process"`.
 */
export function resolveTaskCommand(task: TaskDefinition, context: VariableContext = {}): ResolvedCommand {
  const command = resolveVariables(task.command, context)
  const args = task.args.map((a) => resolveVariables(a, context))
  const cwd = task.options?.cwd ? resolveVariables(task.options.cwd, context) : undefined
  const env = task.options?.env
    ? Object.fromEntries(Object.entries(task.options.env).map(([k, v]) => [k, resolveVariables(v, context)]))
    : undefined
  const shell = task.type === "shell"
  const commandLine = shell
    ? [command, ...args].filter((s) => s !== "").map(shellQuote).join(" ")
    : [command, ...args].filter((s) => s !== "").join(" ")
  return { command, args, commandLine, cwd, env, shell }
}

// ── lookups ────────────────────────────────────────────────────────────────

export function findTask(config: TasksConfig, label: string): TaskDefinition | undefined {
  return config.tasks.find((t) => t.label === label)
}

export function tasksInGroup(config: TasksConfig, kind: TaskGroupKind): TaskDefinition[] {
  return config.tasks.filter((t) => t.group.kind === kind)
}

/** The default task for a group (the `isDefault` one), if any. */
export function defaultTaskForGroup(config: TasksConfig, kind: TaskGroupKind): TaskDefinition | undefined {
  return config.tasks.find((t) => t.group.kind === kind && t.group.isDefault)
}

// ── dependsOn ordering ──────────────────────────────────────────────────────

export interface DependsResolution {
  /** Execution order (dependencies first), ending with the requested task. */
  order: string[]
  hasCycle: boolean
  /** dependsOn labels that don't resolve to a known task. */
  missing: string[]
}

/**
 * Flatten a task's `dependsOn` graph into a post-order execution sequence
 * (dependencies before dependents), detecting cycles and collecting any
 * dependsOn labels that reference an unknown task. The requested task is
 * always last in `order` (unless it doesn't exist → empty order).
 */
export function resolveDependsOrder(config: TasksConfig, label: string): DependsResolution {
  const order: string[] = []
  const missing: string[] = []
  let hasCycle = false
  const visiting = new Set<string>()
  const done = new Set<string>()

  const visit = (lbl: string) => {
    if (done.has(lbl)) return
    if (visiting.has(lbl)) { hasCycle = true; return }
    const task = findTask(config, lbl)
    if (!task) { if (!missing.includes(lbl)) missing.push(lbl); return }
    visiting.add(lbl)
    for (const dep of task.dependsOn) visit(dep)
    visiting.delete(lbl)
    done.add(lbl)
    order.push(lbl)
  }

  if (!findTask(config, label)) return { order: [], hasCycle: false, missing: [] }
  visit(label)
  return { order, hasCycle, missing }
}
