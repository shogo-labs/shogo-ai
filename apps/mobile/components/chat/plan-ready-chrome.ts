// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Named sizes for the native Plan Ready oval and sheet footer chips.
 * Values match the shipped UI — do not retune here without a visual pass.
 */
import { COMPACT_DENSITY, PHONE_DENSITY } from "../../lib/phone-density"

export const PLAN_READY_CHIP_HEIGHT = "h-10"
export const PLAN_READY_COMPACT_CHIP_HEIGHT = "h-8"
export const PLAN_READY_OVAL_BUILD_HEIGHT = "h-9"
export const PLAN_READY_CHIP_TEXT = "text-[15px]"
export const PLAN_READY_CHIP_CHEVRON = PHONE_DENSITY.icon.xs
export const PLAN_READY_COMPACT_CHEVRON = COMPACT_DENSITY.icon.sm
export const PLAN_READY_ROW_CHEVRON = COMPACT_DENSITY.icon.md
export const PLAN_READY_MODEL_TRIGGER_MAX_WIDTH = 168
export const PLAN_READY_OVAL_CLASS = "mx-2 rounded-full px-4 py-2.5"
export const PLAN_READY_STREAM_CLASS = "mx-2 my-1.5 gap-2.5 rounded-2xl px-3 py-3"
export const PLAN_READY_STREAM_ICON_WELL =
  "h-9 w-9 items-center justify-center rounded-xl bg-primary/10"
export const PLAN_READY_KICKER_CLASS =
  "text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
export const PLAN_READY_WEB_ICON_WELL =
  "h-7 w-7 items-center justify-center rounded-lg bg-primary/10"
export const PLAN_READY_WEB_KICKER_CLASS =
  "text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
