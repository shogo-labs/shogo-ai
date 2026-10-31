// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure helpers for "build brief" user messages: the idea a user types in
 * onboarding's "What do you want to build?" step, wrapped with instructions
 * for the workspace agent to research and plan before building.
 *
 * Like the ask_user answer marker, the marker is part of the message text so
 * persisted chats can show just the idea without a metadata channel. The agent
 * receives the full text, instructions included.
 */

const BUILD_BRIEF_MARKER = "::Build Brief::"
const BUILD_BRIEF_PATTERN = /^::Build Brief::(?:\r?\n|$)/
const INSTRUCTIONS_SEPARATOR = "\n\n---\n"

const BUILD_BRIEF_INSTRUCTIONS = `Build a first working version of this in this turn. Do not plan it back to me first.
1. Make reasonable assumptions and build something I can look at now: a project with a preview, an agent, or a workflow that runs.
2. Share the preview link as soon as it works, so I can open what you made.
3. Then state the assumptions you made in 2-4 short bullets.
4. Then ask at most 3 short questions that would shape the next version.
Keep any research to a sentence or two. Never open with plan limits, pricing, or capabilities that are switched off.`

export function buildBuildBriefMessage(idea: string): string {
  return `${BUILD_BRIEF_MARKER}\n${idea.trim()}${INSTRUCTIONS_SEPARATOR}${BUILD_BRIEF_INSTRUCTIONS}`
}

/** The user's idea from a build brief message, or null for other text. */
export function parseBuildBriefMessage(text: string): string | null {
  const match = text.match(BUILD_BRIEF_PATTERN)
  if (!match) return null
  const body = text.slice(match[0].length)
  const separator = body.indexOf(INSTRUCTIONS_SEPARATOR)
  const idea = (separator === -1 ? body : body.slice(0, separator)).trim()
  return idea || null
}

/** The user's idea for a build brief message; other text is returned unchanged. */
export function stripBuildBriefMarker(text: string): string {
  return parseBuildBriefMessage(text) ?? text
}
