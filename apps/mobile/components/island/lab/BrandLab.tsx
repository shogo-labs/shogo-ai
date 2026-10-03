// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The buddy as the brand: app icon tiles, favicons, a browser tab and the
// logo lockup, all drawn from the engine with the lab's colour, look and finish.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { Image, Text, View } from "react-native"
import { ShogoWordmark } from "@shogo/shared-ui/branding"
import {
  BUDDY_ASPECT,
  BuddyEngine,
  parseColor,
  type BuddyEmote,
  type BuddyFinish,
  type RGB,
} from "../buddy/engine"
import type { BuddyLook } from "../buddy/look"
import { Chip, Row, SectionTitle, Slider } from "./lab-controls"

const SPRITE_W = 640
const CREAM = "#FFF4EA"

type Expression = "idle" | BuddyEmote

/** The buddy drawn once at high resolution, cropped to its pixels. Glow is
 * left out: it reads as a smudge on a flat tile. */
function renderSprite(color: string, look: BuddyLook, finish: BuddyFinish, expression: Expression) {
  const engine = new BuddyEngine()
  engine.reducedMotion = true
  engine.look = look
  engine.finish = { ...finish, glow: 0 }
  engine.setBodyColor(color)
  if (expression !== "idle") engine.emote(expression)
  for (let i = 0; i < 90; i++) engine.update(1 / 60)
  const canvas = document.createElement("canvas")
  canvas.width = SPRITE_W
  canvas.height = Math.round(SPRITE_W * BUDDY_ASPECT)
  const ctx = canvas.getContext("2d")!
  engine.draw(ctx, SPRITE_W, SPRITE_W * BUDDY_ASPECT)
  engine.dispose()

  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] <= 8) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) return canvas
  const out = document.createElement("canvas")
  out.width = x1 - x0 + 1
  out.height = y1 - y0 + 1
  out.getContext("2d")!.drawImage(canvas, -x0, -y0)
  return out
}

