// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Colour and finish controls for the buddy in the island motion lab.

import { useState } from "react"
import { Text, View } from "react-native"
import { BUDDY_FINISHES, type BuddyFinish } from "../buddy/engine"
import { BUDDY_COLORS, BUDDY_FINISH_LABELS, BUDDY_FINISH_NAMES, type BuddyFinishId } from "../buddy/look"
import { Chip, Row, SectionTitle, Slider } from "./lab-controls"

type NumericKey = { [K in keyof BuddyFinish]: BuddyFinish[K] extends number ? K : never }[keyof BuddyFinish]

const SLIDERS: { key: NumericKey; label: string; min: number; max: number }[] = [
  { key: "shading", label: "Shading", min: 0, max: 1.5 },
  { key: "gloss", label: "Gloss", min: 0, max: 1.5 },
  { key: "core", label: "Jelly core", min: 0, max: 1.5 },
  { key: "rim", label: "Rim shadow", min: 0, max: 1.5 },
  { key: "edge", label: "Edge light", min: 0, max: 1.5 },
  { key: "glow", label: "Glow", min: 0, max: 1.5 },
  { key: "boxiness", label: "Boxiness", min: 2.5, max: 8 },
  { key: "eyeSize", label: "Eye size", min: 0.6, max: 1.4 },
  { key: "sparkle", label: "Eye sparkle", min: 0, max: 1.5 },
  { key: "blush", label: "Blush", min: 0, max: 1.5 },
  { key: "mouth", label: "Mouth weight", min: 0.4, max: 1.6 },
]

const sameFinish = (a: BuddyFinish, b: BuddyFinish) =>
  (Object.keys(a) as (keyof BuddyFinish)[]).every((key) => a[key] === b[key])

const normalizeHex = (value: string) => {
  const hex = value.trim().replace(/^#?/, "#")
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toUpperCase() : null
}

export function StyleLab({
  color,
  accent,
  onColorChange,
  finish,
  onFinishChange,
  onPresetChange,
}: {
  color: string
  /** The app's theme accent, offered as the "follow the theme" option. */
  accent: string
  onColorChange: (color: string) => void
  finish: BuddyFinish
  /** Exact strengths from the sliders. */
  onFinishChange: (finish: BuddyFinish) => void
  /** A named finish, saved on the look. */
  onPresetChange: (finish: BuddyFinishId) => void
}) {
  const [hexDraft, setHexDraft] = useState("")
  const [copied, setCopied] = useState(false)
  const set = <K extends keyof BuddyFinish>(key: K, value: BuddyFinish[K]) => onFinishChange({ ...finish, [key]: value })
  const hexValue = normalizeHex(color) ?? "#FF7A3D"

  return (
    <View className="gap-4">
      <SectionTitle>Color and finish (applies to every buddy on this page)</SectionTitle>
      <View className="flex-row flex-wrap gap-8">
        <View className="min-w-[320px] flex-1 gap-4">
          <Row label="Body color">
            <Chip label="Theme accent" active={color === accent} onPress={() => onColorChange(accent)} />
            <input
              type="color"
              value={hexValue}
              onChange={(event) => onColorChange(event.target.value.toUpperCase())}
              title="Pick any color"
              style={{ width: 34, height: 28, border: "none", background: "none", cursor: "pointer", padding: 0 }}
            />
            <input
              value={hexDraft}
              placeholder={hexValue}
              onChange={(event) => {
                setHexDraft(event.target.value)
                const hex = normalizeHex(event.target.value)
                if (hex) onColorChange(hex)
              }}
              onBlur={() => setHexDraft("")}
              style={{
                width: 84,
                padding: "5px 8px",
                borderRadius: 8,
                border: "1px solid rgb(var(--color-border, 63 63 70))",
                background: "transparent",
                color: "rgb(var(--color-foreground))",
                fontSize: 12,
                fontFamily: "ui-monospace, monospace",
              }}
            />
          </Row>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {BUDDY_COLORS.map((s) => {
              const active = s.color.toUpperCase() === color.toUpperCase()
              return (
                <button
                  key={s.label}
                  title={s.label}
                  onClick={() => onColorChange(s.color)}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 9,
                    background: s.color,
                    cursor: "pointer",
                    border: "1px solid rgba(127,127,127,0.35)",
                    outline: active ? "2px solid rgb(var(--color-primary))" : "none",
                    outlineOffset: 2,
                  }}
                />
              )
            })}
          </div>
          <Row label="Finish preset">
            {BUDDY_FINISH_NAMES.map((name) => (
              <Chip
                key={name}
                label={BUDDY_FINISH_LABELS[name].label}
                active={sameFinish(finish, BUDDY_FINISHES[name])}
                onPress={() => onPresetChange(name)}
              />
            ))}
            <Chip
              label={copied ? "Copied" : "Copy finish as code"}
              onPress={() => {
                void navigator.clipboard?.writeText(JSON.stringify(finish, null, 2))
                setCopied(true)
                setTimeout(() => setCopied(false), 1200)
              }}
            />
          </Row>
          <Row label="Eyes">
            <Chip label="Oval" active={finish.eyes === "oval"} onPress={() => set("eyes", "oval")} />
            <Chip label="Pill" active={finish.eyes === "pill"} onPress={() => set("eyes", "pill")} />
          </Row>
        </View>
        <View className="min-w-[320px] flex-1 gap-2">
          {SLIDERS.map((s) => (
            <Slider
              key={s.key}
              label={s.label}
              value={finish[s.key]}
              min={s.min}
              max={s.max}
              onChange={(value) => set(s.key, value)}
            />
          ))}
          <Text className="text-[11px] text-muted-foreground">
            1.00 is the classic amount for each strength; boxiness is the superellipse exponent.
          </Text>
        </View>
      </View>
    </View>
  )
}
