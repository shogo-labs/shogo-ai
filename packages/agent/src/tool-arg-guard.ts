// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Empty-argument guard for tool calls.
 *
 * pi-agent-core validates tool arguments against each tool's TypeBox schema,
 * but `Type.String()` accepts `""`. A model that loses its tool-call arguments
 * (e.g. plans a heredoc in its thinking, then sends `exec {"command": ""}`)
 * therefore reaches `execute` with an empty required string and the tool runs
 * the empty value — `exec ""` exits 0 with no output, which reads as success
 * and tells the model nothing was lost.
 *
 * This module finds required *string* properties that are missing or blank so
 * the orchestration wrapper can reject the call before it runs. It is driven
 * purely by the tool's schema: no tool-specific code, so every tool (gateway,
 * MCP, composio) is covered by the same rule.
 *
 * Scope is deliberately narrow and fails open:
 * - only top-level `required` string properties are checked (no recursion);
 * - optional properties, non-string required properties and schemas without a
 *   usable `properties`/`required` pair are never flagged;
 * - a property whose schema says `'x-empty-ok': true` is exempt, for the few
 *   tools where an empty string is a real argument rather than a lost one
 *   (`edit_file.old_string` creates a file, `edit_file.new_string` deletes
 *   text, `write_file.content` writes an empty file).
 */

type JsonSchema = Record<string, unknown>

function isSchemaObject(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Required top-level properties of `schema` whose own schema is `type: "string"`.
 * Computed once per tool at wrap time, then reused on every call.
 *
 * A property that declares `'x-empty-ok': true` is left out: for those, `""` is
 * a real argument, not a lost one.
 */
export function requiredStringProps(schema: unknown): string[] {
  if (!isSchemaObject(schema)) return []
  // A union at the root has no single `required` list to trust — fail open.
  if ('anyOf' in schema || 'oneOf' in schema) return []

  const { properties, required } = schema
  if (!isSchemaObject(properties) || !Array.isArray(required)) return []

  const names: string[] = []
  for (const name of required) {
    if (typeof name !== 'string') continue
    const prop = properties[name]
    if (!isSchemaObject(prop) || prop.type !== 'string') continue
    if (prop['x-empty-ok'] === true) continue
    names.push(name)
  }
  return names
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  return typeof value === 'string' && value.trim() === ''
}

/**
 * Which of the already-known required string names are missing or blank in
 * `params`. Empty list means the call may proceed.
 */
export function findEmptyFromNames(
  requiredNames: readonly string[],
  params: unknown,
): string[] {
  if (requiredNames.length === 0) return []
  const args = isSchemaObject(params) ? params : {}
  return requiredNames.filter((name) => isEmptyValue(args[name]))
}

/** Convenience form for callers that only have the schema. */
export function findEmptyRequiredArgs(schema: unknown, params: unknown): string[] {
  return findEmptyFromNames(requiredStringProps(schema), params)
}

/** The error text a rejected call returns to the model. */
export function emptyArgsMessage(toolName: string, names: readonly string[]): string {
  const quoted = names.map((name) => `'${name}'`)
  const subject = quoted.length === 1
    ? `required argument ${quoted[0]} was empty`
    : `required arguments ${quoted.join(', ')} were empty`
  return `${toolName}: ${subject}. Your tool-call arguments were lost; resend the call with the content, or write large payloads with write_file.`
}
