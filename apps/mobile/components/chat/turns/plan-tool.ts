// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

const PLAN_FILEPATH_PATTERN = /\.shogo[\\/]+plans[\\/]+([a-zA-Z0-9._-]+\.plan\.md)/

/**
 * The runtime returns plan paths in several result shapes depending on whether
 * the tool call came from a live stream or persisted message history.
 */
export function extractPlanFilepath(result: unknown): string | undefined {
  const directPath =
    result &&
    typeof result === "object" &&
    "filepath" in result &&
    typeof result.filepath === "string"
      ? result.filepath
      : undefined

  const text = directPath ?? stringifyPlanResult(result)
  const match = text.match(PLAN_FILEPATH_PATTERN)
  return match?.[1] ? `.shogo/plans/${match[1]}` : undefined
}

function stringifyPlanResult(value: unknown): string {
  if (typeof value === "string") return value
  if (value == null) return ""

  if (Array.isArray(value)) {
    return value.map(stringifyPlanResult).join("\n")
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const preferredFields = ["text", "content", "details", "output", "result"]
    const preferredText = preferredFields
      .map((field) => record[field])
      .filter((field) => field != null)
      .map(stringifyPlanResult)
      .join("\n")

    if (preferredText) return preferredText

    try {
      return JSON.stringify(value)
    } catch {
      return ""
    }
  }

  return String(value)
}
