// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ToolCallData } from "../tools/types"

function resultObject(result: unknown): Record<string, unknown> | null {
  if (result && typeof result === "object") return result as Record<string, unknown>
  if (typeof result !== "string") return null
  try {
    const parsed = JSON.parse(result)
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

/** A `publish` call the Pro-plan gate refused (`code: "plan_not_allowed"`). */
export function isPublishPlanGate(tool: Pick<ToolCallData, "toolName" | "result">): boolean {
  return tool.toolName === "publish" && resultObject(tool.result)?.code === "plan_not_allowed"
}
