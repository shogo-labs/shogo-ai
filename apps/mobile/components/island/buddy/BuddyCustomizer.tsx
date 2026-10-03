// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useRef, useState, type ReactNode } from "react"
import { FlatList, Platform, Pressable, ScrollView, Text, View } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import type { BuddyFinish, BuddyState } from "./engine"
import {
  BUDDY_COLORS,
  BUDDY_EYEWEAR,
  BUDDY_EYEWEAR_NAMES,
  BUDDY_FACES,
  BUDDY_FACE_NAMES,
  BUDDY_FINISH_LABELS,
  BUDDY_FINISH_NAMES,
  BUDDY_NECKS,
  BUDDY_NECK_NAMES,
  BUDDY_TAILS,
  BUDDY_TAIL_NAMES,
  BUDDY_PRESETS,
  BUDDY_TOPPERS,
  BUDDY_TOPPER_NAMES,
  normalizeBuddyColor,
  sameLook,
  withPreset,
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
      <View className="flex-row flex-wrap items-center gap-2">{children}</View>
    </View>
  )
}

/** `#RRGGBB` for a hex or `rgb(r, g, b)` colour, for the web colour input. */
function toHex(color: string): string {
  const hex = normalizeBuddyColor(color)
  if (hex) return hex
  const [r = 255, g = 122, b = 61] = color.match(/\d+/g)?.map(Number) ?? []
  return `#${[r, g, b].map((v) => Math.min(255, v).toString(16).padStart(2, "0")).join("")}`.toUpperCase()
}

const SWATCH = Platform.OS === "web" ? 26 : 32

function Swatch({
  label,
  active,
  onPress,
  children,
}: {
  label: string
  active: boolean
  onPress?: () => void
  children: ReactNode
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      className={cn("items-center justify-center rounded-full border-2", active ? "border-primary" : "border-transparent")}
      style={{ width: SWATCH + 8, height: SWATCH + 8 }}
    >
      {children}
    </Pressable>
  )
}

/** Body colour: follow the app accent, a swatch, or (web) any colour. */
function ColorOptions({ look, onChange, color }: { look: BuddyLook; onChange: (look: BuddyLook) => void; color: string }) {
  const custom = look.color !== null && !BUDDY_COLORS.some((c) => c.color === look.color)
  const dot = (fill: string) => (
    <View
      style={{
        width: SWATCH,
        height: SWATCH,
        borderRadius: SWATCH / 2,
        backgroundColor: fill,
        borderWidth: 1,
        borderColor: "rgba(127,127,127,0.35)",
      }}
    />
  )
  return (
    <>
      <Chip label="Match theme" active={look.color === null} onPress={() => onChange({ ...look, color: null })} />
      {BUDDY_COLORS.map((c) => (
        <Swatch
          key={c.color}
          label={c.label}
          active={look.color === c.color}
          onPress={() => onChange({ ...look, color: c.color })}
        >
          {dot(c.color)}
        </Swatch>
      ))}
      {Platform.OS === "web" ? (
        <Swatch label="Custom colour" active={custom}>
          <label
            title="Custom colour"
            style={{
              position: "relative",
              width: SWATCH,
              height: SWATCH,
              borderRadius: SWATCH / 2,
              cursor: "pointer",
              background: custom
                ? look.color!
                : "conic-gradient(#f43f5e, #f59e0b, #a3e635, #22d3ee, #6366f1, #d946ef, #f43f5e)",
            }}
          >
            <input
              type="color"
              aria-label="Custom colour"
              value={toHex(look.color ?? color)}
              onChange={(event) => {
                const next = normalizeBuddyColor(event.target.value)
                if (next) onChange({ ...look, color: next })
              }}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer" }}
            />
          </label>
        </Swatch>
      ) : null}
    </>
  )
}

function FinishOptions({ look, onChange }: { look: BuddyLook; onChange: (look: BuddyLook) => void }) {
  return (
    <>
      {BUDDY_FINISH_NAMES.map((name) => (
        <Chip
          key={name}
          label={`${BUDDY_FINISH_LABELS[name].label} · ${BUDDY_FINISH_LABELS[name].hint}`}
          active={look.finish === name}
          onPress={() => onChange({ ...look, finish: name })}
        />
      ))}
    </>
  )
}

interface BuddyCustomizerProps {
  look: BuddyLook
  onChange: (look: BuddyLook) => void
  /** Body colour when the look follows the theme (the app accent). */
  color: string
  /** Exact finish strengths instead of the look's finish (the motion lab). */
  finish?: BuddyFinish
  state?: BuddyState
  previewSize?: number
  /**
   * `full` shows every option at once (desktop, settings). `compact` is the
   * phone layout: pinned preview, preset strip and one category at a time.
   */
  layout?: "full" | "compact"
}

