// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Small web-only controls shared by the island motion lab panels.

import type { ReactNode } from "react"
import { Pressable, Text, View } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"

export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        "rounded-full border px-3 py-1.5",
        active ? "border-primary bg-primary/15" : "border-border bg-card hover:bg-muted",
      )}
    >
      <Text className={cn("text-xs", active ? "font-semibold text-primary" : "text-foreground")}>{label}</Text>
    </Pressable>
  )
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View className="gap-2">
      <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</Text>
      <View className="flex-row flex-wrap items-center gap-2">{children}</View>
    </View>
  )
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</Text>
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
      <span style={{ width: 84, color: "rgb(var(--color-muted-foreground))" }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ flex: 1, accentColor: "rgb(var(--color-primary))" }}
      />
      <span style={{ width: 36, textAlign: "right", fontVariantNumeric: "tabular-nums", color: "rgb(var(--color-foreground))" }}>
        {value.toFixed(2)}
      </span>
    </label>
  )
}
