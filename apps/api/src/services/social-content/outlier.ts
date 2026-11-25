// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure outlier-scoring helpers for the social_media search action.
 *
 * `median` returns the statistical median of an array of numbers.
 * `outlierScore` returns how many times a post's views exceed its
 * creator's median — the viral-potential signal agents use to find
 * content worth remaking.
 *
 * Both are pure (no I/O, no side effects) so they're trivially testable.
 */

/**
 * Returns the median of `values`, or null when the array is empty.
 * Values are sorted ascending before the midpoint is taken.
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/**
 * Returns `views / medianViews` rounded to 2 decimal places.
 * Returns null when `medianViews` is null, 0 or negative (can't divide).
 */
export function outlierScore(views: number, medianViews: number | null): number | null {
  if (medianViews === null || medianViews <= 0) return null
  return Math.round((views / medianViews) * 100) / 100
}
