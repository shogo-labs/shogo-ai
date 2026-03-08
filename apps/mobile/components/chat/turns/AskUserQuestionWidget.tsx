// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AskUserQuestionWidget Component (React Native)
 *
 * Interactive Decision Card for the AskUserQuestion tool.
 * Renders questions with clickable options inline in the chat flow.
 */

import { useState, useCallback, useMemo } from "react"
import { View, Text, TextInput, Pressable } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import {
  CheckCircle2,
  ChevronRight,
  ChevronDown,
  MessageCircleQuestion,
} from "lucide-react-native"
import {
  type ToolCallData,
  type AskUserQuestionArgs,
  type AskUserQuestionItem,
} from "../tools/types"

export interface AskUserQuestionWidgetProps {
  tool: ToolCallData
  isExpanded?: boolean
  onToggle?: () => void
  onSubmitResponse: (response: string) => void
  className?: string
}

function isValidQuestionItem(item: unknown): item is AskUserQuestionItem {
  if (!item || typeof item !== "object") return false
  const q = item as Record<string, unknown>
  return (
    typeof q.question === "string" &&
    typeof q.header === "string" &&
    Array.isArray(q.options) &&
    (q.multiSelect === undefined || typeof q.multiSelect === "boolean")
  )
}

function isValidOption(
  opt: unknown
): opt is { label: string; description: string } {
  if (!opt || typeof opt !== "object") return false
  const o = opt as Record<string, unknown>
  return typeof o.label === "string" && typeof o.description === "string"
}

function normalizeQuestionItem(
  item: AskUserQuestionItem
): AskUserQuestionItem {
  return {
    ...item,
    options: Array.isArray(item.options)
      ? item.options.filter(isValidOption)
      : [],
    multiSelect: item.multiSelect ?? false,
  }
}

function parseQuestions(
  args?: Record<string, unknown>
): AskUserQuestionItem[] {
  if (!args?.questions || !Array.isArray(args.questions)) {
    return []
  }

  return args.questions.filter(isValidQuestionItem).map(normalizeQuestionItem)
}

