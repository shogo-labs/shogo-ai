// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState } from "react"
import { Pressable, Text, TextInput, View } from "react-native"
import { PlanCard, type PlanData } from "../chat/PlanCard"
import type { IslandPlanSummary } from "../../lib/desktop-island"

export function IslandPlanReview({
  plan,
  modelId,
  isPro,
  onBuild,
  onFeedback,
  onOpenInApp,
  onInputFocus,
}: {
  plan: PlanData | IslandPlanSummary
  modelId: string
  isPro: boolean
  onBuild: (modelId?: string) => Promise<unknown>
  onFeedback: (text: string) => Promise<unknown>
  onOpenInApp: () => void
  onInputFocus: () => void
}) {
  const [feedback, setFeedback] = useState("")
  const [busy, setBusy] = useState(false)

  const submitFeedback = () => {
    const text = feedback.trim()
    if (!text || busy) return
    setBusy(true)
    void onFeedback(text)
      .then(() => setFeedback(""))
      .finally(() => setBusy(false))
  }

  return (
    <View className="gap-2">
      <PlanCard
        plan={plan as PlanData}
        compact
        selectedModel={modelId}
        isPro={isPro}
        onBuild={(buildModelId) => void onBuild(buildModelId)}
        onViewFull={onOpenInApp}
      />
      <View className="flex-row items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5">
        <TextInput
          value={feedback}
          onChangeText={setFeedback}
          onFocus={onInputFocus}
          onSubmitEditing={submitFeedback}
          placeholder="Suggest changes to the plan…"
          placeholderTextColor="#71717a"
          className="flex-1 py-2 text-[12px] text-zinc-100"
          style={{ outlineStyle: "none" } as object}
        />
        <Pressable onPress={submitFeedback} disabled={!feedback.trim() || busy}>
          <Text className="text-[12px] font-semibold text-primary">Revise</Text>
        </Pressable>
      </View>
    </View>
  )
}
