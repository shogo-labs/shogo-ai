// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import React, { useState } from "react"
import { Pressable, Text, View } from "react-native"
import { AUTO_MODEL_ID } from "@shogo/model-catalog"
import { Check, ChevronDown } from "lucide-react-native"
import {
  useModelPickerList,
  type ReasoningEffort,
} from "../../lib/visible-models"
import {
  Popover,
  PopoverBackdrop,
  PopoverContent,
} from "@/components/ui/popover"

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  off: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Xhigh",
}

interface ComposerReasoningEffortPickerProps {
  modelId: string
  selectedEffort?: ReasoningEffort
  onSelect: (modelId: string, effort: ReasoningEffort | null) => void
  disabled?: boolean
}

/** A separate composer control for the selected model's supported effort. */
export function ComposerReasoningEffortPicker({
  modelId,
  selectedEffort,
  onSelect,
  disabled = false,
}: ComposerReasoningEffortPickerProps) {
  const models = useModelPickerList()
  const [open, setOpen] = useState(false)

  if (!modelId || modelId === AUTO_MODEL_ID) return null
  const model = models.find((candidate) => candidate.id === modelId)
  if (!model || !model.reasoningEfforts?.length) return null
  const efforts = model.reasoningEfforts

  const effectiveEffort = selectedEffort ?? model.reasoningEffort ?? null
  const currentLabel = effectiveEffort ? EFFORT_LABEL[effectiveEffort] : "Default"
  const options: Array<{ value: ReasoningEffort | null; label: string }> = [
    { value: null, label: "Default" },
    ...efforts.map((effort) => ({ value: effort, label: EFFORT_LABEL[effort] })),
  ]

  return (
    <Popover
      placement="top"
      size="xs"
      isOpen={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      trigger={(triggerProps) => (
        <Pressable
          {...triggerProps}
          testID="reasoning-effort-picker-trigger"
          accessibilityRole="button"
          accessibilityLabel={`Reasoning effort for ${model.displayName}: ${currentLabel}`}
          accessibilityState={{ expanded: open, disabled }}
          disabled={disabled}
          className="h-8 flex-row items-center gap-1.5 rounded-lg bg-muted px-2.5 active:opacity-70"
        >
          <Text className="text-xs font-medium text-foreground">{currentLabel}</Text>
          <ChevronDown className="text-muted-foreground" size={13} />
        </Pressable>
      )}
    >
      <PopoverBackdrop />
      <PopoverContent className="w-[164px] p-1 rounded-xl">
        <View className="gap-0.5">
          {options.map((option) => {
            const selected = option.value === effectiveEffort
            return (
              <Pressable
                key={option.value ?? "default"}
                testID={`reasoning-effort-picker-${option.value ?? "default"}`}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`${option.label} reasoning effort`}
                onPress={() => {
                  onSelect(modelId, option.value)
                  setOpen(false)
                }}
                className={`min-h-9 flex-row items-center justify-between rounded-md px-2.5 py-1.5 ${
                  selected ? "bg-muted" : "active:bg-muted/70"
                }`}
              >
                <Text className="text-sm text-foreground">{option.label}</Text>
                {selected ? <Check className="text-foreground" size={15} /> : null}
              </Pressable>
            )
          })}
        </View>
      </PopoverContent>
    </Popover>
  )
}
