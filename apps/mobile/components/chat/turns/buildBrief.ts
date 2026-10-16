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

const BUILD_BRIEF_INSTRUCTIONS = `Before building anything, research this and put a plan together:
1. Ask me up to 3 short clarifying questions only if something essential is ambiguous; otherwise state your assumptions.
2. Research the problem space: who it's for, comparable tools or approaches, and the integrations or data sources it would need.
3. Propose a concrete plan: the agents, apps, and workflows to create in this workspace, what each does, and the tools or integrations each needs.
4. Lay out the first steps you'd take, then ask me to confirm before you start building.
Keep it skimmable: headings and short bullets, no walls of text.`

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
