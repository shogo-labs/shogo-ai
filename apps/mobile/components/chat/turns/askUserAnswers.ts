// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure helpers for the AskUserQuestion tool's answer messages.
 *
 * The answer marker is intentionally part of the user message so persisted
 * chats can associate the answer with the exact ask_user call without
 * relying on timing or a second metadata channel.
 */

import type { AskUserQuestionItem, AskUserQuestionOption } from "../tools/types"

export interface ParsedAskUserAnswer {
  /** Display label for the selected option or custom answer. */
  label: string
  /** The matching option, when this is a predefined answer. */
  option?: AskUserQuestionOption
  /** Custom text for an Other answer or unrecognized response text. */
  otherText?: string
}

export interface ParsedAskUserQuestionResponse {
  question: AskUserQuestionItem
  answers: ParsedAskUserAnswer[]
}

const ANSWER_MARKER_PREFIX = "::My Answers ["
const ANSWER_MARKER_PATTERN = /^::My Answers \[([^\]]+)\]::(?:\r?\n|$)/

function isValidQuestionItem(item: unknown): item is AskUserQuestionItem {
  if (!item || typeof item !== "object") return false
  const question = item as Record<string, unknown>
  return (
    typeof question.question === "string" &&
    typeof question.header === "string" &&
    Array.isArray(question.options) &&
    (question.multiSelect === undefined ||
      typeof question.multiSelect === "boolean")
  )
}

function isValidOption(option: unknown): option is AskUserQuestionOption {
  if (!option || typeof option !== "object") return false
  const candidate = option as Record<string, unknown>
  return (
    typeof candidate.label === "string" &&
    typeof candidate.description === "string"
  )
}

function normalizeQuestionItem(item: AskUserQuestionItem): AskUserQuestionItem {
  return {
    ...item,
    options: Array.isArray(item.options)
      ? item.options.filter(isValidOption)
      : [],
    multiSelect: item.multiSelect ?? false,
  }
}

export function parseQuestions(
  args?: Record<string, unknown>,
): AskUserQuestionItem[] {
  if (!args?.questions || !Array.isArray(args.questions)) {
    return []
  }

  return args.questions.filter(isValidQuestionItem).map(normalizeQuestionItem)
}

export function formatResponse(
  questions: AskUserQuestionItem[],
  selections: Map<number, string[]>,
  otherTexts: Map<number, string>,
): string {
  const lines: string[] = []

  questions.forEach((question, index) => {
    const selected = selections.get(index) || []
    const otherText = otherTexts.get(index)
    const hasOther = selected.includes("__other__")
    const regularSelections = selected.filter((label) => label !== "__other__")

    let responseLine = ""
    if (questions.length > 1) {
      responseLine = `${question.header}: `
    }

    if (hasOther && otherText?.trim()) {
      if (regularSelections.length > 0) {
        responseLine += `${regularSelections.join(", ")}, Other: ${otherText.trim()}`
      } else {
        responseLine += `Other: ${otherText.trim()}`
      }
    } else if (regularSelections.length > 0) {
      responseLine += regularSelections.join(", ")
    }

    if (
      responseLine &&
      (regularSelections.length > 0 || (hasOther && otherText?.trim()))
    ) {
      lines.push(responseLine)
    }
  })

  return lines.join("\n")
}

export function buildAskUserAnswerMessage(
  toolCallId: string,
  response: string,
): string {
  return `${ANSWER_MARKER_PREFIX}${toolCallId}]::\n${response}`
}

export function parseAskUserAnswerMessage(
  text: string,
): { toolCallId: string; response: string } | null {
  const match = text.match(ANSWER_MARKER_PATTERN)
  if (!match) return null

  return {
    toolCallId: match[1],
    response: text.slice(match[0].length),
  }
}

export function stripAskUserAnswerMarker(text: string): string {
  return parseAskUserAnswerMessage(text)?.response ?? text
}

/**
 * Returns the ask_user dynamic-tool part with the requested call id.
 * The message shape is deliberately kept loose because UIMessage parts
 * differ slightly between live AI SDK messages and persisted messages.
 */
export function findAskUserPart(
  message: { parts?: readonly unknown[] } | null | undefined,
  toolCallId: string,
): Record<string, unknown> | null {
  const parts = message?.parts
  if (!Array.isArray(parts)) return null

  const part = parts.find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false
    const value = candidate as Record<string, unknown>
    return (
      value.type === "dynamic-tool" &&
      value.toolName === "ask_user" &&
      value.toolCallId === toolCallId
    )
  })

  return (part as Record<string, unknown> | undefined) ?? null
}

function splitQuestionResponse(
  questions: AskUserQuestionItem[],
  response: string,
): string[] {
  if (questions.length <= 1)
    return questions.length === 1 ? [response.trim()] : []

  const lines = response.split(/\r?\n/)
  return questions.map((question) => {
    const prefix = `${question.header}:`
    const line = lines.find((candidate) => {
      const trimmed = candidate.trim()
      return (
        trimmed === prefix ||
        trimmed.startsWith(`${prefix} `) ||
        trimmed.startsWith(prefix)
      )
    })
    return line ? line.trim().slice(prefix.length).trim() : ""
  })
}

function parseAnswerLine(
  question: AskUserQuestionItem,
  line: string,
): ParsedAskUserAnswer[] {
  if (!line) return []

  let regularText = line.trim()
  let otherText: string | undefined

  const otherMatch = regularText.match(/(?:^|,\s*)Other:\s*(.*)$/)
  if (otherMatch) {
    otherText = otherMatch[1].trim()
    const otherStart = otherMatch.index ?? regularText.length
    regularText = regularText.slice(0, otherStart).replace(/,\s*$/, "").trim()
  }

  const answers: ParsedAskUserAnswer[] = []
  let remaining = regularText
  const options = [...question.options].sort(
    (a, b) => b.label.length - a.label.length,
  )

  while (remaining) {
    const option = options.find(
      (candidate) =>
        remaining === candidate.label ||
        remaining.startsWith(`${candidate.label},`),
    )

    if (!option) {
      answers.push({
        label: remaining,
        otherText: remaining,
      })
      remaining = ""
      break
    }

    answers.push({ label: option.label, option })
    remaining = remaining.slice(option.label.length).replace(/^,\s*/, "").trim()
  }

  if (otherText) {
    answers.push({
      label: "Other",
      otherText,
    })
  }

  return answers
}

export function parseAskUserResponse(
  questions: AskUserQuestionItem[],
  response: string,
): ParsedAskUserQuestionResponse[] {
  const lines = splitQuestionResponse(questions, response)
  return questions.map((question, index) => ({
    question,
    answers: parseAnswerLine(question, lines[index] ?? ""),
  }))
}
