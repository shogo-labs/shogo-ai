// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useState } from "react"

/**
 * Keeps a plan's Build model selection in sync with the selected chat model
 * when a new plan is shown, while preserving an explicit user choice.
 */
export function usePlanBuildModel(
  selectedModel: string | undefined,
  planKey: string | undefined,
): [string, (modelId: string) => void] {
  const [buildModelId, setBuildModelId] = useState(selectedModel ?? "")

  useEffect(() => {
    setBuildModelId(selectedModel ?? "")
  }, [planKey, selectedModel])

  return [buildModelId, setBuildModelId]
}
