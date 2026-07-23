// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TechStackPicker
 *
 * Popover-based selector (drop-in twin of the model / environment chips in
 * CompactChatInput) that lets the user choose the tech stack for a project
 * they're about to create from the home composer.
 *
 * It is a *controlled* chip: the parent owns the selected `value` so the
 * choice can be threaded into `createProject(... techStackId)` at submit
 * time, persisting `settings.techStackId`. The list itself is fetched lazily
 * from `GET /api/tech-stacks` (same source as the Configuration screen).
 *
 * Defaults to `react-app` to match the agent-runtime fallback — the chip
 * reflects what the runtime would seed even before the user touches it.
 */
import React, { useEffect, useMemo, useRef, useState } from "react"
import { View, Text, Pressable, ScrollView } from "react-native"
import { Layers, ChevronDown, Check } from "lucide-react-native"
import {
  Popover,
  PopoverBackdrop,
  PopoverContent,
} from "@/components/ui/popover"
import { cn } from "@shogo/shared-ui/primitives"
import { api, createHttpClient, type TechStackSummary } from "../../lib/api"
import { WebTooltip } from "../ui/tooltip"

export interface TechStackPickerProps {
  /** Currently selected stack id (e.g. "react-app"). */
  value?: string
  /** Called with the chosen stack id when the user picks one. */
  onChange?: (techStackId: string) => void
  disabled?: boolean
}

export function TechStackPicker({ value, onChange, disabled }: TechStackPickerProps) {
  const [open, setOpen] = useState(false)
  const [stacks, setStacks] = useState<TechStackSummary[]>([])
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true
    const http = createHttpClient()
    api
      .getTechStacks(http)
      .then((s) => setStacks(s))
      .catch((e) => console.error("[TechStackPicker] Failed to fetch tech stacks:", e))
  }, [])

  const selected = useMemo(
    () => stacks.find((s) => s.id === value),
    [stacks, value],
  )

  // Until the list loads (or if the id has no match) we don't have a human
  // label, so fall back to a generic "Type" rather than flashing the raw id.
  const displayLabel = selected?.name ?? "Type"

  // Nothing to choose from (tech-stacks dir missing on disk / fetch failed).
  // Hide the chip entirely rather than render a dead control.
  if (stacks.length === 0) return null

  return (
    <Popover
      placement="top"
      size="xs"
      isOpen={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      trigger={(triggerProps) => (
        <WebTooltip label={`Project type: ${selected?.name ?? "default"}`} placement="bottom">
          <Pressable
            {...triggerProps}
            disabled={disabled}
            accessibilityLabel={`Project type: ${selected?.name ?? "default"}`}
            className={cn(
              "h-[22px] flex-row items-center gap-1 rounded-md px-1.5",
              "border border-border/60 bg-muted/40 active:opacity-80",
              disabled && "opacity-60",
            )}
            testID="tech-stack-picker-trigger"
          >
            <Layers className="h-3 w-3 text-muted-foreground" size={12} />
            <Text className="text-[11px] text-muted-foreground">{displayLabel}</Text>
            <ChevronDown className="h-2 w-2 text-muted-foreground/60" size={8} />
          </Pressable>
        </WebTooltip>
      )}
    >
      <PopoverBackdrop />
      <PopoverContent className="w-[280px] p-0 max-h-[360px]">
        <ScrollView>
          <View className="px-3 pt-3 pb-1">
            <Text className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Project Type
            </Text>
          </View>
          {stacks.map((stack) => {
            const isSelected = stack.id === value
            return (
              <Pressable
                key={stack.id}
                onPress={() => {
                  setOpen(false)
                  if (!isSelected) onChange?.(stack.id)
                }}
                className={cn(
                  "flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted/60",
                  isSelected && "bg-primary/10",
                )}
              >
                <View className="flex-1">
                  <Text
                    className={cn(
                      "text-sm font-medium",
                      isSelected ? "text-primary" : "text-foreground",
                    )}
                  >
                    {stack.name}
                  </Text>
                  <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
                    {stack.description}
                  </Text>
                </View>
                {isSelected && <Check className="h-4 w-4 text-primary" size={16} />}
              </Pressable>
            )
          })}
        </ScrollView>
      </PopoverContent>
    </Popover>
  )
}

export default TechStackPicker