/** Hops the preview whenever the look changes after the first render. */
function usePreviewHop(look: BuddyLook) {
  const preview = useRef<ShogoBuddyHandle>(null)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    preview.current?.hop()
  }, [look])
  return preview
}

type CompactCategory = "color" | "top" | "face" | "eyes" | "tail" | "neck" | "extras"

const COMPACT_CATEGORIES: { id: CompactCategory; label: string }[] = [
  { id: "color", label: "Color" },
  { id: "top", label: "Top" },
  { id: "face", label: "Face" },
  { id: "eyes", label: "Eyes" },
  { id: "tail", label: "Tail" },
  { id: "neck", label: "Neck" },
  { id: "extras", label: "Extras" },
]

/** Fixed so the sheet doesn't resize as the options change between tabs. */
const COMPACT_OPTIONS_HEIGHT = 168

function PresetThumb({
  preset,
  look,
  active,
  state,
  color,
  finish,
  onPress,
}: {
  preset: (typeof BUDDY_PRESETS)[number]
  /** The preset as it would look with the user's colour and finish. */
  look: BuddyLook
  active: boolean
  state: BuddyState
  color: string
  finish?: BuddyFinish
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${preset.label} preset`}
      accessibilityState={{ selected: active }}
      className={cn("mr-2 items-center rounded-xl border bg-muted px-1.5 pb-1.5", active ? "border-primary" : "border-border")}
    >
      {/* The buddy is a WebView on native; keep it from swallowing touches. */}
      <View pointerEvents="none">
        <ShogoBuddy size={52} state={state} color={color} finish={finish} look={look} followPointer={false} still />
      </View>
      <Text className={cn("text-[11px] font-semibold", active ? "text-primary" : "text-muted-foreground")}>
        {preset.label}
      </Text>
    </Pressable>
  )
}

function CompactBuddyCustomizer({
  look,
  onChange,
  color,
  finish,
  state = "idle",
  previewSize = 130,
}: BuddyCustomizerProps) {
  const preview = usePreviewHop(look)
  const [category, setCategory] = useState<CompactCategory>("color")
  const classic = look.face === "classic"

  return (
    <View className="gap-3">
      <View className="items-center justify-end self-center rounded-2xl bg-muted pb-2" style={{ width: previewSize + 48 }}>
        <ShogoBuddy
          ref={preview}
          size={previewSize}
          state={state}
          color={color}
          finish={finish}
          look={look}
          interactive
          accessibilityLabel="Your Shogo preview"
        />
      </View>

      <FlatList
        horizontal
        data={BUDDY_PRESETS}
        extraData={look}
        keyExtractor={(preset) => preset.id}
        showsHorizontalScrollIndicator={false}
        initialNumToRender={4}
        maxToRenderPerBatch={2}
        windowSize={3}
        keyboardShouldPersistTaps="handled"
        accessibilityLabel="Presets"
        renderItem={({ item }) => (
          <PresetThumb
            preset={item}
            look={withPreset(look, item)}
            active={sameLook(look, withPreset(look, item))}
            state={state}
            color={color}
            finish={finish}
            onPress={() => onChange(withPreset(look, item))}
          />
        )}
      />

      <View className="flex-row rounded-xl bg-muted p-1" accessibilityRole="tablist">
        {COMPACT_CATEGORIES.map((c) => {
          const active = c.id === category
          return (
            <Pressable
              key={c.id}
              onPress={() => setCategory(c.id)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              className={cn("flex-1 items-center rounded-lg py-1.5", active && "bg-card")}
            >
              <Text className={cn("text-xs", active ? "font-semibold text-foreground" : "text-muted-foreground")}>
                {c.label}
              </Text>
            </Pressable>
          )
        })}
      </View>

      <ScrollView style={{ height: COMPACT_OPTIONS_HEIGHT }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
        <View className="flex-row flex-wrap items-center gap-2 pb-1">
          {category === "color" && (
            <>
              <FinishOptions look={look} onChange={onChange} />
              <View className="h-1 w-full" />
              <ColorOptions look={look} onChange={onChange} color={color} />
            </>
          )}
          {category === "top" &&
            BUDDY_TOPPER_NAMES.map((name) => (
              <Chip
                key={name}
                label={BUDDY_TOPPERS[name]}
                active={look.topper === name}
                onPress={() => onChange({ ...look, topper: name })}
              />
            ))}
          {category === "face" &&
            BUDDY_FACE_NAMES.map((name) => (
              <Chip
                key={name}
                label={BUDDY_FACES[name]}
                active={look.face === name}
                onPress={() => onChange({ ...look, face: name })}
              />
            ))}
          {category === "eyes" && (
            <>
              {!classic ? <Text className="w-full text-xs text-muted-foreground">Needs the Classic face.</Text> : null}
              {BUDDY_EYEWEAR_NAMES.map((name) => (
                <Chip
                  key={name}
                  label={BUDDY_EYEWEAR[name]}
                  active={look.eyewear === name}
                  disabled={!classic && name !== "none"}
                  onPress={() => onChange({ ...look, eyewear: name })}
                />
              ))}
            </>
          )}
          {category === "tail" &&
            BUDDY_TAIL_NAMES.map((name) => (
              <Chip
                key={name}
                label={BUDDY_TAILS[name]}
                active={look.tail === name}
                onPress={() => onChange({ ...look, tail: name })}
              />
            ))}
          {category === "neck" &&
            BUDDY_NECK_NAMES.map((name) => (
              <Chip
                key={name}
                label={BUDDY_NECKS[name]}
                active={look.neck === name}
                onPress={() => onChange({ ...look, neck: name })}
              />
            ))}
          {category === "extras" && (
            <>
              <Chip label="Ear bolts" active={look.bolts} onPress={() => onChange({ ...look, bolts: !look.bolts })} />
              <Chip
                label="Blush"
                active={look.blush && classic}
                disabled={!classic}
                onPress={() => onChange({ ...look, blush: !look.blush })}
              />
              {!classic ? <Text className="w-full text-xs text-muted-foreground">Blush needs the Classic face.</Text> : null}
            </>
          )}
        </View>
      </ScrollView>
    </View>
  )
}

/**
 * Pick a Shogo: presets plus the individual accessories, with a live preview.
 * Holds no state; the caller owns and saves the look.
 */
export function BuddyCustomizer({ layout = "full", ...props }: BuddyCustomizerProps) {
  if (layout === "compact") return <CompactBuddyCustomizer {...props} />
  return <FullBuddyCustomizer {...props} />
}

function FullBuddyCustomizer({
  look,
  onChange,
  color,
  finish,
  state = "idle",
  previewSize = 150,
}: BuddyCustomizerProps) {
  const preview = usePreviewHop(look)

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
            finish={finish}
            look={look}
            interactive
            accessibilityLabel="Your Shogo preview"
          />
        </View>
        <View className="min-w-[240px] flex-1 gap-4">
          <Row label="Style">
            <FinishOptions look={look} onChange={onChange} />
          </Row>
          <Row label="Color">
            <ColorOptions look={look} onChange={onChange} color={color} />
          </Row>
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
          <Row label="Eyewear">
            {BUDDY_EYEWEAR_NAMES.map((name) => (
              <Chip
                key={name}
                label={
                  name !== "none" && look.face !== "classic"
                    ? `${BUDDY_EYEWEAR[name]} (classic face only)`
                    : BUDDY_EYEWEAR[name]
                }
                active={look.eyewear === name}
                onPress={() => onChange({ ...look, eyewear: name })}
              />
            ))}
          </Row>
          <Row label="Tail">
            {BUDDY_TAIL_NAMES.map((name) => (
              <Chip
                key={name}
                label={BUDDY_TAILS[name]}
                active={look.tail === name}
                onPress={() => onChange({ ...look, tail: name })}
              />
            ))}
          </Row>
          <Row label="Neckwear">
            {BUDDY_NECK_NAMES.map((name) => (
              <Chip
                key={name}
                label={BUDDY_NECKS[name]}
                active={look.neck === name}
                onPress={() => onChange({ ...look, neck: name })}
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
          const presetLook = withPreset(look, preset)
          const active = sameLook(look, presetLook)
          if (Platform.OS !== "web") {
            return (
              <Chip
                key={preset.id}
                label={preset.label}
                active={active}
                onPress={() => onChange(presetLook)}
              />
            )
          }
          return (
            <Pressable
              key={preset.id}
              onPress={() => onChange(presetLook)}
              accessibilityRole="button"
              accessibilityLabel={`${preset.label} preset`}
              accessibilityState={{ selected: active }}
              className={cn(
                "items-center rounded-xl border bg-zinc-950 px-1.5 pb-2",
                active ? "border-primary" : "border-white/5 hover:border-white/20",
              )}
            >
              <ShogoBuddy size={64} state={state} color={color} finish={finish} look={presetLook} followPointer={false} still />
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
