// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useMemo, useState } from "react"
import { Pressable, ScrollView, Text, View } from "react-native"
import { ShieldAlert, MessageCircleQuestion } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { AskUserQuestionWidget } from "../chat/turns/AskUserQuestionWidget"
import type { IslandPermissionDecision } from "../../lib/desktop-island"
import { IslandDiffPreview, fileChangeFromParams } from "./IslandDiffPreview"
import type { IslandPermission, IslandQuestion } from "./useIslandChatSession"

function commandFromParams(params: Record<string, unknown>): string | null {
  for (const key of ["command", "cmd", "script", "url", "query"]) {
    const value = params[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return null
}

function useSecondsLeft(startedAt: number, timeoutSeconds: number): number | null {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!timeoutSeconds) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [timeoutSeconds])
  if (!timeoutSeconds) return null
  return Math.max(0, Math.ceil(timeoutSeconds - (now - startedAt) / 1000))
}

function ActionButton({
  label,
  onPress,
  tone = "default",
  disabled,
}: {
  label: string
  onPress: () => void
  tone?: "default" | "primary" | "danger"
  disabled?: boolean
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className={cn(
        "rounded-lg px-3 py-1.5",
        tone === "primary" && "bg-primary",
        tone === "danger" && "bg-rose-500/15",
        tone === "default" && "bg-white/10",
        disabled && "opacity-50",
      )}
    >
      <Text
        className={cn(
          "text-[12px] font-semibold",
          tone === "primary" ? "text-primary-foreground" : tone === "danger" ? "text-rose-300" : "text-zinc-100",
        )}
      >
        {label}
      </Text>
    </Pressable>
  )
}

export function PermissionCard({
  permission,
  onRespond,
}: {
  permission: IslandPermission
  onRespond: (decision: IslandPermissionDecision) => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const secondsLeft = useSecondsLeft(permission.startedAt, permission.timeout)
  const change = useMemo(
    () => fileChangeFromParams(permission.toolName, permission.params),
    [permission.toolName, permission.params],
  )
  const command = change ? null : commandFromParams(permission.params)
  const respond = (decision: IslandPermissionDecision) => {
    setBusy(true)
    void onRespond(decision).finally(() => setBusy(false))
  }

  return (
    <View className="gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3">
      <View className="flex-row items-center gap-2">
        <ShieldAlert size={14} color="#fbbf24" />
        <Text className="flex-1 text-[12px] font-semibold text-amber-200" numberOfLines={1}>
          Allow {permission.toolName.replace(/_/g, " ")}?
        </Text>
        {secondsLeft !== null ? (
          <Text className="text-[10px] text-amber-300/80">{secondsLeft}s</Text>
        ) : null}
      </View>
      {permission.reason ? (
        <Text className="text-[11px] text-zinc-300" numberOfLines={3}>
          {permission.reason}
        </Text>
      ) : null}
      {change ? (
        <IslandDiffPreview change={change} truncated={permission.paramsTruncated} />
      ) : command ? (
        <ScrollView style={{ maxHeight: 96 }} className="rounded-lg bg-black/50">
          <Text className="px-2.5 py-2 font-mono text-[11px] text-zinc-200">{command}</Text>
        </ScrollView>
      ) : null}
      <View className="flex-row flex-wrap justify-end gap-1.5">
        <ActionButton label="Deny" tone="danger" disabled={busy} onPress={() => respond("deny")} />
        <ActionButton label="Always allow" disabled={busy} onPress={() => respond("always_allow")} />
        <ActionButton label="Allow once" tone="primary" disabled={busy} onPress={() => respond("allow_once")} />
      </View>
    </View>
  )
}

export function QuestionCard({
  question,
  onAnswer,
  onOpenInApp,
}: {
  question: IslandQuestion
  onAnswer: (response: string) => Promise<unknown>
  onOpenInApp: () => void
}) {
  if (question.kind === "tool") {
    return (
      <View className="rounded-xl border border-white/10 bg-white/5 p-1">
        <AskUserQuestionWidget
          tool={question.pending.tool}
          onSubmitResponse={(response) => void onAnswer(response)}
          embedded
          bodyMaxHeight={200}
        />
      </View>
    )
  }
  return (
    <View className="gap-2 rounded-xl border border-sky-400/30 bg-sky-400/10 p-3">
      <View className="flex-row items-center gap-2">
        <MessageCircleQuestion size={14} color="#7dd3fc" />
        <Text className="flex-1 text-[12px] font-semibold text-sky-100">{question.prompt}</Text>
      </View>
      {question.answerInApp ? (
        <View className="flex-row justify-end">
          <ActionButton label="Answer in Shogo" tone="primary" onPress={onOpenInApp} />
        </View>
      ) : (
        <View className="gap-1.5">
          {question.options.map((option) => (
            <Pressable
              key={option.label}
              onPress={() => void onAnswer(option.label)}
              className="rounded-lg bg-white/10 px-3 py-2 hover:bg-white/15"
            >
              <Text className="text-[12px] font-medium text-zinc-100">{option.label}</Text>
              {option.description ? (
                <Text className="mt-0.5 text-[11px] text-zinc-400" numberOfLines={2}>
                  {option.description}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )
}
