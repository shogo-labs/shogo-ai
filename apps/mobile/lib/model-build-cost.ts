// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Relative build-cost copy for model pickers.
 *
 * Other apps (Cursor Auto Cost/Balance/Intelligence, ChatGPT model menus)
 * avoid fake dollar prices. They rank options as cheaper / standard /
 * higher-cost so people can tell what they are trading without a price list.
 */
import type { ModelTier } from "@shogo/model-catalog"

export const MODEL_COST_RANK: Record<ModelTier, number> = {
  economy: 0,
  standard: 1,
  premium: 2,
}

export const MODEL_COST_LABEL: Record<ModelTier, string> = {
  economy: "Cheaper",
  standard: "Standard",
  premium: "Higher cost",
}

export const MODEL_COST_DETAIL: Record<ModelTier, string> = {
  economy: "Uses fewer credits per step",
  standard: "Balanced cost and quality",
  premium: "Most capable — uses more credits",
}

export const MODEL_COST_BADGE_CLASS: Record<ModelTier, string> = {
  economy: "text-emerald-500",
  standard: "text-muted-foreground",
  premium: "text-amber-500",
}

export function modelCostHint(tier: ModelTier, comparedTo?: ModelTier): string {
  if (comparedTo && comparedTo !== tier) {
    if (MODEL_COST_RANK[tier] < MODEL_COST_RANK[comparedTo]) {
      return "Lower cost than your current pick"
    }
    if (MODEL_COST_RANK[tier] > MODEL_COST_RANK[comparedTo]) {
      return "Higher cost than your current pick"
    }
  }
  return MODEL_COST_DETAIL[tier]
}

export function formatBuildModelChip(shortName: string, tier: ModelTier): string {
  return `${shortName} · ${MODEL_COST_LABEL[tier]}`
}

/** Native phone sheets and plan pickers show model names only. */
export function modelPickerHidesCostLabels(
  hideCostLabels: boolean,
  presentation: "menu" | "sheet",
): boolean {
  return hideCostLabels || presentation === "sheet"
}
