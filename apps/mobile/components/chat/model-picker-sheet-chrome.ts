// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Native model bottom-sheet type. The web popover stays compact; this is
 * sized for thumb reach (iOS body 17pt, meta 15pt).
 */
export const NATIVE_MODEL_SHEET = {
  nameClass: "text-[17px]",
  metaClass: "text-[15px]",
  detailClass: "text-[15px] leading-5",
  rowClass: "min-h-16 py-3.5",
  icon: 22,
  manageIcon: 18,
} as const
