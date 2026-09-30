// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Read-only recap of an answered AskUserQuestion card.
 *
 * This is rendered in the user's turn after submission, so the transcript
 * retains the questions and the selected answers instead of only showing the
 * transport-formatted response string.
 */

import { useMemo, useState } from "react"
import { Image, Text, View } from "react-native"
import { MessageCircleQuestion } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { useChatContextSafe } from "../ChatContext"
import { buildAgentWorkspaceUrl } from "../../../lib/agent-workspace-url"
import { useAgentImageSource } from "../../../lib/agent-image-source"
import type { AnsweredQuestion } from "./types"
import {
  parseAskUserResponse,
  type ParsedAskUserAnswer,
} from "./askUserAnswers"

export interface AskUserAnswerCardProps {
  answeredQuestion: AnsweredQuestion
  variant?: "bubble" | "row"
  className?: string
}

function letterForIndex(index: number): string {
  let n = index
  let output = ""
  do {
    output = String.fromCharCode(65 + (n % 26)) + output
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return output
}

function AnswerImage({
  imagePath,
  label,
  isBubble,
}: {
  imagePath: string
  label: string
  isBubble: boolean
}) {
  const chatContext = useChatContextSafe()
  const imageUrl = chatContext?.agentUrl
    ? buildAgentWorkspaceUrl(chatContext.agentUrl, imagePath)
    : null
  const imageSource = useAgentImageSource(imageUrl)
  const [failed, setFailed] = useState(false)

  if (!imageSource || failed) return null

  return (
    <Image
      source={imageSource}
      className={cn(
        "h-8 w-8 rounded-md border",
        isBubble ? "border-white/20" : "border-border/50",
      )}
      resizeMode="cover"
      accessibilityLabel={`Preview for answer: ${label}`}
      onError={() => setFailed(true)}
    />
  )
}

function AnswerValue({
  answer,
  optionIndex,
  isBubble,
}: {
  answer: ParsedAskUserAnswer
  optionIndex: number
  isBubble: boolean
}) {
  const option = answer.option
  const label = answer.otherText ? `"${answer.otherText}"` : answer.label

  return (
    <View
      className={cn(
        "flex-row items-center gap-1.5 self-start rounded-full border px-2 py-1",
        isBubble
          ? "border-white/15 bg-white/10"
          : "border-primary/20 bg-primary/10",
      )}
    >
      {option?.imagePath ? (
        <AnswerImage
          imagePath={option.imagePath}
          label={answer.label}
          isBubble={isBubble}
        />
      ) : (
        <View
          className={cn(
            "h-5 w-5 items-center justify-center rounded-full",
            isBubble ? "bg-white/15" : "bg-primary/15",
          )}
        >
          <Text
            className={cn(
              "font-mono text-[10px] font-semibold",
              isBubble ? "text-white/85" : "text-primary",
            )}
          >
            {option ? letterForIndex(optionIndex) : "•"}
          </Text>
        </View>
      )}
      <Text
        className={cn(
          "max-w-[280px] text-xs",
          isBubble ? "text-white" : "text-foreground",
        )}
      >
        {label}
      </Text>
    </View>
  )
}

export function AskUserAnswerCard({
  answeredQuestion,
  variant = "row",
  className,
}: AskUserAnswerCardProps) {
  const isBubble = variant === "bubble"
  const parsed = useMemo(
    () =>
      parseAskUserResponse(
        answeredQuestion.questions,
        answeredQuestion.response,
      ),
    [answeredQuestion.questions, answeredQuestion.response],
  )

  return (
    <View
      className={cn(
        variant === "bubble" ? "w-full max-w-[85%] self-end" : "w-full",
        className,
      )}
    >
      <View
        className={cn(
          "gap-3 rounded-2xl border px-3.5 py-3",
          isBubble
            ? "border-white/10 bg-[#2a2a2a]"
            : "border-border/50 bg-secondary/60",
        )}
      >
        <View className="flex-row items-center gap-2">
          <View
            className={cn(
              "h-6 w-6 items-center justify-center rounded-full",
              isBubble ? "bg-white/10" : "bg-primary/10",
            )}
          >
            <MessageCircleQuestion
              size={14}
              className={isBubble ? "text-white/80" : "text-primary"}
            />
          </View>
          <Text
            className={cn(
              "flex-1 text-xs font-semibold",
              isBubble ? "text-white" : "text-foreground",
            )}
          >
            {answeredQuestion.questions.length > 1
              ? `Answered ${answeredQuestion.questions.length} questions`
              : "Answered"}
          </Text>
        </View>

        {parsed.map(({ question, answers }, questionIndex) => (
          <View key={`${question.header}-${questionIndex}`} className="gap-1.5">
            <View className="gap-0.5">
              <Text
                className={cn(
                  "font-mono text-[9px] font-semibold uppercase tracking-wide",
                  isBubble ? "text-white/55" : "text-muted-foreground",
                )}
              >
                {question.header}
              </Text>
              <Text
                className={cn(
                  "text-[11px] leading-4",
                  isBubble ? "text-white/70" : "text-muted-foreground",
                )}
              >
                {question.question}
              </Text>
            </View>

            {answers.length > 0 ? (
              <View className="flex-row flex-wrap gap-1.5">
                {answers.map((answer, index) => {
                  const optionIndex = answer.option
                    ? question.options.findIndex(
                        (option) => option.label === answer.option?.label,
                      )
                    : index
                  return (
                    <AnswerValue
                      key={`${answer.label}-${index}`}
                      answer={answer}
                      optionIndex={Math.max(optionIndex, 0)}
                      isBubble={isBubble}
                    />
                  )
                })}
              </View>
            ) : (
              <Text
                className={cn(
                  "text-[11px] italic",
                  isBubble ? "text-white/45" : "text-muted-foreground",
                )}
              >
                Skipped
              </Text>
            )}
          </View>
        ))}
      </View>
    </View>
  )
}

export default AskUserAnswerCard
