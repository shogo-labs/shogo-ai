// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/** Required-section check for code-change plans written with `create_plan`. */

const hasHeading = (text: string, title: string) =>
  new RegExp(`^#{1,4}\\s+${title.replace(' ', '\\s+')}\\b`, 'im').test(text)

const SOURCE_FILE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|c|cc|cpp|h|hpp|vue|svelte|sql|prisma)\b/
const CODE_PLAN_SECTIONS = ['Root cause', 'Options considered'] as const

/**
 * Sections a code-change plan is missing. A plan "changes code" when it names
 * a source file; plans for other work (a trip, a launch) are left alone.
 */
export function missingCodePlanSections(planMarkdown: string): string[] {
  if (!SOURCE_FILE.test(planMarkdown)) return []
  return CODE_PLAN_SECTIONS.filter((title) => !hasHeading(planMarkdown, title))
}
