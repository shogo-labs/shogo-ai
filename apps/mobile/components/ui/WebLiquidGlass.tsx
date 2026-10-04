// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Web glass for `LiquidGlassBackdrop`. The frost, rim light and tint come
 * from the `.liquid-glass` class in `global.css`. On Chromium the backdrop
 * is also refracted through an SVG displacement map, which bends what's
 * behind the rim like a convex lens. Safari ignores `url()` in
 * `backdrop-filter` and Firefox renders nothing for it, so refraction is
 * opt-in per engine rather than gated on `@supports`.
 */
import { createElement, useId, useState } from "react";
import {
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";

const BLUR = "blur(12px) saturate(180%) brightness(1.06)";
const REFRACTIVE_INDEX = 1.5;
const GLASS_THICKNESS = 28;

let refractionSupported: boolean | null = null;
function canRefract(): boolean {
  if (refractionSupported !== null) return refractionSupported;
  refractionSupported = false;
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return false;
  }
  const ua = navigator.userAgent;
  const chromium = /Chrome\/\d+/.test(ua) && !/Firefox|FxiOS|CriOS|EdgiOS/.test(ua);
  const reduced =
    window.matchMedia?.("(prefers-reduced-transparency: reduce)").matches ?? false;
  refractionSupported =
    chromium && !reduced && (window.CSS?.supports?.("backdrop-filter", "url(#a)") ?? false);
  return refractionSupported;
}

// Height of the glass across the bezel (0 = outer edge, 1 = flat top), as
// a squircle so the curve eases into the flat interior.
function surface(t: number): number {
  return Math.pow(1 - Math.pow(1 - t, 4), 1 / 4);
}

// How far (px) a vertical ray is bent at each pixel step into the bezel.
function bezelProfile(bezel: number): number[] {
  const out: number[] = [];
  const dt = 1 / Math.max(bezel * 4, 1);
  for (let i = 0; i <= bezel; i++) {
    const t = Math.min(Math.max(i / bezel, dt), 1 - dt);
    const height = surface(t) * GLASS_THICKNESS;
    const slope = ((surface(t + dt) - surface(t - dt)) / (2 * dt)) * (GLASS_THICKNESS / bezel);
    const incidence = Math.atan(slope);
    const refracted = Math.asin(Math.sin(incidence) / REFRACTIVE_INDEX);
    out.push(height * Math.tan(incidence - refracted));
  }
  return out;
}

type DisplacementMap = { url: string; scale: number };
const maps = new Map<string, DisplacementMap | null>();

/**
 * R/G encode where each pixel samples from (128 = itself). Inside the bezel
 * the sample moves inward along the rounded rect's normal, so the rim
 * magnifies the backdrop instead of pulling in pixels from outside it.
 */
function displacementMap(w: number, h: number, radius: number): DisplacementMap | null {
  const key = `${w}x${h}r${radius}`;
  if (maps.has(key)) return maps.get(key)!;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    maps.set(key, null);
    return null;
  }
  const bezel = Math.max(2, Math.round(Math.min(radius * 0.75, 18)));
  const profile = bezelProfile(bezel);
  const max = Math.max(...profile, 0.001);
  const image = ctx.createImageData(w, h);
  const hx = w / 2;
  const hy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - hx;
      const py = y + 0.5 - hy;
      const qx = Math.abs(px) - (hx - radius);
      const qy = Math.abs(py) - (hy - radius);
      let nx = 0;
      let ny = 0;
      let depth: number;
      if (qx > 0 && qy > 0) {
        const len = Math.hypot(qx, qy);
        depth = radius - len;
        nx = (qx / len) * Math.sign(px);
        ny = (qy / len) * Math.sign(py);
      } else if (qx > qy) {
        depth = radius - qx;
        nx = Math.sign(px);
      } else {
        depth = radius - qy;
        ny = Math.sign(py);
      }
      const i = (y * w + x) * 4;
      let magnitude = 0;
      if (depth >= 0 && depth < bezel) magnitude = profile[Math.floor(depth)] / max;
      image.data[i] = Math.round(128 - nx * magnitude * 127);
      image.data[i + 1] = Math.round(128 - ny * magnitude * 127);
      image.data[i + 2] = 128;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const map = { url: canvas.toDataURL(), scale: max * 2 };
  maps.set(key, map);
  return map;
}

export function WebLiquidGlass({ style }: { style?: StyleProp<ViewStyle> }) {
  const id = `lg${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const refract = canRefract();
  const onLayout = refract
    ? (e: LayoutChangeEvent) => {
        const w = Math.round(e.nativeEvent.layout.width);
        const h = Math.round(e.nativeEvent.layout.height);
        if (w > 0 && h > 0 && (w !== size?.w || h !== size?.h)) setSize({ w, h });
      }
    : undefined;
  const radius = Number(StyleSheet.flatten(style)?.borderRadius ?? 0);
  const map =
    refract && size
      ? displacementMap(size.w, size.h, Math.min(radius, size.w / 2, size.h / 2))
      : null;
  const filter = map ? `${BLUR} url(#${id})` : undefined;

  return (
    <View
      pointerEvents="none"
      className="liquid-glass"
      onLayout={onLayout}
      style={[
        StyleSheet.absoluteFill,
        style,
        filter ? ({ backdropFilter: filter, WebkitBackdropFilter: filter } as ViewStyle) : null,
      ]}
    >
      {map && size
        ? createElement(
            "svg",
            { width: 0, height: 0, "aria-hidden": true, style: { position: "absolute" } },
            createElement(
              "filter",
              {
                id,
                x: 0,
                y: 0,
                width: size.w,
                height: size.h,
                filterUnits: "userSpaceOnUse",
                primitiveUnits: "userSpaceOnUse",
                colorInterpolationFilters: "sRGB",
              },
              createElement("feImage", {
                href: map.url,
                x: 0,
                y: 0,
                width: size.w,
                height: size.h,
                preserveAspectRatio: "none",
                result: "map",
              }),
              createElement("feDisplacementMap", {
                in: "SourceGraphic",
                in2: "map",
                scale: map.scale,
                xChannelSelector: "R",
                yChannelSelector: "G",
              })
            )
          )
        : null}
    </View>
  );
}
