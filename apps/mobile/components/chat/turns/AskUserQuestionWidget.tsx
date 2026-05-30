// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AskUserQuestionWidget Component (React Native)
 *
 * Interactive Decision Card for the AskUserQuestion tool.
 * Renders questions with clickable options inline in the chat flow.
 */

import { useState, useCallback, useMemo, useRef } from "react"
import { View, Text, TextInput, Pressable, Animated } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  MessageCircleQuestion,
  ArrowDown,
} from "lucide-react-native"
import {
  type ToolCallData,
  type AskUserQuestionItem,
} from "../tools/types"
import { useAskUserQuestionDraft } from "./useAskUserQuestionDraft"

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

    if (responseLine && (regularSelections.length > 0 || (hasOther && otherText?.trim()))) {
      lines.push(responseLine)
    }
  })

  return lines.join("\n")
}

/**
 * Returns "A", "B", … "Z", "AA", "AB", … for the supplied 0-based index.
 * Stays human-readable even past 26 options.
 */
function letterForIndex(index: number): string {
  let n = index
  let out = ""
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

function OptionRow({
  letter,
  label,
  description,
  isSelected,
  isMultiSelect,
  onSelect,
  disabled,
}: {
  letter: string
  label: string
  description: string
  isSelected: boolean
  isMultiSelect: boolean
  onSelect: () => void
  disabled?: boolean
}) {
  return (
    <Pressable
      onPress={onSelect}
      disabled={disabled}
      className={cn(
        "w-full p-2.5 rounded-md border",
        isSelected
          ? "border-primary/40 bg-primary/10"
          : "border-border/50 bg-background/40"
      )}
    >
      <View className="flex-row items-start gap-2.5">
        {/* Letter badge — doubles as the selection indicator. */}
        <View
          className={cn(
            "w-6 h-6 items-center justify-center border",
            isMultiSelect ? "rounded-sm" : "rounded-full",
            isSelected
              ? "border-primary bg-primary"
              : "border-border/60 bg-muted/40"
          )}
        >
          <Text
            className={cn(
              "font-mono text-[10px] font-semibold",
              isSelected ? "text-primary-foreground" : "text-muted-foreground"
            )}
          >
            {letter}
          </Text>
        </View>

        <View className="flex-1">
          {label !== description && label.length <= 32 ? (
            <Text className="font-medium text-xs text-foreground">
              {label}
            </Text>
          ) : null}
          {description ? (
            <Text className="text-[11px] leading-[15px] text-foreground/90">
              {description}
            </Text>
          ) : (
            <Text className="text-[11px] leading-[15px] text-foreground/90">
              {label}
            </Text>
          )}
        </View>
      </View>
    </Pressable>
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

  // Treat both `undefined` (live stream: gateway suppresses tool-output-available)
  // and `null` (legacy persisted parts that wrote `output: null`) as "not yet
  // answered". Prevents the widget from rendering as already-answered after a
  // cold hydration of an unanswered ask_user.
  const isPending = tool.result == null

  const {
    selections,
    setSelections,
    otherTexts,
    setOtherTexts,
    activeTab,
    setActiveTab,
    submittedResponse,
    markSubmitted,
    needsRetry,
    answered: effectivelyAnswered,
    displayResponse: hookDisplayResponse,
  } = useAskUserQuestionDraft(tool.id, tool.result)

  // Poll stays interactive whenever the server hasn't resolved it AND we don't
  // already have a locally-persisted submission. If a previous session died
  // mid-submit, the Retry button below drives the re-send instead of letting
  // the user accidentally re-answer.
  const effectivelyPending = isPending && submittedResponse == null

  // For the pending state we want the card open by default; once answered we
  // collapse to a one-line summary that the user can re-expand if they want.
  const [internalExpanded, setInternalExpanded] = useState(true)
  const isExpanded = controlledExpanded ?? (effectivelyPending ? true : internalExpanded)

  const handleToggle = useCallback(() => {
    // Toggling is only meaningful in the answered state — while pending we
    // keep the card open so the question is always front-and-centre.
    if (effectivelyPending) return
    if (onToggle) {
      onToggle()
    } else {
      setInternalExpanded((prev) => !prev)
    }
  }, [onToggle, effectivelyPending])

  // Body fade for question transitions. Auto-advance and chevron navigation
  // both run through `animateToQuestion`, which fades the body out, swaps the
  // visible question, then fades back in. Lets the user actually see the
  // selection register before the next question appears.
  const bodyOpacity = useRef(new Animated.Value(1)).current
  const isAnimatingRef = useRef(false)

  const animateToQuestion = useCallback(
    (target: number) => {
      const clamped = Math.max(0, Math.min(questions.length - 1, target))
      if (clamped === activeTab) return
      if (isAnimatingRef.current) {
        // Drop overlapping animations but still ensure we land on the latest
        // requested target.
        bodyOpacity.stopAnimation(() => {
          setActiveTab(clamped)
          isAnimatingRef.current = false
          Animated.timing(bodyOpacity, {
            toValue: 1,
            duration: 160,
            useNativeDriver: true,
          }).start()
        })
        return
      }
      isAnimatingRef.current = true
      Animated.timing(bodyOpacity, {
        toValue: 0,
        duration: 120,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (!finished) {
          isAnimatingRef.current = false
          return
        }
        setActiveTab(clamped)
        Animated.timing(bodyOpacity, {
          toValue: 1,
          duration: 160,
          useNativeDriver: true,
        }).start(() => {
          isAnimatingRef.current = false
        })
      })
    },
    [activeTab, questions.length, setActiveTab, bodyOpacity]
  )

  const handleSelect = useCallback(
    (questionIndex: number, optionLabel: string, isMultiSelect: boolean) => {
      // Capture before mutating: only auto-advance on a true first pick.
      // If the user already has any selection for this question, treat the
      // tap as "changing my answer" and stay put.
      const prevSelections = selections.get(questionIndex) || []
      const wasUnanswered = prevSelections.length === 0

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

      // Auto-advance only on the first single-select pick. Multi-select stays
      // put (user might pick more); "Other" stays put (user still needs to
      // type); changing an existing answer stays put (the user explicitly
      // navigated back to change it).
      if (
        wasUnanswered &&
        !isMultiSelect &&
        optionLabel !== "__other__" &&
        questionIndex < questions.length - 1
      ) {
        animateToQuestion(questionIndex + 1)
      }
    },
    [setSelections, selections, questions.length, animateToQuestion]
  )

  const handleOtherTextChange = useCallback(
    (questionIndex: number, text: string) => {
      setOtherTexts((prev) => {
        const next = new Map(prev)
        next.set(questionIndex, text)
        return next
      })
    },
    [setOtherTexts]
  )

  const hasAnyAnswer = useMemo(() => {
    return questions.some((_, i) => {
      const sel = selections.get(i) || []
      if (sel.length === 0) return false
      if (sel.includes("__other__")) {
        return (otherTexts.get(i)?.trim().length ?? 0) > 0
      }
      return true
    })
  }, [questions, selections, otherTexts])

  const handleSubmit = useCallback(() => {
    if (!hasAnyAnswer) return

    const response = formatResponse(questions, selections, otherTexts)
    if (!response) return
    // Persist BEFORE firing the network call so a mid-submit app kill still
    // leaves a recoverable record on disk.
    void markSubmitted(response).then(() => {
      onSubmitResponse(response)
    })
  }, [
    hasAnyAnswer,
    questions,
    selections,
    otherTexts,
    onSubmitResponse,
    markSubmitted,
  ])

  const isLastQuestion = activeTab >= questions.length - 1
  const isFirstQuestion = activeTab <= 0

  const handleNext = useCallback(() => {
    if (isLastQuestion) {
      handleSubmit()
      return
    }
    animateToQuestion(activeTab + 1)
  }, [activeTab, isLastQuestion, handleSubmit, animateToQuestion])

  const handleRetry = useCallback(() => {
    if (!submittedResponse) return
    onSubmitResponse(submittedResponse)
  }, [submittedResponse, onSubmitResponse])

  const displayResult = hookDisplayResponse

  const summaryText = useMemo(() => {
    if (!effectivelyAnswered) return null

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

    if (displayResult) {
      return displayResult.split("\n")[0]?.slice(0, 40) || "Answered"
    }

    return "Answered"
  }, [effectivelyAnswered, questions, selections, displayResult])

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
          "rounded-md border border-primary/20 bg-primary/5 p-2.5",
          className
        )}
      >
        <View className="flex-row items-center gap-1.5">
          <Text className="text-xs font-medium text-foreground">
            Questions
          </Text>
          <Text className="text-[10px] text-muted-foreground">Loading…</Text>
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

  const showPagination = questions.length > 1
  // Without a Skip button the only way to advance is to answer, so gate Next
  // on the current question being validly answered (single-select still
  // auto-advances on pick, but this also catches multi-select / Other).
  const currentAnswered = (() => {
    const sel = selections.get(activeTab) || []
    if (sel.length === 0) return false
    if (sel.includes("__other__")) {
      return (otherTexts.get(activeTab)?.trim().length ?? 0) > 0
    }
    return true
  })()
  const nextDisabled = !currentAnswered

  return (
    <View
      className={cn(
        "rounded-md border overflow-hidden",
        effectivelyPending
          ? "border-primary/30 bg-primary/5"
          : "border-border/50 bg-muted/30",
        className
      )}
    >
      {/* Header */}
      <Pressable
        onPress={handleToggle}
        disabled={effectivelyPending}
        className="w-full flex-row items-center gap-2 px-3 py-2"
      >
        <Text className="text-xs font-medium text-foreground">
          Questions
        </Text>

        {effectivelyAnswered && (
          <CheckCircle2 className="w-3 h-3 text-green-500" />
        )}

        {!isExpanded && effectivelyAnswered && summaryText && (
          <Text
            className="flex-1 text-[10px] text-muted-foreground"
            numberOfLines={1}
          >
            {summaryText}
          </Text>
        )}

        {(isExpanded || !effectivelyAnswered) && <View className="flex-1" />}

        {/* Pagination — only when there is more than one question and the card is open. */}
        {isExpanded && showPagination && (
          <View className="flex-row items-center gap-1.5">
            <Pressable
              onPress={() => animateToQuestion(activeTab - 1)}
              disabled={isFirstQuestion}
              hitSlop={6}
              className={cn(
                "w-5 h-5 items-center justify-center rounded",
                isFirstQuestion ? "opacity-30" : "opacity-100"
              )}
            >
              <ChevronLeft className="w-3.5 h-3.5 text-muted-foreground" />
            </Pressable>
            <Text className="text-[10px] text-muted-foreground tabular-nums">
              {activeTab + 1} of {questions.length}
            </Text>
            <Pressable
              onPress={() => animateToQuestion(activeTab + 1)}
              disabled={isLastQuestion}
              hitSlop={6}
              className={cn(
                "w-5 h-5 items-center justify-center rounded",
                isLastQuestion ? "opacity-30" : "opacity-100"
              )}
            >
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
            </Pressable>
          </View>
        )}

        {/* Answered-state collapse caret. */}
        {!effectivelyPending && (
          <View className="ml-1">
            {isExpanded ? (
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-3 h-3 text-muted-foreground" />
            )}
          </View>
        )}
      </Pressable>

      {/* Expanded content */}
      {isExpanded && (
        <View className="border-t border-border/40 px-3 pt-2.5 pb-3 gap-2.5">
          {currentQuestion && (
            <Animated.View className="gap-2.5" style={{ opacity: bodyOpacity }}>
              {/* Question text */}
              <Text className="text-[13px] font-semibold text-foreground leading-[18px]">
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
                      <OptionRow
                        key={option.label}
                        letter={letterForIndex(optionIndex)}
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
                        disabled={effectivelyAnswered}
                      />
                    )
                  }
                )}

                {/* "Other" option */}
                <View>
                  <OptionRow
                    letter={letterForIndex(
                      currentQuestion.options?.length ?? 0
                    )}
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
                    disabled={effectivelyAnswered}
                  />

                  {(selections.get(activeTab) || []).includes(
                    "__other__"
                  ) && (
                    <View className="mt-1.5 ml-8">
                      <TextInput
                        placeholder="Type your custom response..."
                        placeholderTextColor="#71717a"
                        value={otherTexts.get(activeTab) || ""}
                        onChangeText={(text) =>
                          handleOtherTextChange(activeTab, text)
                        }
                        className="text-xs h-7 border border-input rounded-md px-2 bg-background text-foreground"
                        autoFocus
                        editable={!effectivelyAnswered}
                      />
                    </View>
                  )}
                </View>
              </View>
            </Animated.View>
          )}

          {/* Next/Submit footer (pending state only) */}
          {effectivelyPending && (
            <View className="flex-row items-center justify-end pt-1">
              <Pressable
                onPress={handleNext}
                disabled={nextDisabled}
                className={cn(
                  "h-7 rounded-md items-center justify-center px-3 min-w-[68px]",
                  nextDisabled ? "bg-muted" : "bg-primary"
                )}
              >
                <Text
                  className={cn(
                    "text-xs font-medium",
                    nextDisabled
                      ? "text-muted-foreground"
                      : "text-primary-foreground"
                  )}
                >
                  {isLastQuestion ? "Submit" : "Next"}
                </Text>
              </Pressable>
            </View>
          )}

          {/* Answered state */}
          {effectivelyAnswered && displayResult && (
            <View className="gap-0.5 pt-1.5 border-t border-border/30">
              <Text className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
                Your Response
              </Text>
              <Text className="text-xs text-foreground">
                {displayResult}
              </Text>

              {/*
                Mid-submit recovery: we persisted a response locally but the
                server never reported a result (likely because the app was
                killed before sendMessage/saveToolOutput completed). Let the
                user resend without re-answering the whole poll.
              */}
              {needsRetry && (
                <View className="flex-row items-center justify-between mt-1.5 pt-1.5 border-t border-border/30">
                  <Text className="text-[9px] text-muted-foreground">
                    Response not yet confirmed by the assistant.
                  </Text>
                  <Pressable
                    onPress={handleRetry}
                    className="flex-row items-center gap-1 h-6 rounded-md border border-primary/30 bg-primary/5 px-2"
                  >
                    <RefreshCw className="w-2.5 h-2.5 text-primary" />
                    <Text className="text-[10px] font-medium text-primary">
                      Retry
                    </Text>
                  </Pressable>
                </View>
              )}
            </View>
          )}
        </View>
      )}
    </View>
  )
}

