// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which Anthropic models require the adaptive thinking API
 * (`thinking.type: "adaptive"` + `output_config.effort`) and reject the
 * legacy budget-based `thinking.type: "enabled"` block with a 400.
 *
 * Substring markers rather than exact ids because DB-defined rows can carry
 * upstream names the static catalog doesn't list (dated snapshots, legacy
 * rows such as `claude-opus-4-8`).
 *
 * The pi-ai patch (patches/@mariozechner%2Fpi-ai@0.73.1.patch) keeps its own
 * copy inside the vendored `supportsAdaptiveThinking`; thinking.test.ts fails
 * when the two drift, and when a catalog entry's `thinkingApi` disagrees
 * with these markers.
 */
export const ADAPTIVE_THINKING_MODEL_MARKERS: readonly string[] = [
  'opus-4-6',
  'opus-4.6',
  'opus-4-7',
  'opus-4.7',
  'opus-4-8',
  'opus-4.8',
  'opus-5',
  'sonnet-4-6',
  'sonnet-4.6',
  'sonnet-5',
  'haiku-5',
  'fable-5-1',
  'fable-5.1',
]

/** True when `apiModel` (an upstream Anthropic model name) requires adaptive thinking. */
export function supportsAdaptiveThinking(apiModel: string): boolean {
  return ADAPTIVE_THINKING_MODEL_MARKERS.some((marker) => apiModel.includes(marker))
}
