// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useRef, type ReactNode } from "react"
import { Pressable, Text, View } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import type { BuddyState } from "./engine"
import {
  BUDDY_FACES,
  BUDDY_FACE_NAMES,
  BUDDY_PRESETS,
  BUDDY_TOPPERS,
  BUDDY_TOPPER_NAMES,
  sameLook,
  type BuddyLook,
} from "./look"
import { ShogoBuddy, type ShogoBuddyHandle } from "./ShogoBuddy"

function Chip({
  label,
  active,
  disabled = false,
  onPress,
}: {
  label: string
  active: boolean
  disabled?: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      className={cn(
        "rounded-full border px-3 py-1.5",
        active ? "border-primary bg-primary/15" : "border-border bg-card",
        disabled ? "opacity-50" : !active && "hover:bg-muted",
      )}
    >
      <Text className={cn("text-xs", active ? "font-semibold text-primary" : "text-foreground")}>{label}</Text>
    </Pressable>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View className="gap-1.5">
      <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</Text>
      <View className="flex-row flex-wrap gap-2">{children}</View>
    </View>
  )
}

/**
 * Pick a Shogo: presets plus the individual accessories, with a live preview.
 * Holds no state; the caller owns and saves the look.
 */
export function BuddyCustomizer({
  look,
  onChange,
  color,
  state = "idle",
  previewSize = 150,
}: {
  look: BuddyLook
  onChange: (look: BuddyLook) => void
  color: string
  state?: BuddyState
  previewSize?: number
}) {
  const preview = useRef<ShogoBuddyHandle>(null)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    preview.current?.hop()
  }, [look])

  return (
    <View className="gap-4">
      <View className="flex-row flex-wrap gap-5">
        <View
          className="items-center justify-end rounded-2xl border border-white/5 bg-zinc-950 pb-2"
          style={{ width: previewSize + 40 }}
        >
          <ShogoBuddy
            ref={preview}
            size={previewSize}
            state={state}
            color={color}
            look={look}
            interactive
            accessibilityLabel="Your Shogo preview"
          />
        </View>
        <View className="min-w-[240px] flex-1 gap-4">
          <Row label="On top">
            {BUDDY_TOPPER_NAMES.map((name) => (
              <Chip
                key={name}
                label={BUDDY_TOPPERS[name]}
                active={look.topper === name}
                onPress={() => onChange({ ...look, topper: name })}
              />
            ))}
          </Row>
          <Row label="Face">
            {BUDDY_FACE_NAMES.map((name) => (
              <Chip
                key={name}
                label={BUDDY_FACES[name]}
                active={look.face === name}
                onPress={() => onChange({ ...look, face: name })}
              />
            ))}
          </Row>
          <Row label="Extras">
            <Chip label="Ear bolts" active={look.bolts} onPress={() => onChange({ ...look, bolts: !look.bolts })} />
            <Chip
              label={look.face === "classic" ? "Blush" : "Blush (classic face only)"}
              active={look.blush && look.face === "classic"}
              disabled={look.face !== "classic"}
              onPress={() => onChange({ ...look, blush: !look.blush })}
            />
          </Row>
        </View>
      </View>
      <Row label="Presets">
        {BUDDY_PRESETS.map((preset) => {
          const active = sameLook(look, preset.look)
          return (
            <Pressable
              key={preset.id}
              onPress={() => onChange(preset.look)}
              accessibilityRole="button"
              accessibilityLabel={`${preset.label} preset`}
              accessibilityState={{ selected: active }}
              className={cn(
                "items-center rounded-xl border bg-zinc-950 px-1.5 pb-2",
                active ? "border-primary" : "border-white/5 hover:border-white/20",
              )}
            >
              <ShogoBuddy size={64} state={state} color={color} look={preset.look} followPointer={false} still />
              <Text className={cn("text-[11px] font-semibold", active ? "text-zinc-50" : "text-zinc-400")}>
                {preset.label}
              </Text>
            </Pressable>
          )
        })}
      </Row>
    </View>
  )
}