const css = (c: RGB) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`
const mixHex = (color: string, toward: RGB, t: number) => {
  const c = parseColor(color)
  return css([c[0] + (toward[0] - c[0]) * t, c[1] + (toward[1] - c[1]) * t, c[2] + (toward[2] - c[2]) * t])
}

interface Tile {
  id: string
  label: string
  /** Top and bottom of the background gradient; null is transparent. */
  bg: [string, string] | null
  sprite: HTMLCanvasElement
}

function paintTile(ctx: CanvasRenderingContext2D, px: number, tile: Tile, fill: number, rounded: boolean) {
  ctx.clearRect(0, 0, px, px)
  if (tile.bg) {
    const g = ctx.createLinearGradient(0, 0, 0, px)
    g.addColorStop(0, tile.bg[0])
    g.addColorStop(1, tile.bg[1])
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.roundRect(0, 0, px, px, rounded ? px * 0.225 : 0)
    ctx.fill()
  }
  const s = tile.sprite
  const scale = (px * fill) / Math.max(s.width, s.height)
  const w = s.width * scale
  const h = s.height * scale
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(s, (px - w) / 2, (px - h) / 2, w, h)
}

/** A tile on a canvas at `size` CSS pixels, drawn at `density` device pixels per CSS pixel. */
function TileCanvas({
  tile,
  size,
  fill,
  density = 2,
  rounded = true,
  style,
}: {
  tile: Tile
  size: number
  fill: number
  density?: number
  rounded?: boolean
  style?: CSSProperties
}) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    const px = Math.round(size * density)
    canvas.width = canvas.height = px
    paintTile(ctx, px, tile, fill, rounded)
  }, [tile, size, fill, density, rounded])
  return <canvas ref={ref} style={{ width: size, height: size, display: "block", ...style }} />
}

function download(tile: Tile, px: number, fill: number, rounded: boolean, name: string) {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = px
  paintTile(canvas.getContext("2d")!, px, tile, fill, rounded)
  const a = document.createElement("a")
  a.href = canvas.toDataURL("image/png")
  a.download = name
  a.click()
}

function SpriteCanvas({ sprite, height }: { sprite: HTMLCanvasElement; height: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const width = Math.round((sprite.width / sprite.height) * height)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    canvas.width = width * 2
    canvas.height = height * 2
    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(sprite, 0, 0, canvas.width, canvas.height)
  }, [sprite, width, height])
  return <canvas ref={ref} style={{ width, height, display: "block" }} />
}

/** The wordmark without the ray mark, which the buddy replaces. */
function Wordmark({ height, dark }: { height: number; dark: boolean }) {
  const crop = 460
  return (
    <div style={{ width: (height * (1740 - crop)) / 412, height, overflow: "hidden" }}>
      <div style={{ width: (height * 1740) / 412, height, marginLeft: (-height * crop) / 412 }}>
        <ShogoWordmark className="h-full w-full" colorScheme={dark ? "dark" : "light"} decorative />
      </div>
    </div>
  )
}

const caption: CSSProperties = { fontSize: 11, color: "rgb(var(--color-muted-foreground))", textAlign: "center" }
const panel: CSSProperties = { borderRadius: 16, padding: 20, background: "rgba(127,127,127,0.08)" }

const EXPRESSIONS: Expression[] = ["idle", "happy", "wink", "proud", "love"]

export function BrandLab({ color, look, finish }: { color: string; look: BuddyLook; finish: BuddyFinish }) {
  const [expression, setExpression] = useState<Expression>("idle")
  const [iconFill, setIconFill] = useState(0.7)
  const [favFill, setFavFill] = useState(0.86)
  const [tabIcon, setTabIcon] = useState("bare")

  const sprite = useMemo(() => renderSprite(color, look, finish, expression), [color, look, finish, expression])
  const creamSprite = useMemo(() => renderSprite(CREAM, look, finish, expression), [look, finish, expression])

  const tiles = useMemo<Tile[]>(
    () => [
      {
        id: "color",
        label: "Color tile",
        bg: [mixHex(color, [1, 1, 1], 0.2), mixHex(color, [0, 0, 0], 0.08)],
        sprite: creamSprite,
      },
      {
        id: "light",
        label: "Light tile",
        bg: [mixHex(color, [1, 1, 1], 0.95), mixHex(color, [1, 1, 1], 0.84)],
        sprite,
      },
      { id: "dark", label: "Dark tile", bg: ["#2A2A2E", "#141416"], sprite },
    ],
    [color, sprite, creamSprite],
  )
  const bare: Tile = useMemo(() => ({ id: "bare", label: "No tile", bg: null, sprite }), [sprite])
  const favTiles = [bare, ...tiles]
  const tab = favTiles.find((t) => t.id === tabIcon) ?? bare

  return (
    <View className="gap-4">
      <SectionTitle>Brand preview: app icon, favicon and logo with this buddy</SectionTitle>
      <View className="flex-row flex-wrap gap-8">
        <Row label="Expression">
          {EXPRESSIONS.map((e) => (
            <Chip key={e} label={e} active={expression === e} onPress={() => setExpression(e)} />
          ))}
        </Row>
        <View className="min-w-[260px] flex-1 gap-1">
          <Slider label="Icon fill" value={iconFill} min={0.4} max={1} onChange={setIconFill} />
          <Slider label="Favicon fill" value={favFill} min={0.5} max={1} onChange={setFavFill} />
        </View>
      </View>

      <div style={{ ...panel, display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <Image source={require("@/assets/icon.png")} style={{ width: 150, height: 150, borderRadius: 34 }} />
          <span style={caption}>Current</span>
        </div>
        {tiles.map((tile) => (
          <div key={tile.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <TileCanvas tile={tile} size={150} fill={iconFill} />
            <span style={caption}>{tile.label}</span>
            <Chip
              label="Download 1024"
              onPress={() => download(tile, 1024, iconFill, false, `shogo-icon-${tile.id}-1024.png`)}
            />
          </div>
        ))}
      </div>

      <View className="flex-row flex-wrap gap-4">
        <div
          style={{
            display: "flex",
            gap: 22,
            alignItems: "center",
            padding: "20px 26px",
            borderRadius: 18,
            background: "linear-gradient(135deg, #5b6cff, #c35bd6 60%, #f59e0b)",
          }}
        >
          {tiles.map((tile) => (
            <div key={tile.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
              <TileCanvas tile={tile} size={60} fill={iconFill} />
              <span style={{ fontSize: 10, color: "#fff" }}>Shogo</span>
            </div>
          ))}
        </div>
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            padding: "10px 16px",
            borderRadius: 20,
            background: "rgba(240,240,245,0.55)",
            border: "1px solid rgba(255,255,255,0.4)",
            backdropFilter: "blur(10px)",
          }}
        >
          {tiles.map((tile) => (
            <TileCanvas key={tile.id} tile={tile} size={44} fill={iconFill} />
          ))}
          <span style={{ ...caption, marginLeft: 6 }}>Dock</span>
        </div>
      </View>

      <div style={{ ...panel, display: "flex", gap: 18, flexWrap: "wrap" }}>
        {favTiles.map((tile) => (
          <div key={tile.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <div
              style={{
                display: "flex",
                gap: 12,
                alignItems: "center",
                padding: "12px 14px",
                borderRadius: 10,
                background: "#fff",
              }}
            >
              <TileCanvas tile={tile} size={16} fill={favFill} />
              <TileCanvas tile={tile} size={32} fill={favFill} />
              <TileCanvas tile={tile} size={48} fill={favFill} />
              <TileCanvas tile={tile} size={64} fill={favFill} density={0.25} style={{ imageRendering: "pixelated" }} />
            </div>
            <span style={caption}>{tile.label} · 16 / 32 / 48 · 16px zoomed</span>
            <Chip
              label="Download 32"
              onPress={() => download(tile, 32, favFill, true, `shogo-favicon-${tile.id}-32.png`)}
            />
          </div>
        ))}
      </div>

      <Row label="Tab favicon">
        {favTiles.map((t) => (
          <Chip key={t.id} label={t.label} active={tabIcon === t.id} onPress={() => setTabIcon(t.id)} />
        ))}
      </Row>
      <View className="flex-row flex-wrap gap-4">
        {(
          [
            ["#dee1e6", "#ffffff", "#1f1f1f"],
            ["#202124", "#35363a", "#e8eaed"],
          ] as const
        ).map(([strip, active, text]) => (
          <div key={strip} style={{ background: strip, padding: "8px 8px 0", borderRadius: 10, width: 420 }}>
            <div style={{ display: "flex", gap: 2 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 12px",
                  borderRadius: "8px 8px 0 0",
                  background: active,
                  color: text,
                  fontSize: 12,
                  flex: 1,
                }}
              >
                <TileCanvas tile={tab} size={16} fill={favFill} />
                <span>Shogo — Build with AI</span>
              </div>
              <div style={{ padding: "8px 12px", color: text, opacity: 0.6, fontSize: 12, flex: 1 }}>New Tab</div>
            </div>
          </div>
        ))}
      </View>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {(
          [
            ["#ffffff", false, sprite],
            ["#0f0f11", true, sprite],
            [mixHex(color, [0, 0, 0], 0.04), true, creamSprite],
          ] as const
        ).map(([bg, dark, s], i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "22px 30px",
              borderRadius: 16,
              background: bg,
              border: "1px solid rgba(127,127,127,0.2)",
            }}
          >
            <SpriteCanvas sprite={s} height={64} />
            <Wordmark height={52} dark={dark} />
          </div>
        ))}
      </div>
      <Text className="text-[11px] text-muted-foreground">
        Icon downloads are full-bleed squares (iOS and Android mask the corners). Favicon downloads keep the rounded
        tile.
      </Text>
    </View>
  )
}
