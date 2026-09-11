// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Type scale for Account-hosted settings sheets. Desktop Settings tabs
 * keep `text-sm` / 14px icons; the same bodies bump one step on phone.
 */

/** Lucide default when `size` is omitted. */
export const ACCOUNT_SHEET_ICON_DEFAULT = 24
/** 14 → 19, 16 → 22, 20 → 27, 24 → 32. */
export const ACCOUNT_SHEET_ICON_SCALE = 1.35

const TEXT_SIZE_CLASS: Record<string, string> = {
  'text-[10px]': 'text-sm',
  'text-[11px]': 'text-sm',
  'text-xs': 'text-base',
  'text-sm': 'text-lg',
  'text-base': 'text-xl',
  'text-lg': 'text-xl',
  'text-xl': 'text-2xl',
  'text-2xl': 'text-3xl',
}

export function remapAccountSheetTextClass(
  className: string | undefined,
): string | undefined {
  if (!className) return className
  return className
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => TEXT_SIZE_CLASS[token] ?? token)
    .join(' ')
}

export function scaleAccountSheetIcon(size: number): number {
  return Math.round(size * ACCOUNT_SHEET_ICON_SCALE)
}