function formatResponse(
  questions: AskUserQuestionItem[],
  selections: Map<number, string[]>,
  otherTexts: Map<number, string>
): string {
  const lines: string[] = []

  questions.forEach((q, index) => {
    const selected = selections.get(index) || []
    const otherText = otherTexts.get(index)

    const hasOther = selected.includes("__other__")
    const regularSelections = selected.filter((s) => s !== "__other__")

    let responseLine = ""

    if (questions.length > 1) {
      responseLine = `${q.header}: `
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

    if (responseLine) {
      lines.push(responseLine)
    }
  })

  return lines.join("\n")
}

function OptionButton({
  label,
  description,
  isSelected,
  isMultiSelect,
  onSelect,
}: {
  label: string
  description: string
  isSelected: boolean
  isMultiSelect: boolean
  onSelect: () => void
  animationDelay: number
}) {
  return (
    <Pressable
      onPress={onSelect}
      className={cn(
        "w-full p-2 rounded-md border",
        isSelected
          ? "border-primary bg-primary/5"
          : "border-border/50 bg-background/50"
      )}
    >
      <View className="flex-row items-start gap-2">
        <View
          className={cn(
            "mt-0.5 w-3.5 h-3.5 rounded-full border-2 items-center justify-center",
            isMultiSelect && "rounded-sm",
            isSelected
              ? "border-primary bg-primary"
              : "border-muted-foreground/40"
          )}
        >
          {isSelected && (
            <View
              className={cn(
                "bg-primary-foreground",
                isMultiSelect
                  ? "w-1.5 h-1.5 rounded-sm"
                  : "w-1 h-1 rounded-full"
              )}
            />
          )}
        </View>

        <View className="flex-1">
          <Text className="font-medium text-xs text-foreground">{label}</Text>
          {description ? (
            <Text
              className="text-[10px] text-muted-foreground mt-0.5"
              numberOfLines={2}
            >
              {description}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  )
}

function QuestionTabs({
  questions,
  activeTab,
  onTabChange,
  selections,
}: {
  questions: AskUserQuestionItem[]
  activeTab: number
  onTabChange: (index: number) => void
  selections: Map<number, string[]>
}) {
  if (questions.length <= 1) return null

  return (
    <View className="flex-row gap-1 mb-2 border-b border-border/50 pb-1.5">
      {questions.map((_, index) => {
        const hasSelection = (selections.get(index)?.length || 0) > 0
        return (
          <Pressable
            key={index}
            onPress={() => onTabChange(index)}
            className={cn(
              "px-2 py-1 rounded-md flex-row items-center gap-1",
              activeTab === index
                ? "bg-primary"
                : ""
            )}
          >
            <Text
              className={cn(
                "text-[10px] font-medium",
                activeTab === index
                  ? "text-primary-foreground"
                  : "text-muted-foreground"
              )}
            >
              Q{index + 1}
            </Text>
            {hasSelection && (
              <CheckCircle2 className="w-2.5 h-2.5 text-green-500" />
            )}
          </Pressable>
        )
      })}
    </View>
  )
}

export function AskUserQuestionWidget({
  tool,
  isExpanded: controlledExpanded,
  onToggle,
  onSubmitResponse,
  className,
}: AskUserQuestionWidgetProps) {
  const questions = useMemo(() => parseQuestions(tool.args), [tool.args])

  const isPending = tool.result === undefined
  const isAnswered = !isPending

  const [internalExpanded, setInternalExpanded] = useState(isPending)
  const isExpanded = controlledExpanded ?? internalExpanded

  const [selections, setSelections] = useState<Map<number, string[]>>(
    new Map()
  )
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(new Map())
  const [activeTab, setActiveTab] = useState(0)

  const handleToggle = useCallback(() => {
    if (onToggle) {
      onToggle()
    } else {
      setInternalExpanded((prev) => !prev)
    }
  }, [onToggle])

  const handleSelect = useCallback(
    (questionIndex: number, optionLabel: string, isMultiSelect: boolean) => {
      setSelections((prev) => {
        const next = new Map(prev)
        const current = next.get(questionIndex) || []

        if (isMultiSelect) {
          if (current.includes(optionLabel)) {
            next.set(
              questionIndex,
              current.filter((l) => l !== optionLabel)
            )
          } else {
            next.set(questionIndex, [...current, optionLabel])
          }
        } else {
          next.set(questionIndex, [optionLabel])
        }

        return next
      })
    },
    []
  )

  const handleOtherTextChange = useCallback(
    (questionIndex: number, text: string) => {
      setOtherTexts((prev) => {
        const next = new Map(prev)
        next.set(questionIndex, text)
        return next
      })
    },
    []
  )

  const isValid = useMemo(() => {
    return questions.every((_, index) => {
      const selected = selections.get(index) || []
      if (selected.length === 0) return false

      if (selected.includes("__other__")) {
        const otherText = otherTexts.get(index)
        return (otherText?.trim().length ?? 0) > 0
      }

      return true
    })
  }, [questions, selections, otherTexts])

  const handleSubmit = useCallback(() => {
    if (!isValid) return

    const response = formatResponse(questions, selections, otherTexts)
    onSubmitResponse(response)

    if (!onToggle) {
      setInternalExpanded(false)
    }
  }, [isValid, questions, selections, otherTexts, onSubmitResponse, onToggle])

  const summaryText = useMemo(() => {
    if (!isAnswered) return null

    const firstQuestion = questions[0]
    if (!firstQuestion) return "Answered"

    const selected = selections.get(0) || []
    if (selected.length > 0) {
      const label = selected[0]
      if (label === "__other__") {
        return `${firstQuestion.header}: Other`
      }
      return `${firstQuestion.header}: ${label}`
    }

    if (typeof tool.result === "string") {
      return tool.result.split("\n")[0]?.slice(0, 40) || "Answered"
    }

    return "Answered"
  }, [isAnswered, questions, selections, tool.result])

  const currentQuestion =
    activeTab >= 0 && activeTab < questions.length
      ? questions[activeTab]
      : undefined

  const isStillLoading =
    tool.state === "streaming" &&
    (questions.length === 0 || !currentQuestion)

  if (isStillLoading) {
    return (
      <View
        className={cn(
          "rounded-md border border-primary/20 bg-primary/5 p-2",
          className
        )}
      >
        <View className="flex-row items-center gap-1.5">
          <MessageCircleQuestion className="w-3 h-3 text-primary" />
          <Text className="font-mono text-[10px] font-medium text-foreground">
            AskUserQuestion
          </Text>
          <Text className="text-[9px] text-muted-foreground">Loading...</Text>
        </View>
      </View>
    )
  }

  if (questions.length === 0 || !currentQuestion) {
    return (
      <View
        className={cn(
          "rounded-md border border-border/50 bg-muted/30 p-2",
          className
        )}
      >
        <Text className="text-xs text-muted-foreground">
          Invalid AskUserQuestion data
        </Text>
      </View>
    )
  }

  return (
    <View
      className={cn(
        "rounded-md border overflow-hidden",
        isPending
          ? "border-primary/30 bg-primary/5"
          : "border-border/50 bg-muted/30",
        className
      )}
    >
      {/* Header */}
      <Pressable
        onPress={handleToggle}
        className="w-full flex-row items-center gap-1.5 py-1.5 px-2"
      >
        {isExpanded ? (
          <ChevronDown className="w-3 h-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted-foreground" />
        )}

        <MessageCircleQuestion
          className={cn(
            "w-3 h-3",
            isPending ? "text-primary" : "text-muted-foreground"
          )}
        />

        <Text className="font-mono text-[10px] font-medium text-foreground">
          AskUserQuestion
        </Text>

        {!isExpanded && isAnswered && summaryText && (
          <Text
            className="flex-1 text-[9px] text-muted-foreground text-right"
            numberOfLines={1}
          >
            {summaryText}
          </Text>
        )}

        {(isExpanded || !isAnswered) && <View className="flex-1" />}

        {isAnswered && (
          <CheckCircle2 className="w-3 h-3 text-green-500" />
        )}
      </Pressable>

      {/* Expanded content */}
      {isExpanded && (
        <View className="border-t border-border/50 p-3 gap-3">
          <QuestionTabs
            questions={questions}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            selections={selections}
          />

          {currentQuestion && (
            <View className="gap-2">
              {/* Header badge */}
              <View className="flex-row items-center gap-2">
                <View className="px-1.5 py-0.5 rounded-full bg-primary/10 border border-primary/20">
                  <Text className="text-[10px] font-medium text-primary">
                    {currentQuestion.header}
                  </Text>
                </View>
              </View>

              {/* Question text */}
              <Text className="text-xs font-medium text-foreground">
                {currentQuestion.question}
              </Text>

              {/* Options */}
              <View className="gap-1.5">
                {(currentQuestion.options ?? []).map(
                  (option, optionIndex) => {
                    const currentSelections =
                      selections.get(activeTab) || []
                    const isSelected = currentSelections.includes(
                      option.label
                    )

                    return (
                      <OptionButton
                        key={option.label}
                        label={option.label}
                        description={option.description}
                        isSelected={isSelected}
                        isMultiSelect={
                          currentQuestion.multiSelect ?? false
                        }
                        onSelect={() =>
                          handleSelect(
                            activeTab,
                            option.label,
                            currentQuestion.multiSelect ?? false
                          )
                        }
                        animationDelay={optionIndex * 50}
                      />
                    )
                  }
                )}

                {/* "Other" option */}
                <View>
                  <OptionButton
                    label="Other"
                    description="Provide a custom response"
                    isSelected={(
                      selections.get(activeTab) || []
                    ).includes("__other__")}
                    isMultiSelect={
                      currentQuestion.multiSelect ?? false
                    }
                    onSelect={() =>
                      handleSelect(
                        activeTab,
                        "__other__",
                        currentQuestion.multiSelect ?? false
                      )
                    }
                    animationDelay={
                      (currentQuestion.options?.length ?? 0) * 50
                    }
                  />

                  {(selections.get(activeTab) || []).includes(
                    "__other__"
                  ) && (
                    <View className="mt-1.5 ml-5">
                      <TextInput
                        placeholder="Type your custom response..."
                        placeholderTextColor="#71717a"
                        value={otherTexts.get(activeTab) || ""}
                        onChangeText={(text) =>
                          handleOtherTextChange(activeTab, text)
                        }
                        className="text-xs h-7 border border-input rounded-md px-2 bg-background text-foreground"
                        autoFocus
                      />
                    </View>
                  )}
                </View>
              </View>
            </View>
          )}

          {/* Submit button */}
          {isPending && (
            <View className="flex-row justify-end pt-1.5">
              <Pressable
                onPress={handleSubmit}
                disabled={!isValid}
                className={cn(
                  "min-w-[100px] h-7 rounded-md items-center justify-center px-3",
                  isValid ? "bg-primary" : "bg-muted"
                )}
              >
                <Text
                  className={cn(
                    "text-xs font-medium",
                    isValid
                      ? "text-primary-foreground"
                      : "text-muted-foreground"
                  )}
                >
                  Submit
                </Text>
              </Pressable>
            </View>
          )}

          {/* Answered state */}
          {isAnswered && typeof tool.result === "string" && (
            <View className="gap-0.5 pt-1.5 border-t border-border/30">
              <Text className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
                Your Response
              </Text>
              <Text className="text-xs text-foreground">
                {tool.result}
              </Text>
            </View>
          )}
        </View>
      )}
    </View>
  )
}

export default AskUserQuestionWidget
