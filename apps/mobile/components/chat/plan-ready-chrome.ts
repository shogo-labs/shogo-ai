// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Named sizes for the native Plan Ready oval and sheet footer chips.
 * Values match the shipped UI — do not retune here without a visual pass.
 */
import { COMPACT_DENSITY, PHONE_DENSITY } from "../../lib/phone-density"

export const PLAN_READY_CHIP_HEIGHT = "h-10"
export const PLAN_READY_OVAL_BUILD_HEIGHT = "h-9"
export const PLAN_READY_CHIP_TEXT = "text-[15px]"
export const PLAN_READY_CHIP_CHEVRON = PHONE_DENSITY.icon.xs
export const PLAN_READY_COMPACT_CHEVRON = COMPACT_DENSITY.icon.sm
export const PLAN_READY_ROW_CHEVRON = COMPACT_DENSITY.icon.md
export const PLAN_READY_MODEL_TRIGGER_MAX_WIDTH = 168
