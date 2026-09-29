// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import type { AskUserQuestionItem } from "../../tools/types"
import {
  buildAskUserAnswerMessage,
  formatResponse,
  parseAskUserAnswerMessage,
  parseAskUserResponse,
} from "../askUserAnswers"

function question(header: string, options: string[]): AskUserQuestionItem {
  return {
    header,
    question: `Question for ${header}`,
    options: options.map((label) => ({ label, description: label })),
    multiSelect: true,
  }
}

describe("askUserAnswers", () => {
  test("formats a single question without a header", () => {
    const questions = [question("Style", ["Minimal", "Bold"])]
    const response = formatResponse(
      questions,
      new Map([[0, ["Minimal"]]]),
      new Map(),
    )

    expect(response).toBe("Minimal")
    expect(parseAskUserResponse(questions, response)[0]?.answers).toEqual([
      { label: "Minimal", option: questions[0].options[0] },
    ])
  })

  test("parses multiple questions and multi-select answers", () => {
    const questions = [
      question("Style", ["Minimal", "Bold"]),
      question("Colors", ["Blue", "Green", "Red"]),
    ]
    const response = formatResponse(
      questions,
      new Map([
        [0, ["Bold"]],
        [1, ["Blue", "Green"]],
      ]),
      new Map(),
    )

    expect(response).toBe("Style: Bold\nColors: Blue, Green")
    expect(
      parseAskUserResponse(questions, response).map((entry) =>
        entry.answers.map((answer) => answer.label),
      ),
    ).toEqual([["Bold"], ["Blue", "Green"]])
  })

  test("parses Other alongside predefined answers", () => {
    const questions = [question("Layout", ["Grid", "List"])]
    const response = "Grid, Other: two columns on mobile"
    const answers = parseAskUserResponse(questions, response)[0]?.answers

    expect(answers).toEqual([
      { label: "Grid", option: questions[0].options[0] },
      { label: "Other", otherText: "two columns on mobile" },
    ])
  })

  test("matches option labels containing commas and colons", () => {
    const questions = [
      question("Template", ["Marketing, launch", "API: public", "Simple"]),
    ]
    const answers = parseAskUserResponse(
      questions,
      "Marketing, launch, API: public",
    )[0]?.answers

    expect(answers).toEqual([
      { label: "Marketing, launch", option: questions[0].options[0] },
      { label: "API: public", option: questions[0].options[1] },
    ])
  })

  test("preserves response text that does not match an option", () => {
    const questions = [question("Choice", ["Known"])]
    expect(
      parseAskUserResponse(questions, "A custom answer")[0]?.answers,
    ).toEqual([{ label: "A custom answer", otherText: "A custom answer" }])
  })

  test("builds and parses the answer marker", () => {
    const message = buildAskUserAnswerMessage("toolu_abc123", "Style: Bold")
    expect(message).toBe("::My Answers [toolu_abc123]::\nStyle: Bold")
    expect(parseAskUserAnswerMessage(message)).toEqual({
      toolCallId: "toolu_abc123",
      response: "Style: Bold",
    })
  })

  test("only accepts a marker at the start of the message", () => {
    expect(
      parseAskUserAnswerMessage("Style\n::My Answers [toolu_abc]::"),
    ).toBeNull()
    expect(parseAskUserAnswerMessage("ordinary answer")).toBeNull()
  })
})