export interface AskUserQuestionBarProps {
  tool: ToolCallData
  /** Tap handler — typically scrolls to the input-attached question widget. */
  onPress?: () => void
  className?: string
}

/**
 * Collapsed in-stream placeholder for a pending ask_user call. Styled like the
 * unexpanded TodoWidget header. The interactive answer UI lives attached above
 * the chat input; tapping this bar scrolls there via `onPress`.
 */
export function AskUserQuestionBar({
  tool,
  onPress,
  className,
}: AskUserQuestionBarProps) {
  const questions = useMemo(() => parseQuestions(tool.args), [tool.args])
  const count = questions.length

  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel="Pending question — answer below"
      className={cn(
        "rounded-md border border-primary/30 bg-primary/5 w-full flex-row items-center gap-1.5 py-1.5 px-2",
        className
      )}
    >
      <MessageCircleQuestion className="w-3 h-3 text-primary" />

      <Text className="font-mono text-[10px] font-medium text-foreground">
        Questions
      </Text>

      <Text className="flex-1 text-[9px] text-muted-foreground text-right">
        {count > 1 ? `${count} questions • ` : ""}Answer below
      </Text>

      <ArrowDown className="w-3 h-3 text-primary" />
    </Pressable>
  )
}

export default AskUserQuestionWidget
