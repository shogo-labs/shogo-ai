/**
 * AskUserQuestionWidget Component
 * Task: feat-ask-user-question-ui
 *
 * Interactive Decision Card for the AskUserQuestion tool.
 * Renders questions with clickable options inline in the chat flow.
 *
 * States:
 * - Pending: Auto-expanded, interactive options, submit button
 * - Answered: Collapsed summary, expandable for details
 */

import { useState, useCallback, useMemo } from "react"
import { cn } from "@/lib/utils"
import {
  CheckCircle2,
  ChevronRight,
  ChevronDown,
  MessageCircleQuestion,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  type ToolCallData,
  type AskUserQuestionArgs,
  type AskUserQuestionItem,
} from "../tools/types"

// ============================================================
// Types
// ============================================================

export interface AskUserQuestionWidgetProps {
  /** Tool call data containing the questions */
  tool: ToolCallData
  /** Whether the widget is expanded (controlled mode) */
  isExpanded?: boolean
  /** Callback when expand/collapse is toggled */
  onToggle?: () => void
  /** Callback to submit user's response as a chat message */
  onSubmitResponse: (response: string) => void
  /** Optional class name */
  className?: string
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Validate a single question item has required fields
 * Note: multiSelect is optional and defaults to false during streaming
 */
function isValidQuestionItem(item: unknown): item is AskUserQuestionItem {
  if (!item || typeof item !== "object") return false
  const q = item as Record<string, unknown>
  return (
    typeof q.question === "string" &&
    typeof q.header === "string" &&
    Array.isArray(q.options) &&
    // multiSelect is optional, defaults to false if not provided
    (q.multiSelect === undefined || typeof q.multiSelect === "boolean")
  )
}

/**
 * Validate an option has required fields
 */
function isValidOption(opt: unknown): opt is { label: string; description: string } {
  if (!opt || typeof opt !== "object") return false
  const o = opt as Record<string, unknown>
  return typeof o.label === "string" && typeof o.description === "string"
}

/**
 * Normalize a question item, ensuring options array is valid and multiSelect has a default
 */
function normalizeQuestionItem(item: AskUserQuestionItem): AskUserQuestionItem {
  return {
    ...item,
    options: Array.isArray(item.options)
      ? item.options.filter(isValidOption)
      : [],
    // Default multiSelect to false if not provided (common during streaming)
    multiSelect: item.multiSelect ?? false,
  }
}

/**
 * Parse questions from tool args with validation
 */
function parseQuestions(args?: Record<string, unknown>): AskUserQuestionItem[] {
  if (!args?.questions || !Array.isArray(args.questions)) {
    return []
  }

  // Filter to only valid question items and normalize them
  return args.questions
    .filter(isValidQuestionItem)
    .map(normalizeQuestionItem)
}

/**
 * Format the response string for submission
 */
function formatResponse(
  questions: AskUserQuestionItem[],
  selections: Map<number, string[]>,
  otherTexts: Map<number, string>
): string {
  const lines: string[] = []

  questions.forEach((q, index) => {
    const selected = selections.get(index) || []
    const otherText = otherTexts.get(index)

    // Check if "Other" was selected
    const hasOther = selected.includes("__other__")
    const regularSelections = selected.filter((s) => s !== "__other__")

    let responseLine = ""

    if (questions.length > 1) {
      // Multi-question: prefix with header
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

// ============================================================
// Sub-Components
// ============================================================

interface OptionButtonProps {
  label: string
  description: string
  isSelected: boolean
  isMultiSelect: boolean
  onSelect: () => void
  animationDelay: number
}

function OptionButton({
  label,
  description,
  isSelected,
  isMultiSelect,
  onSelect,
  animationDelay,
}: OptionButtonProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full text-left p-3 rounded-md border transition-all duration-200",
        "hover:border-primary/50 hover:bg-muted/50",
        "animate-in fade-in slide-in-from-left-2",
        isSelected
          ? "border-primary bg-primary/5 ring-1 ring-primary/20"
          : "border-border/50 bg-background/50"
      )}
      style={{ animationDelay: `${animationDelay}ms` }}
    >
      <div className="flex items-start gap-3">
        {/* Radio/Checkbox indicator */}
        <div
          className={cn(
            "mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors",
            isMultiSelect && "rounded-sm",
            isSelected
              ? "border-primary bg-primary"
              : "border-muted-foreground/40"
          )}
        >
          {isSelected && (
            <div
              className={cn(
                "bg-primary-foreground",
                isMultiSelect ? "w-2 h-2 rounded-sm" : "w-1.5 h-1.5 rounded-full"
              )}
            />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm text-foreground">{label}</div>
          {description && (
            <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
              {description}
            </div>
          )}
        </div>
      </div>
    </button>
  )
}

interface QuestionTabsProps {
  questions: AskUserQuestionItem[]
  activeTab: number
  onTabChange: (index: number) => void
  selections: Map<number, string[]>
}

function QuestionTabs({
  questions,
  activeTab,
  onTabChange,
  selections,
}: QuestionTabsProps) {
  if (questions.length <= 1) return null

  return (
    <div className="flex gap-1 mb-3 border-b border-border/50 pb-2">
      {questions.map((q, index) => {
        const hasSelection = (selections.get(index)?.length || 0) > 0
        return (
          <button
            key={index}
            type="button"
            onClick={() => onTabChange(index)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
              "flex items-center gap-1.5",
              activeTab === index
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            )}
          >
            <span>Q{index + 1}</span>
            {hasSelection && (
              <CheckCircle2 className="w-3 h-3 text-green-500" />
            )}
          </button>
        )
      })}
    </div>
  )
}

// ============================================================
// Main Component
// ============================================================

export function AskUserQuestionWidget({
  tool,
  isExpanded: controlledExpanded,
  onToggle,
  onSubmitResponse,
  className,
}: AskUserQuestionWidgetProps) {
  // Parse questions from tool args
  const questions = useMemo(() => parseQuestions(tool.args), [tool.args])

  // Determine if this is pending (no result yet) or answered
  const isPending = tool.result === undefined
  const isAnswered = !isPending

  // Internal expanded state (uncontrolled mode)
  // Auto-expand when pending, collapse when answered
  const [internalExpanded, setInternalExpanded] = useState(isPending)
  const isExpanded = controlledExpanded ?? internalExpanded

  // Selection state: questionIndex -> array of selected option labels
  const [selections, setSelections] = useState<Map<number, string[]>>(new Map())

  // "Other" text input state: questionIndex -> text
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(new Map())

  // Active tab for multi-question
  const [activeTab, setActiveTab] = useState(0)

  // Toggle expand/collapse
  const handleToggle = useCallback(() => {
    if (onToggle) {
      onToggle()
    } else {
      setInternalExpanded((prev) => !prev)
    }
  }, [onToggle])

  // Handle option selection
  const handleSelect = useCallback(
    (questionIndex: number, optionLabel: string, isMultiSelect: boolean) => {
      setSelections((prev) => {
        const next = new Map(prev)
        const current = next.get(questionIndex) || []

        if (isMultiSelect) {
          // Toggle selection
          if (current.includes(optionLabel)) {
            next.set(
              questionIndex,
              current.filter((l) => l !== optionLabel)
            )
          } else {
            next.set(questionIndex, [...current, optionLabel])
          }
        } else {
          // Single select - replace
          next.set(questionIndex, [optionLabel])
        }

        return next
      })
    },
    []
  )

  // Handle "Other" text change
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

  // Check if form is valid (at least one selection per question)
  const isValid = useMemo(() => {
    return questions.every((_, index) => {
      const selected = selections.get(index) || []
      if (selected.length === 0) return false

      // If "Other" is selected, require text
      if (selected.includes("__other__")) {
        const otherText = otherTexts.get(index)
        return (otherText?.trim().length ?? 0) > 0
      }

      return true
    })
  }, [questions, selections, otherTexts])

  // Handle submit
  const handleSubmit = useCallback(() => {
    if (!isValid) return

    const response = formatResponse(questions, selections, otherTexts)
    onSubmitResponse(response)

    // Collapse after submission
    if (!onToggle) {
      setInternalExpanded(false)
    }
  }, [isValid, questions, selections, otherTexts, onSubmitResponse, onToggle])

  // Get summary text for collapsed answered state
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

    // Fallback: try to parse from result
    if (typeof tool.result === "string") {
      return tool.result.split("\n")[0]?.slice(0, 40) || "Answered"
    }

    return "Answered"
  }, [isAnswered, questions, selections, tool.result])

  // Current question for display (with bounds check)
  const currentQuestion = activeTab >= 0 && activeTab < questions.length
    ? questions[activeTab]
    : undefined

  // Streaming state - show loading while args are being populated
  // Only show loading if we're streaming AND don't have valid questions yet
  // (Once questions are valid, show the widget regardless of tool state)
  const isStillLoading = tool.state === "streaming" && (questions.length === 0 || !currentQuestion)

  if (isStillLoading) {
    return (
      <div
        className={cn(
          "rounded-md border border-primary/20 bg-primary/5 p-3",
          "animate-in fade-in duration-200",
          className
        )}
      >
        <div className="flex items-center gap-2">
          <MessageCircleQuestion className="w-4 h-4 text-primary animate-pulse" />
          <span
            className="font-mono text-xs font-medium text-foreground"
            style={{ fontFamily: "var(--font-display)" }}
          >
            AskUserQuestion
          </span>
          <span className="text-xs text-muted-foreground">Loading...</span>
        </div>
      </div>
    )
  }

  // Empty state - only shown if NOT streaming but data is still invalid
  if (questions.length === 0 || !currentQuestion) {
    return (
      <div
        className={cn(
          "rounded-md border border-border/50 bg-muted/30 p-3",
          className
        )}
      >
        <span className="text-sm text-muted-foreground">
          Invalid AskUserQuestion data
        </span>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "rounded-md border overflow-hidden transition-all duration-300",
        isPending
          ? "border-primary/30 bg-primary/5 shadow-sm"
          : "border-border/50 bg-muted/30",
        "animate-in fade-in slide-in-from-bottom-2 duration-300",
        className
      )}
    >
      {/* Header - always visible */}
      <button
        type="button"
        onClick={handleToggle}
        className={cn(
          "w-full flex items-center gap-2 py-2 px-3",
          "hover:bg-muted/50 transition-colors",
          "text-left"
        )}
      >
        {/* Expand/collapse chevron */}
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
        )}

        {/* Icon */}
        <MessageCircleQuestion
          className={cn(
            "w-4 h-4 shrink-0",
            isPending ? "text-primary" : "text-muted-foreground"
          )}
        />

        {/* Tool name */}
        <span
          className="font-mono text-xs font-medium text-foreground"
          style={{ fontFamily: "var(--font-display)" }}
        >
          AskUserQuestion
        </span>

        {/* Summary when collapsed and answered */}
        {!isExpanded && isAnswered && summaryText && (
          <span className="flex-1 text-xs text-muted-foreground truncate text-right">
            {summaryText}
          </span>
        )}

        {/* Spacer */}
        {(isExpanded || !isAnswered) && <span className="flex-1" />}

        {/* Status icon */}
        {isAnswered && (
          <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
        )}
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-border/50 p-4 space-y-4 animate-in fade-in duration-200">
          {/* Question tabs (if multiple) */}
          <QuestionTabs
            questions={questions}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            selections={selections}
          />

          {/* Current question */}
          {currentQuestion && (
            <div className="space-y-3">
              {/* Header badge */}
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary border border-primary/20">
                  {currentQuestion.header}
                </span>
              </div>

              {/* Question text */}
              <p className="text-sm font-medium text-foreground">
                {currentQuestion.question}
              </p>

              {/* Options */}
              <div className="space-y-2">
                {(currentQuestion.options ?? []).map((option, optionIndex) => {
                  const currentSelections = selections.get(activeTab) || []
                  const isSelected = currentSelections.includes(option.label)

                  return (
                    <OptionButton
                      key={option.label}
                      label={option.label}
                      description={option.description}
                      isSelected={isSelected}
                      isMultiSelect={currentQuestion.multiSelect ?? false}
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
                })}

                {/* "Other" option */}
                <div
                  className="animate-in fade-in slide-in-from-left-2"
                  style={{
                    animationDelay: `${(currentQuestion.options?.length ?? 0) * 50}ms`,
                  }}
                >
                  <OptionButton
                    label="Other"
                    description="Provide a custom response"
                    isSelected={(selections.get(activeTab) || []).includes(
                      "__other__"
                    )}
                    isMultiSelect={currentQuestion.multiSelect ?? false}
                    onSelect={() =>
                      handleSelect(
                        activeTab,
                        "__other__",
                        currentQuestion.multiSelect ?? false
                      )
                    }
                    animationDelay={(currentQuestion.options?.length ?? 0) * 50}
                  />

                  {/* Text input for "Other" */}
                  {(selections.get(activeTab) || []).includes("__other__") && (
                    <div className="mt-2 ml-7 animate-in fade-in slide-in-from-top-1 duration-200">
                      <Input
                        type="text"
                        placeholder="Type your custom response..."
                        value={otherTexts.get(activeTab) || ""}
                        onChange={(e) =>
                          handleOtherTextChange(activeTab, e.target.value)
                        }
                        className="text-sm"
                        autoFocus
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Submit button - only when pending */}
          {isPending && (
            <div className="flex justify-end pt-2">
              <Button
                onClick={handleSubmit}
                disabled={!isValid}
                size="sm"
                className="min-w-[140px]"
              >
                Submit Selection
              </Button>
            </div>
          )}

          {/* Answered state info */}
          {isAnswered && typeof tool.result === "string" && (
            <div className="space-y-1 pt-2 border-t border-border/30">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                Your Response
              </span>
              <p className="text-sm text-foreground whitespace-pre-wrap">
                {tool.result}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default AskUserQuestionWidget
